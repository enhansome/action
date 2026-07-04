import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as github from './github.js';
import { RepoInfoDetails } from './github.js';
import {
  fetchAllRepoInfo,
  processMarkdownContent,
  ReplacementRule,
} from './markdown.js';

// Mock the modules we depend on
vi.mock('./github.js');

function findItemByTitle(
  items: { children?: unknown[]; title: string }[],
  title: string,
): undefined | { description: null | string; title: string } {
  for (const item of items) {
    if (item.title === title) {
      return item as { description: null | string; title: string };
    }
    if (item.children) {
      const nested = findItemByTitle(
        item.children as { children?: unknown[]; title: string }[],
        title,
      );
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

describe('fetchAllRepoInfo with Concurrency', () => {
  const token = 'test-token';
  const mockRepoData: RepoInfoDetails = {
    archived: false,
    language: 'TypeScript',
    open_issues_count: 5,
    owner: 'test-user',
    pushed_at: '2025-01-01T00:00:00Z',
    repo: 'test-repo',
    stargazers_count: 100,
  };

  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
      if (!url.includes('github.com')) {
        return null;
      }
      const parts = url.split('/');
      const repo = parts[parts.length - 1];
      const owner = parts[parts.length - 2];
      return { owner, repo };
    });
  });

  it('should respect the concurrency limit when fetching many URLs', async () => {
    const CONCURRENCY_LIMIT = 10; // This must match the value in fetchAllRepoInfo
    const totalUrls = 25;
    const urls = new Set(
      Array.from(
        { length: totalUrls },
        (_, i) => `https://github.com/user/repo-${i}`,
      ),
    );

    let activeRequests = 0;
    let maxConcurrentRequests = 0;

    // Mock getRepoInfo with a delay to simulate real network calls
    vi.mocked(github.getRepoInfo).mockImplementation(async () => {
      activeRequests++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay
      activeRequests--;
      return { ...mockRepoData };
    });

    const result = await fetchAllRepoInfo(urls, token);

    // 1. All URLs should have been processed successfully
    expect(result.size).toBe(totalUrls);
    expect(github.getRepoInfo).toHaveBeenCalledTimes(totalUrls);

    // 2. The number of concurrent requests should never exceed the limit
    expect(maxConcurrentRequests).toBe(CONCURRENCY_LIMIT);

    // 3. All requests should be finished by the end
    expect(activeRequests).toBe(0);
  }, 1000); // Increase timeout for this time-based test

  it('should use a concurrency level equal to the URL count if it is less than the limit', async () => {
    const totalUrls = 4;
    const urls = new Set(
      Array.from(
        { length: totalUrls },
        (_, i) => `https://github.com/user/repo-${i}`,
      ),
    );

    let activeRequests = 0;
    let maxConcurrentRequests = 0;

    vi.mocked(github.getRepoInfo).mockImplementation(async () => {
      activeRequests++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeRequests--;
      return { ...mockRepoData };
    });

    const result = await fetchAllRepoInfo(urls, token);

    expect(result.size).toBe(totalUrls);
    // Max concurrency should be the number of URLs, not the hard limit of 10
    expect(maxConcurrentRequests).toBe(totalUrls);
  });

  it('should continue processing the queue even if some fetches fail', async () => {
    const urls = new Set([
      'https://github.com/user/fail-1',
      'https://github.com/user/fail-2',
      'https://github.com/user/success-1',
      'https://github.com/user/success-2',
      'https://github.com/user/success-3',
    ]);

    vi.mocked(github.getRepoInfo).mockImplementation(
      (_octokit, _owner: string, repo: string) => {
        if (repo.startsWith('fail')) {
          throw new Error(`API failed for ${repo}`);
        }
        return Promise.resolve({ ...mockRepoData, language: repo });
      },
    );

    const result = await fetchAllRepoInfo(urls, token);

    // It should attempt to fetch all URLs
    expect(github.getRepoInfo).toHaveBeenCalledTimes(5);

    // The final map should only contain the successful results
    expect(result.size).toBe(3);
    expect(result.has('https://github.com/user/success-1')).toBe(true);
    expect(result.has('https://github.com/user/fail-1')).toBe(false);
  });

  it('should handle an empty set of URLs gracefully', async () => {
    const result = await fetchAllRepoInfo(new Set<string>(), token);
    expect(result.size).toBe(0);
    expect(github.getRepoInfo).not.toHaveBeenCalled();
  });
});

