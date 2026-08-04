import { getOctokitOptions, GitHub } from '@actions/github/lib/utils';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import { consoleLog, Logger } from './logger.js';

import type { OctokitOptions } from '@octokit/core';

const MAX_RETRIES = 3,
  MAX_WAIT_TIME_SECONDS = 300;

const HardenedOctokit = GitHub.plugin(retry, throttling);

export type GithubClient = InstanceType<typeof HardenedOctokit>;

export interface RepoInfoDetails {
  archived: boolean;
  description: null | string;
  language: null | string;
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

/** Exported for unit testing; wired into the throttling plugin by `makeOctokit`. */
export function createRateLimitHandler(
  kind: 'primary' | 'secondary',
  log: Logger = consoleLog,
) {
  return (
    retryAfter: number,
    reqOptions: { method: string; url: string },
    _octokit: unknown,
    retryCount: number,
  ): boolean => {
    const where = `${reqOptions.method} ${reqOptions.url}`;

    if (retryAfter > MAX_WAIT_TIME_SECONDS) {
      log.error(
        `${kind} rate limit retry-after (${retryAfter}s) exceeds the maximum wait time of ${MAX_WAIT_TIME_SECONDS}s. Aborting retries for ${where}.`,
      );
      return false;
    }

    if (retryCount >= MAX_RETRIES) {
      log.error(
        `Giving up on ${where} after ${MAX_RETRIES} ${kind} rate-limit retries.`,
      );
      return false;
    }

    log.warn(
      `${kind} rate limit hit for ${where}. Waiting ${retryAfter}s before retry ${retryCount + 1}/${MAX_RETRIES}.`,
    );
    return true;
  };
}

/**
 * The client is where the sink lives: Octokit takes a `log` and exposes it as
 * `octokit.log`, so every function below reaches it through the client it is
 * already given, instead of taking a logger of its own.
 */
export function makeOctokit(
  token: string,
  log: Logger = consoleLog,
): GithubClient {
  const options: OctokitOptions = {
    log,
    // The throttling plugin owns rate-limit (403/429) retries, so keep them out
    // of the retry plugin to avoid double-handling.
    retry: {
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
      retries: MAX_RETRIES,
    },
    throttle: {
      onRateLimit: createRateLimitHandler('primary', log),
      onSecondaryRateLimit: createRateLimitHandler('secondary', log),
    },
  };

  return token
    ? new HardenedOctokit(getOctokitOptions(token, options))
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
    language: data.language,
    open_issues_count: data.open_issues_count,
    owner: data.owner.login,
    pushed_at: data.pushed_at,
    repo: data.name,
    stargazers_count: data.stargazers_count,
    topics: data.topics ?? [],
  };
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
