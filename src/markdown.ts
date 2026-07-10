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

// A node's intrinsic kind: a `registry` is a directory that exists to enable
// discovery (an awesome-list); a `repository` is a terminal, consumable
// project. Every genuine GitHub node carries exactly one.
export type Kind = 'registry' | 'repository';

// Field names are the *output* names (stars / last_commit), renamed from the
// API fields (stargazers_count / pushed_at).
export interface RepoInfo {
  archived: boolean;
  language: null | string;
  last_commit: null | string;
  owner: string;
  repo: string;
  stars: number;
}

// A genuine GitHub node: the item's OWN paragraph links to a GitHub repo, so it
// has an intrinsic kind, and when the link resolves, `repo_info`. It may
// still wrap nested GitHub items/groups in `children`.
export interface JsonItem {
  children: JsonNode[];
  description: null | string;
  kind: Kind;
  // Discriminator present on every node so any consumer (TS or not) can switch
  // cleanly without inferring from `kind`/`repo_info` presence (a dead-link
  // item has `kind` but no repo_info).
  node_type: 'item';
  repo_info?: RepoInfo;
  title: string;
}

// A grouping/category with NO GitHub identity of its own — an editor
// subheading, a "see also" cluster, a wrapper around linked resources whose own
// link is non-GitHub (e.g. SBCL linked via its website). Carries `children` but
// NEVER a `kind` or `repo_info`: those belong to genuine GitHub nodes only.
export interface JsonGroup {
  children: JsonNode[];
  description: null | string;
  node_type: 'group';
  title: string;
}

export type JsonNode = JsonGroup | JsonItem;

// The source document is itself a node: it always carries a kind, computed
// from its own README the same way each target is classified, independent
// of any item's identity. `node_type` does not apply — `metadata` is a distinct
// top-level shape, not a member of the items/children union.
interface JsonMetadata {
  enhanced_repository: null | string;
  enhanced_repository_description: null | string;
  kind: Kind;
  last_updated: string;
  original_repository: string;
  original_repository_sha: null | string;
  title: string;
}

interface JsonSection {
  description: null | string;
  items: JsonNode[];
  title: string;
}

export interface TargetData {
  kindsMap: Map<string, Kind>;
  repoInfoMap: Map<string, RepoInfoDetails>;
}

// One shared throttled client (see `fetchTargetData`) coordinates rate limits
// across the whole pool rather than per request.
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

/**
 * `urls` are badged (every GitHub link needs repo_info); `entryUrls` are the
 * first GitHub link of each list item — the only targets that become typed
 * JsonItems, so the only ones a `kind` (a README fetch) is fetched for.
 *
 * Each target's failure is independent and non-fatal: a dead link is skipped
 * with a warning and its item is still emitted (no repo_info, kind defaults to
 * 'repository'). Only the source README fetch in main.ts can fail the run.
 */
