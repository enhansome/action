import * as core from '@actions/core';
import { RequestError } from '@octokit/request-error';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRateLimitHandler,
  getLatestCommitSha,
  getReadme,
  getRepoInfo,
  GithubClient,
  makeOctokit,
  parseGitHubUrl,
  parseOwnerRepo,
  RepoInfoDetails,
} from './github.js';

vi.mock(import('@actions/core'), async importOriginal => {
  const mod = await importOriginal();
  return {
    ...mod,

    debug: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  };
});

// --- Tiny fake Octokit -----------------------------------------------------
// Dispatches by REST method name (e.g. 'repos.get'); each handler returns the
// value placed in res.data, or throws to simulate a RequestError. Lets us test
// getRepoInfo / getReadme as pure transforms over the client, without fetch
// stubbing or fighting the throttling plugin's Bottleneck timers.

type Handler = (params: Record<string, unknown>) => unknown;

function mockOctokit(handlers: Record<string, Handler>): GithubClient {
  function createMethod(group: string, name: string) {
    return vi.fn(async (params: Record<string, unknown> = {}) => {
      const method = `${group}.${name}`;
      const handler = handlers[method] as Handler | undefined;
      if (!handler) {
        throw new Error(`Unhandled mock method: ${method}`);
      }
      const data = await handler(params);
      return { data, headers: {}, status: 200, url: method };
    });
  }

  const client = {
    rest: {
      repos: {
        get: createMethod('repos', 'get'),
        getReadme: createMethod('repos', 'getReadme'),
        listCommits: createMethod('repos', 'listCommits'),
      },
    },
  };

  return client as unknown as GithubClient;
}

function notFound(label: string): RequestError {
  return new RequestError(`${label}: Not Found`, 404, {
    request: { headers: {}, method: 'GET', url: label },
    response: {
      data: { message: 'Not Found' },
      headers: {},
      retryCount: 0,
      status: 404,
      url: label,
    },
  });
}

