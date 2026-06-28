import * as core from '@actions/core';
import { getOctokitOptions, GitHub } from '@actions/github/lib/utils';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

import type { OctokitOptions } from '@octokit/core';

const MAX_RETRIES = 3,
  MAX_WAIT_TIME_SECONDS = 300; // 5 minutes

// Octokit core (from @actions/github) hardened with the retry + throttling
// plugins. The throttling plugin is the battle-tested replacement for the
// hand-rolled `Retry-After` / `x-ratelimit-*` loop this module used to carry.
const HardenedOctokit = GitHub.plugin(retry, throttling);

/** A fully-wired Octokit client (rest endpoints + retry + throttling). */
export type GithubClient = InstanceType<typeof HardenedOctokit>;

export interface RepoInfoDetails {
  archived: boolean;
  language: null | string;
  open_issues_count: number;
  owner: string;
  pushed_at: null | string;
  repo: string;
  stargazers_count: number;
}

interface RepoIdentifier {
  owner: string;
  repo: string;
}

/**
 * Decides whether a rate-limited request should be retried and logs the
 * outcome. Preserves the old `MAX_WAIT_TIME_SECONDS` cap intent: a reset that
 * is further out than the cap is abandoned rather than waited on.
 *
 * Exported for unit testing - wired into the throttling plugin by `makeOctokit`.
 * @param kind 'primary' or 'secondary' rate limit (for log wording).
 * @returns true to retry, false to give up.
 */
export function createRateLimitHandler(kind: 'primary' | 'secondary') {
  return (
    retryAfter: number,
    reqOptions: { method: string; url: string },
    _octokit: unknown,
    retryCount: number,
  ): boolean => {
    const where = `${reqOptions.method} ${reqOptions.url}`;

    if (retryAfter > MAX_WAIT_TIME_SECONDS) {
      core.error(
        `${kind} rate limit retry-after (${retryAfter}s) exceeds the maximum wait time of ${MAX_WAIT_TIME_SECONDS}s. Aborting retries for ${where}.`,
      );
      return false;
    }

    if (retryCount >= MAX_RETRIES) {
      core.error(
        `Giving up on ${where} after ${MAX_RETRIES} ${kind} rate-limit retries.`,
      );
      return false;
    }

    core.warning(
      `${kind} rate limit hit for ${where}. Waiting ${retryAfter}s before retry ${retryCount + 1}/${MAX_RETRIES}.`,
    );
    return true;
  };
}

/**
 * Builds an Octokit client wired with the retry + throttling plugins.
 * When `token` is non-empty the client is authenticated; when empty an
 * anonymous client is returned (public, lower rate limit).
 * @param token GitHub API token, or '' for anonymous access.
 */
export function makeOctokit(token: string): GithubClient {
  const options: OctokitOptions = {
    // The throttling plugin owns rate-limit (403/429) retries, so keep them out
    // of the retry plugin to avoid double-handling.
    retry: {
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
      retries: MAX_RETRIES,
    },
    throttle: {
      onRateLimit: createRateLimitHandler('primary'),
      onSecondaryRateLimit: createRateLimitHandler('secondary'),
    },
  };

  return token
    ? new HardenedOctokit(getOctokitOptions(token, options))
    : new HardenedOctokit(options);
}

/**
 * Fetches rich repository information. Retry / rate-limit handling is delegated
 * to the Octokit retry + throttling plugins on the injected client.
 * @param octokit A client from `makeOctokit`.
 * @param owner The repository owner.
 * @param repo The repository name.
 * @returns A RepoInfoDetails object or null if a non-retriable error occurs.
 */
export async function getRepoInfo(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<null | RepoInfoDetails> {
  try {
    core.debug(`Fetching repository info for ${owner}/${repo}`);
    const { data } = await octokit.rest.repos.get({ owner, repo });

    return {
      archived: data.archived,
      language: data.language,
      open_issues_count: data.open_issues_count,
      owner: data.owner.login,
      pushed_at: data.pushed_at,
      repo: data.name,
      stargazers_count: data.stargazers_count,
    };
  } catch (error: unknown) {
    logRequestError(`repo info for ${owner}/${repo}`, error);
    return null;
  }
}

/**
 * Fetches the raw README markdown for a repository.
 * Uses the `raw` media type so the response body *is* the markdown text
 * (no base64 decode required).
 * @param octokit A client from `makeOctokit`.
 * @param owner The repository owner.
 * @param repo The repository name.
 * @returns The README markdown, or null if none exists / a request fails.
 */
export async function getReadme(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<null | string> {
  try {
    core.debug(`Fetching README for ${owner}/${repo}`);
    const response = await octokit.rest.repos.getReadme({
      mediaType: { format: 'raw' },
      owner,
      repo,
    });

    // With the `raw` media type the body is the markdown string, but the
    // generated types still describe the JSON shape - cast to string.
    return response.data as unknown as string;
  } catch (error: unknown) {
    logRequestError(`README for ${owner}/${repo}`, error);
    return null;
  }
}

/**
 * Fetches the SHA of the latest commit on a repository's default branch.
 * Used to stamp `README.json` with the exact source revision an enhanced list
 * was generated from.
 * @param octokit A client from `makeOctokit`.
 * @param owner The repository owner.
 * @param repo The repository name.
 * @returns The 40-char commit SHA, or null if it cannot be determined.
 */
export async function getLatestCommitSha(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<null | string> {
  try {
    core.debug(`Fetching latest commit SHA for ${owner}/${repo}`);
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      per_page: 1,
      repo,
    });

    return data[0]?.sha ?? null;
  } catch (error: unknown) {
    logRequestError(`latest commit for ${owner}/${repo}`, error);
    return null;
  }
}

/**
 * Parses an `original_repository` input into owner/repo.
 * Accepts either `owner/repo` or a full GitHub URL
 * (`https://github.com/owner/repo`, with or without scheme). Strict: rejects
 * a bare owner, empty input, and anything that is not exactly two path parts.
 * @param value The raw input value.
 * @returns RepoIdentifier or null if it cannot be parsed.
 */
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

/**
 * Parses a GitHub repository URL to extract owner and repo name.
 * Supports URLs like:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo/issues
 * @param url The GitHub URL.
 * @returns RepoIdentifier object or null if parsing fails.
 */
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
        repo = pathParts[1].replace(/\.git$/, ''); // Remove .git suffix if present
      return { owner, repo };
    }
    return null;
  } catch (error) {
    core.debug(`Failed to parse URL ${url}: ${error}`);
    return null;
  }
}

/**
 * Logs a failed request, surfacing the HTTP status when the error is an
 * Octokit RequestError and falling back to a generic network-error message.
 */
function logRequestError(subject: string, error: unknown): void {
  const status = getErrorStatus(error);
  const message = error instanceof Error ? error.message : String(error);

  if (status !== undefined) {
    core.error(`Failed to fetch ${subject}: ${message} (Status: ${status})`);
  } else {
    core.error(`Network error fetching ${subject}: ${message}`);
  }
}

function getErrorStatus(error: unknown): number | undefined {
  if (!!error && typeof error === 'object' && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