export async function fetchTargetData(
  urls: Set<string>,
  entryUrls: Set<string>,
  token: string,
  minEntries: number,
): Promise<TargetData> {
  const repoInfoMap = new Map<string, RepoInfoDetails>();
  const kindsMap = new Map<string, Kind>();

  const octokit = makeOctokit(token);

  // Per-canonical-repo memo: two distinct URLs that resolve to the same
  // owner/repo (e.g. a README link and a deep `/tree/...` link into it) must
  // share one `getRepoInfo` / `classifyKind` call. We store in-flight Promises
  // keyed by `owner/repo`; the lookup-and-set is synchronous, so a concurrent
  // worker hitting the same repo awaits the first worker's fetch instead of
  // racing a duplicate. Results are written under every alias URL below, so
  // consumers that look up by raw URL are unaffected.
  const repoInfoByRepo = new Map<string, Promise<RepoInfoDetails>>();
  const kindByRepo = new Map<string, Promise<{ kind: Kind }>>();

  function repoInfoFor(owner: string, repo: string): Promise<RepoInfoDetails> {
    const key = `${owner}/${repo}`;
    const existing = repoInfoByRepo.get(key);
    if (existing) {
      return existing;
    }
    const pending = getRepoInfo(octokit, owner, repo);
    repoInfoByRepo.set(key, pending);
    return pending;
  }

  function kindFor(owner: string, repo: string): Promise<{ kind: Kind }> {
    const key = `${owner}/${repo}`;
    const existing = kindByRepo.get(key);
    if (existing) {
      return existing;
    }
    const pending = classifyKind(octokit, owner, repo, minEntries);
    kindByRepo.set(key, pending);
    return pending;
  }

  // `entryUrls` is a subset of `urls` in practice, but the signature does not
  // enforce that, so the union keeps this correct for any caller.
  const fetchStart = Date.now();
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
          repoInfoMap.set(url, await repoInfoFor(details.owner, details.repo));
        } catch (error) {
          core.warning(
            `Skipping repo info for ${url}: ${formatRequestError(error)}`,
          );
        }
      }
      if (entryUrls.has(url)) {
        try {
          const { kind } = await kindFor(details.owner, details.repo);
          kindsMap.set(url, kind);
        } catch (error) {
          core.warning(
            `Skipping kind for ${url}: ${formatRequestError(error)}`,
          );
        }
      }
    },
  );

  // The success/total ratio makes dead-link volume visible, and elapsed exposes
  // the per-entry README-fetch cost that drives the deferred classification-manifest decision.
  core.info(
    `Target fetch: ${repoInfoMap.size}/${urls.size} repo-info ok, ${kindsMap.size}/${entryUrls.size} kinds ok in ${Date.now() - fetchStart}ms (concurrency ${FETCH_CONCURRENCY}).`,
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

  // Classify the source from the pristine parse — *before* processTree sorts
  // the tree in place — so the source's kind can never drift from how another
  // mirror would classify this very repo from its raw README.
  const sourceKind: Kind =
    countListEntries(tree) >= REGISTRY_MIN_ENTRIES ? 'registry' : 'repository';

  const githubUrls = collectGitHubLinks(tree);
  const entryUrls = collectEntryGitHubUrls(tree);

  const { kindsMap, repoInfoMap } = await fetchTargetData(
    githubUrls,
    entryUrls,
    token,
    REGISTRY_MIN_ENTRIES,
  );

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
      kind: sourceKind,
      title,
    },
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

// The GitHub link that represents a list item: the FIRST GitHub link in the
// item's OWN paragraph only. A nested-descendant link is deliberately ignored
// — it belongs to a child, not to this item. An item is a GitHub node iff its
// own paragraph links to a GitHub repo; an item with no own GitHub link but
// nested GitHub children is a kind-less group, not a node borrowing a child's
// identity.
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

/**
 * Read-only — neither mutates nor sorts, so safe to run before or after
 * enhancement. The classification primitive: a README with at least
 * `REGISTRY_MIN_ENTRIES` such items is a `registry`, otherwise a `repository`.
 * An item containing a nested list is counted once for itself plus once per
 * nested item that has its own GitHub link.
 */
export function countListEntries(tree: Root): number {
  let count = 0;
  visit(tree, 'listItem', (item: ListItem) => {
    // Reuses `findFirstGitHubLink` so "is this a GitHub link?" stays consistent
    // with the rest of the parser.
    if (findFirstGitHubLink(item)) {
      count++;
    }
  });
  return count;
}

/**
 * The set of targets that become typed JsonItems, so the only ones
 * `fetchTargetData` fetches a README for. Uses the same own-paragraph resolver
 * as `processListRecursively` so a kind is fetched iff the item is emitted
 * keyed by that exact URL.
 */
function collectEntryGitHubUrls(tree: Root): Set<string> {
  const urls = new Set<string>();
  visit(tree, 'listItem', (item: ListItem) => {
    const url = findOwnGitHubLink(item);
    if (url) {
      urls.add(url);
    }
  });
  return urls;
}

// Calibrated against real READMEs: concrete projects top out at ~17 (chalk),
// bulk awesome-lists start far higher, so 20 sits just above the project
// ceiling with margin. Hardcoded (not an action input) so the emitted kind is
// trustworthy standalone.
export const REGISTRY_MIN_ENTRIES = 20;

/**
 * README fetch failures propagate: `getReadme` throws and this does not swallow
 * it. Uses `countListEntries` — the same counter the source is classified with
 * — so a target is judged identically whether it is the source or a link.
 *
 * No regex pre-scan: parsing even the largest known registry README is cheap
 * (<220ms; the network fetch dominates), and a line-scan approximation can't
 * model raw HTML blocks, so it could mislabel a `repository` a `registry`
 * without consulting the AST. Returns only `kind`; the raw count is not emitted.
 */
