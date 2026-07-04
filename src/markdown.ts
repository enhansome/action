import * as core from '@actions/core';
import * as path from 'path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import {
  getRepoInfo,
  makeOctokit,
  parseGitHubUrl,
  RepoInfoDetails,
} from './github.js';

import type { Heading, Link, List, ListItem, Parent, Root, Text } from 'mdast';
import type { Node } from 'unist';

// --- TYPE DEFINITIONS ---

export interface JsonOutput {
  items: JsonSection[];
  metadata: JsonMetadata;
}

export type ReplacementRule =
  | {
      find: string;
      replace: string;
      type: 'literal' | 'regex';
    }
  | { type: 'branding' };

export interface SortOptions {
  by: '' | 'last_commit' | 'stars';
  minLinks: number;
}

interface EnrichedListItem {
  node: ListItem;
  repoInfo: null | RepoInfoDetails;
}

// --- JSON OUTPUT STRUCTURE ---
interface JsonItem {
  children: JsonItem[];
  description: null | string;
  repo_info?: {
    archived: boolean;
    language: null | string;
    last_commit: null | string;
    owner: string;
    repo: string;
    stars: number;
  };
  title: string;
}

interface JsonMetadata {
  enhanced_repository: null | string;
  enhanced_repository_description: null | string;
  last_updated: string;
  original_repository: string;
  original_repository_sha: null | string;
  title: string;
}

interface JsonSection {
  description: null | string;
  items: JsonItem[];
  title: string;
}

interface ProcessedListItem {
  node: ListItem;
  repoInfo: null | RepoInfoDetails;
}

export async function fetchAllRepoInfo(
  urls: Set<string>,
  token: string,
): Promise<Map<string, RepoInfoDetails>> {
  const repoInfoMap = new Map<string, RepoInfoDetails>();
  const queue = Array.from(urls);
  const CONCURRENCY_LIMIT = 10; // Process up to 10 requests in parallel

  // One shared client so the throttling plugin can coordinate rate limits
  // across every lookup instead of per-request.
  const octokit = makeOctokit(token);

  // A worker pulls a URL from the queue, processes it, and repeats
  // until the queue is empty.
  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) {
        continue;
      }

      const details = parseGitHubUrl(url);
      if (details) {
        try {
          const info = await getRepoInfo(octokit, details.owner, details.repo);
          if (info) {
            repoInfoMap.set(url, info);
          }
        } catch (error) {
          // Log errors but don't stop the other workers
          core.error(`Failed to process URL ${url}: ${error}`);
        }
      }
    }
  }

  // Create and start the pool of workers.
  const workers = Array(CONCURRENCY_LIMIT).fill(null).map(worker);
  await Promise.all(workers);

  core.debug(
    `Fetched info for ${repoInfoMap.size} repositories using a concurrency of ${CONCURRENCY_LIMIT}.`,
  );
  return repoInfoMap;
}

export async function processMarkdownContent(
  originalContent: string,
  token: string,
  replacements: ReplacementRule[] = [],
  sortOptions: SortOptions = { by: '', minLinks: 2 },
  originalRepository: string,
  relativeLinkPrefix = '',
  enhancedRepository?: string,
  enhancedRepositoryDescription?: string,
  originalRepositorySha?: string,
  now: Date = new Date(),
): Promise<{ finalContent: string; jsonData: JsonOutput }> {
  const brandingEnabled = replacements.some(rule => rule.type === 'branding');
  const contentAfterReplacements = applyTextReplacements(
    originalContent,
    replacements.filter(rule => rule.type !== 'branding'),
  );

  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.parse(contentAfterReplacements);

  // 1. Collect all unique GitHub links from the plain document.
  const githubUrls = collectGitHubLinks(tree);

  // 2. Fetch all required data in a single parallel batch.
  const repoInfoMap = await fetchAllRepoInfo(githubUrls, token);

  // This single call now handles tree traversal, sorting, and JSON generation.
  // The title derives from the *source* repository (originalRepository), never
  // the enhanced/mirror repo — otherwise the org name doubles into the title.
  const {
    sections,
    title: rawTitle,
    titleHeadingIndex,
  } = processTree(tree, repoInfoMap, sortOptions, originalRepository);

  // Single source of truth for the document title: brand it once and use the
  // same value for the markdown H1 and metadata.title (parity).
  const title = brandingEnabled ? brandTitle(rawTitle) : rawTitle;
  if (brandingEnabled) {
    applyBrandingToTree(tree, title, titleHeadingIndex);
  }

  const jsonData: JsonOutput = {
    items: sections,
    metadata: {
      last_updated: now.toISOString(),
      original_repository: originalRepository.trim(),
      original_repository_sha: (originalRepositorySha?.trim() ?? '') || null,
      enhanced_repository: (enhancedRepository?.trim() ?? '') || null,
      enhanced_repository_description:
        (enhancedRepositoryDescription?.trim() ?? '') || null,
      title,
    },
  };

  // 3. Modify the AST by sorting lists and adding badges.
  sortLists(tree, repoInfoMap, sortOptions);
  addInfoBadges(tree, repoInfoMap);
  fixRelativeLinks(tree, relativeLinkPrefix);

  // 4. Convert the modified AST back to a string, then stamp the enhansomed-on
  //    footer when branding is on.
  let finalContent = serializeAst(tree, originalContent);
  if (brandingEnabled) {
    finalContent = appendEnhansomedFooter(finalContent, now);
  }

  return {
    finalContent,
    jsonData,
  };
}

