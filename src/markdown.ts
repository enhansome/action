import * as core from '@actions/core';
import * as path from 'path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import {
  formatRequestError,
  getReadme,
  getRepoInfo,
  GithubClient,
  makeOctokit,
  parseGitHubUrl,
  RepoInfoDetails,
} from './github.js';

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

// --- KIND ---

// A node's intrinsic kind: a `registry` is a directory that exists to enable
// discovery (an awesome-list); a `repository` is a terminal, consumable
// project. Every emitted node carries exactly one (PLAN.md §2/§5, D6).
export type Kind = 'registry' | 'repository';

// --- JSON OUTPUT STRUCTURE ---

// The README-side projection of a repo: the subset of `RepoInfoDetails` that
// the JSON output exposes. Field names are the *output* names (stars /
// last_commit), renamed from the API fields (stargazers_count / pushed_at).
export interface RepoInfo {
  archived: boolean;
  language: null | string;
  last_commit: null | string;
  owner: string;
  repo: string;
  stars: number;
}

// Shared base: every GitHub node has an intrinsic kind and a title. A section
// is a category heading, NOT a GitHub node, so `JsonSection` does not extend
// this and carries no kind (PLAN.md §5, D5).
interface JsonNode {
  kind: Kind;
  title: string;
}

interface JsonItem extends JsonNode {
  children: JsonItem[];
  description: null | string;
  repo_info?: RepoInfo;
}

interface JsonMetadata extends JsonNode {
  enhanced_repository: null | string;
  enhanced_repository_description: null | string;
  last_updated: string;
  original_repository: string;
  original_repository_sha: null | string;
}

interface JsonSection {
  description: null | string;
  items: JsonItem[];
  title: string;
}

export interface TargetData {
  kindsMap: Map<string, Kind>;
  repoInfoMap: Map<string, RepoInfoDetails>;
}

// Up to this many GitHub targets are processed in parallel. One shared
// throttled client (see `fetchTargetData`) coordinates rate limits across the
// whole pool rather than per request.
const FETCH_CONCURRENCY = 10;

/**
 * Runs `task` over every item with at most `limit` invocations in flight. Task
 * rejections propagate, so a caller that must not abort the batch on a single
 * failure (e.g. a dead link) wraps its own per-item try/catch.
 */
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

/**
 * Fetches everything the JSON builder needs about the document's GitHub targets
 * in one bounded-concurrency pass over a single shared throttled client:
 *
 *  - `repo_info` for every URL in `urls` — every github link is badged, so all
 *    of them need stars/language/etc.
 *  - `kind` only for URLs in `entryUrls` — the first github link of each list
 *    item, i.e. the targets that become typed JsonItems. A README (the heaviest
 *    call) is fetched only for these, never for prose/badge/secondary links.
 *
 * Both fetches are independently non-fatal per target (D7): a dead/inaccessible
 * link is skipped with a warning and the run continues — its item is still
 * emitted (without repo_info, kind defaulting to 'repository' downstream). Only
 * the source README fetch (main.ts) can fail the run.
 */
