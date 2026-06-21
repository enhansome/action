import * as core from '@actions/core';
import * as path from 'path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import { getRepoInfo, parseGitHubUrl, RepoInfoDetails } from './github.js';

import type { Heading, Link, List, ListItem, Parent, Root, Text } from 'mdast';

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
  last_updated: string;
  original_repository: null | string;
  source_repository: null | string;
  source_repository_description: null | string;
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
          const info = await getRepoInfo(details.owner, details.repo, token);
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
  originalRepository?: string,
  relativeLinkPrefix = '',
  sourceRepository?: string,
  sourceRepositoryDescription?: string,
): Promise<{ finalContent: string; isChanged: boolean; jsonData: JsonOutput }> {
  const contentAfterReplacements = applyTextReplacements(
    originalContent,
    replacements,
  );

  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.parse(contentAfterReplacements);

  // 1. Collect all unique GitHub links from the plain document.
  const githubUrls = collectGitHubLinks(tree);

  // 2. Fetch all required data in a single parallel batch.
  const repoInfoMap = await fetchAllRepoInfo(githubUrls, token);

  // This single call now handles tree traversal, sorting, and JSON generation.
  const { sections, title } = processTree(
    tree,
    repoInfoMap,
    sortOptions,
    sourceRepository,
  );

  const jsonData: JsonOutput = {
    items: sections,
    metadata: {
      last_updated: new Date().toISOString(),
      original_repository: (originalRepository?.trim() ?? '') || null,
      source_repository: (sourceRepository?.trim() ?? '') || null,
      source_repository_description:
        (sourceRepositoryDescription?.trim() ?? '') || null,
      title,
    },
  };

  // 3. Modify the AST by sorting lists and adding badges.
  sortLists(tree, repoInfoMap, sortOptions);
  addInfoBadges(tree, repoInfoMap);
  fixRelativeLinks(tree, relativeLinkPrefix);

  // 4. Convert the modified AST back to a string.
  const finalContent = serializeAst(tree, originalContent);

  return {
    finalContent,
    isChanged: finalContent.trim() !== originalContent.trim(),
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
    } else {
      core.debug('Applying default branding replacement for title.');
      const brandingRegex = new RegExp('^# (Awesome[\\s-].+)$', 'gm');
      processedContent = processedContent.replace(
        brandingRegex,
        '# $1 with stars',
      );
    }
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
  let text = '';
  visit(node, 'text', (textNode: Text) => {
    text += textNode.value;
  });
  return text.replace(/\s\s+/g, ' ').trim();
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
      const linkNode = paragraph.children.find(
        (c): c is Link => c.type === 'link',
      );
      title = linkNode ? getNodeText(linkNode) : getNodeText(paragraph);
      description = paragraph.children
        .filter((c): c is Text => c.type === 'text')
        .map(t => t.value)
        .join('')
        .replace(/^[\s\W]+/, '')
        .trim();
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

function formatRepoNameAsTitle(repoName: string): string {
  // Convert "awesome-nodejs" or "nodejs" to "Awesome Node.js"
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
 * Main orchestrator that walks the document to build sections based on headings.
 */
function processTree(
  tree: Root,
  repoInfoMap: Map<string, RepoInfoDetails>,
  sortOptions: SortOptions,
  sourceRepository?: string,
): { sections: JsonSection[]; title: string } {
  // Collect all H1 headings
  const h1Titles: string[] = [];
  visit(tree, 'heading', (node: Heading) => {
    if (node.depth === 1) {
      h1Titles.push(getNodeText(node));
    }
  });

  // Find first valid title (skip section headers like "Contributing", "License", etc.)
  let documentTitle = '';
  for (const title of h1Titles) {
    if (isValidTitle(title)) {
      documentTitle = title;
      break;
    }
  }

  // Fallback: extract from source repository name if available
  if (documentTitle === '' && sourceRepository) {
    const repoName = sourceRepository.split('/')[1];
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

  return { sections, title: documentTitle };
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