export async function classifyKind(
  octokit: GithubClient,
  owner: string,
  repo: string,
  minEntries: number,
): Promise<{ kind: Kind }> {
  const readme = await getReadme(octokit, owner, repo);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(readme);
  return {
    kind: countListEntries(tree) >= minEntries ? 'registry' : 'repository',
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

function processListRecursively(
  listNode: List,
  repoInfoMap: Map<string, RepoInfoDetails>,
  kindsMap: Map<string, Kind>,
  sortOptions: SortOptions,
  isNested = false,
): JsonNode[] {
  // The section-sparsity gate counts items whose SUBTREE contains a GitHub
  // link, not items with an own-paragraph link only. A category with no own
  // link but nested GitHub children still counts (it becomes a group);
  // switching to `findOwnGitHubLink` would silently drop purely categorical
  // sections, so it deliberately diverges from the identity resolver below.
  const itemsWithGitHubLinks = listNode.children.filter(
    item => !!findFirstGitHubLink(item),
  );
  if (!isNested && itemsWithGitHubLinks.length < sortOptions.minLinks) {
    return [];
  }

  // Zip each item with its JSON node and repo info so one sort orders both the
  // rendered AST and the emitted JSON. `json` is null only for non-GitHub
  // leaves (no own link, no nested GitHub children): kept in the AST, dropped
  // from JSON.
  const entries: {
    json: JsonNode | null;
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

    // No-own-link items with children become kind-less groups — NEVER give them
    // a `kind`/`repo_info`, that's the identity-borrowing bug. No-own-link,
    // no-child items are non-GitHub leaves: kept in markdown, dropped from JSON.
    // TODO(future): preserve non-GitHub leaves in a separate shape.
    let jsonData: JsonNode | null = null;
    if (githubUrl) {
      // A missing kind means the README was unreadable (dead link) and was
      // skipped. Default to 'repository' so a dead link never drops an item; the
      // webapp membership backstop recovers any registry we misclassified.
      const kind = kindsMap.get(githubUrl) ?? 'repository';
      const item: JsonItem = {
        node_type: 'item',
        kind,
        title,
        description: description || null,
        children: childrenJson,
      };
      if (repoInfo) {
        item.repo_info = {
          archived: repoInfo.archived,
          language: repoInfo.language,
          last_commit: repoInfo.pushed_at,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          stars: repoInfo.stargazers_count,
        };
      }
      jsonData = item;
    } else if (childrenJson.length > 0) {
      jsonData = {
        node_type: 'group',
        title,
        description: description || null,
        children: childrenJson,
      };
    }

    entries.push({ json: jsonData, node: itemNode, repoInfo });
  }

  if (sortOptions.by) {
    entries.sort((a, b) =>
      compareByRepoInfo(sortOptions.by, a.repoInfo, b.repoInfo),
    );
  }

  // Reorder the AST to match the sort so rendered markdown and JSON agree.
  listNode.children = entries.map(entry => entry.node);
  return entries
    .map(entry => entry.json)
    .filter((json): json is JsonNode => json !== null);
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
  kindsMap: Map<string, Kind>,
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

  // Derive a subject from the *source* repository name when no valid H1 is
  // present. Using the source — not the enhanced/mirror repo — keeps the org
  // name out of the title.
  if (documentTitle === '' && originalRepository) {
    const repoName = repoNameFromIdentifier(originalRepository);
    if (repoName) {
      documentTitle = formatRepoNameAsTitle(repoName);
    }
  }

  const sections: JsonSection[] = [];
  let currentSection: JsonSection | null = null;

  for (const node of tree.children) {
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
        const items = processListRecursively(
          node,
          repoInfoMap,
          kindsMap,
          sortOptions,
        );
        if (items.length > 0) {
          currentSection.items = items;
          sections.push(currentSection);
        }
        currentSection = null;
      }
    } else if (node.type === 'list') {
      // No active section: not part of any JSON section, but still sort its AST
      // so the rendered markdown matches.
      processListRecursively(node, repoInfoMap, kindsMap, sortOptions);
    }
  }

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

function appendEnhansomedFooter(content: string, now: Date): string {
  const date = now.toISOString().split('T')[0];
  const footer = `***\n\n> _Enhansomed by [enhansome](https://github.com/enhansome) on ${date}._`;
  const body = content.replace(/\n+$/, '');
  return `${body}\n\n${footer}\n`;
}