export async function fetchTargetData(
  urls: Set<string>,
  entryUrls: Set<string>,
  token: string,
  minEntries: number,
): Promise<TargetData> {
  const repoInfoMap = new Map<string, RepoInfoDetails>();
  const kindsMap = new Map<string, Kind>();

  // One shared client so the throttling plugin coordinates rate limits across
  // every request in the pool instead of per call.
  const octokit = makeOctokit(token);

  await forEachConcurrent(
    new Set([...urls, ...entryUrls]),
    FETCH_CONCURRENCY,
    async url => {
      const details = parseGitHubUrl(url);
      if (!details) {
        return;
      }
      if (urls.has(url)) {
        try {
          repoInfoMap.set(
            url,
            await getRepoInfo(octokit, details.owner, details.repo),
          );
        } catch (error) {
          core.warning(
            `Skipping repo info for ${url}: ${formatRequestError(error)}`,
          );
        }
      }
      if (entryUrls.has(url)) {
        try {
          const { kind } = await classifyKind(
            octokit,
            details.owner,
            details.repo,
            minEntries,
          );
          kindsMap.set(url, kind);
        } catch (error) {
          core.warning(
            `Skipping kind for ${url}: ${formatRequestError(error)}`,
          );
        }
      }
    },
  );

  core.debug(
    `Fetched repo info for ${repoInfoMap.size} targets and classified ${kindsMap.size} entries (concurrency ${FETCH_CONCURRENCY}).`,
  );
  return { kindsMap, repoInfoMap };
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

  // The source document is itself a node (D5). Classify it from the pristine
  // parse — the same oracle applied to each target — *before* processTree sorts
  // the tree in place, so the source's kind can never drift from how another
  // mirror would classify this very repo from its raw README.
  const sourceKind: Kind =
    countListEntries(tree) >= REGISTRY_MIN_ENTRIES ? 'registry' : 'repository';

  // 1. Collect GitHub links: every link is badged and needs repo info; the
  //    first link of each list item is a typed entry that also needs a kind.
  const githubUrls = collectGitHubLinks(tree);
  const entryUrls = collectEntryGitHubUrls(tree);

  // 2. Fetch repo info (all links) + classify each entry's kind (list items
  //    only) in one bounded-concurrency pass over a shared throttled client.
  //    Non-fatal per target: a dead link is skipped (warning), its item is
  //    still emitted (no repo_info, kind defaults to 'repository'), and the run
  //    succeeds. Only the source README fetch (main.ts) can fail the run.
  const { kindsMap, repoInfoMap } = await fetchTargetData(
    githubUrls,
    entryUrls,
    token,
    REGISTRY_MIN_ENTRIES,
  );

  // This single call now handles tree traversal, sorting, and JSON generation.
  // The title derives from the *source* repository (originalRepository), never
  // the enhanced/mirror repo — otherwise the org name doubles into the title.
  const {
    sections,
    title: rawTitle,
    titleHeadingIndex,
  } = processTree(tree, repoInfoMap, kindsMap, sortOptions, originalRepository);

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
      // The source document is itself a node (D5); classified above from the
      // pristine parse (the same oracle applied to its own README).
      kind: sourceKind,
      title,
    },
  };

  // 3. Add badges + fix relative links. List sorting already happened inside
  //    processTree, which is now the single sort authority for both the AST
  //    (rendered markdown) and the JSON items.
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
// Resolve the GitHub link that represents a list item: prefer a repo link in
// the item's own paragraph (the project's repo). When there isn't one — e.g. a
// "LeetCode" / "Spotify" category header whose links live in nested children —
// rank the category by its best (most-starred) nested repo instead of whichever
// child happened to be listed first. Max is order-independent, so unlike a
// "first link" lookup it cannot diverge between the JSON and markdown passes.
function findItemGitHubLink(
  itemNode: ListItem,
  repoInfoMap: Map<string, RepoInfoDetails>,
): string | undefined {
  const paragraph = itemNode.children.find(
    (child): child is Paragraph => child.type === 'paragraph',
  );
  const direct = paragraph ? findFirstGitHubLink(paragraph) : undefined;
  if (direct) {
    return direct;
  }

  let bestStars = -1;
  let bestUrl: string | undefined;
  visit(itemNode, 'link', (linkNode: Link) => {
    if (!parseGitHubUrl(linkNode.url)) {
      return;
    }
    const stars = repoInfoMap.get(linkNode.url)?.stargazers_count ?? -1;
    if (stars > bestStars) {
      bestStars = stars;
      bestUrl = linkNode.url;
    }
  });
  return bestUrl;
}

/**
 * Counts list items whose subtree contains at least one GitHub link — a link
 * whose URL `parseGitHubUrl` accepts. Read-only: it neither mutates nor sorts,
 * so it is safe to run on a tree before/after enhancement.
 *
 * This is the oracle's primitive (PLAN.md §4): a target README with at least
 * `REGISTRY_MIN_ENTRIES` such items classifies as a `registry`, otherwise a
 * `repository`. Every item is judged independently; an outer item that
 * contains a nested list is counted once for itself plus once per nested item
 * that has its own GitHub link.
 */
export function countListEntries(tree: Root): number {
  let count = 0;
  visit(tree, 'listItem', (item: ListItem) => {
    // An item counts once iff its subtree contains at least one GitHub link.
    // Reuses `findFirstGitHubLink` so the "is this a GitHub link?" semantics
    // stay identical to the rest of the parser.
    if (findFirstGitHubLink(item)) {
      count++;
    }
  });
  return count;
}

/**
 * The GitHub URL that identifies each list item — the first github link in the
 * item's subtree (`findFirstGitHubLink`) — for every list item that has one.
 * This is exactly the set of targets that become typed JsonItems and therefore
 * need a `kind`, so `fetchTargetData` fetches a README (the heaviest call) only
 * for these — not for prose, badge, or secondary links.
 */
function collectEntryGitHubUrls(tree: Root): Set<string> {
  const urls = new Set<string>();
  visit(tree, 'listItem', (item: ListItem) => {
    const url = findFirstGitHubLink(item);
    if (url) {
      urls.add(url);
    }
  });
  return urls;
}

// Minimum number of GitHub-linked list items a target README must parse to for
// the target to classify as a `registry` (PLAN.md §4/D2). Calibrated against
// real READMEs: concrete projects top out at ~17 (chalk), bulk awesome-lists
// start far higher, so 20 sits just above the project ceiling with margin.
// Pinned as a constant — not an action input — so the action's emitted kind is
// trustworthy standalone.
export const REGISTRY_MIN_ENTRIES = 20;

/**
 * Classifies a GitHub target as a `registry` or `repository` by reading its
 * README and counting GitHub-linked list items — the oracle (PLAN.md §4, D1).
 *
 * A target is a `registry` iff its README has at least `minEntries` such items,
 * otherwise a `repository`. README fetch failures propagate (strict mode, D7):
 * `getReadme` throws and this function does not swallow it.
 *
 * @returns The entry count alongside the kind so callers/tests can observe the
 *   raw signal; only `kind` is emitted in the JSON output (D10).
 */
