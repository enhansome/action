import * as fs from 'fs';
import * as path from 'path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as github from './github.js';
import { RepoInfoDetails } from './github.js';
import {
  classifyKind,
  countListEntries,
  fetchTargetData,
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

describe('fetchTargetData with Concurrency', () => {
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

  function githubUrls(count: number): Set<string> {
    return new Set(
      Array.from(
        { length: count },
        (_, i) => `https://github.com/user/repo-${i}`,
      ),
    );
  }

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
    vi.mocked(github.getRepoInfo).mockResolvedValue({ ...mockRepoData });
    // A minimal README -> 0 entries -> every target classifies as a repository.
    vi.mocked(github.getReadme).mockResolvedValue('# project\n');
  });

  it('respects the concurrency limit across the shared pool', async () => {
    const CONCURRENCY_LIMIT = 10; // must match FETCH_CONCURRENCY in markdown.ts
    const totalUrls = 25;
    const urls = githubUrls(totalUrls);

    // Every worker calls getRepoInfo first, so its active count is the pool's
    // concurrency. Instrument it with a delay to observe the ceiling.
    let activeRequests = 0;
    let maxConcurrentRequests = 0;
    vi.mocked(github.getRepoInfo).mockImplementation(async () => {
      activeRequests++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 50));
      activeRequests--;
      return { ...mockRepoData };
    });

    // urls === entryUrls: every target is both badged and classified.
    const { kindsMap, repoInfoMap } = await fetchTargetData(
      urls,
      urls,
      token,
      20,
    );

    expect(repoInfoMap.size).toBe(totalUrls);
    expect(kindsMap.size).toBe(totalUrls);
    expect(github.getRepoInfo).toHaveBeenCalledTimes(totalUrls);
    expect(github.getReadme).toHaveBeenCalledTimes(totalUrls);
    expect(maxConcurrentRequests).toBe(CONCURRENCY_LIMIT);
    expect(activeRequests).toBe(0);
  }, 1000);

  it('uses a concurrency level equal to the URL count when below the limit', async () => {
    const totalUrls = 4;
    const urls = githubUrls(totalUrls);

    let activeRequests = 0;
    let maxConcurrentRequests = 0;
    vi.mocked(github.getRepoInfo).mockImplementation(async () => {
      activeRequests++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeRequests--;
      return { ...mockRepoData };
    });

    const { repoInfoMap } = await fetchTargetData(urls, urls, token, 20);

    expect(repoInfoMap.size).toBe(totalUrls);
    expect(maxConcurrentRequests).toBe(totalUrls);
  });

  it('fetches a README only for entry URLs, never for every link', async () => {
    // All three links are badged (repo info), but only `entry` is a list-item
    // entry that needs a kind. The heavy README fetch must be scoped to it —
    // prose/badge/secondary links must not pay for a classification.
    const urls = new Set([
      'https://github.com/user/entry',
      'https://github.com/user/prose',
      'https://github.com/user/secondary',
    ]);
    const entryUrls = new Set(['https://github.com/user/entry']);

    const { kindsMap, repoInfoMap } = await fetchTargetData(
      urls,
      entryUrls,
      token,
      20,
    );

    expect(repoInfoMap.size).toBe(3);
    expect(github.getRepoInfo).toHaveBeenCalledTimes(3);
    // Exactly one README fetch — the entry — not one per link.
    expect(github.getReadme).toHaveBeenCalledTimes(1);
    expect([...kindsMap.keys()]).toEqual(['https://github.com/user/entry']);
  });

  it('skips a dead repo-info target yet still classifies it (independent failures)', async () => {
    const urls = githubUrls(2); // repo-0, repo-1
    vi.mocked(github.getRepoInfo).mockImplementation(
      (_octokit, _owner: string, repo: string) => {
        if (repo === 'repo-0') {
          throw new Error('Not Found (404)');
        }
        return Promise.resolve({ ...mockRepoData, language: repo });
      },
    );

    const { kindsMap, repoInfoMap } = await fetchTargetData(
      urls,
      urls,
      token,
      20,
    );

    // repo-0's /repos failed -> no repo_info, but its README still classified.
    expect(repoInfoMap.has('https://github.com/user/repo-0')).toBe(false);
    expect(kindsMap.get('https://github.com/user/repo-0')).toBe('repository');
    // repo-1 is unaffected.
    expect(repoInfoMap.has('https://github.com/user/repo-1')).toBe(true);
    expect(kindsMap.get('https://github.com/user/repo-1')).toBe('repository');
  });

  it('skips a dead README target yet still records its repo info (independent failures)', async () => {
    const urls = githubUrls(2); // repo-0, repo-1
    vi.mocked(github.getReadme).mockImplementation(
      (_octokit, _owner: string, repo: string) => {
        if (repo === 'repo-0') {
          throw new Error('Not Found (404)');
        }
        return Promise.resolve('# project\n');
      },
    );

    const { kindsMap, repoInfoMap } = await fetchTargetData(
      urls,
      urls,
      token,
      20,
    );

    // repo-0's README failed -> no kind, but its /repos still succeeded.
    expect(kindsMap.has('https://github.com/user/repo-0')).toBe(false);
    expect(repoInfoMap.has('https://github.com/user/repo-0')).toBe(true);
    // repo-1 is unaffected.
    expect(kindsMap.get('https://github.com/user/repo-1')).toBe('repository');
    expect(repoInfoMap.has('https://github.com/user/repo-1')).toBe(true);
  });

  it('handles an empty set of URLs gracefully', async () => {
    const { kindsMap, repoInfoMap } = await fetchTargetData(
      new Set<string>(),
      new Set<string>(),
      token,
      20,
    );
    expect(repoInfoMap.size).toBe(0);
    expect(kindsMap.size).toBe(0);
    expect(github.getRepoInfo).not.toHaveBeenCalled();
    expect(github.getReadme).not.toHaveBeenCalled();
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
    // Mock getReadme so per-item classification (fetchTargetData) stays offline.
    // A minimal README parses to 0 entries -> every item classifies as a
    // repository (the common case; kind-specific coverage lives in step 9).
    vi.mocked(github.getReadme).mockResolvedValue('# project\n');
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
    // Mock getReadme so per-item classification (fetchTargetData) stays offline.
    // A minimal README parses to 0 entries -> every item classifies as a
    // repository (the common case; kind-specific coverage lives in step 9).
    vi.mocked(github.getReadme).mockResolvedValue('# project\n');
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

describe('countListEntries (fixture counts)', () => {
  const fixturesDir = path.join(__dirname, 'fixtures', 'original');

  function parseFixture(name: string) {
    const content = fs.readFileSync(
      path.join(fixturesDir, `${name}.md`),
      'utf-8',
    );
    return unified().use(remarkParse).use(remarkGfm).parse(content);
  }

  function parseMarkdown(markdown: string) {
    return unified().use(remarkParse).use(remarkGfm).parse(markdown);
  }

  // `countListEntries` (and the `findFirstGitHubLink` it reuses) calls
  // `parseGitHubUrl`, which this file auto-mocks (vi.mock('./github.js')). A
  // leaked permissive impl from a sibling describe would over-count URLs whose
  // host is not exactly github.com (e.g. raw.githubusercontent.com), so pin the
  // mock to the real implementation here. The asserted counts then reflect the
  // production oracle, not mock contamination.
  beforeEach(async () => {
    const actual = await vi.importActual<typeof github>('./github.js');
    vi.mocked(github.parseGitHubUrl).mockImplementation(actual.parseGitHubUrl);
  });

  // Calibration is pinned at K = 20 (PLAN.md §4). These counts are the ground
  // truth that threshold sits against, so they are asserted exactly.
  it.each([
    { name: 'go', expected: 2570 },
    { name: 'free-for-dev', expected: 13 },
    { name: 'complex', expected: 7 },
    { name: 'userscripts', expected: 0 },
  ])(
    'counts $name github-linked list items as $expected',
    ({ name, expected }) => {
      expect(countListEntries(parseFixture(name))).toBe(expected);
    },
  );

  it('counts zero for a README with no github links', () => {
    const tree = parseMarkdown(
      '# Title\n\n- [book](https://example.com/book)\n- plain note\n',
    );
    expect(countListEntries(tree)).toBe(0);
  });

  it('counts an item once even when its subtree has multiple github links', () => {
    const tree = parseMarkdown(
      '- [a](https://github.com/o/a) and [b](https://github.com/o/b)\n- [c](https://example.com/c)\n',
    );
    expect(countListEntries(tree)).toBe(1);
  });
});

describe('classifyKind', () => {
  // getReadme is auto-mocked (vi.mock('./github.js')), so the octokit passed to
  // classifyKind is never actually used.
  const octokit = undefined as unknown as github.GithubClient;

  function readmeWithItems(n: number): string {
    const items = Array.from(
      { length: n },
      (_, i) => `- [repo-${i}](https://github.com/o/repo-${i})`,
    ).join('\n');
    return `# Some Repo\n\n${items}\n`;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies a README with >= minEntries github items as a registry (boundary inclusive)', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeWithItems(20));
    const result = await classifyKind(octokit, 'o', 'r', 20);
    expect(result.kind).toBe('registry');
    expect(result.entries).toBe(20);
  });

  it('classifies a README just below the threshold as a repository', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeWithItems(19));
    const result = await classifyKind(octokit, 'o', 'r', 20);
    expect(result.kind).toBe('repository');
    expect(result.entries).toBe(19);
  });

  it('classifies a sparse project README as a repository', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(
      '# chalk\n\nTerminal string styling.\n',
    );
    const result = await classifyKind(octokit, 'chalk', 'chalk', 20);
    expect(result.kind).toBe('repository');
    expect(result.entries).toBe(0);
  });

  it('classifies a real registry README fixture as a registry', async () => {
    const readme = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'original', 'kind-registry.md'),
      'utf-8',
    );
    vi.mocked(github.getReadme).mockResolvedValue(readme);
    const result = await classifyKind(
      octokit,
      'example',
      'awesome-example',
      20,
    );
    expect(result.kind).toBe('registry');
    expect(result.entries).toBeGreaterThanOrEqual(20);
  });

  it('classifies a real project README fixture as a repository', async () => {
    const readme = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'original', 'kind-repository.md'),
      'utf-8',
    );
    vi.mocked(github.getReadme).mockResolvedValue(readme);
    const result = await classifyKind(octokit, 'chalk', 'chalk', 20);
    expect(result.kind).toBe('repository');
    expect(result.entries).toBeLessThan(20);
  });

  it('throws on an unreadable README (the oracle; fetchTargetData catches it)', async () => {
    vi.mocked(github.getReadme).mockRejectedValue(new Error('Not Found (404)'));
    await expect(classifyKind(octokit, 'o', 'r', 20)).rejects.toThrow(
      'Not Found (404)',
    );
  });
});