function addInfoBadges(tree: Root, repoInfoMap: Map<string, RepoInfoDetails>) {
  const modifications = new Map<Parent, { index: number; node: Text }[]>();

  visit(tree, 'link', (node: Link, index?: number, parent?: Parent) => {
    if (index === undefined || !parent) {
      return;
    }

    const repoInfo = repoInfoMap.get(node.url);
    if (!repoInfo) {
      return;
    }

    const badgeNode: Text = {
      type: 'text',
      value: createBadgeText(repoInfo),
    };
    if (!modifications.has(parent)) {
      modifications.set(parent, []);
    }

    modifications.get(parent)?.push({ index: index + 1, node: badgeNode });
  });

  for (const [parent, changes] of modifications.entries()) {
    changes.sort((a, b) => b.index - a.index);
    for (const { index, node } of changes) {
      parent.children.splice(index, 0, node);
    }
  }
}

function applyTextReplacements(
  content: string,
  rules: ReplacementRule[],
): string {
  let processedContent = content;

  for (const rule of rules) {
    if (rule.type === 'literal') {
      core.debug(
        `Applying literal replacement: '${rule.find}' -> '${rule.replace}'`,
      );
      processedContent = processedContent.replaceAll(rule.find, rule.replace);
    } else if (rule.type === 'regex') {
      try {
        const regex = new RegExp(rule.find, 'gm');
        core.debug(
          `Applying regex replacement: /${rule.find}/gm -> '${rule.replace}'`,
        );
        processedContent = processedContent.replace(regex, rule.replace);
      } catch (e: unknown) {
        core.warning(
          `Skipping invalid regex pattern '${rule.find}': ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    // 'branding' rules are applied to the AST/title downstream, not here.
  }

  return processedContent;
}

function collectGitHubLinks(tree: Root): Set<string> {
  const urls = new Set<string>();
  visit(tree, 'link', (node: Link) => {
    if (parseGitHubUrl(node.url)) {
      urls.add(node.url);
    }
  });
  return urls;
}

function createBadgeText(info: RepoInfoDetails): string {
  if (info.archived) {
    return ' ⚠️ Archived';
  }
  const parts: string[] = [
    `⭐ ${info.stargazers_count.toLocaleString()}`,
    `🐛 ${info.open_issues_count.toLocaleString()}`,
  ];
  if (info.language) {
    parts.push(`🌐 ${info.language}`);
  }
  if (info.pushed_at) {
    parts.push(`📅 ${formatDate(info.pushed_at)}`);
  }
  return ` ${parts.join(' | ')}`;
}

function findFirstGitHubLink(node: Parent): string | undefined {
  let linkUrl: string | undefined;
  visit(node, 'link', (linkNode: Link) => {
    if (!linkUrl && parseGitHubUrl(linkNode.url)) {
      linkUrl = linkNode.url;
    }
  });
  return linkUrl;
}
function fixRelativeLinks(tree: Root, relativeLinkPrefix: string) {
  if (!relativeLinkPrefix) {
    return;
  }

  if (relativeLinkPrefix) {
    visit(tree, 'link', node => {
      if (
        !node.url.startsWith('http') &&
        !node.url.startsWith('/') &&
        !node.url.startsWith('#')
      ) {
        node.url = path.join(relativeLinkPrefix, node.url).replace(/\\/g, '/');
      }
    });
  }
}

function formatDate(isoString: null | string): string {
  if (!isoString) {
    return '';
  }
  return new Date(isoString).toISOString().split('T')[0];
}

function getNodeText(node: Parent | Root): string {
  return getInlineText([node]);
}

// Concatenate the text descendants of a run of inline nodes, collapsing any
// whitespace (incl. a lone soft-break newline) to a single space. Operates on
// a slice so callers can isolate text before/after a specific child.
function getInlineText(nodes: Node[]): string {
  let text = '';
  for (const node of nodes) {
    visit(node, 'text', (textNode: Text) => {
      text += textNode.value;
    });
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Descriptions are the prose trailing a list item's link; strip a single
// leading separator — a dash, en/em dash, pipe, colon, or middot — and the
// whitespace around it (e.g. " - ", " — ", "· "). Tightly scoped so a
// meaningful leading character (digit, symbol, non-ASCII letter) survives.
function stripLeadingNoise(text: string): string {
  return text.replace(/^\s*[-–—·|:]\s*/, '').trim();
}

function processListRecursively(
  listNode: List,
  repoInfoMap: Map<string, RepoInfoDetails>,
  sortOptions: SortOptions,
  isNested = false,
): JsonItem[] {
  const itemsWithGitHubLinks = listNode.children.filter(
    item => !!findFirstGitHubLink(item),
  );
  if (!isNested && itemsWithGitHubLinks.length < sortOptions.minLinks) {
    return [];
  }

  const processedItems: ProcessedListItem[] = [];
  const originalOrderJsonItems: JsonItem[] = [];

  for (const itemNode of listNode.children) {
    const githubUrl = findFirstGitHubLink(itemNode);
    const repoInfo = githubUrl ? (repoInfoMap.get(githubUrl) ?? null) : null;

    const nestedLists = itemNode.children.filter(
      (child): child is List => child.type === 'list',
    );
    const childrenJson = nestedLists.flatMap(nestedList =>
      processListRecursively(nestedList, repoInfoMap, sortOptions, true),
    );

    let title = '';
    let description = '';
    const paragraph = itemNode.children.find(p => p.type === 'paragraph');
    if (paragraph) {
      const linkIndex = paragraph.children.findIndex(
        (c): c is Link => c.type === 'link',
      );
      if (linkIndex !== -1) {
        // The title is the leading text plus the first link's text, so
        // distinguishing tags like "[UPDATED]" / "[PDF]" survive instead of
        // being dropped or leaking into the description. The description is
        // whatever prose trails the link.
        title = getInlineText(paragraph.children.slice(0, linkIndex + 1));
        description = stripLeadingNoise(
          getInlineText(paragraph.children.slice(linkIndex + 1)),
        );
      } else {
        // No link: the whole paragraph is the title, so there is no trailing
        // prose to treat as a description (avoid echoing the title back).
        title = getInlineText(paragraph.children);
        description = '';
      }
    }

    const jsonData: JsonItem = {
      children: childrenJson,
      description: description || null,
      title,
    };
    if (repoInfo && githubUrl) {
      jsonData.repo_info = {
        archived: repoInfo.archived,
        language: repoInfo.language,
        last_commit: repoInfo.pushed_at,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        stars: repoInfo.stargazers_count,
      };
    }

    originalOrderJsonItems.push(jsonData);
    processedItems.push({ node: itemNode, repoInfo });
  }

  if (sortOptions.by) {
    processedItems.sort((a, b) => {
      if (!a.repoInfo) {
        return 1;
      }
      if (!b.repoInfo) {
        return -1;
      }
      if (sortOptions.by === 'stars') {
        return b.repoInfo.stargazers_count - a.repoInfo.stargazers_count;
      }
      if (sortOptions.by === 'last_commit') {
        const dateA = a.repoInfo.pushed_at
          ? new Date(a.repoInfo.pushed_at).getTime()
          : 0;
        const dateB = b.repoInfo.pushed_at
          ? new Date(b.repoInfo.pushed_at).getTime()
          : 0;
        return dateB - dateA;
      }
      return 0;
    });
  }

  listNode.children = processedItems.map(p => p.node);
  return originalOrderJsonItems;
}

// Common section headers that should NOT be used as document titles
const INVALID_TITLE_PATTERNS = [
  /^contributing/i,
  /^license$/i,
  /^resources$/i,
  /^contents$/i,
  /^table of contents$/i,
  /^other awesome/i,
  /^other awesomeness$/i,
  /^communities/i,
  /^guides$/i,
  /^tools$/i,
  /^video$/i,
  /^science/i,
];

// Extract the repo segment from a repository identifier, accepting either
// "owner/repo" or a github.com URL (with optional trailing ".git").
function repoNameFromIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return '';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const parts = trimmed
      .replace(/\.git$/i, '')
      .replace(/[?#].*$/, '')
      .split('/')
      .filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }
  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);
}

function formatRepoNameAsTitle(repoName: string): string {
  const cleaned = repoName.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

  // If it already starts with "awesome", format it nicely
  if (/^awesome\s+/i.test(cleaned)) {
    return cleaned.replace(/^awesome\s+/i, 'Awesome ');
  }
  // Otherwise, prefix with "Awesome "
  return `Awesome ${cleaned}`;
}

function isValidTitle(title: string): boolean {
  if (!title || title.trim() === '') {
    return false;
  }
  return !INVALID_TITLE_PATTERNS.some(pattern => pattern.test(title.trim()));
}

/**
 * Brand a document title into the canonical "Awesome <x> with stars" form.
 *
 * If the source title already contains the word "Awesome" (e.g. "Awesome Go"
 * or "My Awesome List"), keep it verbatim and just append the suffix — never
 * duplicate the word. Otherwise prefix with "Awesome " first.
 */
function brandTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/\bawesome\b/i.test(trimmed)) {
    return `${trimmed} with stars`;
  }
  return `Awesome ${trimmed} with stars`;
}

// Index in tree.children of the first H1 usable as the document title — i.e.
// the first top-level H1 that passes isValidTitle (skipping section headers
// like "Contributing"/"Contents"). Returns -1 when none qualifies. Shared by
// title extraction and branding so both act on the very same heading.
function findTitleHeadingIndex(tree: Root): number {
  return tree.children.findIndex(
    (node): node is Heading =>
      node.type === 'heading' &&
      node.depth === 1 &&
      isValidTitle(getNodeText(node)),
  );
}

/**
 * Make the title H1 carry the branded title, so the rendered heading matches
 * metadata.title exactly. Acts on the heading occupying the title slot:
 *  - a valid title H1 (e.g. "# Awesome Go") is replaced in place — leading
 *    non-title H1s like "# Contents" that sit above it are left untouched;
 *  - when no valid title H1 exists, the document's first H1 (however generic —
 *    e.g. "# Guides") is the de-facto title slot, so it is overridden too;
 *  - a source with no H1 at all gets a fresh branded H1 injected at the top.
 * The branded title is therefore always the sole title H1, never a duplicate.
 */
function applyBrandingToTree(
  tree: Root,
  title: string,
  titleHeadingIndex: number,
): void {
  if (!title.trim()) {
    return;
  }
  const heading: Heading = {
    type: 'heading',
    depth: 1,
    children: [{ type: 'text', value: title }],
  };
  if (titleHeadingIndex !== -1) {
    tree.children[titleHeadingIndex] = heading;
    return;
  }
  // No valid title H1 anywhere: override the first H1 (the de-facto title slot)
  // rather than unshifting alongside it, which would leave two H1s. Inject at
  // the top only when the source has no H1 at all.
  const firstH1Index = tree.children.findIndex(
    (node): node is Heading => node.type === 'heading' && node.depth === 1,
  );
  if (firstH1Index !== -1) {
    tree.children[firstH1Index] = heading;
  } else {
    tree.children.unshift(heading);
  }
}

/**
 * Main orchestrator that walks the document to build sections based on headings.
 */
function processTree(
  tree: Root,
  repoInfoMap: Map<string, RepoInfoDetails>,
  sortOptions: SortOptions,
  originalRepository?: string,
): { sections: JsonSection[]; title: string; titleHeadingIndex: number } {
  // Find the first H1 usable as the document title and remember its node index,
  // so branding can later replace this exact heading. We look only at top-level
  // headings — the same scope branding and section-building operate on — so the
  // title text and the branded heading can never drift to different nodes.
  const titleHeadingIndex = findTitleHeadingIndex(tree);
  let documentTitle =
    titleHeadingIndex === -1
      ? ''
      : getNodeText(tree.children[titleHeadingIndex] as Heading);

  // Fallback: derive a subject from the *source* repository name when no valid
  // H1 is present (e.g. a generic "# Guides" heading). Using the source — not
  // the enhanced/mirror repo — keeps the org name out of the title.
  if (documentTitle === '' && originalRepository) {
    const repoName = repoNameFromIdentifier(originalRepository);
    if (repoName) {
      documentTitle = formatRepoNameAsTitle(repoName);
    }
  }

  const sections: JsonSection[] = [];
  let currentSection: JsonSection | null = null;

  for (const node of tree.children) {
    // Headings (H2, H3, etc.) start a new section
    if (node.type === 'heading' && node.depth > 1) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        description: '',
        items: [],
        title: getNodeText(node),
      };
    } else if (currentSection) {
      // If we are in a section, look for paragraphs or lists
      if (node.type === 'paragraph') {
        const paragraphText = getNodeText(node);
        // Avoid adding boilerplate "back to top" links to description
        if (!paragraphText.includes('back to top')) {
          if (currentSection.description) {
            currentSection.description += `\n${paragraphText}`;
          } else {
            currentSection.description = paragraphText;
          }
        }
      } else if (node.type === 'list') {
        // A list is the main content of a section. The `isNested` flag defaults to false here.
        const items = processListRecursively(node, repoInfoMap, sortOptions);
        // Only add the section if the list was valid and produced items
        if (items.length > 0) {
          currentSection.items = items;
          sections.push(currentSection);
        }
        currentSection = null; // Reset after processing a list
      }
    }
  }

  // Add any final section that was not followed by a list
  if (currentSection) {
    sections.push(currentSection);
  }

  return { sections, title: documentTitle, titleHeadingIndex };
}

function serializeAst(tree: Root, originalContent: string): string {
  let finalContent = unified()
    .use(remarkStringify)
    .use(remarkGfm)
    .stringify(tree);

  const originalHadNewline =
    originalContent.endsWith('\n') || originalContent === '';
  if (finalContent.endsWith('\n') && !originalHadNewline) {
    finalContent = finalContent.slice(0, -1);
  } else if (!finalContent.endsWith('\n') && originalHadNewline) {
    finalContent += '\n';
  }
  return finalContent;
}

// Stamp the "Enhansomed by enhansome on <ISO date>." attribution at the end of
// the document, separated by a thematic break so it reads as a distinct footer.
function appendEnhansomedFooter(content: string, now: Date): string {
  const date = now.toISOString().split('T')[0];
  const footer = `***\n\n> _Enhansomed by [enhansome](https://github.com/enhansome) on ${date}._`;
  const body = content.replace(/\n+$/, '');
  return `${body}\n\n${footer}\n`;
}

function sortLists(
  root: Root,
  repoInfoMap: Map<string, RepoInfoDetails>,
  options: SortOptions,
) {
  if (!options.by) {
    return;
  }

  visit(root, 'list', (list: List) => {
    const itemsWithLinks = list.children.filter(item =>
      findFirstGitHubLink(item),
    );
    if (itemsWithLinks.length < options.minLinks) {
      return;
    }

    const enrichedItems: EnrichedListItem[] = list.children.map(itemNode => {
      const url = findFirstGitHubLink(itemNode);
      const repoInfo = url ? (repoInfoMap.get(url) ?? null) : null;
      return { node: itemNode, repoInfo };
    });

    enrichedItems.sort((a, b) => {
      if (!a.repoInfo) {
        return 1;
      }
      if (!b.repoInfo) {
        return -1;
      }
      if (options.by === 'stars') {
        return b.repoInfo.stargazers_count - a.repoInfo.stargazers_count;
      }

      if (options.by === 'last_commit') {
        const dateA = a.repoInfo.pushed_at
          ? new Date(a.repoInfo.pushed_at).getTime()
          : 0;
        const dateB = b.repoInfo.pushed_at
          ? new Date(b.repoInfo.pushed_at).getTime()
          : 0;
        return dateB - dateA;
      }

      return 0;
    });

    list.children = enrichedItems.map(item => item.node);
  });
}
