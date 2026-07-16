import * as fs from 'fs';
import * as path from 'path';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRepoLookup,
  REGISTRY_CONTENT_BACKSTOP_LINKS,
} from './classify.js';
import * as github from './github.js';
import { RepoInfoDetails } from './github.js';
import { silentLog } from './logger.js';
import {
  classifySource,
  countResourceLinks,
  fetchTargetData,
  processMarkdownContent,
  REGISTRY_MIN_LINKS,
  ReplacementRule,
  toRepoInfo,
} from './markdown.js';

vi.mock('./github.js');

// `github.js` is auto-mocked, so `makeOctokit` returns undefined by default.
// A real client always carries a `log` and the code reads its sink back off it,
// so every stand-in client needs one.
beforeEach(() => {
  vi.mocked(github.makeOctokit).mockReturnValue({
    log: silentLog,
  } as unknown as github.GithubClient);
});

// `./github.js` is auto-mocked file-wide for the network-path tests.
// countResourceLinks and classifySource are pure, but self-ref detection routes
// through real github helpers (`parseGitHubUrl`, `isSelfReference`) — the
// auto-mock returns undefined and would silently disable it, so the
// pure-function blocks restore them per test.
async function restoreGithubPureHelpers() {
  const real = await vi.importActual<typeof github>('./github.js');
  vi.mocked(github.parseGitHubUrl).mockImplementation(real.parseGitHubUrl);
  vi.mocked(github.isSelfReference).mockImplementation(real.isSelfReference);
  vi.mocked(github.isRelative).mockImplementation(real.isRelative);
}

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

// Any emitted node (item or group) for shape assertions in the identity tests.
// `node_type` discriminates: 'item' carries kind/repo_info, 'group' carries
// neither — only children.
interface AnyNode {
  children?: AnyNode[];
  description: null | string;
  kind?: string;
  node_type?: 'group' | 'item';
  repo_info?: { owner: string; repo: string; stars: number };
  title: string;
}

function findNode(
  items: AnyNode[] | undefined,
  title: string,
): AnyNode | undefined {
  for (const node of items ?? []) {
    if (node.title === title) {
      return node;
    }
    const nested = findNode(node.children, title);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

// A pre-resolved (empty) membership set keeps these offline and keeps the
// README-fetch counts attributable to targets alone; the lowered backstop keeps
// a stub README from tripping the content layer. `makeOctokit` is auto-mocked,
// so the client is a bare stub that still has to carry the sink everything logs
// to (`client.log`).
function targets(members = new Set<string>()) {
  return createRepoLookup({
    client: { log: silentLog } as unknown as github.GithubClient,
    contentBackstopMin: REGISTRY_MIN_LINKS,
    members,
  });
}

describe('fetchTargetData with Concurrency', () => {
  const mockRepoData: RepoInfoDetails = {
    archived: false,
    language: 'TypeScript',
    open_issues_count: 5,
    owner: 'test-user',
    pushed_at: '2025-01-01T00:00:00Z',
    repo: 'test-repo',
    stargazers_count: 100,
    topics: [],
    description: null,
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
      targets(),
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

    const { repoInfoMap } = await fetchTargetData(urls, urls, targets());

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
      targets(),
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
      targets(),
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
      targets(),
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
      targets(),
    );
    expect(repoInfoMap.size).toBe(0);
    expect(kindsMap.size).toBe(0);
    expect(github.getRepoInfo).not.toHaveBeenCalled();
    expect(github.getReadme).not.toHaveBeenCalled();
  });

  it('dedups alias URLs to the same repo (one fetch per canonical owner/repo)', async () => {
    // Two distinct URL strings that parseGitHubUrl resolves to the SAME repo
    // (facebook/jest): a README link and a deep `/tree/...` link. Each must pay
    // for exactly one getRepoInfo + one getReadme, but both URLs get results.
    const real = await vi.importActual<typeof github>('./github.js');
    vi.mocked(github.parseGitHubUrl).mockImplementation(real.parseGitHubUrl);

    const aliasA = 'https://github.com/facebook/jest';
    const aliasB = 'https://github.com/facebook/jest/tree/main/packages/jest';
    const urls = new Set([aliasA, aliasB]);

    const { kindsMap, repoInfoMap } = await fetchTargetData(
      urls,
      urls,
      targets(),
    );

    // One canonical repo -> one of each call, not two.
    expect(github.getRepoInfo).toHaveBeenCalledTimes(1);
    expect(github.getReadme).toHaveBeenCalledTimes(1);
    // But both alias URLs are populated in the maps (consumers look up by URL).
    expect(repoInfoMap.size).toBe(2);
    expect(kindsMap.size).toBe(2);
    expect(repoInfoMap.has(aliasA)).toBe(true);
    expect(repoInfoMap.has(aliasB)).toBe(true);
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
      topics: [],
      description: null,
    });
    // Mock getReadme so per-item classification (fetchTargetData) stays offline.
    // A minimal README parses to 0 entries -> every item classifies as a
    // repository (the common case; kind coverage is tested separately).
    vi.mocked(github.getReadme).mockResolvedValue('# project\n');
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
      topics: [],
      description: null,
    });
    // Mock getReadme so per-item classification (fetchTargetData) stays offline.
    // A minimal README parses to 0 entries -> every item classifies as a
    // repository (the common case; kind coverage is tested separately).
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

