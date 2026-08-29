import { Octokit, type OctokitOptions } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import { consoleLog, Logger } from './logger.js';

import type { ThrottlingOptions } from '@octokit/plugin-throttling';

const DEFAULT_MAX_WAIT_TIME_SECONDS = 300,
  MAX_RETRIES = 3;

// `@actions/github`'s `GitHub` is `Octokit.plugin(restEndpointMethods,
// paginateRest).defaults(...)` — it pre-applies REST endpoint methods
// (`octokit.rest.*`) and pagination. We dropped `@actions/github` to keep core
// free of the Actions runtime, so re-apply those two plugins here alongside the
// retry/throttling hardening, on a bare `Octokit`. Note this drops
// `@actions/github`'s `.defaults` (GHE baseUrl + proxy agent/fetch) — acceptable
// for the github.com + GITHUB_TOKEN path the action uses; self-hosted runners
// behind a proxy or GHE installs would regress.
const HardenedOctokit = Octokit.plugin(
  restEndpointMethods,
  paginateRest,
  retry,
  throttling,
);

export type GithubClient = InstanceType<typeof HardenedOctokit>;

export interface RepoInfoDetails {
  archived: boolean;
  description: null | string;
  homepage: null | string;
  id: number;
  language: null | string;
  license: null | string;
  open_issues_count: number;
  owner: string;
  pushed_at: null | string;
  repo: string;
  stargazers_count: number;
  topics: string[];
}

export interface RepoIdentifier {
  owner: string;
  repo: string;
}

/**
 * Exported for unit testing; wired into the throttling plugin by `makeOctokit`.
 *
 * `maxWaitSeconds` caps how long a single retry will wait for a rate-limit
 * reset. It defaults to 300s: the Action must self-bound its run time so a
 * workflow never hangs on a limit it cannot service. Longer-lived callers raise
 * it to wait out a reset instead of aborting into an unrecoverable 403.
 *
 * `maxRetries` bounds the rate-limit retry budget reported here and matches the
 * transport-retry count set in `makeOctokit`, so the two budgets stay aligned.
 */
export function createRateLimitHandler(
  kind: 'primary' | 'secondary',
  log: Logger = consoleLog,
  maxWaitSeconds: number = DEFAULT_MAX_WAIT_TIME_SECONDS,
  maxRetries: number = MAX_RETRIES,
) {
  return (
    retryAfter: number,
    reqOptions: { method: string; url: string },
    _octokit: unknown,
    retryCount: number,
  ): boolean => {
    const where = `${reqOptions.method} ${reqOptions.url}`;

    if (retryAfter > maxWaitSeconds) {
      log.error(
        `${kind} rate limit retry-after (${retryAfter}s) exceeds the maximum wait time of ${maxWaitSeconds}s. Aborting retries for ${where}.`,
      );
      return false;
    }

    if (retryCount >= maxRetries) {
      log.error(
        `Giving up on ${where} after ${maxRetries} ${kind} rate-limit retries.`,
      );
      return false;
    }

    log.warn(
      `${kind} rate limit hit for ${where}. Waiting ${retryAfter}s before retry ${retryCount + 1}/${maxRetries}.`,
    );
    return true;
  };
}

// All throttling groups share Bottleneck's Group type. The plugin only types
// `write`/`search`/`notifications`, but `global` and `auth` are honored at
// runtime too, so reuse the typed member as the Group token for all five —
// `bottleneck` stays a transitive concern, not a public one.
type ThrottleGroup = NonNullable<ThrottlingOptions['write']>;

/**
 * Pass-through overrides for `@octokit/plugin-throttling`. The plugin's groups
 * are process-wide singletons by default; supplying your own detaches this
 * client so its limits apply per-instance instead of being shared across every
 * Octokit in the process.
 */
export interface ThrottleOptions {
  auth?: ThrottleGroup;
  /** Secondary-rate-limit retry wait in seconds when the response carries no retry-after header (plugin default 60). */
  fallbackSecondaryRateRetryAfter?: number;
  global?: ThrottleGroup;
  notifications?: ThrottleGroup;
  search?: ThrottleGroup;
  /** Per-request Bottleneck timeout in ms (plugin default 120_000). */
  timeout?: number;
  write?: ThrottleGroup;
}

/**
 * Tuning for the hardened client built by `makeOctokit`. All fields optional;
 * omitting the bag yields the Action defaults — `consoleLog`, 3 retries, a 300s
 * rate-limit cap, and the throttling plugin's built-in limits.
 */
export interface MakeOctokitOptions {
  /** Sink for debug/warn/error; defaults to `consoleLog`. */
  log?: Logger;
  /** Transport and rate-limit retry budget (default 3). */
  maxRetries?: number;
  /** Rate-limit retry-wait cap in seconds (default 300); see `createRateLimitHandler`. */
  maxWaitSeconds?: number;
  /** Throttling overrides forwarded into the plugin's `throttle` config. */
  throttle?: ThrottleOptions;
}

