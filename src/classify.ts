import {
  getRepoInfo as fetchRepoInfo,
  formatRequestError,
  getReadme,
  getRootEntryNames,
  GithubClient,
  isRelative,
  isSelfReference,
  makeOctokit,
  parseGitHubUrl,
  parseOwnerRepo,
  RepoIdentifier,
  RepoInfoDetails,
} from './github.js';
import { consoleLog, Logger } from './logger.js';

// A node's intrinsic kind: a `registry` is a directory that exists to enable
// discovery (an awesome-list); a `repository` is a terminal, consumable
// project. Every genuine GitHub node carries exactly one.
export type Kind = 'registry' | 'repository';

// Which signal classified a node as a `registry`. Present only on registries; a
// 'repository' is the signal-less fallthrough. The layers differ in reliability
// (membership terminal; topic/name/description confirmed by the README; content
// a last-resort backstop), so the deciding layer grades the binary kind for
// downstream confidence.
export type RegistrySignal =
  'content' | 'description' | 'membership' | 'name' | 'topic';

export interface Classification {
  kind: Kind;
  registrySignal?: RegistrySignal;
}

/** Any way of naming a repo: `{ owner, repo }`, `owner/repo`, or a github.com URL. */
export type RepoRef = RepoIdentifier | string;

// Last-resort backstop for dense, convention-free lists no anchor signals,
// counted in OUTBOUND anchors so a repo can't backstop itself into `registry`.
// 200 (not a stricter bar) is safe only because the breadth guard below applies.
export const REGISTRY_CONTENT_BACKSTOP_LINKS = 200;

// Backstop breadth guard: distinct external targets the outbound hrefs must
// reach. Excludes the prompt-gallery shape (hundreds of hrefs on one CDN + one
// social host, distinctTargets ~10) without losing genuine outward indices.
export const REGISTRY_CONTENT_BACKSTOP_DISTINCT = 15;

// Floor on outbound count: without it a lone CI badge is a 100%-outbound README
// that would confirm any anchor.
export const REGISTRY_CONFIRM_MIN_OUTBOUND = 5;

// Name-anchor breadth veto: an `awesome-*` repo whose outbound links collapse to
// few distinct targets is the content carrying the prefix, not a directory. Name
// only — topic/description are stronger signals and need no veto. 20 separates
// the name-only content FPs (well under 20) from genuine name-caught registries.
export const REGISTRY_NAME_BREADTH_MIN = 20;

// Root build manifests that mark a repo as the deliverable itself (runnable/
// buildable source), so the compile-manifest gate vetoes its outward-README
// confirmation — catching products the majority rule can't (a Java patterns repo
// with a root pom.xml). package.json is deliberately excluded: net-negative
// (9 FPs, 22 genuine registries carry it as tooling config).
export const COMPILE_PRODUCT_MANIFESTS: ReadonlySet<string> = new Set([
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'go.mod',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
]);

// Knobs surfaced so the decision can run offline (candidate + anchors + a lazy
// root listing, no fetch). Defaults ARE the constants above — single source of
// truth — so the default verdict is unchanged.
export type GateScope =
  'also-backstop' | 'any-admission' | 'any-candidate' | 'post-facesOutward';

export interface ClassifierConfig {
  compileManifests: ReadonlySet<string>;
  confirmMinOutbound: number;
  contentBackstopDistinct: number;
  contentBackstopLinks: number;
  // Where the compile-manifest product-veto runs (see decideClassification).
  gateScope: GateScope;
  nameBreadthMin: number;
  outwardRatio: number;
  // Topic-anchor breadth floor (mirrors nameBreadthMin). Default 0 = disabled; a
  // topic is a stronger signal than a name prefix and needs no veto by default.
  topicBreadthMin: number;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  compileManifests: COMPILE_PRODUCT_MANIFESTS,
  confirmMinOutbound: REGISTRY_CONFIRM_MIN_OUTBOUND,
  contentBackstopDistinct: REGISTRY_CONTENT_BACKSTOP_DISTINCT,
  contentBackstopLinks: REGISTRY_CONTENT_BACKSTOP_LINKS,
  // Product-veto at every non-membership admission: gating only outward
  // candidates left sub-ratio/backstop products admitted as registries.
  gateScope: 'any-admission',
  nameBreadthMin: REGISTRY_NAME_BREADTH_MIN,
  // ≥50%-outbound README faces outward. 0.5 (not 0.6) is the recall-favored knee:
  // recovers registries in the 50–60% band for one low-star FP.
  outwardRatio: 0.5,
  topicBreadthMin: 0,
};

