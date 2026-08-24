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
  Blockquote,
  Heading,
  Html,
  Link,
  List,
  ListItem,
  Paragraph,
  Parent,
  Root,
  Table,
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

// The first link in a subtree that points at a GitHub repo. Returns the link
// node itself so callers can take both its URL (identity) and its text
// (title fallbacks).
export function findFirstGitHubLink(node: Parent): Link | undefined {
  let linkNode: Link | undefined;
  visit(node, 'link', (candidate: Link) => {
    if (!linkNode && parseGitHubUrl(candidate.url)) {
      linkNode = candidate;
    }
  });
  return linkNode;
}

// The GitHub link that represents a list item: the FIRST GitHub link in the
// item's OWN paragraphs, in document order. Paper-list entries carry their
// identity link ([[Code]](github)) in a paragraph after the title one, so
// every own paragraph is scanned — the title still comes from the first
// paragraph alone. A nested-descendant link is deliberately ignored — it
// belongs to a child, not to this item. An item is a GitHub node iff its own
// paragraphs link to a GitHub repo; an item with no own GitHub link but
// nested GitHub children is a group, not a node borrowing a child's identity.
//
// A GitHub link that is secondary within a paragraph (e.g.
// `[name](marketplace) … [On GitHub](github)`) is still the item's own link, so
// `findFirstGitHubLink` over the paragraph finds it correctly.
function findOwnGitHubLink(itemNode: ListItem): Link | undefined {
  for (const child of itemNode.children) {
    if (child.type !== 'paragraph') {
      continue;
    }
    const link = findFirstGitHubLink(child);
    if (link) {
      return link;
    }
  }
  return undefined;
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

// The table counterpart of countLinkedItems for the section gate: rows whose
// subtree contains a GitHub link. No header-row skip — a card grid's first row
// sits above the delimiter and is content, while pure-label header rows carry
// no links and count zero either way.
function countLinkedRows(tableNode: Table): number {
  return tableNode.children.filter(
    row => row.type === 'tableRow' && !!findFirstGitHubLink(row),
  ).length;
}

interface EntryText {
  title: string;
  description: string;
}

// One entry's title and description, split from its own inlines: leading text
// up to and including the first link is the title (prefix tags like
// "[UPDATED]" survive), the prose trailing it the description. The link is
// found through emphasis wrappers — a bolded card link
// (`**[Name](repo)** - description`) splits like a plain one. With no link
// the whole text is the title — the description must never echo the title
// back.
function splitEntryText(inlines: Node[]): EntryText {
  const linkIndex = inlines.findIndex(child => {
    let hasLink = false;
    visit(child, 'link', () => {
      hasLink = true;
    });
    return hasLink;
  });
  if (linkIndex === -1) {
    return { title: getInlineText(inlines), description: '' };
  }
  return {
    title: getInlineText(inlines.slice(0, linkIndex + 1)),
    description: stripLeadingNoise(getInlineText(inlines.slice(linkIndex + 1))),
  };
}

// The emission decision every entry source shares — list items, table rows,
// and the paragraph/blockquote sources to come: an own GitHub link that
// resolved makes an item; a dead own link drops the entry and lifts its
// children to the nearest live parent; no own link with children makes a
// group — never a `repo_info`, that's the identity-borrowing bug; no own link
// and no children is a non-GitHub leaf, kept in markdown, dropped from JSON.
// TODO(future): preserve non-GitHub leaves in a separate shape.
function emitEntryNodes(
  githubUrl: string | undefined,
  repoInfo: null | RepoInfoDetails,
  text: EntryText,
  childrenJson: JsonNode[],
): JsonNode[] {
  if (githubUrl && repoInfo) {
    return [
      {
        node_type: 'item',
        title: text.title,
        description: text.description || null,
        children: childrenJson,
        repo_info: toRepoInfo(repoInfo),
      },
    ];
  }
  if (githubUrl) {
    return childrenJson;
  }
  if (childrenJson.length > 0) {
    return [
      {
        node_type: 'group',
        title: text.title,
        description: text.description || null,
        children: childrenJson,
      },
    ];
  }
  return [];
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
    const ownLink = findOwnGitHubLink(itemNode);
    const githubUrl = ownLink?.url;
    const repoInfo = githubUrl ? (repoInfoMap.get(githubUrl) ?? null) : null;

    // Nested content is the item's children: deeper lists as before, plus
    // tables — the AnimeResearch shape wraps a <details><summary> block and
    // its table inside one list item. Both emit under the parent item
    // regardless of the gate: the top-level call already gated the section.
    const nestedContent = itemNode.children.filter(
      (child): child is List | Table =>
        child.type === 'list' || child.type === 'table',
    );
    const childrenJson = nestedContent.flatMap(child =>
      child.type === 'list'
        ? processListRecursively(child, repoInfoMap, sortOptions, true)
        : processTableRows(child, repoInfoMap, true),
    );

    // Title/description split on the FIRST paragraph only — a paper-list
    // entry's identity link may live in a later paragraph (findOwnGitHubLink)
    // while its title text stays the leading one.
    const paragraph = itemNode.children.find(
      (child): child is Paragraph => child.type === 'paragraph',
    );
    const entryText = splitEntryText(paragraph?.children ?? []);
    // A details-wrapped item carries its visible text in the summary, not in
    // a paragraph — that text is the group's title.
    if (!entryText.title) {
      entryText.title = listItemSummaryTitle(itemNode);
    }
    // The shared title fallbacks (an inline-code link label carries no text
    // nodes, so the split alone can leave an empty title).
    entryText.title = entryTitle(entryText.title, ownLink, repoInfo);
    const emitted = emitEntryNodes(
      githubUrl,
      repoInfo,
      entryText,
      childrenJson,
    );

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

// Title with the fallbacks every entry source shares when the split yields no
// text (e.g. an image-only card link): the own link's text, then the repo
// name.
function entryTitle(
  base: string,
  ownLink: Link | undefined,
  repoInfo: null | RepoInfoDetails,
): string {
  return (
    base ||
    (ownLink ? getInlineText(ownLink.children) : '') ||
    repoInfo?.repo ||
    ''
  );
}

// Table rows are entries under the nearest open container. The common shape —
// scala's `[name](repo) | description`, spec tables with the link in a later
// column — holds ONE repo per row: the title is the first cell's text (the
// own link's text, then the repo name, when the first cell is empty), the
// description the remaining cells' text (badge images carry no text nodes, so
// they never pollute it). Card grids pin several repos per row, each cell its
// own card, so those emit one entry per link-bearing cell. A linked row above
// the delimiter is content like any other (grid tables have no label header;
// pure-label header rows carry no links and emit nothing). Rows stay in source
// order — unlike the unranked lists the product sorts, a table's row order is
// part of its meaning.
function processTableRows(
  tableNode: Table,
  repoInfoMap: Map<string, RepoInfoDetails>,
  gateOpen: boolean,
): JsonNode[] {
  if (!gateOpen) {
    return [];
  }
  const items: JsonNode[] = [];
  for (const row of tableNode.children) {
    if (row.type !== 'tableRow') {
      continue;
    }
    const cellLinks = row.children.map(cell => findFirstGitHubLink(cell));
    const distinctUrls = new Set(
      cellLinks.flatMap(link => (link ? [link.url] : [])),
    );
    if (distinctUrls.size === 0) {
      continue;
    }
    if (distinctUrls.size === 1) {
      const ownLink = cellLinks.find((link): link is Link => !!link);
      if (!ownLink) {
        continue;
      }
      const repoInfo = repoInfoMap.get(ownLink.url) ?? null;
      const firstCellText = splitEntryText(row.children[0]?.children ?? []);
      const restCellsText = row.children
        .slice(1)
        .map(cell => getNodeText(cell))
        .filter(Boolean);
      items.push(
        ...emitEntryNodes(ownLink.url, repoInfo, {
          title: entryTitle(firstCellText.title, ownLink, repoInfo),
          description: [firstCellText.description, ...restCellsText]
            .join(' ')
            .trim(),
        }, []),
      );
      continue;
    }
    const emittedUrls = new Set<string>();
    for (const [cellIndex, ownLink] of cellLinks.entries()) {
      if (!ownLink || emittedUrls.has(ownLink.url)) {
        continue;
      }
      emittedUrls.add(ownLink.url);
      const repoInfo = repoInfoMap.get(ownLink.url) ?? null;
      const cellText = splitEntryText(row.children[cellIndex].children);
      items.push(
        ...emitEntryNodes(ownLink.url, repoInfo, {
          title: entryTitle(cellText.title, ownLink, repoInfo),
          description: cellText.description,
        }, []),
      );
    }
  }
  return items;
}

// A top-level paragraph can BE an entry, not only feed container prose. Two
// corpus families qualify (progress/empty-tree-parses.md, step 4): a GitHub
// link LEADING the paragraph behind a short entry label, or the paragraph
// ending in a tag cluster whose GitHub link carries the identity — the
// paper-list shape whose first link points at the paper and a [Code]/[Github]
// tag at the end, name/author lines ending in that tag, and dated lines
// ("… [Github] 4 Feb 2023"). Prose that mentions a repo ("Please see
// CONTRIBUTING", "See also [repo]", intro text ending in a bare repo URL) is
// neither and stays description. Calibrated on the 2,293-README corpus plus
// the fixture fleet, not intuition: an entry label is a TAG (empty, CJK/emoji,
// bracketed, or colon-terminated) — never bare English prose — and the
// identity link must carry text, so the ubiquitous image-only awesome badge
// is not an entry.
const ENTRY_LABEL_MAX = 15;
const ENTRY_TRAILING_MAX = 3;
const TAG_LINK_TEXT =
  /^[\[\]()*\s:_-]*(?:source\s+code|code|github|repo|source|src|project|paper|page|web|site|home|official|notebook|demo|data|docs|implementation|arxiv)\b[\[\]()*\s:_-]*$/i;
const URL_LINK_TEXT = /^https?:\/\/\S+$/i;
// Dated entry lines end their tag cluster with a publication date ("4 Feb
// 2023", "19 Apr 2022", "2023") — a real corpus family (dated paper/tutorial
// lists), not a sentence continuation.
const DATE_TRAILING = /^(\d{1,2}[ -])?([a-zà-ÿ]{3,12}[ -])?\d{2,4}$/i;
// Boilerplate navigation line present in most mirror READMEs; casing and
// the optional "the" vary ("⬆ back to top", "⬆️ Back to Top",
// "Back to the Top").
const BACK_TO_TOP = /back to (?:the )?top/i;
// Tag-shaped leading label: empty, non-ASCII (CJK labels like 项目地址：,
// emoji markers), bracketed ([6] Diffusion:), or colon-terminated (Demo:).
// English prose ("Please see", "See also", "Inspired by the") is none of
// these — those are cross-reference sentences, not entry labels.
function isEntryLabel(label: string): boolean {
  return (
    label === '' ||
    /[^\x00-\x7f]/.test(label) ||
    label.startsWith('[') ||
    /[:：]$/.test(label)
  );
}

interface InlineScan {
  firstLink: Link | undefined;
  label: string;
  trailing: string;
}

// Flattened view of a paragraph's (or heading's) inline content for the entry
// test: the first link, the free text before it, and the free text after the
// link cluster (emphasis recursed into; link labels, images, and inline html
// carry no positional weight — a bare [Code] tag's label is not trailing
// prose).
function scanInlines(paragraph: Heading | Paragraph): InlineScan {
  let firstLink: Link | undefined;
  let label = '';
  let trailing = '';
  const walk = (node: Node): void => {
    if (node.type === 'link') {
      if (firstLink) {
        trailing = '';
      }
      firstLink = firstLink ?? (node as Link);
      return;
    }
    if (node.type === 'text') {
      if (firstLink) {
        trailing += (node as Text).value;
      } else {
        label += (node as Text).value;
      }
      return;
    }
    for (const child of (node as Parent).children ?? []) {
      walk(child);
    }
  };
  for (const child of paragraph.children) {
    walk(child);
  }
  return { firstLink, label: label.trim(), trailing: trailing.trim() };
}

// True when nothing of substance follows the paragraph's last link: pure
// punctuation, or a date (see DATE_TRAILING).
function tagClusterEndsParagraph(trailing: string): boolean {
  if (trailing.length <= ENTRY_TRAILING_MAX) {
    return true;
  }
  return DATE_TRAILING.test(trailing.replace(/^[\[\]()*\s:;,_-]+/, ''));
}

// The GitHub link that makes a top-level paragraph — or a heading inside a
// blockquote — an entry, if it is one (see the family comment above). Null
// for plain prose.
function paragraphEntryLink(paragraph: Heading | Paragraph): Link | undefined {
  const githubLink = findFirstGitHubLink(paragraph);
  if (!githubLink) {
    return undefined;
  }
  const labelText = getInlineText(githubLink.children);
  if (!labelText) {
    return undefined;
  }
  const scan = scanInlines(paragraph);
  if (
    scan.firstLink === githubLink &&
    scan.label.length <= ENTRY_LABEL_MAX &&
    isEntryLabel(scan.label)
  ) {
    return githubLink;
  }
  if (
    tagClusterEndsParagraph(scan.trailing) &&
    (TAG_LINK_TEXT.test(labelText) ||
      (URL_LINK_TEXT.test(labelText) && scan.firstLink !== githubLink))
  ) {
    return githubLink;
  }
  return undefined;
}

// A blockquote card is the blockquote face of an entry — java's generated
// card layout (`> **[Name](repo)** <kbd>★ 3.1k</kbd> …<br>One-line
// description.`), Spain's `> Lista dedicada: **[list](repo)**`, and
// person-re-identification's conference blocks: ONE quote holding many
// `######` paper headings, each an entry line. The same entry test runs on
// the card's first paragraph and on every heading child, so a quote
// mentioning a repo mid-prose stays description exactly as the paragraph
// face does.
interface EntryFace {
  inlines: Node[];
  link: Link;
}

function blockquoteEntries(blockquote: Blockquote): EntryFace[] {
  const faces: EntryFace[] = [];
  let sawParagraph = false;
  for (const child of blockquote.children) {
    if (child.type === 'paragraph') {
      if (sawParagraph) {
        continue;
      }
      sawParagraph = true;
      const link = paragraphEntryLink(child);
      if (link) {
        faces.push({ inlines: child.children, link });
      }
    } else if (child.type === 'heading') {
      const link = paragraphEntryLink(child);
      if (link) {
        faces.push({ inlines: child.children, link });
      }
    }
  }
  return faces;
}

// The shared entry emission for the non-list sources (paragraph entries,
// blockquote cards): resolve, split, title-fallback — the same decisions the
// list and table paths make through the same helpers.
function entryNodesFor(
  ownLink: Link,
  inlines: Node[],
  repoInfoMap: Map<string, RepoInfoDetails>,
): JsonNode[] {
  const repoInfo = repoInfoMap.get(ownLink.url) ?? null;
  const entryText = splitEntryText(inlines);
  return emitEntryNodes(ownLink.url, repoInfo, {
    title: entryTitle(entryText.title, ownLink, repoInfo),
    description: entryText.description,
  }, []);
}

// The <details><summary>…</summary> collapsible-section idiom: the summary
// text delimits structure like a heading would (java's generated README,
// paper-list tables behind "1.1 <topic>" summaries). kbd chips inside the
// summary ("5 projects") are metadata, not the title. A details block with
// no summary, or an empty one, delimits nothing.
const DETAILS_SUMMARY =
  /<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>/i;
const DETAILS_CLOSE = /^\s*<\/details>/i;

function detailsSummaryTitle(htmlValue: string): null | string {
  const match = DETAILS_SUMMARY.exec(htmlValue);
  if (!match) {
    return null;
  }
  const title = match[1]
    .replace(/<kbd>[\s\S]*?<\/kbd>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return title || null;
}

// The summary text of a <details><summary> block inside a list item, when the
// item has no paragraph text of its own.
function listItemSummaryTitle(itemNode: ListItem): string {
  for (const child of itemNode.children) {
    if (child.type === 'html') {
      const title = detailsSummaryTitle((child as Html).value);
      if (title) {
        return title;
      }
    }
  }
  return '';
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
  const gateForSection = sectionGatePasses(
    tree,
    titleSlotIndex,
    sectionDepth,
    repoInfoMap,
    sortOptions,
  );

  // Sections finalize out of document order when a details-section closes
  // inside its parent section's span, so each carries the document index it
  // opened at for the document-order sort at the end.
  const sectionRecords: SectionRecord[] = [];
  const stack: ContainerBuilder[] = [];

  // Entry emission shared by the paragraph and blockquote-card faces: the
  // implicit section opens for a containerless entry (the stack-bottom
  // invariant), the minLinks gate is the section aggregate, and a gated or
  // dead entry emits nothing and stays out of the description (mirrors dead
  // list items).
  const emitStandaloneEntry = (
    ownLink: Link,
    inlines: Node[],
    atIndex: number,
  ): void => {
    if (stack.length === 0) {
      openImplicitSection(stack, atIndex);
    }
    if (gateForSection(stack[0])) {
      stack[stack.length - 1].children.push(
        ...entryNodesFor(ownLink, inlines, repoInfoMap),
      );
    }
  };

  // A standalone entry restating the repo of an open item container (crypto's
  // generated cards repeat the repo URL in a line under the link-heading) is
  // that item's description, not a second item for the same repo. The
  // repoInfoMap resolves both URLs through one per-repo memo, so identity
  // comparison holds even for aliased spellings.
  const rementionsOpenItem = (link: Link): boolean => {
    const repoInfo = repoInfoMap.get(link.url);
    return !!repoInfo && stack.some(container => container.repoInfo === repoInfo);
  };

  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i];

    if (node.type === 'heading') {
      // The title-slot H1 belongs to branding/metadata; non-structural
      // headings (see isStructuralHeading) delimit nothing. Neither
      // participates in the section tree.
      if (i === titleSlotIndex || !isStructuralHeading(node)) {
        continue;
      }
      const headingEntry = entryHeadingInfo(node, repoInfoMap);
      // The promotion flavor of the entry test: a textless identity link is
      // a title-line badge, not an entry (see entryHeadingInfo).
      const promotedEntry =
        headingEntry && getInlineText(headingEntry.link.children)
          ? headingEntry
          : null;
      closeContainers(stack, node.depth, sectionRecords, !!promotedEntry);
      openContainer(stack, node, i, sectionDepth, promotedEntry, headingEntry);
    } else if (node.type === 'paragraph') {
      const text = getNodeText(node);
      // Boilerplate "back to top" lines are neither entries nor description.
      const ownLink =
        BACK_TO_TOP.test(text) ? undefined : paragraphEntryLink(node);
      // An entry paragraph behaves like a one-item list; a failed gate, a
      // dead target, or a re-mention of the enclosing item leaves plain
      // description.
      if (ownLink && !rementionsOpenItem(ownLink)) {
        emitStandaloneEntry(ownLink, node.children, i);
      } else {
        const container = stack[stack.length - 1];
        // Avoid adding boilerplate "back to top" links to descriptions.
        if (container && text && !BACK_TO_TOP.test(text)) {
          container.description = container.description
            ? `${container.description}\n${text}`
            : text;
        }
      }
    } else if (node.type === 'blockquote') {
      const text = getNodeText(node);
      // A card blockquote is the blockquote face of entries — one per
      // qualifying paragraph/heading child; any other quote is container
      // prose.
      const faces = BACK_TO_TOP.test(text)
        ? []
        : blockquoteEntries(node).filter(face => !rementionsOpenItem(face.link));
      if (faces.length > 0) {
        for (const face of faces) {
          emitStandaloneEntry(face.link, face.inlines, i);
        }
      } else {
        const container = stack[stack.length - 1];
        // Avoid adding boilerplate "back to top" links to descriptions.
        if (container && text && !BACK_TO_TOP.test(text)) {
          container.description = container.description
            ? `${container.description}\n${text}`
            : text;
        }
      }
    } else if (node.type === 'html') {
      // A details-summary block opens a section like a heading would; the
      // close tag (or the next summary) ends it — never the enclosing
      // section, which keeps collecting after the collapsible block.
      const summaryTitle = detailsSummaryTitle(node.value);
      if (summaryTitle) {
        closeInnermostDetails(stack, sectionRecords);
        // Container depths never decrease going up the stack. When the open
        // containers sit deeper than sectionDepth (a mid-document H1 defines
        // sectionDepth while the content sections run deeper), the
        // details-section joins at the current depth — pushing at the
        // shallower sectionDepth would invert the stack and strand the gate
        // (which reads the stack bottom) on a tiny outer section.
        const joinDepth =
          stack.length === 0
            ? sectionDepth
            : Math.max(sectionDepth, stack[stack.length - 1].headingDepth);
        stack.push({
          children: [],
          description: '',
          headingDepth: joinDepth,
          headingIndex: i,
          kind: 'section',
          openedByDetails: true,
          title: summaryTitle,
        });
      } else if (DETAILS_CLOSE.test(node.value)) {
        closeInnermostDetails(stack, sectionRecords);
      }
    } else if (node.type === 'list') {
      // A list with no open container still means content: synthesize the
      // implicit section for it (see openImplicitSection). Afterwards the
      // stack bottom is always a section — implicit or real — which is the
      // invariant the gate below and closeContainers rely on.
      if (stack.length === 0) {
        openImplicitSection(stack, i);
      }
      // Every list inside the open container contributes items — a section is
      // not closed by its first list — and the minLinks gate is decided per
      // section, against the whole section subtree.
      const items = processListRecursively(
        node,
        repoInfoMap,
        sortOptions,
        false,
        gateForSection(stack[0]),
      );
      stack[stack.length - 1].children.push(...items);
    } else if (node.type === 'table') {
      // Tables hold entries the same way lists do — the implicit section opens
      // for one with no open container (the stack-bottom invariant), and the
      // minLinks gate is the same section aggregate.
      if (stack.length === 0) {
        openImplicitSection(stack, i);
      }
      const items = processTableRows(
        node,
        repoInfoMap,
        gateForSection(stack[0]),
      );
      stack[stack.length - 1].children.push(...items);
    }
  }

  closeContainers(stack, 0, sectionRecords);

  const sections = sectionRecords
    .sort((a, b) => a.headingIndex - b.headingIndex)
    .map(record => record.section);

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
  // True when this section was opened to wrap a run of promoted entry
  // headings (openSynthesizedSection) rather than by a heading of its own.
  openedBySynthesis?: boolean;
  // True when this section was opened by a <details><summary> block rather
  // than a heading — its closing </details> ends it.
  openedByDetails?: boolean;
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

// A heading whose first GitHub link (found through emphasis wrappers)
// resolved is an ENTRY heading: the link-heading pattern of generated indexes
// (`### [repo](github)`, crypto's layout), go-recipes'
// `### [⏫](#contents) … with [tool](github)`, hand-pose-estimation's
// `[PDF](paper) [Code](github)` paper lines, and llm-services'
// `**[Name](github)**` cards. Navigation anchors and paper links are skipped
// by the GitHub filter. The identity is the first GitHub link —
// paragraph-entry semantics — never a group borrowing a child's identity.
// Callers that promote the heading to an ENTRY ITEM (openContainer's
// promotion branch) additionally require the identity link to carry text: a
// generated index always labels its repo, so a textless identity there is a
// title-line badge (streaming's `## Title [![Awesome](badge)](repo)`). A
// DEEPER heading's only link may legitimately be textless — mac's
// `### Markdown Tools [![…](icon)](repo)`, machine-learning-cn's
// `### [](repo#anchor)类别` — so the deeper container branch keeps the
// sole-link reading.
interface EntryHeading {
  link: Link;
  repoInfo: RepoInfoDetails;
}

function entryHeadingInfo(
  heading: Heading,
  repoInfoMap: Map<string, RepoInfoDetails>,
): EntryHeading | null {
  const link = findFirstGitHubLink(heading);
  if (!link) {
    return null;
  }
  const repoInfo = repoInfoMap.get(link.url);
  return repoInfo ? { link, repoInfo } : null;
}

function openContainer(
  stack: ContainerBuilder[],
  heading: Heading,
  headingIndex: number,
  sectionDepth: number,
  promotedEntry: EntryHeading | null,
  headingEntry: EntryHeading | null,
): void {
  const title = getNodeText(heading);
  // Sections sit at the section level — and any heading met with an empty
  // stack is promoted: a deeper heading before the first section (orphan
  // subheading) still owns its subtree. A promoted ENTRY heading (see
  // entryHeadingInfo) is an item, not a section: the JSON contract has no
  // top-level items, so a synthesized section wraps the whole run of them.
  if (stack.length === 0 || heading.depth === sectionDepth) {
    if (promotedEntry) {
      if (stack.length === 0) {
        openSynthesizedSection(stack, headingIndex, sectionDepth);
      }
      stack.push({
        children: [],
        description: '',
        headingDepth: heading.depth,
        headingIndex,
        kind: 'item',
        repoInfo: promotedEntry.repoInfo,
        title,
      });
      return;
    }
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
  // A deeper entry heading opens an item container the same way a promoted
  // one does — children and prose below it collect as its content.
  stack.push({
    children: [],
    description: '',
    headingDepth: heading.depth,
    headingIndex,
    kind: headingEntry ? 'item' : 'group',
    repoInfo: headingEntry?.repoInfo,
    title,
  });
}

// A document can hold registry content with no heading above it — headingless
// docs, TOC-only docs, or preamble entries (list, table) before the first
// section heading. Rather than dropping them, the first one synthesizes the
// section it implicitly belongs to ("Overview"). It behaves exactly like a
// real section:
// closed by the first structural heading (or document end), gated with its
// whole subtree, and pruned when empty.
function openImplicitSection(
  stack: ContainerBuilder[],
  atIndex: number,
): void {
  stack.push({
    children: [],
    description: '',
    // Infinity so ANY structural heading closes it in closeContainers and
    // ends its span in the section gate — the implicit section never reaches
    // past the preamble.
    headingDepth: Infinity,
    // One before the opening list so the gate's scan (from headingIndex + 1)
    // counts that list itself.
    headingIndex: atIndex - 1,
    kind: 'section',
    title: 'Overview',
  });
}

// The section synthesized around a run of promoted entry headings
// (openContainer's entry branch). It behaves like the implicit section — same
// "Overview" title, gated by its subtree — but sits at sectionDepth, so the
// first plain heading at that level ends the run, and closeContainers'
// stopAtSynthesized keeps the entry headings' own pops from closing it:
// consecutive entry headings are siblings INSIDE it.
function openSynthesizedSection(
  stack: ContainerBuilder[],
  firstEntryIndex: number,
  depth: number,
): void {
  stack.push({
    children: [],
    description: '',
    headingDepth: depth,
    // One before the first entry heading so the gate's scan (from
    // headingIndex + 1) counts that heading itself.
    headingIndex: firstEntryIndex - 1,
    kind: 'section',
    openedBySynthesis: true,
    title: 'Overview',
  });
}

// The minLinks gate scoped to a SECTION: every entry source in the section
// counts together (list items, table rows, entry paragraphs, entry headings,
// blockquote faces) — best-of-style documents put each entry in its own
// single-item list, which the per-list gate dropped one by one. The section's
// subtree runs from its heading to the first structural heading at or above
// its depth (the same heading that would close it in closeContainers).
//
// Heading-per-entry documents (FBI-tools' `### name` + link paragraph, FLOSS's
// `## game` + link cluster) put exactly ONE entry in each section, so every
// section fails the gate alone and the whole document drops. They are not
// sparse sections but flat entry lists delimited by headings: a section at
// sectionDepth that fails alone is re-gated against its RUN — the maximal
// sequence of adjacent section spans each holding at most one entry. The
// noise floor survives: a single one-entry section between multi-entry
// sections is a run of one and stays dropped.
function sectionGatePasses(
  tree: Root,
  titleSlotIndex: number,
  sectionDepth: number,
  repoInfoMap: Map<string, RepoInfoDetails>,
  sortOptions: SortOptions,
): (section: ContainerBuilder) => boolean {
  const cache = new Map<number, boolean>();

  // Linked entries from scanStart to the first structural heading that would
  // close a container of closeDepth. An entry heading counts as an entry
  // wherever it sits inside the span — it opens an item, not a container —
  // except at the scanned section's own depth, where the walk closes that
  // section when the entry run starts (a same-depth entry heading is content
  // only for the synthesized wrapper, hence sameDepthEntriesAreContent).
  const scanCount = (
    scanStart: number,
    closeDepth: number,
    sameDepthEntriesAreContent: boolean,
  ): number => {
    let linkedEntries = 0;
    for (let j = scanStart; j < tree.children.length; j++) {
      const node = tree.children[j];
      if (node.type === 'heading') {
        if (j === titleSlotIndex || !isStructuralHeading(node)) {
          continue;
        }
        if (entryHeadingInfo(node, repoInfoMap)) {
          if (sameDepthEntriesAreContent || node.depth > closeDepth) {
            linkedEntries += 1;
          } else {
            break;
          }
          continue;
        }
        if (node.depth <= closeDepth) {
          break;
        }
        continue;
      }
      if (node.type === 'list') {
        linkedEntries += countLinkedItems(node);
      } else if (node.type === 'table') {
        linkedEntries += countLinkedRows(node);
      } else if (node.type === 'paragraph' && paragraphEntryLink(node)) {
        linkedEntries += 1;
      } else if (node.type === 'blockquote') {
        linkedEntries += blockquoteEntries(node).length;
      }
    }
    return linkedEntries;
  };

  // A boundary's entry count for the run walk: the heading itself when it is
  // an entry heading, plus its span's entries (the span closes at the first
  // heading at or above the boundary's OWN depth, exactly where the walk
  // closes that section).
  const spanCountCache = new Map<number, number>();
  const spanCount = (boundaryIndex: number): number => {
    const cached = spanCountCache.get(boundaryIndex);
    if (cached !== undefined) {
      return cached;
    }
    const heading = tree.children[boundaryIndex] as Heading;
    const count =
      (entryHeadingInfo(heading, repoInfoMap) ? 1 : 0) +
      scanCount(boundaryIndex + 1, heading.depth, false);
    spanCountCache.set(boundaryIndex, count);
    return count;
  };

  // The section boundaries in document order, by the walk's own promotion
  // rule (openContainer): a heading opens a section when it sits at
  // sectionDepth or arrives with nothing open — FLOSS-style documents have a
  // lone late H1 that pins sectionDepth at 1 while every `## game` heading
  // alternately closes its predecessor (stack empties) and is promoted. The
  // depth simulation mirrors closeContainers/openContainer exactly.
  let boundaries: number[] | undefined;
  const sectionBoundaries = (): number[] => {
    if (!boundaries) {
      const indices: number[] = [];
      const openDepths: number[] = [];
      tree.children.forEach((node, i) => {
        if (node.type !== 'heading' || i === titleSlotIndex) {
          return;
        }
        if (!isStructuralHeading(node)) {
          return;
        }
        while (
          openDepths.length > 0 &&
          openDepths[openDepths.length - 1] >= node.depth
        ) {
          openDepths.pop();
        }
        if (openDepths.length === 0 || node.depth === sectionDepth) {
          indices.push(i);
        }
        openDepths.push(node.depth);
      });
      boundaries = indices;
    }
    return boundaries;
  };

  const runTotal = (section: ContainerBuilder): number => {
    const list = sectionBoundaries();
    const k = list.indexOf(section.headingIndex);
    if (k === -1) {
      return spanCount(section.headingIndex);
    }
    let total = spanCount(section.headingIndex);
    for (const direction of [-1, 1]) {
      for (
        let m = k + direction;
        m >= 0 && m < list.length;
        m += direction
      ) {
        const count = spanCount(list[m]);
        if (count > 1) {
          break;
        }
        total += count;
      }
    }
    return total;
  };

  return section => {
    const cached = cache.get(section.headingIndex);
    if (cached !== undefined) {
      return cached;
    }
    const own = scanCount(
      section.headingIndex + 1,
      section.headingDepth,
      !!section.openedBySynthesis,
    );
    const passes =
      own >= sortOptions.minLinks ||
      (!section.openedBySynthesis &&
        sectionBoundaries().includes(section.headingIndex) &&
        runTotal(section) >= sortOptions.minLinks);
    cache.set(section.headingIndex, passes);
    return passes;
  };
}

// A finalized section plus the document index it opened at, so sections can
// be returned in document order even when finalization order differs (a
// details-section closes inside its parent section's span).
interface SectionRecord {
  headingIndex: number;
  section: JsonSection;
}

// Prune-or-emit one popped container: a section/group whose children array is
// empty (no items anywhere beneath — the entry sources only return
// item-bearing nodes) is dropped; an item always survives, it IS the content.
// Non-section containers always have an open parent (stack invariant), and
// kind === 'item' exactly when repoInfo is set.
function finalizeContainer(
  container: ContainerBuilder,
  stack: ContainerBuilder[],
  sectionRecords: SectionRecord[],
): void {
  if (container.children.length === 0 && container.kind !== 'item') {
    return;
  }
  const description = container.description || null;
  if (container.kind === 'section') {
    sectionRecords.push({
      headingIndex: container.headingIndex,
      section: { description, items: container.children, title: container.title },
    });
    return;
  }
  const parent = stack[stack.length - 1];
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

// Finalize every container a heading of `depth` closes (same-or-shallower),
// bottom-up so each finalized node lands in its parent. The stack bottom is
// always a section (openContainer's promotion guarantees it), so a finalized
// group/item always has a parent to land in. stopAtSynthesized: the pop an
// entry heading triggers must stop at the synthesized section wrapping its
// run — the next entry heading of the run lands back inside it.
function closeContainers(
  stack: ContainerBuilder[],
  depth: number,
  sectionRecords: SectionRecord[],
  stopAtSynthesized = false,
): void {
  while (
    stack.length > 0 &&
    stack[stack.length - 1].headingDepth >= depth
  ) {
    if (stopAtSynthesized && stack[stack.length - 1].openedBySynthesis) {
      break;
    }
    finalizeContainer(stack.pop() as ContainerBuilder, stack, sectionRecords);
  }
}

// Ends the innermost open details-section and everything opened inside it,
// leaving the enclosing containers untouched — unlike a heading close, a
// details boundary never ends its parent section, so content after the
// collapsible block keeps collecting under it. A stray </details> (no
// details-section open) is a no-op.
function closeInnermostDetails(
  stack: ContainerBuilder[],
  sectionRecords: SectionRecord[],
): void {
  let detailsIndex = -1;
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s].openedByDetails) {
      detailsIndex = s;
      break;
    }
  }
  if (detailsIndex === -1) {
    return;
  }
  while (stack.length > detailsIndex) {
    finalizeContainer(stack.pop() as ContainerBuilder, stack, sectionRecords);
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
