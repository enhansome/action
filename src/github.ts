import * as core from '@actions/core';
import axios, { AxiosError } from 'axios';

const GITHUB_API_URL = 'https://api.github.com',
  MAX_RETRIES = 3,
  MAX_WAIT_TIME_SECONDS = 300; // 5 minutes

export interface RepoInfoDetails {
  archived: boolean;
  language: null | string;
  open_issues_count: number;
  owner: string;
  pushed_at: null | string;
  repo: string;
  stargazers_count: number;
}

interface GitHubApiRepoResponse {
  archived: boolean;
  language: null | string;
  name: string;
  open_issues_count: number;
  owner: GitHubOwner;
  pushed_at: null | string;
  stargazers_count: number;
}

interface GitHubOwner {
  login: string;
}

interface RepoIdentifier {
  owner: string;
  repo: string;
}

/**
 * Fetches rich repository information with robust, compliant retry logic.
 * @param owner The repository owner.
 * @param repo The repository name.
 * @param token GitHub API token.
 * @returns A RepoInfoDetails object or null if an error occurs.
 */
export async function getRepoInfo(
  owner: string,
  repo: string,
  token: string,
): Promise<null | RepoInfoDetails> {
  const repoUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      core.debug(
        `Fetching repository info for ${owner}/${repo} (Attempt ${attempt}/${MAX_RETRIES})`,
      );

      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await axios.get<GitHubApiRepoResponse>(repoUrl, {
        headers,
      });

      if (response.status === 200) {
        const { data } = response;

        return {
          archived: data.archived,
          language: data.language,
          open_issues_count: data.open_issues_count,
          owner: data.owner.login,
          pushed_at: data.pushed_at,
          repo: data.name,
          stargazers_count: data.stargazers_count,
        };
      }
      core.warning(
        `Received an unexpected successful response for ${owner}/${repo}. Data: ${JSON.stringify(
          response.data,
        )}`,
      );
      return null;
    } catch (error: unknown) {
      if (attempt === MAX_RETRIES) {
        break;
      }

      function isAxiosError(error: unknown): error is AxiosError {
        return !!error && typeof error === 'object' && 'response' in error;
      }

      if (isAxiosError(error) && error.response) {
        const { headers } = error.response,
          { status } = error.response;
        let waitTimeSeconds = 0;

        // Guideline 1: Prioritize the 'Retry-After' header if present (sent with 403 or 429).
        if (headers['retry-after']) {
          waitTimeSeconds = Number(headers['retry-after']) + 1; // Add 1s buffer
          core.warning(
            `Request for ${owner}/${repo} was throttled (Status: ${status}). Respecting 'Retry-After' header. Waiting ${waitTimeSeconds} seconds.`,
          );
        }
        // Guideline 2: Fallback to primary rate limit headers for 403 or 429 status codes.
        else if (
          (status === 403 || status === 429) &&
          headers['x-ratelimit-remaining'] === '0' &&
          headers['x-ratelimit-reset']
        ) {
          const currentTime = Math.floor(Date.now() / 1000),
            resetTimestamp = Number(headers['x-ratelimit-reset']);
          waitTimeSeconds = Math.max(0, resetTimestamp - currentTime) + 1; // Add 1s buffer
          core.warning(
            `Primary rate limit hit for ${owner}/${repo} (Status: ${status}). Waiting for reset in ${waitTimeSeconds} seconds.`,
          );
        }

        // If we have a calculated wait time, sleep and retry.
        if (waitTimeSeconds > 0) {
          if (waitTimeSeconds > MAX_WAIT_TIME_SECONDS) {
            core.error(
              `Rate limit reset time (${waitTimeSeconds}s) exceeds the maximum wait time of ${MAX_WAIT_TIME_SECONDS}s. Aborting retries for this URL.`,
            );
            break;
          }

          await sleep(waitTimeSeconds * 1000);
          continue;
        }
      }

      // If we get here, it's a non-retriable error. Log it and exit immediately.
      if (isAxiosError(error) && error.response) {
        core.error(
          `Failed to fetch repo info for ${owner}/${repo}: ${error.message} (Status: ${error.response.status})`,
        );
        core.debug(`Response Data: ${JSON.stringify(error.response.data)}`);
      } else {
        core.error(
          `Network error fetching repo info for ${owner}/${repo}: ${error instanceof Error ? error.message : error}`,
        );
      }
      return null;
    }
  }

  core.error(
    `Failed to fetch repo info for ${owner}/${repo} after ${MAX_RETRIES} attempts.`,
  );
  return null;
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
 * A simple sleep utility.
 * @param ms Milliseconds to wait.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