// The `awesome-` prefix (or the `awsome-` misspelling), not "awesome" as any word
// token — skips products that merely contain the word (Font-Awesome,
// vue-awesome-swiper, awesomeWM, awesome_print). Narrow recall cost: a genuine
// list with the stem mid-name lands only via topic/description/density.
const AWESOME_NAME_PATTERN = /^(?:awesome|awsome)-/i;

/** The naming convention the name anchor reads, shared so tests exercise the real one. */
export function isAwesomeListName(repo: string): boolean {
  return AWESOME_NAME_PATTERN.test(repo);
}

// Tight, list-proximate phrasing. Bare `collection of` / `curated` / `awesome`
// are deliberately excluded: they flip popular real projects (gitignore,
// PowerToys, iptv, SecLists, nerd-fonts via "Font Awesome") for ~0 recall gain.
const REGISTRY_DESCRIPTION_PATTERN =
  /(curated (?:list|collection)|a list of|collective list|cheat\s?sheet)/i;

// The canonical "list of awesome-lists". Membership is FP-free in practice and
// catches convention-free registries (papers-we-love, free-programming-books)
// that no other anchor signals. Fetched at most once per lookup; a failure
// degrades to an empty set (the layer is skipped) rather than failing
// classification.
const AWESOME_REGISTRY = { owner: 'sindresorhus', repo: 'awesome' };

// GitHub path prefixes that are not repositories, so a link like
// github.com/topics/foo must not become a "member".
const NON_REPO_OWNERS = new Set([
  'blog',
  'features',
  'orgs',
  'search',
  'settings',
  'topics',
]);

export interface AnchorCounts {
  /** Distinct external targets among OUTBOUND hrefs (github → owner/repo, others
   * → hostname). The breadth signal — high `outbound` alone can't confirm a
   * registry, since a content repo's links can collapse to a few hosts. */
  distinctTargets: number;
  /** Anchors pointing anywhere but back into the repo's own tree. */
  outbound: number;
  /** Every anchor that leads off the page, self-tree links included. */
  total: number;
}

/**
 * Links in a target's RENDERED HTML README (the self-aware counterpart of
 * `countResourceLinks`); the two must agree on what is internal, or a repo
 * linking its own files inflates its outbound ratio and defeats `facesOutward`.
 * Same-page `#` anchors and self-tree links (absolute github.com/<self>/… or
 * relative `docs/x`) count in `total` but not `outbound`. GitHub double-quotes
 * attributes, so the scan is exact without an HTML parser.
 */
export function countAnchors(html: string, self: RepoIdentifier): AnchorCounts {
  let outbound = 0,
    total = 0;
  const ghTargets = new Set<string>();
  const extHosts = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*"([^"]*)"/g)) {
    const href = match[1];
    if (!href || href.startsWith('#')) {
      continue;
    }
    total++;
    if (isRelative(href) || isSelfReference(href, self)) {
      continue;
    }
    outbound++;
    const gh = parseGitHubUrl(href);
    if (gh) {
      ghTargets.add(`${gh.owner.toLowerCase()}/${gh.repo.toLowerCase()}`);
      continue;
    }
    try {
      const url = new URL(href);
      if (url.hostname !== 'github.com') {
        extHosts.add(url.hostname.toLowerCase());
      }
    } catch {
      // A schemeless or malformed href cannot name an external host; skip.
    }
  }
  return {
    distinctTargets: ghTargets.size + extHosts.size,
    outbound,
    total,
  };
}

