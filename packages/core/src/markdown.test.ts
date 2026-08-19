import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as github from './github.js';
import { RepoInfoDetails } from './github.js';
import { silentLog } from './logger.js';
import {
  processMarkdownContent,
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
// `node_type` discriminates: 'item' carries repo_info, 'group' carries neither
// repo_info nor children's identity — only children.
interface AnyNode {
  children?: AnyNode[];
  description: null | string;
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
      id: 1,
      language: 'TypeScript',
      open_issues_count: 0,
      owner: 'test-user',
      pushed_at: '2025-01-01T00:00:00Z',
      repo: 'test-repo',
      stargazers_count: 100,
      topics: [],
      description: null,
    });
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
      id: 1,
      language: 'TypeScript',
      open_issues_count: 0,
      owner: 'test-user',
      pushed_at: '2025-01-01T00:00:00Z',
      repo: 'test-repo',
      stargazers_count: 100,
      topics: [],
      description: null,
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

describe('toRepoInfo', () => {
  it('renames the API fields to the emitted ones', () => {
    const details: RepoInfoDetails = {
      archived: true,
      description: 'ignored by the emitted shape',
      id: 991823,
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
      id: 991823,
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
        id: 1,
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

  it('emits a category with nested GitHub children as a group', async () => {
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
    expect(sbcl?.repo_info).toBeUndefined();

    // The nested children are emitted as their own items, keyed by their OWN
    // links — not hidden under a borrowed identity.
    const lib = findNode(section?.items, 'sbcl-librarian');
    expect(lib?.node_type).toBe('item');
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

  it('sinks groups below starred items under a stars sort', async () => {
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