describe('github.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseGitHubUrl', () => {
    it('should parse a standard GitHub URL', () => {
      expect(parseGitHubUrl('https://github.com/owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should parse a URL with a trailing slash', () => {
      expect(parseGitHubUrl('https://github.com/owner/repo/')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should parse a URL with a .git suffix', () => {
      expect(parseGitHubUrl('https://github.com/owner/repo.git')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should parse a URL with subpaths', () => {
      expect(parseGitHubUrl('https://github.com/owner/repo/issues/1')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should return null for non-GitHub URLs', () => {
      expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
    });

    it('should return null for invalid URLs', () => {
      expect(parseGitHubUrl('not-a-url')).toBeNull();
    });
  });

  describe('parseOwnerRepo', () => {
    it('should parse owner/repo shorthand', () => {
      expect(parseOwnerRepo('owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should trim surrounding whitespace', () => {
      expect(parseOwnerRepo('  owner/repo  ')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should parse a full GitHub URL', () => {
      expect(parseOwnerRepo('https://github.com/owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should parse a scheme-less github.com URL', () => {
      expect(parseOwnerRepo('github.com/owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should strip a .git suffix from shorthand', () => {
      expect(parseOwnerRepo('owner/repo.git')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('should reject a bare owner', () => {
      expect(parseOwnerRepo('owner')).toBeNull();
    });

    it('should reject empty input', () => {
      expect(parseOwnerRepo('')).toBeNull();
      expect(parseOwnerRepo('   ')).toBeNull();
    });

    it('should reject more than two path parts', () => {
      expect(parseOwnerRepo('owner/repo/extra')).toBeNull();
    });
  });

  describe('createRateLimitHandler', () => {
    const reqOptions = { method: 'GET', url: '/repos/o/r' };

    it('retries (returns true) while under the cap and within budget', () => {
      const handler = createRateLimitHandler('primary');
      expect(handler(10, reqOptions, null, 0)).toBe(true);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('primary rate limit hit'),
      );
    });

    it('aborts (returns false) when retry-after exceeds the max wait', () => {
      const handler = createRateLimitHandler('primary');
      expect(handler(301, reqOptions, null, 0)).toBe(false);
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining('exceeds the maximum wait time of 300s'),
      );
    });

    it('gives up (returns false) once the retry budget is exhausted', () => {
      const handler = createRateLimitHandler('secondary');
      expect(handler(10, reqOptions, null, 3)).toBe(false);
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining('after 3 secondary rate-limit retries'),
      );
    });
  });

  describe('makeOctokit', () => {
    it('builds an authenticated client without throwing', () => {
      const client = makeOctokit('test-token');
      expect(typeof client.rest.repos.get).toBe('function');
    });

    it('builds an anonymous client when token is empty', () => {
      const client = makeOctokit('');
      expect(typeof client.rest.repos.get).toBe('function');
    });
  });

  describe('getRepoInfo', () => {
    const owner = 'test-owner';
    const repo = 'test-repo';
    const mockRepoInfo: RepoInfoDetails = {
      archived: false,
      language: 'TypeScript',
      open_issues_count: 42,
      owner: 'test-owner',
      pushed_at: '2025-06-29T10:00:00Z',
      repo: 'test-repo',
      stargazers_count: 1234,
    };

    const apiPayload = {
      archived: mockRepoInfo.archived,
      language: mockRepoInfo.language,
      name: mockRepoInfo.repo,
      open_issues_count: mockRepoInfo.open_issues_count,
      owner: { login: mockRepoInfo.owner },
      pushed_at: mockRepoInfo.pushed_at,
      stargazers_count: mockRepoInfo.stargazers_count,
    };

    it('should return mapped repo info on success', async () => {
      const client = mockOctokit({ 'repos.get': () => apiPayload });

      const result = await getRepoInfo(client, owner, repo);

      expect(result).toEqual(mockRepoInfo);
    });

    it('should return null on a non-retriable error and log the status', async () => {
      const client = mockOctokit({
        'repos.get': () => {
          throw notFound(`${owner}/${repo}`);
        },
      });

      const result = await getRepoInfo(client, owner, repo);

      expect(result).toBeNull();
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to fetch repo info for ${owner}/${repo}`,
        ),
      );
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining('(Status: 404)'),
      );
    });

    it('should map undefined properties for partial API responses', async () => {
      const client = mockOctokit({
        'repos.get': () => ({
          archived: true,
          name: 'test-repo',
          owner: { login: 'test-owner' },
        }),
      });

      const result = await getRepoInfo(client, owner, repo);

      expect(result).toEqual({
        archived: true,
        language: undefined,
        open_issues_count: undefined,
        owner: 'test-owner',
        pushed_at: undefined,
        repo: 'test-repo',
        stargazers_count: undefined,
      });
      expect(core.warning).not.toHaveBeenCalled();
    });

    it('should fetch real repository info from GitHub API for a sanity check', async () => {
      const realToken = process.env.GITHUB_TOKEN ?? '';
      if (!realToken) {
        core.warning(
          'Running integration test without a GITHUB_TOKEN. This may be rate-limited.',
        );
      }

      const result = await getRepoInfo(
        makeOctokit(realToken),
        'microsoft',
        'vscode',
      );

      expect(result).not.toBeNull();
      if (!result) {
        throw new Error('Test failed: getRepoInfo returned null');
      }

      expect(result.archived).toBe(false);
      expect(typeof result.stargazers_count).toBe('number');
      expect(result.stargazers_count).toBeGreaterThan(100000);
      expect(typeof result.open_issues_count).toBe('number');
      expect(result.language).toBe('TypeScript');
      expect(result.pushed_at).toEqual(expect.any(String));
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(new Date(result.pushed_at!).toString()).not.toBe('Invalid Date');
      expect(result.owner).toBe('microsoft');
      expect(result.repo).toBe('vscode');
    }, 15000);
  });

  describe('getReadme', () => {
    const owner = 'test-owner';
    const repo = 'test-repo';
    const markdown = '# Awesome Things\n\n- item one\n';

    it('should return the raw README markdown on success', async () => {
      const getReadmeMock = vi.fn(() => markdown);
      const client = mockOctokit({ 'repos.getReadme': getReadmeMock });

      const result = await getReadme(client, owner, repo);

      expect(result).toBe(markdown);
      // Must request the raw media type so the body is the markdown text.
      expect(getReadmeMock).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType: { format: 'raw' }, owner, repo }),
      );
    });

    it('should return null when the repo has no README (404)', async () => {
      const client = mockOctokit({
        'repos.getReadme': () => {
          throw notFound(`${owner}/${repo}`);
        },
      });

      const result = await getReadme(client, owner, repo);

      expect(result).toBeNull();
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to fetch README for ${owner}/${repo}`),
      );
    });
  });

  describe('getLatestCommitSha', () => {
    const owner = 'test-owner';
    const repo = 'test-repo';

    it('should return the SHA of the most recent commit', async () => {
      const listCommitsMock = vi.fn(() => [{ sha: 'deadbeef' }]);
      const client = mockOctokit({ 'repos.listCommits': listCommitsMock });

      const result = await getLatestCommitSha(client, owner, repo);

      expect(result).toBe('deadbeef');
      // Only the latest commit is needed.
      expect(listCommitsMock).toHaveBeenCalledWith(
        expect.objectContaining({ owner, per_page: 1, repo }),
      );
    });

    it('should return null when the repo has no commits', async () => {
      const client = mockOctokit({ 'repos.listCommits': () => [] });

      const result = await getLatestCommitSha(client, owner, repo);

      expect(result).toBeNull();
    });

    it('should return null and log the status on a request error', async () => {
      const client = mockOctokit({
        'repos.listCommits': () => {
          throw notFound(`${owner}/${repo}`);
        },
      });

      const result = await getLatestCommitSha(client, owner, repo);

      expect(result).toBeNull();
      expect(core.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to fetch latest commit for ${owner}/${repo}`,
        ),
      );
    });
  });
});