/**
 * Parses markdown links to github.com/<owner>/<repo> out of the
 * sindresorhus/awesome README. Scoped to markdown `[..](url)` links only: that
 * README opens with HTML sponsor badges (`<a href>`), and sweeping those would
 * import sponsor/author links (e.g. sindresorhus/sponsors) and break the layer's
 * 0%-false-positive property.
 */
export function parseAwesomeMembers(markdown: string): Set<string> {
  const members = new Set<string>();
  const token = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
  for (const m of markdown.matchAll(
    new RegExp(`\\([^)]*github\\.com/(${token})/(${token})[^)]*\\)`, 'g'),
  )) {
    const owner = m[1];
    let repo = m[2];
    if (owner === AWESOME_REGISTRY.owner && repo === AWESOME_REGISTRY.repo) {
      continue;
    }
    if (NON_REPO_OWNERS.has(owner)) {
      continue;
    }
    if (repo.endsWith('.git')) {
      repo = repo.slice(0, -4);
    }
    members.add(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
  }
  return members;
}

export async function fetchAwesomeMembers(
  octokit: GithubClient,
): Promise<Set<string>> {
  try {
    const markdown = await getReadme(
      octokit,
      AWESOME_REGISTRY.owner,
      AWESOME_REGISTRY.repo,
      'raw',
    );
    return parseAwesomeMembers(markdown);
  } catch (error) {
    octokit.log.warn(
      `sindresorhus/awesome membership unavailable; skipping that layer: ${formatRequestError(error)}`,
    );
    return new Set();
  }
}

/**
 * The layered decision, inputs explicit. Most callers want `createRepoLookup`,
 * which resolves and memoizes `repoInfo`/`members`; this is the shared core.
 *
 * Membership is terminal; the soft anchors (topic/name/description) only make a
 * repo a CANDIDATE — it can read as "awesome-list" yet be the content — so every
 * non-member fetches its README once. An outward-facing README confirms the
 * candidate; a low-breadth one is vetoed, and a root compile manifest gate-vetoes
 * it (that fetch is paid only once the prior checks pass). Anchor-less targets
 * fall to the breadth-guarded backstop.
 *
 * A README can confirm an anchor but never refute one: an unreadable README
 * (none/404/rate-limited) is a fetch fact, not a repo fact, so a candidate keeps
 * its verdict and only logs. An anchor-less target has no verdict to keep, so the
 * backstop's failure propagates.
 */
export async function classifyKind(
  octokit: GithubClient,
  owner: string,
  repo: string,
  repoInfo: null | RepoInfoDetails,
  members: Set<string>,
  backstopMin: number,
  config?: Partial<ClassifierConfig>,
): Promise<Classification> {
  if (members.has(`${owner.toLowerCase()}/${repo.toLowerCase()}`)) {
    return { kind: 'registry', registrySignal: 'membership' };
  }

  const candidate = softRegistrySignal(repo, repoInfo);

  let anchors: AnchorCounts;
  try {
    const html = await getReadme(octokit, owner, repo, 'html');
    anchors = countAnchors(html, { owner, repo });
  } catch (error) {
    if (!candidate) {
      throw error;
    }
    octokit.log.warn(
      `README unreadable for ${owner}/${repo}; keeping its unconfirmed ${candidate} anchor: ${formatRequestError(error)}`,
    );
    return { kind: 'registry', registrySignal: candidate };
  }

  // Lazy: paid only when decideClassification runs the gate. A failure reads as
  // "no manifest" (warn + empty) so the outward verdict stays intact.
  async function lazyRootNames(): Promise<string[]> {
    try {
      return await getRootEntryNames(octokit, owner, repo);
    } catch (error: unknown) {
      octokit.log.warn(
        `root contents unreadable for ${owner}/${repo}; skipping the compile-manifest gate: ${formatRequestError(error)}`,
      );
      return [];
    }
  }

  return decideClassification(
    repo,
    repoInfo,
    members,
    anchors,
    lazyRootNames,
    resolveConfig(backstopMin, config),
  );
}

/**
 * Merges a partial override onto the defaults. The positional `backstopMin`
 * (the legacy single knob threaded from `RepoLookupOptions.contentBackstopMin`)
 * stays the source for `contentBackstopLinks` unless the override sets it
 * explicitly, so every existing 6-arg `classifyKind` call behaves identically.
 */
function resolveConfig(
  backstopMin: number,
  override?: Partial<ClassifierConfig>,
): ClassifierConfig {
  return {
    ...DEFAULT_CLASSIFIER_CONFIG,
    ...override,
    contentBackstopLinks: override?.contentBackstopLinks ?? backstopMin,
  };
}

/**
 * The structural test a soft anchor must pass: the README points at other
 * people's things, not its own tree. Outbound >= `outwardRatio` of total ⇒ a
 * directory of resources; a README below that bar is about itself (its own
 * code/patterns/docs) and the anchor is vetoed however awesome-list-shaped it
 * reads. A floor stops a single CI badge (a 100%-outbound README) from
 * confirming an anchor.
 */
function facesOutward(
  { outbound, total }: AnchorCounts,
  config: ClassifierConfig,
): boolean {
  return (
    outbound >= config.confirmMinOutbound &&
    outbound >= config.outwardRatio * total
  );
}

/**
 * The non-terminal registry anchors, in priority order. Unlike membership these
 * misfire on products — a name/topic/description can read as "awesome-list" while
 * the repo is itself the content — so the winner is returned as a candidate for
 * `classifyKind` to confirm from the README rather than acted on here. `null`
 * repoInfo (a dead link) simply skips the topic/description anchors.
 */
function softRegistrySignal(
  repo: string,
  repoInfo: null | RepoInfoDetails,
): RegistrySignal | undefined {
  if (repoInfo?.topics.includes('awesome-list')) {
    return 'topic';
  }
  if (isAwesomeListName(repo)) {
    return 'name';
  }
  const description = repoInfo?.description ?? '';
  if (description && REGISTRY_DESCRIPTION_PATTERN.test(description)) {
    return 'description';
  }
  return undefined;
}

/** Root carries a compile manifest (the gate signal). A `getContent` failure
 * can't establish product-ness, so it warns and returns false — leaving the
 * outward verdict intact. */
export async function isCompileProductRepo(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const names = await getRootEntryNames(octokit, owner, repo);
    return names.some(name => COMPILE_PRODUCT_MANIFESTS.has(name));
  } catch (error) {
    octokit.log.warn(
      `root contents unreadable for ${owner}/${repo}; skipping the compile-manifest gate: ${formatRequestError(error)}`,
    );
    return false;
  }
}

