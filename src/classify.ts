import {
  getRepoInfo as fetchRepoInfo,
  formatRequestError,
  getReadme,
  GithubClient,
  makeOctokit,
  parseOwnerRepo,
  RepoIdentifier,
  RepoInfoDetails,
} from './github.js';
import { actionsLog, Logger } from './logger.js';

// A node's intrinsic kind: a `registry` is a directory that exists to enable
// discovery (an awesome-list); a `repository` is a terminal, consumable
// project. Every genuine GitHub node carries exactly one.
export type Kind = 'registry' | 'repository';

// Which signal classified a node as a `registry`. Present only on registries
// (every 'repository' is the signal-less fallthrough, so it carries none). The
// layers differ sharply in reliability (membership/name/topic ~0% error;
// description/content ~30-40%), so emitting the deciding layer lets downstream
// treat the soft-derived registries as lower confidence than the anchor-derived
// ones — turning the binary kind into a graded signal at no extra fetch cost.
export type RegistrySignal =
  'content' | 'description' | 'membership' | 'name' | 'topic';

export interface Classification {
  kind: Kind;
  registrySignal?: RegistrySignal;
}

/** Any way of naming a repo: `{ owner, repo }`, `owner/repo`, or a github.com URL. */
export type RepoRef = RepoIdentifier | string;

// TARGET content backstop. Popular software has link-heavy READMEs
// (nodejs/node ~662 anchors, webpack ~403), so a low threshold flips real
// projects. The precision anchors (membership/topic/name/description) catch the
// bulk of registries at ~0 false-positives; content is only the LAST-resort
// backstop for dense convention-free lists no anchor signals (e.g. a CV list
// titled "3D-Machine-Learning" with 800 anchors). 700 sits above virtually all
// software (clean-project p90 ~106) while still catching those dense
// registries; marked registry_signal='content' so downstream treats it as soft.
export const REGISTRY_CONTENT_BACKSTOP_LINKS = 700;

// The awesome-list naming convention, as a word-boundary token so it does NOT
// fire on `awesome_print` (underscore is a word char, so no boundary lies
// between `awesome` and `_print`). The `\bawsome\b` alternation covers the
// common misspelling (e.g. HuaizhengZhang/Awsome-Deep-Learning-for-Video-Analysis).
const AWESOME_NAME_PATTERN = /\bawesome\b|\bawsome\b/i;

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

/**
 * Counts outbound links in a target's RENDERED HTML README, so a non-Markdown
 * README (reStructuredText, AsciiDoc) — whose links Markdown parsing cannot see
 * — is judged by the links a reader actually sees. Same-page `#` anchors are
 * excluded so a Table of Contents does not inflate the count.
 *
 * GitHub's rendered HTML double-quotes attributes, so this targeted scan is
 * exact without an HTML-parser dependency.
 */
export function countOutboundAnchors(html: string): number {
  let count = 0;
  for (const match of html.matchAll(/href\s*=\s*"([^"]*)"/g)) {
    if (match[1] && !match[1].startsWith('#')) {
      count++;
    }
  }
  return count;
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
 * The layered decision itself, with every input explicit. Most callers want
 * `createRepoLookup`, which resolves and memoizes `repoInfo` and `members` for
 * them; this is the shared core it runs, exposed for callers that already hold
 * those inputs (a batch job, a replay over cached data).
 *
 * Precision-first: the anchors (membership/topic/name/description) are ~0%
 * false-positive and need no README fetch, so a target one of them catches never
 * pays for one. Only when every anchor misses do we fetch the rendered HTML and
 * fall back to the high content threshold. A registry carries the deciding layer
 * as `registrySignal` so downstream can grade confidence; a repository is the
 * signal-less fallthrough and carries none. A README fetch failure propagates.
 */
export async function classifyKind(
  octokit: GithubClient,
  owner: string,
  repo: string,
  repoInfo: null | RepoInfoDetails,
  members: Set<string>,
  backstopMin: number,
): Promise<Classification> {
  if (members.has(`${owner.toLowerCase()}/${repo.toLowerCase()}`)) {
    return { kind: 'registry', registrySignal: 'membership' };
  }
  if (repoInfo?.topics.includes('awesome-list')) {
    return { kind: 'registry', registrySignal: 'topic' };
  }
  if (AWESOME_NAME_PATTERN.test(repo)) {
    return { kind: 'registry', registrySignal: 'name' };
  }
  const description = repoInfo?.description ?? '';
  if (description && REGISTRY_DESCRIPTION_PATTERN.test(description)) {
    return { kind: 'registry', registrySignal: 'description' };
  }
  const html = await getReadme(octokit, owner, repo, 'html');
  if (countOutboundAnchors(html) >= backstopMin) {
    return { kind: 'registry', registrySignal: 'content' };
  }
  return { kind: 'repository' };
}

export interface RepoLookupOptions {
  /** Reuse an existing client, and its rate-limit budget, instead of building one from `token`. Carries its own `log`. */
  client?: GithubClient;
  /** Rendered-README anchor count at or above which the content backstop fires. */
  contentBackstopMin?: number;
  /** Where diagnostics go. Defaults to the Actions sink; ignored when `client` is supplied, which brings its own. */
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
  const contentBackstopMin =
    options.contentBackstopMin ?? REGISTRY_CONTENT_BACKSTOP_LINKS;
  // The sink is installed on the client, which is already handed to everything
  // that logs — so nothing below needs to carry one.
  const client =
    options.client ??
    makeOctokit(options.token ?? '', options.log ?? actionsLog);

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
        contentBackstopMin,
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
 * Collapses the refs naming one repo — a bare link and a deep `/tree/...` link —
 * into a single fetch. Stores the in-flight Promise rather than the settled
 * value: the lookup-and-set is synchronous, so a concurrent caller awaits the
 * first caller's fetch instead of racing a duplicate.
 *
 * Keyed on the ref's own casing, so `ReactiveX/RxJS` and `reactivex/rxjs` each
 * pay their own round-trip. GitHub treats the two as one repo and answers both
 * with the same canonical record, so deduping them would be sound — and cheaper
 * — but it is a behavior change, not a memo detail, and is left alone here.
 */
function memoize<T>(
  store: Map<string, Promise<T>>,
  owner: string,
  repo: string,
  fetch: () => Promise<T>,
): Promise<T> {
  const key = `${owner}/${repo}`;
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
