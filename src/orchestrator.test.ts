import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonItem, JsonNode } from './markdown.js';

import * as github from './github.js';
import { RepoInfoDetails } from './github.js';
import { enhance } from './orchestrator.js';

// Mock the lowest-level dependency, which is the GitHub API client.
vi.mock('./github.js');

// Narrow a `JsonNode` (item | group) to a `JsonItem`. Section/children arrays
// can now contain kind-less groups (Option B); the kind/repo_info assertions in
// this file are all about genuine GitHub items, so they narrow first.
function isItem(node: JsonNode): node is JsonItem {
  return node.node_type === 'item';
}

describe('Orchestrator: enhance()', () => {
  const token = 'test-token';

  const repoMockDb = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'fixtures', 'repo-mock-db.json'),
      'utf-8',
    ),
  ) as Record<string, Record<string, RepoInfoDetails>>;

  beforeEach(() => {
    // Reset all mocks before each test to ensure isolation
    vi.clearAllMocks();
  });

  describe('Badge Enhancement', () => {
    it('should add a rich info badge to a valid GitHub link', async () => {
      const originalContent =
        'Check out [my-project](https://github.com/test-user/test-repo).';
      const expectedContent =
        'Check out [my-project](https://github.com/test-user/test-repo) ⭐ 1,234 | 🐛 42 | 🌐 TypeScript | 📅 2025-06-29.';

      const mockRepoData: github.RepoInfoDetails = {
        archived: false,
        language: 'TypeScript',
        open_issues_count: 42,
        owner: 'test-user',
        pushed_at: '2025-06-29T10:00:00Z',
        repo: 'test-repo',
        stargazers_count: 1234,
      };

      vi.mocked(github.parseGitHubUrl).mockReturnValue({
        owner: 'test-user',
        repo: 'test-repo',
      });
      vi.mocked(github.getRepoInfo).mockResolvedValue(mockRepoData);
      // Per-item classification stays offline; minimal README -> repository.
      vi.mocked(github.getReadme).mockResolvedValue('# project\n');

      const { finalContent } = await enhance({
        content: originalContent,
        disableBranding: true,
        originalRepository: 'owner/source-repo',
        token,
      });

      // First arg is the injected Octokit client (auto-mocked → undefined);
      // assert the meaningful owner/repo args.
      expect(github.getRepoInfo).toHaveBeenCalledWith(
        undefined,
        'test-user',
        'test-repo',
      );
      expect(finalContent).toBe(expectedContent);
    });

    it('should add an "Archived" badge if the repository is archived', async () => {
      const originalContent =
        'This is an [old-project](https://github.com/test-user/old-repo).';
      const expectedContent =
        'This is an [old-project](https://github.com/test-user/old-repo) ⚠️ Archived.';

      const mockRepoData: github.RepoInfoDetails = {
        archived: true,
        language: 'JavaScript',
        open_issues_count: 1,
        owner: 'test-user',
        pushed_at: '2020-01-01T10:00:00Z',
        repo: 'old-repo',
        stargazers_count: 500,
      };

      vi.mocked(github.parseGitHubUrl).mockReturnValue({
        owner: 'test-user',
        repo: 'old-repo',
      });
      vi.mocked(github.getRepoInfo).mockResolvedValue(mockRepoData);
      // Per-item classification stays offline; minimal README -> repository.
      vi.mocked(github.getReadme).mockResolvedValue('# project\n');

      const { finalContent } = await enhance({
        content: originalContent,
        disableBranding: true,
        originalRepository: 'owner/source-repo',
        token,
      });

      expect(github.getRepoInfo).toHaveBeenCalled();
      expect(finalContent).toBe(expectedContent);
    });
  });

  describe('Find and Replace (fixture-driven)', () => {
    const replacementCases = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'fixtures', 'replacements.json'),
        'utf-8',
      ),
    ) as {
      expected: string;
      find: string;
      input: string;
      replace: string;
      type: 'literal' | 'regex';
    }[];

    beforeEach(() => {
      // parseGitHubUrl -> null ⇒ no GitHub links collected ⇒ getRepoInfo /
      // (later) getReadme are never invoked, so enhancement is a no-op here.
      vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
    });

    it.each(replacementCases)(
      '$type replace "$find" -> "$replace"',
      async ({ type, find, replace, input, expected }) => {
        const raw = `${find}:::${replace}`;
        const { finalContent } = await enhance({
          content: input,
          disableBranding: true,
          originalRepository: 'owner/source-repo',
          ...(type === 'literal'
            ? { findAndReplaceRaw: raw }
            : { regexFindAndReplaceRaw: raw }),
          token,
        });
        expect(finalContent).toBe(expected);
      },
    );
  });

  describe('Branding', () => {
    beforeEach(() => {
      // parseGitHubUrl -> null ⇒ no GitHub links collected ⇒ getRepoInfo /
      // (later) getReadme are never invoked, so enhancement is a no-op here.
      vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
    });

    it('should apply the branding rule by default', async () => {
      const originalContent =
        '# Awesome Go\n\nA list of awesome Go frameworks.';
      const expectedContent = `# Awesome Go with stars

A list of awesome Go frameworks.

***

> _Enhansomed by [enhansome](https://github.com/enhansome) on 2026-06-28._
`;

      const { finalContent } = await enhance({
        content: originalContent,
        originalRepository: 'owner/source-repo',
        token,
        now: new Date('2026-06-28T12:00:00Z'),
      });
      expect(finalContent).toBe(expectedContent);
    });

    it('should NOT apply branding if disableBranding is true', async () => {
      const originalContent = '# Awesome Go\n\nThis title should not change.';

      const { finalContent } = await enhance({
        content: originalContent,
        disableBranding: true,
        originalRepository: 'owner/source-repo',
        token,
      });
      expect(finalContent).toBe(originalContent);
    });
  });

  describe('Branding parity (md H1 === metadata.title)', () => {
    beforeEach(() => {
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
        if (!url.includes('github.com')) {
          return null;
        }
        const parts = url.split('/');
        return {
          owner: parts[parts.length - 2],
          repo: parts[parts.length - 1],
        };
      });
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
      // A minimal README -> 0 entries -> repository (the common case).
      vi.mocked(github.getReadme).mockResolvedValue('# project\n');
    });

    it('brands a generic-H1 list identically in markdown and JSON (guides)', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, 'fixtures', 'original', 'guides.md'),
        'utf-8',
      );

      const { finalContent, jsonData } = await enhance({
        content,
        originalRepository: 'NARKOZ/guides',
        enhancedRepository: 'enhansome/enhansome-guides',
        token,
      });

      // Every enhanced doc reads "Awesome <x> with stars" (req 5), and the
      // markdown H1 and metadata.title must be identical (req 4).
      expect(jsonData.metadata.title).toBe('Awesome guides with stars');
      const lines = finalContent.split('\n');
      expect(lines[0]).toBe(`# ${jsonData.metadata.title}`);
      // The source's generic "# Guides" H1 is the de-facto title slot, so the
      // branded title overrides it — not sits alongside it as a second H1.
      expect(lines.filter(l => l.startsWith('# '))).toHaveLength(1);
      expect(lines).not.toContain('# Guides');
    });

    it('brands the real title H1, not a leading section header', async () => {
      // "# Contents" is an invalid title (a section header) sitting above the
      // real "# Awesome Foo". Branding must replace the latter, leave the ToC
      // heading intact, and never duplicate the title.
      const content = [
        '# Contents',
        '',
        '- [Tools](#tools)',
        '',
        '# Awesome Foo',
        '',
        '## Tools',
        '',
        '* [a](https://github.com/x/a)',
        '* [b](https://github.com/x/b)',
        '',
      ].join('\n');

      const { finalContent, jsonData } = await enhance({
        content,
        originalRepository: 'x/awesome-foo',
        token,
      });

      expect(jsonData.metadata.title).toBe('Awesome Foo with stars');

      const lines = finalContent.split('\n');
      // The ToC header is untouched...
      expect(lines).toContain('# Contents');
      // ...the real title is branded exactly once...
      expect(lines.filter(l => l === '# Awesome Foo with stars')).toHaveLength(
        1,
      );
      // ...and no stale, unbranded copy of the title remains.
      expect(lines).not.toContain('# Awesome Foo');
    });
  });

  describe('Item description extraction', () => {
    beforeEach(() => {
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
        if (!url.includes('github.com')) {
          return null;
        }
        const parts = url.split('/');
        return {
          owner: parts[parts.length - 2],
          repo: parts[parts.length - 1],
        };
      });
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
      // A minimal README -> 0 entries -> repository (the common case).
      vi.mocked(github.getReadme).mockResolvedValue('# project\n');
    });

    it('drops a link-less item from the JSON graph but keeps it in the markdown (D9)', async () => {
      const content = [
        '# Awesome Foo',
        '',
        '## Tools',
        '',
        '* [a](https://github.com/x/a) - tool a',
        '* [b](https://github.com/x/b) - tool b',
        '* **Note**: a plain entry without any link',
        '',
      ].join('\n');

      const { finalContent, jsonData } = await enhance({
        content,
        originalRepository: 'x/awesome-foo',
        token,
      });

      const tools = jsonData.items.find(s => s.title === 'Tools');
      expect(tools).toBeDefined();
      // Every emitted JsonItem is a GitHub node (D9): the link-less Note is
      // omitted from the typed JSON graph...
      const titles = tools?.items.map(i => i.title) ?? [];
      expect(titles).toEqual(['a', 'b']);
      expect(titles).not.toContain('Note: a plain entry without any link');
      // ...but retained in the enhanced markdown (badges/sorting only).
      expect(finalContent).toContain('a plain entry without any link');
    });

    it('preserves a leading non-separator character in a description', async () => {
      // Only the " - " separator may be stripped from the trailing prose - a
      // meaningful leading character (here "(") must survive into the
      // description rather than being eaten by a greedy noise stripper.
      const content = [
        '# Awesome Foo',
        '',
        '## Tools',
        '',
        '* [a](https://github.com/x/a) - (deprecated) legacy tool',
        '* [b](https://github.com/x/b) - active tool',
        '',
      ].join('\n');

      const { jsonData } = await enhance({
        content,
        originalRepository: 'x/awesome-foo',
        token,
      });

      const tools = jsonData.items.find(s => s.title === 'Tools');
      const item = tools?.items.find(i => i.title === 'a');
      expect(item).toBeDefined();
      expect(item?.description).toBe('(deprecated) legacy tool');
    });
  });

  describe('Footer marker (req 3 & 6)', () => {
    beforeEach(() => {
      // parseGitHubUrl -> null ⇒ no GitHub links collected ⇒ getRepoInfo /
      // (later) getReadme are never invoked, so enhancement is a no-op here.
      vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
    });

    it('appends an enhansomed-on footer with an ISO date when branded', async () => {
      const { finalContent } = await enhance({
        content: '# Awesome Go\n\nA list of awesome Go frameworks.',
        originalRepository: 'owner/source-repo',
        token,
        now: new Date('2026-06-28T12:00:00Z'),
      });
      expect(finalContent).toMatch(
        /\n\*\*\*\n\n> _Enhansomed by \[enhansome\]\(https:\/\/github\.com\/enhansome\) on 2026-06-28\._\n$/,
      );
    });

    it('does not append the footer when branding is disabled', async () => {
      const { finalContent } = await enhance({
        content: '# Awesome Go\n\nA list.',
        disableBranding: true,
        originalRepository: 'owner/source-repo',
        token,
        now: new Date('2026-06-28T12:00:00Z'),
      });
      expect(finalContent).not.toContain('Enhansomed');
    });
  });

  describe('Sorting', () => {
    beforeEach(() => {
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => ({
        owner: 'user',
        repo: url.split('/')[4],
      }));
      vi.mocked(github.getRepoInfo).mockImplementation(
        (_octokit, _owner: string, repo: string) =>
          Promise.resolve(repoMockDb.sorting[repo] ?? null),
      );
      vi.mocked(github.getReadme).mockResolvedValue('# project\n');
    });

    it('should sort a list by stars', async () => {
      const originalContent = `
* [Project B](https://github.com/user/repo-b) - 100 stars
* [Project C](https://github.com/user/repo-c) - 300 stars
* [Project A](https://github.com/user/repo-a) - 200 stars
    `;
      const { finalContent } = await enhance({
        content: originalContent,
        originalRepository: 'owner/source-repo',
        sortBy: 'stars',
        token,
      });

      expect(finalContent.indexOf('repo-c')).toBeLessThan(
        finalContent.indexOf('repo-a'),
      );
      expect(finalContent.indexOf('repo-a')).toBeLessThan(
        finalContent.indexOf('repo-b'),
      );
    });
  });

  describe('JSON Generation and Structure', () => {
    it('should handle a complex markdown structure and create section-based JSON', async () => {
      const complexContent = fs.readFileSync(
        path.join(__dirname, 'fixtures', 'original', 'complex.md'),
        'utf-8',
      );
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
        if (!url.includes('github.com')) {
          return null;
        }
        const parts = url.split('/');
        return { owner: parts[3], repo: parts[4] };
      });
      vi.mocked(github.getRepoInfo).mockImplementation(
        (_octokit, _owner: string, repo: string) =>
          Promise.resolve(repoMockDb.structure[repo] ?? null),
      );
      vi.mocked(github.getReadme).mockResolvedValue('# project\n');

      const { jsonData } = await enhance({
        content: complexContent,
        originalRepository: 'owner/source-repo',
        sortBy: 'stars',
        token,
      });

      expect(jsonData).not.toBeNull();
      // Expect two sections, as the middle one with one link is skipped
      expect(jsonData.items).toHaveLength(2);

      expect(jsonData.metadata.title).toBe('My Awesome List with stars');

      // Check first section
      const firstSection = jsonData.items[0];
      expect(firstSection.title).toBe('First Section');
      expect(firstSection.description).toBe(
        'Description for the first section.',
      );
      expect(firstSection.items).toHaveLength(3);
      // JSON order now matches the rendered markdown: sorted by stars desc.
      // Repo B (300) > Repo C (200) > Repo A (100).
      const repoB = firstSection.items[0];
      expect(repoB.title).toBe('Repo B');
      expect(isItem(repoB)).toBe(true);
      expect(isItem(repoB) ? repoB.repo_info?.stars : undefined).toBe(300);
      expect(firstSection.items[1].title).toBe('Repo C');
      expect(firstSection.items[2].title).toBe('Repo A');

      // Nested items travel with their parent (Repo B).
      const nestedItems = repoB.children;
      expect(nestedItems).toHaveLength(1);
      const nested1 = nestedItems[0];
      expect(nested1.title).toBe('Nested 1');
      expect(isItem(nested1) ? nested1.repo_info?.language : undefined).toBe(
        'JS',
      );

      // Check second valid section (sorted: Repo C 200 before Repo A 100)
      const thirdSection = jsonData.items[1];
      expect(thirdSection.title).toBe('Third Section');
      expect(thirdSection.description).toBe('Another valid section.');
      expect(thirdSection.items).toHaveLength(2);
      expect(thirdSection.items[0].title).toBe('Repo C');
      expect(thirdSection.items[1].title).toBe('Repo A');
    });
  });

  describe('Comprehensive End-to-End Test', () => {
    it('should handle a complex document with branding, replacements, sorting, and badges', async () => {
      const originalContent = `
# Awesome Test List

Version: __VERSION__ | Last Updated: 2025-01-01

* [Repo C](https://github.com/user/repo-c) - A new project.
* [Repo A](https://github.com/user/repo-a) - An older, popular project.
`;
      const expectedContent = fs.readFileSync(
        path.join(__dirname, 'fixtures', 'expected', 'e2e.md'),
        'utf-8',
      );
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
        if (url.includes('github.com')) {
          return { owner: 'user', repo: url.split('/')[4] };
        }
        return null;
      });
      vi.mocked(github.getRepoInfo).mockImplementation(
        (_octokit, _owner: string, repo: string) =>
          Promise.resolve(repoMockDb.endToEnd[repo] ?? null),
      );
      vi.mocked(github.getReadme).mockResolvedValue('# project\n');

      const { finalContent } = await enhance({
        content: originalContent,
        findAndReplaceRaw: '__VERSION__:::1.5.0',
        regexFindAndReplaceRaw: '\\d{4}-\\d{2}-\\d{2}:::TBD',
        originalRepository: 'owner/source-repo',
        sortBy: 'stars',
        token,
        now: new Date('2026-06-28T12:00:00Z'),
      });

      expect(finalContent).toEqual(expectedContent);
    });
  });

  describe('Original Repository in JSON Metadata', () => {
    beforeEach(() => {
      // parseGitHubUrl -> null ⇒ no GitHub links collected ⇒ getRepoInfo /
      // (later) getReadme are never invoked, so enhancement is a no-op here.
      vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
    });

    it('should include original_repository in JSON metadata when provided', async () => {
      const originalContent =
        '# Awesome Test List\n\n* [Some Repo](https://github.com/user/repo)';
      const originalRepository = 'jorgebucaran/awsm.fish';
      const enhancedRepository = 'myuser/awsm-with-stars';

      const { jsonData } = await enhance({
        content: originalContent,
        originalRepository,
        enhancedRepository,
        enhancedRepositoryDescription: 'Enhanced awesome list',
        token,
      });

      expect(jsonData.metadata.original_repository).toBe(originalRepository);
      expect(jsonData.metadata.enhanced_repository).toBe(enhancedRepository);
      expect(jsonData.metadata.enhanced_repository_description).toBe(
        'Enhanced awesome list',
      );
    });

    it('should include the source commit SHA in JSON metadata when provided', async () => {
      const originalContent = '# Awesome Test List';

      const { jsonData } = await enhance({
        content: originalContent,
        originalRepository: 'jorgebucaran/awsm.fish',
        originalRepositorySha: 'deadbeefcafe',
        token,
      });

      expect(jsonData.metadata.original_repository_sha).toBe('deadbeefcafe');
    });

    it('should set the source commit SHA to null when not provided', async () => {
      const originalContent = '# Awesome Test List';

      const { jsonData } = await enhance({
        content: originalContent,
        originalRepository: 'jorgebucaran/awsm.fish',
        token,
      });

      expect(jsonData.metadata.original_repository_sha).toBeNull();
    });
  });

  describe('Item kind classification (integration)', () => {
    const registryReadme = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'original', 'kind-registry.md'),
      'utf-8',
    );
    const repositoryReadme = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'original', 'kind-repository.md'),
      'utf-8',
    );

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
        if (!url.includes('github.com')) {
          return null;
        }
        const parts = url.split('/');
        return {
          owner: parts[parts.length - 2],
          repo: parts[parts.length - 1],
        };
      });
      vi.mocked(github.getRepoInfo).mockResolvedValue({
        archived: false,
        language: 'TypeScript',
        open_issues_count: 0,
        owner: 'test-user',
        pushed_at: '2025-01-01T00:00:00Z',
        repo: 'test-repo',
        stargazers_count: 100,
      });
    });

    it('stamps metadata.kind from the source and per-item kind from each target README', async () => {
      // awesome-go's target README is a registry; gin's is a single project.
      vi.mocked(github.getReadme).mockImplementation(
        (_octokit, _owner: string, repo: string) => {
          if (repo === 'awesome-go') {
            return Promise.resolve(registryReadme);
          }
          return Promise.resolve(repositoryReadme);
        },
      );

      const content = [
        '# Awesome Index',
        '',
        '## Lists',
        '',
        '* [awesome-go](https://github.com/avelino/awesome-go) - a registry target',
        '* [gin](https://github.com/gin-gonic/gin) - a repository target',
        '',
      ].join('\n');

      const { jsonData } = await enhance({
        content,
        disableBranding: true,
        originalRepository: 'enhansome/awesome-index',
        token,
      });

      // The source has 2 GitHub list items (< 20) -> repository by the oracle.
      expect(jsonData.metadata.kind).toBe('repository');

      const lists = jsonData.items.find(s => s.title === 'Lists');
      expect(lists).toBeDefined();
      const kindByTitle = Object.fromEntries(
        lists?.items.filter(isItem).map(i => [i.title, i.kind]) ?? [],
      );
      expect(kindByTitle['awesome-go']).toBe('registry');
      expect(kindByTitle.gin).toBe('repository');
    });

    it('types a large source list as a registry (metadata.kind)', async () => {
      // Every target README here is a project, so items stay repositories; the
      // point is the *source* has >= 20 entries -> metadata.kind = registry.
      vi.mocked(github.getReadme).mockResolvedValue(repositoryReadme);

      const { jsonData } = await enhance({
        content: registryReadme,
        disableBranding: true,
        originalRepository: 'example/awesome-example',
        token,
      });

      expect(jsonData.metadata.kind).toBe('registry');
      // Sanity: items did get classified (all repositories here).
      for (const section of jsonData.items) {
        for (const item of section.items.filter(isItem)) {
          expect(item.kind).toBe('repository');
        }
      }
    });

    it('does not fail on a dead target link (non-fatal): item defaults to repository', async () => {
      // One target is dead — both /repos and README 404. The run must still
      // succeed; the item is emitted with kind 'repository' and no repo_info,
      // while its live neighbour is enriched normally.
      vi.mocked(github.getRepoInfo).mockImplementation(
        (_octokit, _owner: string, repo: string) =>
          repo === 'dead'
            ? Promise.reject(new Error('Not Found (404)'))
            : Promise.resolve({
                archived: false,
                language: 'TypeScript',
                open_issues_count: 0,
                owner: 'o',
                pushed_at: '2025-01-01T00:00:00Z',
                repo,
                stargazers_count: 10,
              }),
      );
      vi.mocked(github.getReadme).mockImplementation(
        (_octokit, _owner: string, repo: string) =>
          repo === 'dead'
            ? Promise.reject(new Error('Not Found (404)'))
            : Promise.resolve('# project\n'),
      );

      const content = [
        '# Awesome Foo',
        '',
        '## Tools',
        '',
        '* [alive](https://github.com/o/alive) - lives',
        '* [dead](https://github.com/o/dead) - dead link',
        '',
      ].join('\n');

      const { jsonData } = await enhance({
        content,
        disableBranding: true,
        originalRepository: 'o/awesome-foo',
        token,
      });

      const tools = jsonData.items.find(s => s.title === 'Tools');
      expect(tools).toBeDefined();
      const byTitle = Object.fromEntries(
        tools?.items.filter(isItem).map(i => [i.title, i]) ?? [],
      );
      // The dead link did not fail the run — its item is still in the graph...
      expect(byTitle.dead).toBeDefined();
      // ...defaulted to 'repository' (no README to classify it)...
      expect(byTitle.dead.kind).toBe('repository');
      // ...and without repo_info (no /repos either).
      expect(byTitle.dead.repo_info).toBeUndefined();
      // The live neighbour is unaffected.
      expect(byTitle.alive.kind).toBe('repository');
      expect(byTitle.alive.repo_info).toBeDefined();
    });
  });

  describe('Item kinds: jbhuang0604/awesome-computer-vision (mixed meta+list)', () => {
    // The real source is a genuinely mixed awesome-list — the case the per-item
    // oracle exists for and no repo-level meta/list classifier could bin: its
    // "Awesome Lists" section links other registries, its "Software" section
    // links concrete repositories (and hides a registry among them), and its
    // "Books"/"Courses" sections are non-GitHub. The fixture is the *real*
    // README; each target's README is mocked to a known-kind fixture so the
    // assertion is about enhance()'s wiring (kind -> JsonItem), not the network.
    const content = fs.readFileSync(
      path.join(
        __dirname,
        'fixtures',
        'original',
        'awesome-computer-vision.md',
      ),
      'utf-8',
    );
    const registryReadme = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'original', 'kind-registry.md'),
      'utf-8',
    );
    const repositoryReadme = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'original', 'kind-repository.md'),
      'utf-8',
    );

    // Awesome-list targets whose repo name lacks the "awesome"/"awsome" stem.
    const explicitRegistries = new Set([
      '3D-Machine-Learning',
      'Deep-Learning-for-Tracking-and-Detection',
    ]);

    interface AnyItem {
      children?: AnyItem[];
      kind?: string;
      title: string;
    }

    // Flatten every JsonItem (with its kind) across all sections, recursing into
    // children, so assertions don't depend on which subsections clear minLinks.
    function allItems(sections: { items: AnyItem[] }[]): AnyItem[] {
      const out: AnyItem[] = [];
      function walk(items: AnyItem[]) {
        for (const it of items) {
          out.push(it);
          if (it.children) {
            walk(it.children);
          }
        }
      }
      for (const s of sections) {
        walk(s.items);
      }
      return out;
    }

    beforeEach(async () => {
      vi.clearAllMocks();
      // Use the REAL parseGitHubUrl so trailing-path GitHub URLs in the source
      // (…/pulls, …/blob/master/…) resolve to the right owner/repo instead of
      // the naive last-two-segments mock used by the simpler suites above.
      const actual = await vi.importActual<typeof github>('./github.js');
      vi.mocked(github.parseGitHubUrl).mockImplementation(
        actual.parseGitHubUrl,
      );
      vi.mocked(github.getRepoInfo).mockResolvedValue({
        archived: false,
        language: 'C',
        open_issues_count: 0,
        owner: 'test-user',
        pushed_at: '2025-01-01T00:00:00Z',
        repo: 'test-repo',
        stargazers_count: 100,
      });
      // Mock the per-target oracle: a registry README (>= 20 entries) for targets
      // whose name reads as an awesome-list, a project README otherwise.
      vi.mocked(github.getReadme).mockImplementation(
        (_octokit, _owner: string, repo: string) =>
          Promise.resolve(
            /awesome|awsome/i.test(repo) || explicitRegistries.has(repo)
              ? registryReadme
              : repositoryReadme,
          ),
      );
    });

    function enhanceAcv() {
      return enhance({
        content,
        disableBranding: true,
        originalRepository: 'jbhuang0604/awesome-computer-vision',
        token,
      });
    }

    it('classifies the mixed source itself as a registry (>= 20 entries)', async () => {
      const { jsonData } = await enhanceAcv();
      expect(jsonData.metadata.kind).toBe('registry');
    });

    it('types every "Awesome Lists" entry as a registry', async () => {
      const { jsonData } = await enhanceAcv();
      const awesomeLists = jsonData.items.find(
        s => s.title === 'Awesome Lists',
      );
      expect(
        awesomeLists,
        '"Awesome Lists" section should exist',
      ).toBeDefined();
      const items = awesomeLists?.items ?? [];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items.filter(isItem)) {
        expect(item.kind, `"${item.title}" should be a registry`).toBe(
          'registry',
        );
      }
    });

    it('types concrete Software entries as repositories', async () => {
      const { jsonData } = await enhanceAcv();
      const ccv = allItems(jsonData.items).find(i =>
        i.title.toLowerCase().includes('ccv'),
      );
      expect(ccv, 'ccv should be present in the JSON graph').toBeDefined();
      expect(ccv?.kind).toBe('repository');
    });

    it('assigns kinds per item, not per source (mixed kinds in one pass)', async () => {
      // The defining property of the per-item oracle: a single mixed source
      // yields BOTH registries (its "Awesome Lists" entries) and repositories
      // (its "Software" entries) in one enhance() pass — something a repo-level
      // meta/list classifier could never produce.
      const { jsonData } = await enhanceAcv();
      const kinds = new Set(allItems(jsonData.items).map(i => i.kind));
      expect(kinds.has('registry')).toBe(true);
      expect(kinds.has('repository')).toBe(true);
    });

    it('drops non-GitHub entries from the JSON graph but keeps them in markdown (D9)', async () => {
      const { finalContent, jsonData } = await enhanceAcv();
      const bookTitle = 'Models, Learning, and Inference';
      // A Books entry has no GitHub link -> never typed -> not a JsonItem.
      expect(
        allItems(jsonData.items).find(i => i.title.includes(bookTitle)),
        'non-GitHub book must be absent from the typed JSON graph',
      ).toBeUndefined();
      // ...but it is retained in the enhanced markdown (badges/sorting only).
      expect(finalContent).toContain(bookTitle);
    });
  });
});