/**
 * The pure decision core: a verdict from a candidate, its anchors, and (only if
 * a gate fires) a lazy root listing. No fetch or logger here — the caller supplies
 * `getRootNames` and encodes fetch failure at that boundary, keeping this pure.
 * `classifyKind` is the production wrapper.
 *
 * Membership is keyed on `repoInfo.owner` (classifyKind pre-fetches it, so this
 * only matters for direct callers). The compile gate's placement is `gateScope`:
 * - `any-admission` (default) — gate every admission point (outward + sub-ratio +
 *   backstop); a product-veto belongs at every non-membership admission.
 * - `post-facesOutward` — only outward candidates; leaves sub-ratio/backstop
 *   products ungated.
 * - `any-candidate` — also gate a sub-ratio candidate (no manifest ⇒ fall through
 *   to the backstop, no outright confirmation).
 * - `also-backstop` — also gate inside the content-backstop branch.
 */
export async function decideClassification(
  repo: string,
  repoInfo: null | RepoInfoDetails,
  members: Set<string>,
  anchors: AnchorCounts,
  getRootNames: () => Promise<string[]>,
  config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
): Promise<Classification> {
  if (
    repoInfo &&
    members.has(`${repoInfo.owner.toLowerCase()}/${repo.toLowerCase()}`)
  ) {
    return { kind: 'registry', registrySignal: 'membership' };
  }

  const candidate = softRegistrySignal(repo, repoInfo);
  const outward = facesOutward(anchors, config);

  if (candidate && outward) {
    if (
      candidate === 'name' &&
      anchors.distinctTargets < config.nameBreadthMin
    ) {
      return { kind: 'repository' };
    }
    // The topic analog of the name-breadth veto, inert at the default 0 (see
    // ClassifierConfig.topicBreadthMin). A topic candidate whose outward links
    // collapse to a narrow target set is the content, not a directory of it.
    if (
      candidate === 'topic' &&
      anchors.distinctTargets < config.topicBreadthMin
    ) {
      return { kind: 'repository' };
    }
    if (await hasCompileManifest(getRootNames, config)) {
      return { kind: 'repository' };
    }
    return { kind: 'registry', registrySignal: candidate };
  }

  // Sub-ratio candidate gate: a candidate whose README is below the outward
  // majority bar. Reached by the default `any-admission` and by `any-candidate`.
  if (
    candidate &&
    !outward &&
    (config.gateScope === 'any-candidate' ||
      config.gateScope === 'any-admission')
  ) {
    if (await hasCompileManifest(getRootNames, config)) {
      return { kind: 'repository' };
    }
    // No manifest: fall through to the content backstop rather than confirming
    // a sub-ratio candidate outright.
  }

  if (
    anchors.outbound >= config.contentBackstopLinks &&
    anchors.distinctTargets >= config.contentBackstopDistinct
  ) {
    if (
      (config.gateScope === 'also-backstop' ||
        config.gateScope === 'any-admission') &&
      (await hasCompileManifest(getRootNames, config))
    ) {
      return { kind: 'repository' };
    }
    return { kind: 'registry', registrySignal: 'content' };
  }
  return { kind: 'repository' };
}