export async function classifyKind(
  octokit: GithubClient,
  owner: string,
  repo: string,
  minEntries: number,
): Promise<{ entries: number; kind: Kind }> {
  const readme = await getReadme(octokit, owner, repo);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(readme);
  const entries = countListEntries(tree);
  return {
    entries,
    kind: entries >= minEntries ? 'registry' : 'repository',
  };
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

// Order two items by their repo info: higher stars / more-recent last commit
// first; items with no repo info sink to the bottom. The single comparator
// shared by the JSON builder and the AST sorter so both outputs agree on order.
function compareByRepoInfo(
  by: SortOptions['by'],
  a: null | RepoInfoDetails,
  b: null | RepoInfoDetails,
): number {
  if (!by) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  if (by === 'stars') {
    return b.stargazers_count - a.stargazers_count;
  }
  // `by` is narrowed to 'last_commit' here (the only remaining option).
  const timeA = a.pushed_at ? new Date(a.pushed_at).getTime() : 0;
  const timeB = b.pushed_at ? new Date(b.pushed_at).getTime() : 0;
  return timeB - timeA;
}

function processListRecursively(
  listNode: List,
  repoInfoMap: Map<string, RepoInfoDetails>,
  kindsMap: Map<string, Kind>,
  sortOptions: SortOptions,
  isNested = false,
): JsonItem[] {
  const itemsWithGitHubLinks = listNode.children.filter(
    item => !!findFirstGitHubLink(item),
  );
  if (!isNested && itemsWithGitHubLinks.length < sortOptions.minLinks) {
    return [];
  }

  // Zip each list item with its parsed JSON and resolved repo info so one sort
  // orders both the rendered AST and the emitted JSON identically. `json` is
  // null for non-GitHub entries (D9): they keep their AST slot so the enhanced
  // markdown still renders them, but are dropped from the JSON output.
  const entries: {
    json: JsonItem | null;
    node: ListItem;
    repoInfo: null | RepoInfoDetails;
  }[] = [];

  for (const itemNode of listNode.children) {
    const githubUrl = findItemGitHubLink(itemNode, repoInfoMap);
    const repoInfo = githubUrl ? (repoInfoMap.get(githubUrl) ?? null) : null;

    const nestedLists = itemNode.children.filter(
      (child): child is List => child.type === 'list',
    );
    const childrenJson = nestedLists.flatMap(nestedList =>
      processListRecursively(
        nestedList,
        repoInfoMap,
        kindsMap,
        sortOptions,
        true,
      ),
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

    // D9: only GitHub-linked entries enter the typed JSON graph — every emitted
    // JsonItem must be a GitHub node so it can carry a required kind (D6).
    // Non-GitHub entries (books/papers/courses) and link-less notes are kept in
    // the enhanced markdown (every item still drives `entries` for sorting/
    // badges below) but omitted from `jsonData`.
    // TODO(future): preserve non-GitHub entries in a separate shape (PLAN.md §11).
    let jsonData: JsonItem | null = null;
    if (githubUrl) {
      // A missing kind means the target README was unreadable (dead link) and
      // `fetchTargetData` skipped it. Default to 'repository' so the node still
      // carries a real kind; the webapp membership backstop recovers any
      // registry we mistyped (PLAN.md §5). Never let a dead link drop an item.
      const kind = kindsMap.get(githubUrl) ?? 'repository';
      jsonData = {
        children: childrenJson,
        description: description || null,
        kind,
        title,
      };
      if (repoInfo) {
        jsonData.repo_info = {
          archived: repoInfo.archived,
          language: repoInfo.language,
          last_commit: repoInfo.pushed_at,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          stars: repoInfo.stargazers_count,
        };
      }
    }

    entries.push({ json: jsonData, node: itemNode, repoInfo });
  }

  if (sortOptions.by) {
    entries.sort((a, b) =>
      compareByRepoInfo(sortOptions.by, a.repoInfo, b.repoInfo),
    );
  }

  // A single sort feeds both outputs — the AST (rendered markdown) and the JSON
  // items — so they can never drift out of order. Non-GitHub items keep their
  // AST slot (rendered markdown) but are dropped from the JSON (D9).
  listNode.children = entries.map(entry => entry.node);
  return entries
    .map(entry => entry.json)
    .filter((json): json is JsonItem => json !== null);
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
  kindsMap: Map<string, Kind>,
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
        const items = processListRecursively(
          node,
          repoInfoMap,
          kindsMap,
          sortOptions,
        );
        // Only add the section if the list was valid and produced items
        if (items.length > 0) {
          currentSection.items = items;
          sections.push(currentSection);
        }
        currentSection = null; // Reset after processing a list
      }
    } else if (node.type === 'list') {
      // No active section (a list before the first heading, or a second
      // consecutive list after the reset above). It isn't part of any JSON
      // section, but still sort its AST so the rendered markdown matches.
      processListRecursively(node, repoInfoMap, kindsMap, sortOptions);
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
