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

interface Container {
  children?: unknown[];
  description?: null | string;
  items?: unknown[];
  title: string;
}

// The originalRepositoryInfo a "owner/name" source-repos entry stands for —
// the repo name is what feeds the no-H1 title fallback.
function sourceRepoInfo(
  identifier: string | undefined,
): null | RepoInfoDetails {
  if (!identifier) {
    return null;
  }
  const [owner, repo] = identifier.split('/');
  return {
    archived: false,
    description: null,
    id: 1,
    language: null,
    open_issues_count: 0,
    owner,
    pushed_at: null,
    repo,
    stargazers_count: 0,
    topics: [],
  };
}

function findContainer(
  nodes: Container[],
  title: string,
): Container | undefined {
  for (const node of nodes) {
    if (node.title === title) {
      return node;
    }
    const nested = findContainer(
      (node.items ?? node.children ?? []) as Container[],
      title,
    );
    if (nested) {
      return nested;
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

      const result = await processMarkdownContent(
        content,
        token,
        brandingRules,
        { by: '', minLinks: 2 },
        '',
        `enhansome/enhansome-${fixtureName}`,
        undefined,
        undefined,
        sourceRepoInfo(sourceRepos[fixtureName]),
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
        '',
        `enhansome/enhansome-${fixtureName}`,
        undefined,
        undefined,
        sourceRepoInfo(sourceRepos[fixtureName]),
      );

      const sec = findContainer(result.jsonData.items, section);
      expect(sec, `section "${section}" should exist`).toBeDefined();
      const item = findItemByTitle(
        (sec?.items ?? sec?.children ?? []) as { children?: unknown[]; title: string }[],
        title,
      );
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

// A title that carries no name — a rank number, a year, a URL, or a bare tag
// word — falls back to the repo link's own label when that names the repo,
// else owner/name. The measured families (progress/degenerate-titles.md):
// numbered rank tables (`| 15. | [**Day.js**](…) |`), year-first paper tables
// with a tag link column, URL-as-label links, and best-of's `[GitHub](repo)`
// lines. CJK labels and letter-bearing text are titles, not noise.
describe('Degenerate titles fall back to the link label, then owner/name', () => {
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
      { by: '', minLinks: 0 },
      sourceRepo,
      '',
    );
    return jsonData;
  }

  function sectionItems(
    data: Awaited<ReturnType<typeof process>>,
    title: string,
  ) {
    const section = data.items.find(s => s.title === title);
    expect(section, `section "${title}" should exist`).toBeDefined();
    return section?.items ?? [];
  }

  it('titles a numbered rank table row from the link label, not the rank cell', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Ranking',
        '',
        '| # | Tool | Notes | License |',
        '| - | ---- | ----- | ------- |',
        '| 15. | [**Day.js**](https://github.com/iamkun/dayjs) | Fast 2kB alternative to Moment.js. | MIT |',
        '| 16. | [**Tempus**](https://github.com/Eonasdan/tempus-dominus) | A date time picker. | MIT |',
        '',
      ].join('\n'),
    );
    const items = sectionItems(data, 'Ranking');
    const dayjs = items.find(i => i.title === 'Day.js');
    expect(dayjs, 'item titled "Day.js" should exist').toBeDefined();
    expect(dayjs?.node_type).toBe('item');
    // The rank cell and the label that became the title stay out of the
    // description — no echo, no noise.
    expect(dayjs?.description).toBe('Fast 2kB alternative to Moment.js. MIT');
    expect(items.some(i => i.title === '15.')).toBe(false);
  });

  it('titles a year-first paper row owner/name when the link label is a tag', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Papers',
        '',
        '| Year | Venue | Paper | Code |',
        '| ---- | ----- | ----- | ---- |',
        '| 2024 | Arxiv | [Human-Art](https://example.com/human-art.pdf) | [Github](https://github.com/IDEA-Research/HumanArt) |',
        '| 2023 | CVPR | [CoMix](https://example.com/comix.pdf) | [Github](https://github.com/emanuelevivoli/comix-dataset) |',
        '',
      ].join('\n'),
    );
    const items = sectionItems(data, 'Papers');
    const humanArt = items.find(i => i.title === 'IDEA-Research/HumanArt');
    expect(
      humanArt,
      'item titled "IDEA-Research/HumanArt" should exist',
    ).toBeDefined();
    expect(humanArt?.node_type).toBe('item');
    // The year cell and the tag label drop; venue and paper title survive.
    expect(humanArt?.description).toBe('Arxiv Human-Art');
    expect(items.some(i => i.title === '2024')).toBe(false);
    expect(items.some(i => i.title === 'Github')).toBe(false);
  });

  it('titles a URL-label link owner/name', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Tools',
        '',
        '- [https://github.com/o/repo](https://github.com/o/repo) - the label is the URL itself',
        '- github.com/o/plain - the linkified bare form, same defect',
        '',
      ].join('\n'),
    );
    const items = sectionItems(data, 'Tools');
    expect(items.map(i => i.title)).toEqual(['o/repo', 'o/plain']);
  });

  it('titles a tag-word label owner/name', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Projects',
        '',
        '- [GitHub](https://github.com/bitcoin/bitcoin) (⭐ 77K · stats):',
        '- [Source code](https://github.com/ElementsProject/lightning) (⭐ 2.8K):',
        '',
      ].join('\n'),
    );
    const items = sectionItems(data, 'Projects');
    expect(items.map(i => i.title)).toEqual([
      'bitcoin/bitcoin',
      'ElementsProject/lightning',
    ]);
  });

  it('keeps a CJK label as the title', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## 工具',
        '',
        '- 代码仓库：[tool](https://github.com/o/tool) - a CJK label is a name, not noise',
        '',
      ].join('\n'),
    );
    const items = sectionItems(data, '工具');
    expect(items.map(i => i.title)).toEqual(['代码仓库：tool']);
  });

  it('keeps the repo-name fallback for an empty title (image-only link)', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Badges',
        '',
        '- [![badge](https://example.com/b.svg)](https://github.com/o/badge-tool) - an image-only link',
        '',
      ].join('\n'),
    );
    const items = sectionItems(data, 'Badges');
    expect(items.map(i => i.title)).toEqual(['badge-tool']);
  });
});