async function hasCompileManifest(
  getRootNames: () => Promise<string[]>,
  config: ClassifierConfig,
): Promise<boolean> {
  const names = await getRootNames();
  return names.some(name => config.compileManifests.has(name));
}

export interface RepoLookupOptions {
  /** Overrides the classifier's structural knobs; unset fields fall back to the defaults. */
  classifierConfig?: Partial<ClassifierConfig>;
  /** Reuse an existing client, and its rate-limit budget, instead of building one from `token`. Carries its own `log`. */
  client?: GithubClient;
  /**
   * Rendered-README anchor count at or above which the content backstop fires.
   * Predates {@link ClassifierConfig}; kept because callers already set it. When
   * both are present this wins for `contentBackstopLinks` (the field it always
   * controlled), while `classifierConfig` overrides every other knob.
   */
  contentBackstopMin?: number;
  /** Where diagnostics go. Defaults to the console sink; ignored when `client` is supplied, which brings its own. */
  log?: Logger;
  /** Pre-resolved sindresorhus/awesome membership; omit to fetch it once, on first use. */
  members?: Set<string>;
  token?: string;
}

export interface RepoLookup {
  /** The repo's kind, resolving its repo info and the membership set on the caller's behalf. */
  classify(ref: RepoRef): Promise<Classification>;
  /** The client every lookup runs on, and the sink they log to (`client.log`). */
  client: GithubClient;
  /** Rejects when the repo is unreadable (a dead link); `classify` tolerates that on its own. */
  getRepoInfo(ref: RepoRef): Promise<RepoInfoDetails>;
  /** The sindresorhus/awesome membership set, fetched on first use. Empty when unreachable. */
  members(): Promise<Set<string>>;
}