describe('countResourceLinks (fixture counts)', () => {
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

  beforeEach(async () => {
    await restoreGithubPureHelpers();
  });

  // Pinned against REGISTRY_MIN_LINKS (50). These counts are the ground truth the
  // threshold sits against, so they are asserted exactly.
  it.each([
    { name: 'go', expected: 2965 },
    { name: 'free-for-dev', expected: 1424 },
    { name: 'complex', expected: 7 },
    { name: 'userscripts', expected: 13 },
  ])('counts $name outbound links as $expected', ({ name, expected }) => {
    expect(countResourceLinks(parseFixture(name))).toBe(expected);
  });

  it('counts a non-GitHub linked entry (a registry of papers/sites, not repos)', () => {
    const tree = parseMarkdown(
      '# Title\n\n- [book](https://example.com/book)\n- plain note\n',
    );
    expect(countResourceLinks(tree)).toBe(1);
  });

  it('counts every outbound link, including several in one item', () => {
    const tree = parseMarkdown(
      '- [a](https://github.com/o/a) and [b](https://github.com/o/b)\n- [c](https://example.com/c)\n',
    );
    expect(countResourceLinks(tree)).toBe(3);
  });

  it('ignores same-page anchor links (a project README ToC is not a registry)', () => {
    const tree = parseMarkdown(
      '# Project\n\n## Contents\n\n- [Install](#install)\n- [Usage](#usage)\n',
    );
    expect(countResourceLinks(tree)).toBe(0);
  });

  it('excludes links back into the source repo when selfRepo is given', () => {
    const tree = parseMarkdown(
      Array.from(
        { length: 3 },
        (_, i) => `- [f${i}](https://github.com/me/myrepo/blob/main/f${i}.md)`,
      ).join('\n') + '\n- [out](https://github.com/other/repo)\n',
    );
    expect(countResourceLinks(tree, { owner: 'me', repo: 'myrepo' })).toBe(1);
  });

  it('keeps self-links counted when selfRepo is omitted', () => {
    const tree = parseMarkdown(
      '- [a](https://github.com/me/myrepo/blob/main/a.md)\n',
    );
    expect(countResourceLinks(tree)).toBe(1);
  });

  it('excludes a self-link only when owner AND repo match, case-insensitively', () => {
    const tree = parseMarkdown(
      '- [same-case](https://github.com/Me/MyRepo/blob/main/a.md)\n' +
        '- [other-repo](https://github.com/me/different/blob/main/b.md)\n' +
        '- [other-owner](https://github.com/you/myrepo/blob/main/c.md)\n',
    );
    // Only same-case matches both segments; the partial matches still count.
    expect(countResourceLinks(tree, { owner: 'me', repo: 'myrepo' })).toBe(2);
  });

  it('excludes relative links (internal navigation) even without selfRepo', () => {
    const tree = parseMarkdown(
      '- [contributing](CONTRIBUTING.md)\n' +
        '- [docs](./docs/guide.md)\n' +
        '- [pages](content/PAGES.md)\n' +
        '- [out](https://example.com/out)\n',
    );
    expect(countResourceLinks(tree)).toBe(1);
  });

  it('still counts schemeless www. links (external sites without a scheme)', () => {
    const tree = parseMarkdown(
      '- [fst](www.fstpackage.org/fst/)\n- [other](https://example.com/x)\n',
    );
    expect(countResourceLinks(tree)).toBe(2);
  });

  it('still counts mailto/tel scheme links', () => {
    const tree = parseMarkdown(
      '- [mail](mailto:a@b.com)\n- [tel](tel:+1555)\n- [out](https://example.com)\n',
    );
    expect(countResourceLinks(tree)).toBe(3);
  });
});

