import * as path from 'path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import {
  formatRequestError,
  getRepoInfo as fetchRepoInfo,
  makeOctokit,
  parseGitHubUrl,
  RepoIdentifier,
  RepoInfoDetails,
} from './github.js';
import type { GithubClient } from './github.js';
import { consoleLog, Logger } from './logger.js';

import type {
  Heading,
  Link,
  List,
  ListItem,
  Paragraph,
  Parent,
  Root,
  Text,
} from 'mdast';
import type { Node } from 'unist';

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

// Field names are the *output* names (stars / last_commit), renamed from the
// API fields (stargazers_count / pushed_at).
export interface RepoInfo {
  archived: boolean;
  id: number;
  language: null | string;
  last_commit: null | string;
  owner: string;
  repo: string;
  stars: number;
}

/** The sole crossing from the API shape to the emitted one, so both agree on the renames. */
export function toRepoInfo(details: RepoInfoDetails): RepoInfo {
  return {
    archived: details.archived,
    id: details.id,
    language: details.language,
    last_commit: details.pushed_at,
    owner: details.owner,
    repo: details.repo,
    stars: details.stargazers_count,
  };
}

// A genuine GitHub node: the item's OWN paragraph (or, for a link-heading,
// its heading) links to a GitHub repo that resolved. Always carries
// `repo_info` — a link that failed to resolve is not emitted (its children
// lift to the nearest live parent instead). May still wrap nested GitHub
// items/groups in `children`.
export interface JsonItem {
  children: JsonNode[];
  description: null | string;
  // Discriminator present on every node so any consumer (TS or not) can switch
  // cleanly between items and groups without inferring from `repo_info`.
  node_type: 'item';
  repo_info: RepoInfo;
  title: string;
}

// A grouping/category with NO GitHub identity of its own — a subheading
// container, a "see also" cluster, a list item wrapping linked resources whose
// own link is non-GitHub (e.g. SBCL linked via its website). Carries `children`
// but NEVER `repo_info`: that belongs to genuine GitHub nodes only. Containers
// whose subtree holds no items are not emitted.
export interface JsonGroup {
  children: JsonNode[];
  description: null | string;
  node_type: 'group';
  title: string;
}

export type JsonNode = JsonGroup | JsonItem;

// Top-level document metadata. `node_type` does not apply — `metadata` is a
// distinct top-level shape, not a member of the items/children union.
export interface JsonMetadata {
  enhanced_repository: null | string;
  enhanced_repository_description: null | string;
  last_updated: string;
  original_repository: string;
  // The source repo's numeric GitHub id — the identity consumers key nodes on.
  // Null only when the lookup failed (transport error); the name above stays
  // authoritative for display.
  original_repository_id: null | number;
  original_repository_sha: null | string;
  title: string;
}

export interface JsonSection {
  description: null | string;
  items: JsonNode[];
  title: string;
}

// The lookup's single throttled client coordinates rate limits across the whole
// pool, so this bounds in-flight targets rather than requests.
const FETCH_CONCURRENCY = 10;