/**
 * Binds the classifier to its dependencies once — the GitHub client, the
 * membership set, the content threshold — so callers name a repo and nothing
 * else.
 *
 * Every lookup memoizes per canonical `owner/repo` and shares one in-flight
 * Promise, so aliased refs (a bare link and a deep `/tree/...` link into the same
 * repo) cost a single round-trip, and `classify` reuses the very repo info the
 * caller may also ask for. Membership is fetched lazily and at most once — the
 * reason to hold a lookup across many repos rather than reaching for
 * `classifyRepo`.
 */
export function createRepoLookup(options: RepoLookupOptions = {}): RepoLookup {
  // Fold the legacy contentBackstopMin into the config surface: it pins
  // contentBackstopLinks (the field it always controlled) even when a
  // classifierConfig override is also supplied, so existing callers behave
  // identically while the new surface drives every other knob.
  const classifierConfig: ClassifierConfig = {
    ...DEFAULT_CLASSIFIER_CONFIG,
    ...options.classifierConfig,
    ...(options.contentBackstopMin !== undefined
      ? { contentBackstopLinks: options.contentBackstopMin }
      : {}),
  };
  // The sink is installed on the client, which is already handed to everything
  // that logs — so nothing below needs to carry one.
  const client =
    options.client ??
    makeOctokit(options.token ?? '', options.log ?? consoleLog);

  const repoInfos = new Map<string, Promise<RepoInfoDetails>>();
  const classifications = new Map<string, Promise<Classification>>();
  let memberships: Promise<Set<string>> | undefined = options.members
    ? Promise.resolve(options.members)
    : undefined;

  function members(): Promise<Set<string>> {
    memberships ??= fetchAwesomeMembers(client);
    return memberships;
  }

  // `async` so an unresolvable ref rejects rather than throwing at the call site.
  async function getRepoInfo(ref: RepoRef): Promise<RepoInfoDetails> {
    const { owner, repo } = resolveRepoRef(ref);
    return memoize(repoInfos, owner, repo, () =>
      fetchRepoInfo(client, owner, repo),
    );
  }

  async function classify(ref: RepoRef): Promise<Classification> {
    const { owner, repo } = resolveRepoRef(ref);
    return memoize(classifications, owner, repo, async () => {
      // A dead link fails /repos but must still reach the remaining anchors, so
      // a missing repoInfo only costs the topic/description layers.
      const info = await getRepoInfo({ owner, repo }).catch((): null => null);
      return classifyKind(
        client,
        owner,
        repo,
        info,
        await members(),
        classifierConfig.contentBackstopLinks,
        classifierConfig,
      );
    });
  }

  return { classify, client, getRepoInfo, members };
}

/**
 * One-shot classification of a single repo.
 *
 * Each call builds a client and re-fetches the membership list, so classifying
 * more than one repo should hold a `createRepoLookup` and reuse it.
 */
export async function classifyRepo(
  ref: RepoRef,
  options: RepoLookupOptions = {},
): Promise<Classification> {
  return createRepoLookup(options).classify(ref);
}

/**
 * Collapses the refs naming one repo — a bare link, a deep `/tree/...` link, or
 * a differently-cased spelling — into a single fetch. Stores the in-flight
 * Promise rather than the settled value: the lookup-and-set is synchronous, so
 * a concurrent caller awaits the first caller's fetch instead of racing a
 * duplicate.
 *
 * GitHub repo names are case-insensitive, so the key is lowercased: the API
 * answers `ReactiveX/RxJS` and `reactivex/rxjs` with the same canonical record,
 * and a README linking both spellings must pay for it once, not twice.
 */
function memoize<T>(
  store: Map<string, Promise<T>>,
  owner: string,
  repo: string,
  fetch: () => Promise<T>,
): Promise<T> {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const existing = store.get(key);
  if (existing) {
    return existing;
  }
  const pending = fetch();
  store.set(key, pending);
  return pending;
}

function resolveRepoRef(ref: RepoRef): RepoIdentifier {
  if (typeof ref !== 'string') {
    return ref;
  }
  const parsed = parseOwnerRepo(ref);
  if (!parsed) {
    throw new Error(`Not a GitHub repository reference: "${ref}"`);
  }
  return parsed;
}
