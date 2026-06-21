import * as core from '@actions/core';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRepoInfo, parseGitHubUrl, RepoInfoDetails } from './github.js';

vi.mock(import('@actions/core'), async importOriginal => {
  const mod = await importOriginal();
  return {
    ...mod,

    debug: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  };
});

describe('github.ts', () => {
  let mockAxios: MockAdapter;

  beforeEach(() => {
    mockAxios = new MockAdapter(axios);
    vi.useFakeTimers();
    vi.clearAllMocks(); // Clear mocks before each test
  });

  afterEach(() => {
    mockAxios.restore();
    vi.useRealTimers();
  });

  describe('parseGitHubUrl', () => {
    it('should parse a standard GitHub URL', () => {
      const url = 'https://github.com/owner/repo';
      expect(parseGitHubUrl(url)).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse a URL with a trailing slash', () => {
      const url = 'https://github.com/owner/repo/';
      expect(parseGitHubUrl(url)).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse a URL with a .git suffix', () => {
      const url = 'https://github.com/owner/repo.git';
      expect(parseGitHubUrl(url)).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse a URL with subpaths', () => {
      const url = 'https://github.com/owner/repo/issues/1';
      expect(parseGitHubUrl(url)).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should return null for non-GitHub URLs', () => {
      const url = 'https://gitlab.com/owner/repo';
      expect(parseGitHubUrl(url)).toBeNull();
    });

    it('should return null for invalid URLs', () => {
      const url = 'not-a-url';
      expect(parseGitHubUrl(url)).toBeNull();
    });
  });

  describe('getRepoInfo', () => {
    const owner = 'test-owner';
    const repo = 'test-repo';
    const token = 'test-token';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const mockRepoInfo: RepoInfoDetails = {
      archived: false,
      language: 'TypeScript',
      open_issues_count: 42,
      owner: 'test-owner',
      pushed_at: '2025-06-29T10:00:00Z',
      repo: 'test-repo',
      stargazers_count: 1234,
    };

    it('should return repo info on successful API call', async () => {
      mockAxios.onGet(apiUrl).reply(200, {
        archived: mockRepoInfo.archived,
        language: mockRepoInfo.language,
        name: mockRepoInfo.repo,
        open_issues_count: mockRepoInfo.open_issues_count,
        owner: { login: mockRepoInfo.owner },
        pushed_at: mockRepoInfo.pushed_at,
        stargazers_count: mockRepoInfo.stargazers_count,
      });

      const result = await getRepoInfo(owner, repo, token);
      expect(result).toEqual(mockRepoInfo);
    });

    it('should return null if API call fails with a non-retriable error', async () => {
      mockAxios.onGet(apiUrl).reply(404, { message: 'Not Found' });

      const result = await getRepoInfo(owner, repo, token);
      expect(result).toBeNull();
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to fetch repo info for ${owner}/${repo}: Request failed with status code 404 (Status: 404)`,
        ),
      );
    });

    it('should return info with undefined properties for partial API responses', async () => {
      mockAxios.onGet(apiUrl).reply(200, {
        archived: true,
        // Intentionally partial response
        name: 'test-repo',
        owner: { login: 'test-owner' },
      });

      const result = await getRepoInfo(owner, repo, token);
      expect(result).toEqual({
        archived: true,
        language: undefined,
        open_issues_count: undefined,
        owner: 'test-owner',
        pushed_at: undefined,
        repo: 'test-repo',
        stargazers_count: undefined,
      });
      // In the new implementation, this is not a warning condition
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('should retry on a 403 rate-limit error and then succeed', async () => {
      const resetTime = Math.floor(Date.now() / 1000) + 2; // 2 seconds in the future

      mockAxios
        .onGet(apiUrl)
        .replyOnce(
          403,
          { message: 'API rate limit exceeded' },
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetTime),
          },
        )
        .onGet(apiUrl)
        .replyOnce(200, {
          archived: mockRepoInfo.archived,
          language: mockRepoInfo.language,
          name: mockRepoInfo.repo,
          open_issues_count: mockRepoInfo.open_issues_count,
          owner: { login: mockRepoInfo.owner },
          pushed_at: mockRepoInfo.pushed_at,
          stargazers_count: mockRepoInfo.stargazers_count,
        });

      const getInfoPromise = getRepoInfo(owner, repo, token);
      await vi.advanceTimersToNextTimerAsync();
      const result = await getInfoPromise;

      expect(result).toEqual(mockRepoInfo);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Primary rate limit hit'),
      );
      expect(mockAxios.history.get.length).toBe(2);
    });

    it('should respect the Retry-After header on a 429 error and then succeed', async () => {
      mockAxios
        .onGet(apiUrl)
        .replyOnce(429, { message: 'Throttled' }, { 'retry-after': '2' })
        .onGet(apiUrl)
        .replyOnce(200, {
          archived: mockRepoInfo.archived,
          language: mockRepoInfo.language,
          name: mockRepoInfo.repo,
          open_issues_count: mockRepoInfo.open_issues_count,
          owner: { login: mockRepoInfo.owner },
          pushed_at: mockRepoInfo.pushed_at,
          stargazers_count: mockRepoInfo.stargazers_count,
        });

      const getInfoPromise = getRepoInfo(owner, repo, token);
      await vi.advanceTimersByTimeAsync(3000);
      const result = await getInfoPromise;

      expect(result).toEqual(mockRepoInfo);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          `Request for ${owner}/${repo} was throttled (Status: 429)`,
        ),
      );
      expect(mockAxios.history.get.length).toBe(2);
    });

    it('should return null after exhausting all retries on persistent rate limit', async () => {
      mockAxios.onGet(apiUrl).reply(
        403,
        { message: 'API rate limit exceeded' },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1),
        },
      );

      const getInfoPromise = getRepoInfo(owner, repo, token);
      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();
      const result = await getInfoPromise;

      expect(result).toBeNull();
      expect(mockAxios.history.get.length).toBe(3);
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to fetch repo info for ${owner}/${repo} after 3 attempts.`,
        ),
      );
    });

    it('should abort retries if wait time exceeds MAX_WAIT_TIME_SECONDS', async () => {
      mockAxios.onGet(apiUrl).replyOnce(
        429,
        { message: 'Throttled for a very long time' },
        { 'retry-after': '301' }, // > MAX_WAIT_TIME_SECONDS (300)
      );

      const result = await getRepoInfo(owner, repo, token);

      expect(result).toBeNull();
      expect(mockAxios.history.get.length).toBe(1);
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(`exceeds the maximum wait time of 300s`),
      );
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to fetch repo info for ${owner}/${repo} after 3 attempts.`,
        ),
      );
    });

    it('should fetch real repository info from GitHub API for a sanity check', async () => {
      mockAxios.restore();

      const token = process.env.GITHUB_TOKEN ?? '';
      if (!token) {
        core.warning(
          'Running integration test without a GITHUB_TOKEN. This may be rate-limited.',
        );
      }

      const owner = 'microsoft';
      const repo = 'vscode';

      const result = await getRepoInfo(owner, repo, token); // If the test fails here, it might be due to network issues or rate-limiting.

      expect(result).not.toBeNull();
      if (!result) {
        throw new Error('Test failed: getRepoInfo returned null');
      } // Assert on the structure and types of the data, not exact values

      expect(result.archived).toBe(false);
      expect(typeof result.stargazers_count).toBe('number');
      expect(result.stargazers_count).toBeGreaterThan(100000);
      expect(typeof result.open_issues_count).toBe('number');
      expect(result.language).toBe('TypeScript');
      expect(result.pushed_at).toEqual(expect.any(String)); // Check if pushed_at is a valid ISO 8601 date string
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(new Date(result.pushed_at!).toString()).not.toBe('Invalid Date');
      expect(result.owner).toBe('microsoft');
      expect(result.repo).toBe('vscode');
    }, 15000); // Increased timeout for a real network request
  });
});