// The offline, network-free counterpart to the target classifier: a caller with
// a README and its repo identity asks about it directly, without an mdast tree.
describe('classifySource', () => {
  function listOf(links: number): string {
    return Array.from(
      { length: links },
      (_, i) => `- [item ${i}](https://example.com/item-${i})`,
    ).join('\n');
  }

  // These fixtures link example.com, so the repo identity never matches anything.
  const anyRepo = { owner: 'any', repo: 'repo' };

  beforeEach(async () => {
    await restoreGithubPureHelpers();
  });

  it('classifies a link-dense README as a content-signalled registry', () => {
    expect(classifySource(anyRepo, listOf(REGISTRY_MIN_LINKS))).toEqual({
      kind: 'registry',
      registrySignal: 'content',
    });
  });

  it('classifies a sparse README as a signal-less repository', () => {
    expect(classifySource(anyRepo, listOf(REGISTRY_MIN_LINKS - 1))).toEqual({
      kind: 'repository',
    });
  });

  it('agrees with the kind the full pipeline puts in metadata', async () => {
    vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
    const content = `# Awesome Things\n\n## Items\n\n${listOf(REGISTRY_MIN_LINKS)}\n`;

    const { jsonData } = await processMarkdownContent(
      content,
      'test-token',
      [],
      { by: '', minLinks: 2 },
      'example/awesome-things',
      '',
      undefined,
      undefined,
      undefined,
      new Date(),
      targets(),
    );

    expect(
      classifySource({ owner: 'example', repo: 'awesome-things' }, content),
    ).toEqual({
      kind: jsonData.metadata.kind,
      registrySignal: jsonData.metadata.registry_signal,
    });
  });

  function githubSelfListOf(
    owner: string,
    repo: string,
    links: number,
  ): string {
    return Array.from(
      { length: links },
      (_, i) =>
        `- [item ${i}](https://github.com/${owner}/${repo}/blob/main/f${i}.md)`,
    ).join('\n');
  }

  it('classifies a self-link-only README as a repository when selfRepo matches', () => {
    const md = githubSelfListOf('me', 'myrepo', REGISTRY_MIN_LINKS + 10);
    expect(classifySource({ owner: 'me', repo: 'myrepo' }, md)).toEqual({
      kind: 'repository',
    });
  });

  it('still classifies as registry when selfRepo names a different repo', () => {
    const md = githubSelfListOf('me', 'myrepo', REGISTRY_MIN_LINKS + 10);
    expect(classifySource({ owner: 'someone', repo: 'else' }, md)).toEqual({
      kind: 'registry',
      registrySignal: 'content',
    });
  });

  it('classifies a relative-link-only README as a repository (unconditional)', () => {
    const md = Array.from(
      { length: REGISTRY_MIN_LINKS + 10 },
      (_, i) => `- [doc ${i}](./docs/doc-${i}.md)`,
    ).join('\n');
    // Relative exclusion is identity-independent: a non-matching repo still
    // discounts the self-relative links.
    expect(classifySource({ owner: 'someone', repo: 'else' }, md)).toEqual({
      kind: 'repository',
    });
  });
});