describe('Branded titles from README fixtures', () => {
  const fixturesDir = path.join(__dirname, 'fixtures', 'original');
  const expectedTitlesPath = path.join(
    __dirname,
    'fixtures',
    'expected-titles.json',
  );
  const sourceReposPath = path.join(__dirname, 'fixtures', 'source-repos.json');
  const token = 'test-token';
  const brandingRules: ReplacementRule[] = [{ type: 'branding' }];

  // Load expected titles and source repos
  const expectedTitles = JSON.parse(
    fs.readFileSync(expectedTitlesPath, 'utf-8'),
  ) as Record<string, Record<string, string>>;
  const sourceRepos = JSON.parse(
    fs.readFileSync(sourceReposPath, 'utf-8'),
  ) as Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock getRepoInfo to return basic data (not needed for title extraction)
    vi.mocked(github.getRepoInfo).mockResolvedValue({
      archived: false,
      language: 'TypeScript',
      open_issues_count: 0,
      owner: 'test-user',
      pushed_at: '2025-01-01T00:00:00Z',
      repo: 'test-repo',
      stargazers_count: 100,
    });
    // Mock parseGitHubUrl
    vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
      if (!url.includes('github.com')) {
        return null;
      }
      const parts = url.split('/');
      return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
    });
  });

  const titleCases: [string, string, string][] = [];
  for (const [category, fixtures] of Object.entries(expectedTitles)) {
    for (const [fixtureName, expectedTitle] of Object.entries(fixtures)) {
      titleCases.push([category, fixtureName, expectedTitle]);
    }
  }

  it.each(titleCases)(
    '[%s] %s should brand title to "%s"',
    async (_category, fixtureName, expectedTitle) => {
      const fixturePath = path.join(fixturesDir, `${fixtureName}.md`);
      const content = fs.readFileSync(fixturePath, 'utf-8');
      const sourceRepo = sourceRepos[fixtureName];

      const result = await processMarkdownContent(
        content,
        token,
        brandingRules,
        { by: '', minLinks: 2 },
        sourceRepo,
        '',
        `enhansome/enhansome-${fixtureName}`,
      );

      expect(result.jsonData.metadata.title).toBe(expectedTitle);
      expect(result.finalContent.split('\n')).toContain(`# ${expectedTitle}`);
    },
  );
});

describe('Item titles and descriptions from README fixtures', () => {
  const fixturesDir = path.join(__dirname, 'fixtures', 'original');
  const expectedItemsPath = path.join(
    __dirname,
    'fixtures',
    'expected-items.json',
  );
  const sourceReposPath = path.join(__dirname, 'fixtures', 'source-repos.json');
  const token = 'test-token';

  const expectedItems = JSON.parse(
    fs.readFileSync(expectedItemsPath, 'utf-8'),
  ) as Record<
    string,
    { description: null | string; section: string; title: string }[]
  >;
  const sourceRepos = JSON.parse(
    fs.readFileSync(sourceReposPath, 'utf-8'),
  ) as Record<string, string>;

  // Flatten the data file into [fixture, section, title, description] rows so
  // each assertion runs as its own test case.
  const cases: [string, string, string, null | string][] = [];
  for (const [fixtureName, entries] of Object.entries(expectedItems)) {
    for (const { section, title, description } of entries) {
      cases.push([fixtureName, section, title, description]);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(github.getRepoInfo).mockResolvedValue({
      archived: false,
      language: 'TypeScript',
      open_issues_count: 0,
      owner: 'test-user',
      pushed_at: '2025-01-01T00:00:00Z',
      repo: 'test-repo',
      stargazers_count: 100,
    });
    vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
      if (!url.includes('github.com')) {
        return null;
      }
      const parts = url.split('/');
      return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
    });
  });

  it.each(cases)(
    '%s: section "%s" should contain item "%s" (description %s)',
    async (fixtureName, section, title, description) => {
      const fixturePath = path.join(fixturesDir, `${fixtureName}.md`);
      const content = fs.readFileSync(fixturePath, 'utf-8');

      const result = await processMarkdownContent(
        content,
        token,
        [],
        { by: '', minLinks: 2 },
        sourceRepos[fixtureName],
        '',
        `enhansome/enhansome-${fixtureName}`,
      );

      const sec = result.jsonData.items.find(s => s.title === section);
      expect(sec, `section "${section}" should exist`).toBeDefined();
      const item = findItemByTitle(sec?.items ?? [], title);
      expect(
        item,
        `item "${title}" should exist in section "${section}"`,
      ).toBeDefined();
      expect(item?.description ?? null).toBe(description);
    },
  );
});