// The section tree must mirror the source README's heading tree: sub-headings
// nest as groups, a heading that is a single GitHub link is an item, containers
// with no items anywhere beneath are dropped, and dead links emit nothing.
// `shape` reduces a tree to title/type/repo/children so the assertions below
// pin structure without pinning every repo_info field.
describe('Tree shape: heading hierarchy, link-headings, empties, dead links', () => {
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
    vi.mocked(github.getRepoInfo).mockImplementation((_ok, owner, repo) =>
      // `o/dead` is the one repo whose fetch fails — the dead-link case. A real
      // failure throws (and fetchTargetData catches), never resolves null.
      `${owner}/${repo}` === 'o/dead'
        ? Promise.reject(new Error('404 Not Found'))
        : Promise.resolve({
            archived: false,
            id: 1,
            language: 'TypeScript',
            open_issues_count: 1,
            owner,
            repo,
            pushed_at: '2025-01-01T00:00:00Z',
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
      { by: '', minLinks: 0 },
      sourceRepo,
      '',
    );
    return jsonData;
  }

  function shape(nodes: unknown[]): unknown[] {
    return nodes.map(node => {
      const n = node as {
        children?: unknown[];
        description?: null | string;
        items?: unknown[];
        node_type?: 'group' | 'item';
        repo_info?: { owner: string; repo: string };
        title: string;
      };
      return {
        children: shape(n.items ?? n.children ?? []),
        repo: n.repo_info ? `${n.repo_info.owner}/${n.repo_info.repo}` : null,
        type: n.node_type ?? 'section',
      };
    });
  }

  it('nests sub-headings by depth instead of flattening them', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Languages',
        '',
        '### Compiled',
        '',
        '#### Rust tooling',
        '',
        '- [tool](https://github.com/o/tool)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          {
            type: 'group',
            repo: null,
            children: [
              {
                type: 'group',
                repo: null,
                children: [{ type: 'item', repo: 'o/tool', children: [] }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('a heading that is one GitHub link becomes an item with the following content', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '### [Repo](https://github.com/o/repo)',
        '',
        '> A blockquote description.',
        '',
        '- [child](https://github.com/o/child)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          {
            type: 'item',
            repo: 'o/repo',
            children: [{ type: 'item', repo: 'o/child', children: [] }],
          },
        ],
      },
    ]);
    const section = data.items[0];
    const heading = (section?.items ?? [])[0] as { description: null | string };
    expect(heading.description).toBe('A blockquote description.');
  });

  it('a non-GitHub link-heading stays a container and wraps the repos beneath it', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '### [Article](https://example.com/article)',
        '',
        '- [repo](https://github.com/o/repo)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          {
            type: 'group',
            repo: null,
            children: [{ type: 'item', repo: 'o/repo', children: [] }],
          },
        ],
      },
    ]);
  });

  it('drops containers with no items beneath but keeps nesting intermediates that have them', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Empty Section',
        '',
        '### Nested Empty',
        '',
        '## Full Section',
        '',
        '### Nested With Items',
        '',
        '- [a](https://github.com/o/a)',
        '- [b](https://github.com/o/b)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          {
            type: 'group',
            repo: null,
            children: [
              { type: 'item', repo: 'o/a', children: [] },
              { type: 'item', repo: 'o/b', children: [] },
            ],
          },
        ],
      },
    ]);
  });

  it('skips a dead link at emit and lifts its children to the parent', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [dead](https://github.com/o/dead)',
        '  - [live-child](https://github.com/o/live-child)',
        '- [live](https://github.com/o/live)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          { type: 'item', repo: 'o/live-child', children: [] },
          { type: 'item', repo: 'o/live', children: [] },
        ],
      },
    ]);
  });

  it('a link-heading whose link is dead stays a container for its live children', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '### [Dead](https://github.com/o/dead)',
        '',
        '- [child](https://github.com/o/child)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          {
            type: 'group',
            repo: null,
            children: [{ type: 'item', repo: 'o/child', children: [] }],
          },
        ],
      },
    ]);
  });

  it('treats H1s after the title as sections', async () => {
    const data = await process(
      [
        '# Awesome List',
        '',
        '# Section A',
        '',
        '1. [a1](https://github.com/o/a1)',
        '',
        '# Section B',
        '',
        '- [b1](https://github.com/o/b1)',
        '',
      ].join('\n'),
    );

    expect(data.metadata.title).toBe('Awesome List');
    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [{ type: 'item', repo: 'o/a1', children: [] }],
      },
      {
        type: 'section',
        repo: null,
        children: [{ type: 'item', repo: 'o/b1', children: [] }],
      },
    ]);
  });

  it('uses the shallowest heading depth present as the section level', async () => {
    const data = await process(
      [
        '# List',
        '',
        '### First',
        '',
        '- [a](https://github.com/o/a)',
        '',
        '### Second',
        '',
        '- [b](https://github.com/o/b)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [{ type: 'item', repo: 'o/a', children: [] }],
      },
      {
        type: 'section',
        repo: null,
        children: [{ type: 'item', repo: 'o/b', children: [] }],
      },
    ]);
  });

  it('keeps every list in a section, not just the first', async () => {
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [a](https://github.com/o/a)',
        '',
        'Prose between the lists.',
        '',
        '- [b](https://github.com/o/b)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          { type: 'item', repo: 'o/a', children: [] },
          { type: 'item', repo: 'o/b', children: [] },
        ],
      },
    ]);
    expect(data.items[0]?.description).toBe('Prose between the lists.');
  });

  it('ignores spacer headings with no text', async () => {
    // Real docs use a bare `#` or `#####` as a visual spacer (14× in one
    // mirror). It must not open a section nor close the open one.
    const data = await process(
      [
        '# List',
        '',
        '## Section',
        '',
        '- [a](https://github.com/o/a)',
        '',
        '#####',
        '',
        '- [b](https://github.com/o/b)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [
          { type: 'item', repo: 'o/a', children: [] },
          { type: 'item', repo: 'o/b', children: [] },
        ],
      },
    ]);
  });

  it('a table-of-contents heading does not wrap the document', async () => {
    // free-for.dev shape: a `# Table of Contents` H1 after the title would
    // nest every real section under a meaningless wrapper if it counted as
    // structure.
    const data = await process(
      [
        '# List',
        '',
        '# Table of Contents',
        '',
        '## Real Section',
        '',
        '- [a](https://github.com/o/a)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [{ type: 'item', repo: 'o/a', children: [] }],
      },
    ]);
  });

  it('a generic first H1 stays the title slot instead of wrapping the document', async () => {
    // guides.md shape: `# Guides` is not valid title material, but it IS the
    // de-facto title slot (branding replaces it) — the H2s below it are
    // sections, not its subsections.
    const data = await process(
      [
        '# Guides',
        '',
        '## Section',
        '',
        '- [a](https://github.com/o/a)',
        '',
      ].join('\n'),
    );

    expect(shape(data.items)).toEqual([
      {
        type: 'section',
        repo: null,
        children: [{ type: 'item', repo: 'o/a', children: [] }],
      },
    ]);
  });
});