describe('toRepoInfo', () => {
  it('renames the API fields to the emitted ones', () => {
    const details: RepoInfoDetails = {
      archived: true,
      description: 'ignored by the emitted shape',
      language: 'Rust',
      open_issues_count: 7,
      owner: 'o',
      pushed_at: '2025-01-01T00:00:00Z',
      repo: 'r',
      stargazers_count: 42,
      topics: ['awesome-list'],
    };

    expect(toRepoInfo(details)).toEqual({
      archived: true,
      language: 'Rust',
      last_commit: '2025-01-01T00:00:00Z',
      owner: 'o',
      repo: 'r',
      stars: 42,
    });
  });
});

describe('Item identity: own-link only, categories become groups', () => {
  const token = 'test-token';
  const sourceRepo = 'example/awesome-test';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
      if (!url.includes('github.com')) {
        return null;
      }
      const parts = url.split('/');
      return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
    });
    // Distinguishable repo info — owner/repo echo the parsed link, so a child's
    // identity is checkable and any borrowing onto a group is detectable.
    vi.mocked(github.getRepoInfo).mockImplementation((_ok, owner, repo) =>
      Promise.resolve({
        archived: false,
        language: 'TypeScript',
        open_issues_count: 1,
        owner,
        pushed_at: '2025-01-01T00:00:00Z',
        repo,
        stargazers_count: 100,
        topics: [],
        description: null,
      }),
    );
    // Minimal README -> every target classifies as a repository by default.
    vi.mocked(github.getReadme).mockResolvedValue('# project\n');
  });

  async function process(md: string) {
    const { jsonData } = await processMarkdownContent(
      md,
      token,
      [],
      // minLinks: 0 disables the section gate so these focused cases don't need
      // a full list — identity/grouping is what's under test, not the gate.
      { by: '', minLinks: 0 },
      sourceRepo,
      '',
    );
    return jsonData;
  }

  it('emits a category with nested GitHub children as a kind-less group', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [SBCL](http://www.sbcl.org/) - Steel Bank Common Lisp',
        '  - [sbcl-librarian](https://github.com/quil-lang/sbcl-librarian) - lib',
        '  - [sbcl-goodies](https://github.com/sionescu/sbcl-goodies) - goodies',
        '',
      ].join('\n'),
    );

    const section = data.items.find(s => s.title === 'Section');
    expect(section, 'section "Section" should exist').toBeDefined();

    const sbcl = findNode(section?.items, 'SBCL');
    expect(sbcl, 'SBCL should be emitted').toBeDefined();
    expect(sbcl?.node_type).toBe('group');
    expect(sbcl?.kind).toBeUndefined();
    expect(sbcl?.repo_info).toBeUndefined();

    // The nested children are emitted as their own items, keyed by their OWN
    // links — not hidden under a borrowed identity.
    const lib = findNode(section?.items, 'sbcl-librarian');
    expect(lib?.node_type).toBe('item');
    expect(lib?.kind).toBe('repository');
    expect(lib?.repo_info).toMatchObject({
      owner: 'quil-lang',
      repo: 'sbcl-librarian',
    });
    const goodies = findNode(section?.items, 'sbcl-goodies');
    expect(goodies?.repo_info).toMatchObject({
      owner: 'sionescu',
      repo: 'sbcl-goodies',
    });
  });

  it('does not borrow a nested child identity onto the group', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- Category',
        '  - [low](https://github.com/o/low)',
        '  - [high](https://github.com/o/high)',
        '',
      ].join('\n'),
    );

    const section = data.items.find(s => s.title === 'Section');
    const cat = findNode(section?.items, 'Category');
    expect(cat).toBeDefined();
    expect(cat?.node_type).toBe('group');
    expect(cat?.repo_info).toBeUndefined();
    expect(cat?.kind).toBeUndefined();
    // Both children present as distinct items — no hidden borrowing/duplication.
    expect(findNode(section?.items, 'low')?.repo_info).toMatchObject({
      repo: 'low',
    });
    expect(findNode(section?.items, 'high')?.repo_info).toMatchObject({
      repo: 'high',
    });
  });

  it('preserves an item own-link identity even with nested children', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [parent](https://github.com/o/parent) - parent',
        '  - [child](https://github.com/o/child) - child',
        '',
      ].join('\n'),
    );

    const section = data.items.find(s => s.title === 'Section');
    const parent = findNode(section?.items, 'parent');
    expect(parent).toBeDefined();
    expect(parent?.node_type).toBe('item');
    expect(parent?.repo_info).toMatchObject({ owner: 'o', repo: 'parent' });
    expect(parent?.children?.some(c => c.title === 'child')).toBe(true);
  });

  it('keys an item by a secondary GitHub link in its own paragraph', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [Name](https://example.com/marketplace) - desc [On GitHub](https://github.com/o/repo)',
        '',
      ].join('\n'),
    );

    const section = data.items.find(s => s.title === 'Section');
    const node = findNode(section?.items, 'Name');
    expect(node).toBeDefined();
    expect(node?.node_type).toBe('item');
    expect(node?.repo_info).toMatchObject({ owner: 'o', repo: 'repo' });
  });

  it('drops a non-GitHub leaf with no children', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [Some Book](https://example.com/book) - a book',
        '',
      ].join('\n'),
    );

    const section = data.items.find(s => s.title === 'Section');
    expect(section && findNode(section.items, 'Some Book')).toBeUndefined();
  });

  it('classifies a group nested child by its own README (kind parity)', async () => {
    vi.mocked(github.getReadme).mockImplementation((_ok, _owner, repo) => {
      if (repo === 'registry-child') {
        return Promise.resolve(
          Array.from(
            { length: REGISTRY_CONTENT_BACKSTOP_LINKS },
            (_, i) => `<a href="https://github.com/o/r-${i}">r-${i}</a>`,
          ).join('\n'),
        );
      }
      return Promise.resolve('<p>project</p>');
    });
    // The default gateScope ('any-admission') runs the compile-manifest gate
    // inside the content backstop, so a dense README's root is now listed —
    // stub it to an empty root (no manifest) so the child backstops into
    // registry as the test intends.
    vi.mocked(github.getRootEntryNames).mockResolvedValue([]);

    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- Editors',
        '  - [registry-child](https://github.com/o/registry-child)',
        '',
      ].join('\n'),
    );

    const section = data.items.find(s => s.title === 'Section');
    const group = findNode(section?.items, 'Editors');
    expect(group).toBeDefined();
    expect(group?.node_type).toBe('group');

    // The child's kind is fetched for its OWN link and applied — proving the
    // kind-fetch target (collectEntryGitHubUrls) and the consumer agree.
    const child = findNode(section?.items, 'registry-child');
    expect(child).toBeDefined();
    expect(child?.node_type).toBe('item');
    expect(child?.kind).toBe('registry');
  });

  it('sinks kind-less groups below starred items under a stars sort', async () => {
    // Product invariant (README "Items vs. groups"): a stars/last-commit sort
    // sinks groups (no repo_info of their own) below the starred items in their
    // list, and groups among themselves keep source order. Pinned because it is
    // user-visible rendered+JSON order and is exercised by no other test.
    const { jsonData } = await processMarkdownContent(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [starred](https://github.com/o/starred) - has stars',
        '- First category',
        '  - [a](https://github.com/o/a)',
        '- Second category',
        '  - [b](https://github.com/o/b)',
        '',
      ].join('\n'),
      token,
      [],
      { by: 'stars', minLinks: 0 },
      sourceRepo,
      '',
    );
    const section = jsonData.items.find(s => s.title === 'Section');
    const titles = section?.items.map(i => i.title) ?? [];
    expect(titles).toEqual(['starred', 'First category', 'Second category']);
  });
});