/** Task rejections propagate, so a caller that must not abort the batch on a single failure wraps its own per-item try/catch. */
async function forEachConcurrent<T>(
  items: Iterable<T>,
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = Array.from(items);
  async function worker(): Promise<void> {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await task(item);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

interface RepoInfoLookup {
  client: GithubClient;
  getRepoInfo(ref: RepoIdentifier): Promise<RepoInfoDetails>;
}

// One throttled client + a per-repo memo for the run: aliased refs (a bare link
// and a deep `/tree/...` link into the same repo) collapse to a single fetch,
// the same way a case-variant spelling of one repo costs one round-trip.
function createRepoInfoLookup(token: string, log: Logger): RepoInfoLookup {
  const client = makeOctokit(token, { log });
  const cache = new Map<string, Promise<RepoInfoDetails>>();
  return {
    client,
    getRepoInfo(ref) {
      const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = fetchRepoInfo(client, ref.owner, ref.repo);
        cache.set(key, pending);
      }
      return pending;
    },
  };
}

/**
 * Fetches repo info for every GitHub link the tree addresses by URL, keyed by
 * URL so badge insertion can look each one up. Aliased URLs pointing at one repo
 * collapse to a single fetch inside the lookup, then fan back out to every alias
 * here.
 *
 * Each target's failure is independent and non-fatal: a dead link is skipped
 * with a warning and its item is still emitted (no repo_info). Only the source
 * README fetch in main.ts can fail the run.
 */
async function fetchTargetData(
  urls: Set<string>,
  repos: RepoInfoLookup,
): Promise<Map<string, RepoInfoDetails>> {
  const log = repos.client.log;
  const repoInfoMap = new Map<string, RepoInfoDetails>();

  const fetchStart = Date.now();
  await forEachConcurrent(urls, FETCH_CONCURRENCY, async url => {
    const details = parseGitHubUrl(url);
    if (!details) {
      return;
    }
    try {
      repoInfoMap.set(url, await repos.getRepoInfo(details));
    } catch (error) {
      log.warn(`Skipping repo info for ${url}: ${formatRequestError(error)}`);
    }
  });

  log.info(
    `Target fetch: ${repoInfoMap.size}/${urls.size} repo-info ok in ${Date.now() - fetchStart}ms (concurrency ${FETCH_CONCURRENCY}).`,
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
  originalRepositoryId?: number,
  now: Date = new Date(),
  log: Logger = consoleLog,
): Promise<{ finalContent: string; jsonData: JsonOutput }> {
  const repos = createRepoInfoLookup(token, log);
  const brandingEnabled = replacements.some(rule => rule.type === 'branding');
  const contentAfterReplacements = applyTextReplacements(
    originalContent,
    replacements.filter(rule => rule.type !== 'branding'),
    log,
  );

  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.parse(contentAfterReplacements);

  const githubUrls = collectGitHubLinks(tree);

  const repoInfoMap = await fetchTargetData(githubUrls, repos);

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

  const metadata: JsonMetadata = {
    last_updated: now.toISOString(),
    original_repository: originalRepository.trim(),
    original_repository_id: originalRepositoryId ?? null,
    original_repository_sha: (originalRepositorySha?.trim() ?? '') || null,
    enhanced_repository: (enhancedRepository?.trim() ?? '') || null,
    enhanced_repository_description:
      (enhancedRepositoryDescription?.trim() ?? '') || null,
    title,
  };

  const jsonData: JsonOutput = {
    items: sections,
    metadata,
  };

  addInfoBadges(tree, repoInfoMap);
  fixRelativeLinks(tree, relativeLinkPrefix);

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
  log: Logger,
): string {
  let processedContent = content;

  for (const rule of rules) {
    if (rule.type === 'literal') {
      log.debug(
        `Applying literal replacement: '${rule.find}' -> '${rule.replace}'`,
      );
      processedContent = processedContent.replaceAll(rule.find, rule.replace);
    } else if (rule.type === 'regex') {
      try {
        const regex = new RegExp(rule.find, 'gm');
        log.debug(
          `Applying regex replacement: /${rule.find}/gm -> '${rule.replace}'`,
        );
        processedContent = processedContent.replace(regex, rule.replace);
      } catch (e: unknown) {
        log.warn(
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

export function findFirstGitHubLink(node: Parent): string | undefined {
  let linkUrl: string | undefined;
  visit(node, 'link', (linkNode: Link) => {
    if (!linkUrl && parseGitHubUrl(linkNode.url)) {
      linkUrl = linkNode.url;
    }
  });
  return linkUrl;
}

// The GitHub link that represents a list item: the FIRST GitHub link in the
// item's OWN paragraph only. A nested-descendant link is deliberately ignored
// — it belongs to a child, not to this item. An item is a GitHub node iff its
// own paragraph links to a GitHub repo; an item with no own GitHub link but
// nested GitHub children is a group, not a node borrowing a child's identity.
//
// A GitHub link that is secondary within the paragraph (e.g.
// `[name](marketplace) … [On GitHub](github)`) is still the item's own link, so
// `findFirstGitHubLink` over the paragraph finds it correctly.
function findOwnGitHubLink(itemNode: ListItem): string | undefined {
  const paragraph = itemNode.children.find(
    (child): child is Paragraph => child.type === 'paragraph',
  );
  return paragraph ? findFirstGitHubLink(paragraph) : undefined;
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

// Concatenates text descendants, collapsing whitespace (incl. a lone soft-break
// newline) to one space. Takes a node slice so callers can isolate text
// before/after a specific child.
function getInlineText(nodes: Node[]): string {
  let text = '';
  for (const node of nodes) {
    visit(node, 'text', (textNode: Text) => {
      text += textNode.value;
    });
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Strip one leading separator (dash, pipe, colon, middot) from the prose
// trailing a link, but stay tightly scoped so a meaningful leading character
// (e.g. "(" in "(deprecated) …") survives.
function stripLeadingNoise(text: string): string {
  return text.replace(/^\s*[-–—·|:]\s*/, '').trim();
}

// Missing repo info sinks below nodes that have it; two missing tie so a stable
// sort keeps source order. The single comparator shared by the JSON builder and
// the AST sorter, so both outputs agree on order.
function compareByRepoInfo(
  by: SortOptions['by'],
  a: null | RepoInfoDetails,
  b: null | RepoInfoDetails,
): number {
  if (!by) {
    return 0;
  }
  // Must precede the field access below (a/b may be null).
  if (!a || !b) {
    return a ? -1 : b ? 1 : 0;
  }
  if (by === 'stars') {
    return b.stargazers_count - a.stargazers_count;
  }
  // `by` is narrowed to 'last_commit' here (the only remaining option).
  const timeA = a.pushed_at ? new Date(a.pushed_at).getTime() : 0;
  const timeB = b.pushed_at ? new Date(b.pushed_at).getTime() : 0;
  return timeB - timeA;
}

// The minLinks noise gate counts items whose SUBTREE contains a GitHub link,
// not items with an own-paragraph link only. A category with no own link but
// nested GitHub children still counts (it becomes a group); switching to
// `findOwnGitHubLink` would silently drop purely categorical sections, so it
// deliberately diverges from the identity resolver.
export function countLinkedItems(listNode: List): number {
  return listNode.children.filter(item => !!findFirstGitHubLink(item)).length;
}

function processListRecursively(
  listNode: List,
  repoInfoMap: Map<string, RepoInfoDetails>,
  sortOptions: SortOptions,
  isNested = false,
  // The caller's section-scope gate decision (sectionGatePasses). Absent for
  // nested lists (emitted under their parent regardless) and for top-level
  // lists with no open container (preamble), which gate per list.
  sectionGateOpen?: boolean,
): JsonNode[] {
  if (!isNested) {
    const gateOpen =
      sectionGateOpen ??
      countLinkedItems(listNode) >= sortOptions.minLinks;
    if (!gateOpen) {
      return [];
    }
  }

  // Zip each item with its emitted JSON nodes and repo info so one sort orders
  // both the rendered AST and the emitted JSON. `emitted` is empty for
  // non-GitHub leaves (no own link, no nested GitHub children): kept in the
  // AST, dropped from JSON.
  const entries: {
    emitted: JsonNode[];
    node: ListItem;
    repoInfo: null | RepoInfoDetails;
  }[] = [];

  for (const itemNode of listNode.children) {
    const githubUrl = findOwnGitHubLink(itemNode);
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
        // Title = leading text + the first link's text, so prefix tags like
        // "[UPDATED]" survive; description is the prose trailing the link.
        title = getInlineText(paragraph.children.slice(0, linkIndex + 1));
        description = stripLeadingNoise(
          getInlineText(paragraph.children.slice(linkIndex + 1)),
        );
      } else {
        // No link: the whole paragraph is the title, so leave description empty
        // (avoid echoing the title back).
        title = getInlineText(paragraph.children);
        description = '';
      }
    }

    // No-own-link items with children become groups — NEVER give them a
    // `repo_info`, that's the identity-borrowing bug. No-own-link, no-child
    // items are non-GitHub leaves: kept in markdown, dropped from JSON.
    // TODO(future): preserve non-GitHub leaves in a separate shape.
    let emitted: JsonNode[] = [];
    if (githubUrl && repoInfo) {
      emitted = [
        {
          node_type: 'item',
          title,
          description: description || null,
          children: childrenJson,
          repo_info: toRepoInfo(repoInfo),
        },
      ];
    } else if (githubUrl) {
      // Dead target: the item itself is not emitted; its children lift to this
      // list's level — the nearest live parent.
      emitted = childrenJson;
    } else if (childrenJson.length > 0) {
      emitted = [
        {
          node_type: 'group',
          title,
          description: description || null,
          children: childrenJson,
        },
      ];
    }

    entries.push({ emitted, node: itemNode, repoInfo });
  }

  if (sortOptions.by) {
    entries.sort((a, b) =>
      compareByRepoInfo(sortOptions.by, a.repoInfo, b.repoInfo),
    );
  }

  // Reorder the AST to match the sort so rendered markdown and JSON agree.
  listNode.children = entries.map(entry => entry.node);
  return entries.flatMap(entry => entry.emitted);
}

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

  if (/^awesome\s+/i.test(cleaned)) {
    return cleaned.replace(/^awesome\s+/i, 'Awesome ');
  }
  return `Awesome ${cleaned}`;
}

function isValidTitle(title: string): boolean {
  if (!title || title.trim() === '') {
    return false;
  }
  return !INVALID_TITLE_PATTERNS.some(pattern => pattern.test(title.trim()));
}

// Headings that mirror structure rather than delimit it. Unlike
// INVALID_TITLE_PATTERNS (a title-detection aid — "## Tools" is a perfectly
// good content section), a TOC heading never owns content: the worst offender
// is a `# Table of Contents` H1 that would otherwise wrap the whole document
// as its "section".
const TOC_TITLE_PATTERNS = [/^contents$/i, /^table of contents$/i];

// A heading that delimits content structure. Text-less headings (a bare `#`,
// an image-only heading) are spacers in real docs; TOC headings are structure
// mirrors. Neither participates in the section tree.
export function isStructuralHeading(node: Heading): boolean {
  const title = getNodeText(node);
  return (
    !!title && !TOC_TITLE_PATTERNS.some(pattern => pattern.test(title.trim()))
  );
}

/** Never duplicates "Awesome": if the title already contains it, append the suffix verbatim; otherwise prefix first. */
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

// Shared by title extraction and branding so both act on the very same heading.
function findTitleHeadingIndex(tree: Root): number {
  return tree.children.findIndex(
    (node): node is Heading =>
      node.type === 'heading' &&
      node.depth === 1 &&
      isValidTitle(getNodeText(node)),
  );
}

// The heading branding owns even when it isn't a *valid* title: a generic
// first H1 ("# Guides", "# Contents") is still the de-facto title slot —
// applyBrandingToTree replaces it — so the section tree must not treat it
// as a section wrapping the whole document.
export function findTitleSlotIndex(tree: Root): number {
  const titleHeadingIndex = findTitleHeadingIndex(tree);
  if (titleHeadingIndex !== -1) {
    return titleHeadingIndex;
  }
  return tree.children.findIndex(
    (node): node is Heading => node.type === 'heading' && node.depth === 1,
  );
}

/**
 * Makes the rendered H1 match metadata.title, replacing whichever heading
 * occupies the title slot (a valid title H1, else the first generic H1, else a
 * freshly injected one) so the branded title is always the sole title H1.
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

function processTree(
  tree: Root,
  repoInfoMap: Map<string, RepoInfoDetails>,
  sortOptions: SortOptions,
  originalRepository?: string,
): { sections: JsonSection[]; title: string; titleHeadingIndex: number } {
  // Remember the title H1's index so branding replaces the exact same node;
  // scope matches branding/section-building so they can't drift apart.
  const titleHeadingIndex = findTitleHeadingIndex(tree);
  let documentTitle =
    titleHeadingIndex === -1
      ? ''
      : getNodeText(tree.children[titleHeadingIndex] as Heading);

  const titleSlotIndex = findTitleSlotIndex(tree);

  // Derive a subject from the *source* repository name when no valid H1 is
  // present. Using the source — not the enhanced/mirror repo — keeps the org
  // name out of the title.
  if (documentTitle === '' && originalRepository) {
    const repoName = repoNameFromIdentifier(originalRepository);
    if (repoName) {
      documentTitle = formatRepoNameAsTitle(repoName);
    }
  }

  const sectionDepth = findSectionDepth(tree, titleSlotIndex);
  const gateForSection = sectionGatePasses(tree, titleSlotIndex, sortOptions);

  const sections: JsonSection[] = [];
  const stack: ContainerBuilder[] = [];

  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i];

    if (node.type === 'heading') {
      // The title-slot H1 belongs to branding/metadata; non-structural
      // headings (see isStructuralHeading) delimit nothing. Neither
      // participates in the section tree.
      if (i === titleSlotIndex || !isStructuralHeading(node)) {
        continue;
      }
      closeContainers(stack, node.depth, sections);
      openContainer(stack, node, i, sectionDepth, repoInfoMap);
    } else if (node.type === 'paragraph' || node.type === 'blockquote') {
      const text = getNodeText(node);
      const container = stack[stack.length - 1];
      // Avoid adding boilerplate "back to top" links to descriptions.
      if (container && text && !text.includes('back to top')) {
        container.description = container.description
          ? `${container.description}\n${text}`
          : text;
      }
    } else if (node.type === 'list') {
      // Every list inside the open container contributes items — a section is
      // not closed by its first list. The minLinks gate is decided per
      // section, against the whole section subtree (the stack bottom — always
      // a section by the openContainer invariant). With no open container
      // (preamble), the list is not part of any JSON section and gates per
      // list, but its AST is still sorted so the rendered markdown matches.
      const openSection = stack[0];
      const items = processListRecursively(
        node,
        repoInfoMap,
        sortOptions,
        false,
        openSection && gateForSection(openSection),
      );
      const container = stack[stack.length - 1];
      if (container) {
        container.children.push(...items);
      }
    }
  }

  closeContainers(stack, 0, sections);

  return { sections, title: documentTitle, titleHeadingIndex };
}

// One open heading while walking the document: the heading's depth, the JSON
// nodes collected beneath it, and the prose accumulated as its description.
// Finalized (and pruned, if empty) when a same-or-shallower heading closes it.
interface ContainerBuilder {
  children: JsonNode[];
  description: string;
  headingDepth: number;
  // The heading's index in the document — the section gate reads it to know
  // where the section's subtree starts.
  headingIndex: number;
  kind: 'group' | 'item' | 'section';
  repoInfo?: RepoInfoDetails;
  title: string;
}

// The heading depth that opens top-level sections: the shallowest structural
// heading in the document other than the title slot. H1s count — ~20% of
// mirror READMEs use `# Section` after the title H1, and hardcoding H2 would
// drop all their items. Non-structural headings are skipped here too (same
// rule as the walk). Infinity when there is no such heading (no sections).
function findSectionDepth(tree: Root, titleSlotIndex: number): number {
  let depth = Infinity;
  tree.children.forEach((node, i) => {
    if (
      node.type === 'heading' &&
      i !== titleSlotIndex &&
      isStructuralHeading(node) &&
      node.depth < depth
    ) {
      depth = node.depth;
    }
  });
  return depth;
}

// A heading whose only link is a live GitHub link represents a resource, not a
// container — the link-heading pattern (`#### [Repo](github…)`). Badge images
// wrapped in links or multiple links disqualify (more than one link means the
// heading is not "the" resource), as does a dead target.
function soleLiveHeadingLink(
  heading: Heading,
  repoInfoMap: Map<string, RepoInfoDetails>,
): null | RepoInfoDetails {
  const links = heading.children.filter(
    (child): child is Link => child.type === 'link',
  );
  if (links.length !== 1) {
    return null;
  }
  return repoInfoMap.get(links[0].url) ?? null;
}

function openContainer(
  stack: ContainerBuilder[],
  heading: Heading,
  headingIndex: number,
  sectionDepth: number,
  repoInfoMap: Map<string, RepoInfoDetails>,
): void {
  const title = getNodeText(heading);
  // Sections sit at the section level — and any heading met with an empty
  // stack is promoted: a deeper heading before the first section (orphan
  // subheading) still owns its subtree, and a link-heading at section level
  // becomes a section rather than a top-level item, which the contract has no
  // place for.
  if (stack.length === 0 || heading.depth === sectionDepth) {
    stack.push({
      children: [],
      description: '',
      headingDepth: heading.depth,
      headingIndex,
      kind: 'section',
      title,
    });
    return;
  }
  const repoInfo = soleLiveHeadingLink(heading, repoInfoMap);
  stack.push({
    children: [],
    description: '',
    headingDepth: heading.depth,
    headingIndex,
    kind: repoInfo ? 'item' : 'group',
    repoInfo: repoInfo ?? undefined,
    title,
  });
}

// The minLinks gate scoped to a SECTION: every top-level list in the section
// counts together — best-of-style documents put each entry in its own
// single-item list, which the per-list gate dropped one by one. The section's
// subtree runs from its heading to the first structural heading at or above
// its depth (the same heading that would close it in closeContainers); the
// gate fires only when the whole subtree holds fewer than minLinks
// link-bearing entries, so a genuinely sparse section ("## My Blog" with one
// link) is still noise-dropped.
function sectionGatePasses(
  tree: Root,
  titleSlotIndex: number,
  sortOptions: SortOptions,
): (section: ContainerBuilder) => boolean {
  const cache = new Map<number, boolean>();
  return section => {
    const cached = cache.get(section.headingIndex);
    if (cached !== undefined) {
      return cached;
    }
    let linkedEntries = 0;
    for (let j = section.headingIndex + 1; j < tree.children.length; j++) {
      const node = tree.children[j];
      if (node.type === 'heading') {
        if (
          j !== titleSlotIndex &&
          isStructuralHeading(node) &&
          node.depth <= section.headingDepth
        ) {
          break;
        }
        continue;
      }
      if (node.type === 'list') {
        linkedEntries += countLinkedItems(node);
      }
    }
    const passes = linkedEntries >= sortOptions.minLinks;
    cache.set(section.headingIndex, passes);
    return passes;
  };
}

// Finalize every container a heading of `depth` closes (same-or-shallower),
// bottom-up so each finalized node lands in its parent. Pruning falls out of
// the finalize rule: a section/group whose children array is empty (no items
// anywhere beneath — lists only return item-bearing nodes, and empty children
// were never appended) is dropped; an item always survives, it IS the content.
// The stack bottom is always a section (openContainer's promotion guarantees
// it), so a finalized group/item always has a parent to land in.
function closeContainers(
  stack: ContainerBuilder[],
  depth: number,
  sections: JsonSection[],
): void {
  while (
    stack.length > 0 &&
    stack[stack.length - 1].headingDepth >= depth
  ) {
    const container = stack.pop() as ContainerBuilder;
    if (container.children.length === 0 && container.kind !== 'item') {
      continue;
    }
    const description = container.description || null;
    if (container.kind === 'section') {
      sections.push({
        description,
        items: container.children,
        title: container.title,
      });
      continue;
    }
    const parent = stack[stack.length - 1];
    // Non-section containers always have an open parent (stack invariant), and
    // kind === 'item' exactly when repoInfo is set.
    if (container.repoInfo) {
      parent.children.push({
        children: container.children,
        description,
        node_type: 'item',
        repo_info: toRepoInfo(container.repoInfo),
        title: container.title,
      });
    } else {
      parent.children.push({
        children: container.children,
        description,
        node_type: 'group',
        title: container.title,
      });
    }
  }
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

function appendEnhansomedFooter(content: string, now: Date): string {
  const date = now.toISOString().split('T')[0];
  const footer = `***\n\n> _Enhansomed by [enhansome](https://github.com/enhansome) on ${date}._`;
  const body = content.replace(/\n+$/, '');
  return `${body}\n\n${footer}\n`;
}