/**
 * The client is where the sink lives: Octokit takes a `log` and exposes it as
 * `octokit.log`, so every function below reaches it through the client it is
 * already given, instead of taking a logger of its own.
 */
export function makeOctokit(
  token: string,
  {
    log = consoleLog,
    maxRetries = MAX_RETRIES,
    maxWaitSeconds,
    throttle,
  }: MakeOctokitOptions = {},
): GithubClient {
  const options: OctokitOptions = {
    log,
    // The throttling plugin owns rate-limit (403/429) retries, so keep them out
    // of the retry plugin to avoid double-handling.
    retry: {
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
      retries: maxRetries,
    },
    // `throttle` spreads first so the rate-limit handlers below always win — a
    // caller can tune Bottleneck, never replace the hardened retry policy.
    throttle: {
      ...throttle,
      onRateLimit: createRateLimitHandler(
        'primary',
        log,
        maxWaitSeconds,
        maxRetries,
      ),
      onSecondaryRateLimit: createRateLimitHandler(
        'secondary',
        log,
        maxWaitSeconds,
        maxRetries,
      ),
    },
  };

  return token
    ? new HardenedOctokit({ ...options, auth: token })
    : new HardenedOctokit(options);
}

export async function getRepoInfo(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<RepoInfoDetails> {
  octokit.log.debug(`Fetching repository info for ${owner}/${repo}`);
  const { data } = await octokit.rest.repos.get({ owner, repo });

  return {
    archived: data.archived,
    description: data.description ?? null,
    homepage: data.homepage || null,
    id: data.id,
    language: data.language,
    license: data.license?.spdx_id ?? null,
    open_issues_count: data.open_issues_count,
    owner: data.owner.login,
    pushed_at: data.pushed_at,
    repo: data.name,
    stargazers_count: data.stargazers_count,
    topics: data.topics ?? [],
  };
}

/**
 * The repo's full info, for the JSON metadata — the numeric id consumers key
 * stable node ids on, plus the stars/language/last_commit the root's own
 * metadata row is built from. Returns null (logged) instead of failing the
 * run: metadata is not a gate; consumers fall back when it is missing.
 */
export async function getRepoInfoOrNull(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<null | RepoInfoDetails> {
  try {
    return await getRepoInfo(octokit, owner, repo);
  } catch (error: unknown) {
    octokit.log.error(
      `Failed to fetch repo info for ${owner}/${repo}: ${formatRequestError(error)}`,
    );
    return null;
  }
}

export async function getReadme(
  octokit: GithubClient,
  owner: string,
  repo: string,
  format: 'html' | 'raw' = 'raw',
): Promise<string> {
  octokit.log.debug(`Fetching ${format} README for ${owner}/${repo}`);
  const response = await octokit.rest.repos.getReadme({
    mediaType: { format },
    owner,
    repo,
  });

  // With `raw`/`html` media types the body is a string, but the generated types
  // still describe the JSON shape - cast to string.
  return response.data as unknown as string;
}

/** Root file/directory names — the compile-manifest gate reads them to tell a
 * directory of resources from a repo that IS the deliverable. A `path: ''`
 * listing is always an array; the single-entry branch defends against a file
 * response. */
export async function getRootEntryNames(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<string[]> {
  octokit.log.debug(`Listing root directory for ${owner}/${repo}`);
  const { data } = await octokit.rest.repos.getContent({
    owner,
    path: '',
    repo,
  });
  const entries = Array.isArray(data) ? data : [data];
  return entries.map(entry => entry.name);
}

/** Source revision for the JSON output, so an enhanced list is traceable to its origin commit. */
export async function getLatestCommitSha(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<null | string> {
  try {
    octokit.log.debug(`Fetching latest commit SHA for ${owner}/${repo}`);
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      per_page: 1,
      repo,
    });

    return data[0]?.sha ?? null;
  } catch (error: unknown) {
    octokit.log.error(
      `Failed to fetch latest commit for ${owner}/${repo}: ${formatRequestError(error)}`,
    );
    return null;
  }
}

export function parseOwnerRepo(value: string): null | RepoIdentifier {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('github.com')) {
    const url = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    return parseGitHubUrl(url);
  }

  const parts = trimmed.split('/').filter(part => part.length > 0);
  if (parts.length !== 2) {
    return null;
  }

  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}

export function parseGitHubUrl(url: string): null | RepoIdentifier {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname !== 'github.com') {
      return null;
    }
    const pathParts = parsedUrl.pathname
      .split('/')
      .filter(part => part.length > 0);
    if (pathParts.length >= 2) {
      const owner = pathParts[0],
        repo = pathParts[1].replace(/\.git$/, '');
      return { owner, repo };
    }
    return null;
  } catch {
    // A relative or malformed href is simply not a GitHub repo link, which is
    // the routine case for most links in a README — not a diagnostic.
    return null;
  }
}

export function formatRequestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = getErrorStatus(error);
  return status === undefined ? message : `${status}: ${message}`;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!!error && typeof error === 'object' && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' && status > 0 ? status : undefined;
  }
  return undefined;
}
