import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as github from './github.js';
import { RepoInfoDetails } from './github.js';
import { enhance } from './orchestrator.js';

// Mock the lowest-level dependency, which is the GitHub API client.
vi.mock('./github.js');

describe('Orchestrator: enhance()', () => {
  const token = 'test-token';

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

      const { finalContent } = await enhance({
        content: originalContent,
        token,
      });

      expect(github.getRepoInfo).toHaveBeenCalledWith(
        'test-user',
        'test-repo',
        token,
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

      const { finalContent } = await enhance({
        content: originalContent,
        token,
      });

      expect(github.getRepoInfo).toHaveBeenCalled();
      expect(finalContent).toBe(expectedContent);
    });
  });

  describe('Find and Replace', () => {
    beforeEach(() => {
      vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
      vi.mocked(github.getRepoInfo).mockResolvedValue(null);
    });

    it('should perform a literal find and replace', async () => {
      const originalContent = 'This is version v__VERSION__.';
      const expectedContent = 'This is version v1.2.3.';
      const findAndReplaceRaw = 'v__VERSION__:::v1.2.3';

      const { finalContent } = await enhance({
        content: originalContent,
        findAndReplaceRaw,
        token,
      });
      expect(finalContent).toBe(expectedContent);
    });

    it('should perform a regex find and replace', async () => {
      const originalContent =
        'Release date: 2025-01-10\nAnother date: 2024-12-25';
      const expectedContent = 'Release date: TBD\nAnother date: TBD';
      const regexFindAndReplaceRaw = '\\d{4}-\\d{2}-\\d{2}:::TBD';

      const { finalContent } = await enhance({
        content: originalContent,
        regexFindAndReplaceRaw,
        token,
      });
      expect(finalContent).toBe(expectedContent);
    });
  });

  describe('Branding', () => {
    beforeEach(() => {
      vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
      vi.mocked(github.getRepoInfo).mockResolvedValue(null);
    });

    it('should apply the branding rule by default', async () => {
      const originalContent =
        '# Awesome Go\n\nA list of awesome Go frameworks.';
      const expectedContent =
        '# Awesome Go with stars\n\nA list of awesome Go frameworks.';

      const { finalContent } = await enhance({
        content: originalContent,
        token,
      });
      expect(finalContent).toBe(expectedContent);
    });

    it('should NOT apply branding if disableBranding is true', async () => {
      const originalContent = '# Awesome Go\n\nThis title should not change.';

      const { finalContent } = await enhance({
        content: originalContent,
        disableBranding: true,
        token,
      });
      expect(finalContent).toBe(originalContent);
    });
  });

  describe('Sorting', () => {
    beforeEach(() => {
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => ({
        owner: 'user',
        repo: url.split('/')[4],
      }));
      vi.mocked(github.getRepoInfo).mockImplementation(
        (owner: string, repo: string) => {
          const repoData: Record<string, RepoInfoDetails> = {
            'repo-a': {
              archived: false,
              language: 'Go',
              open_issues_count: 1,
              owner: 'user',
              pushed_at: '2025-01-01T00:00:00Z',
              repo: 'repo-a',
              stargazers_count: 200,
            },
            'repo-b': {
              archived: false,
              language: 'Go',
              open_issues_count: 1,
              owner: 'user',
              pushed_at: '2025-02-01T00:00:00Z',
              repo: 'repo-b',
              stargazers_count: 100,
            },
            'repo-c': {
              archived: false,
              language: 'Go',
              open_issues_count: 1,
              owner: 'user',
              pushed_at: '2025-03-01T00:00:00Z',
              repo: 'repo-c',
              stargazers_count: 300,
            },
          };
          return Promise.resolve(repoData[repo]);
        },
      );
    });

    it('should sort a list by stars', async () => {
      const originalContent = `
* [Project B](https://github.com/user/repo-b) - 100 stars
* [Project C](https://github.com/user/repo-c) - 300 stars
* [Project A](https://github.com/user/repo-a) - 200 stars
    `;
      const { finalContent } = await enhance({
        content: originalContent,
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
      const complexContent = `
# My Awesome List

### First Section

Description for the first section.

* [Repo C](https://github.com/user/repo-c) - 200 stars
* [Repo B](https://github.com/user/repo-b) - 300 stars
  * [Nested 1](https://github.com/user/nested-1) - 50 stars.
* [Repo A](https://github.com/user/repo-a) - 100 stars

### Second Section (Not enough links)
* [Single Repo](https://github.com/user/single-link-repo)

### Third Section
Another valid section.
* [Repo A](https://github.com/user/repo-a) - 100 stars.
* [Repo C](https://github.com/user/repo-c) - 200 stars.
`;
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
        if (!url.includes('github.com')) {
          return null;
        }
        const parts = url.split('/');
        return { owner: parts[3], repo: parts[4] };
      });
      vi.mocked(github.getRepoInfo).mockImplementation(
        (owner: string, repo: string): Promise<null | RepoInfoDetails> => {
          const db: Record<string, RepoInfoDetails> = {
            'nested-1': {
              archived: false,
              language: 'JS',
              open_issues_count: 4,
              owner: 'user',
              pushed_at: '2025-01-15T00:00:00Z',
              repo: 'nested-1',
              stargazers_count: 50,
            },
            'repo-a': {
              archived: false,
              language: 'Go',
              open_issues_count: 1,
              owner: 'user',
              pushed_at: '2025-01-01T00:00:00Z',
              repo: 'repo-a',
              stargazers_count: 100,
            },
            'repo-b': {
              archived: false,
              language: 'Rust',
              open_issues_count: 2,
              owner: 'user',
              pushed_at: '2025-03-01T00:00:00Z',
              repo: 'repo-b',
              stargazers_count: 300,
            },
            'repo-c': {
              archived: false,
              language: 'Python',
              open_issues_count: 3,
              owner: 'user',
              pushed_at: '2025-02-01T00:00:00Z',
              repo: 'repo-c',
              stargazers_count: 200,
            },
          };
          return Promise.resolve(db[repo] ?? null);
        },
      );

      const { jsonData } = await enhance({
        content: complexContent,
        sortBy: 'stars',
        token,
      });

      expect(jsonData).not.toBeNull();
      // Expect two sections, as the middle one with one link is skipped
      expect(jsonData.items).toHaveLength(2);

      // Check metadata
      expect(jsonData.metadata.title).toBe('My Awesome List');

      // Check first section
      const firstSection = jsonData.items[0];
      expect(firstSection.title).toBe('First Section');
      expect(firstSection.description).toBe(
        'Description for the first section.',
      );
      expect(firstSection.items).toHaveLength(3);
      // **Crucially, check that JSON order is original order, not sorted order**
      expect(firstSection.items[0].title).toBe('Repo C');
      expect(firstSection.items[1].title).toBe('Repo B');
      expect(firstSection.items[1].repo_info?.stars).toBe(300);

      // Check nested items
      const nestedItems = firstSection.items[1].children;
      expect(nestedItems).toHaveLength(1);
      expect(nestedItems[0].title).toBe('Nested 1');
      expect(nestedItems[0].repo_info?.language).toBe('JS');

      // Check second valid section
      const thirdSection = jsonData.items[1];
      expect(thirdSection.title).toBe('Third Section');
      expect(thirdSection.description).toBe('Another valid section.');
      expect(thirdSection.items).toHaveLength(2);
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
      const expectedContent = `# Awesome Test List with stars

Version: 1.5.0 | Last Updated: TBD

* [Repo A](https://github.com/user/repo-a) ⭐ 1,000 | 🐛 10 | 🌐 Go | 📅 2024-05-10 - An older, popular project.
* [Repo C](https://github.com/user/repo-c) ⭐ 50 | 🐛 1 | 🌐 Rust | 📅 2025-07-12 - A new project.
`;
      vi.mocked(github.parseGitHubUrl).mockImplementation((url: string) => {
        if (url.includes('github.com')) {
          return { owner: 'user', repo: url.split('/')[4] };
        }
        return null;
      });
      vi.mocked(github.getRepoInfo).mockImplementation(
        (owner: string, repo: string): Promise<null | RepoInfoDetails> => {
          const db: Record<string, RepoInfoDetails> = {
            'repo-a': {
              archived: false,
              language: 'Go',
              open_issues_count: 10,
              owner: 'user',
              pushed_at: '2024-05-10T12:00:00Z',
              repo: 'repo-a',
              stargazers_count: 1000,
            },
            'repo-c': {
              archived: false,
              language: 'Rust',
              open_issues_count: 1,
              owner: 'user',
              pushed_at: '2025-07-12T12:00:00Z',
              repo: 'repo-c',
              stargazers_count: 50,
            },
          };
          return Promise.resolve(db[repo] ?? null);
        },
      );

      const { finalContent } = await enhance({
        content: originalContent,
        findAndReplaceRaw: '__VERSION__:::1.5.0',
        regexFindAndReplaceRaw: '\\d{4}-\\d{2}-\\d{2}:::TBD',
        sortBy: 'stars',
        token,
      });

      expect(finalContent).toEqual(expectedContent);
    });
  });

  describe('Original Repository in JSON Metadata', () => {
    beforeEach(() => {
      vi.mocked(github.parseGitHubUrl).mockReturnValue(null);
      vi.mocked(github.getRepoInfo).mockResolvedValue(null);
    });

    it('should include original_repository in JSON metadata when provided', async () => {
      const originalContent =
        '# Awesome Test List\n\n* [Some Repo](https://github.com/user/repo)';
      const originalRepository = 'jorgebucaran/awsm.fish';
      const sourceRepository = 'myuser/awsm-with-stars';

      const { jsonData } = await enhance({
        content: originalContent,
        originalRepository,
        sourceRepository,
        sourceRepositoryDescription: 'Enhanced awesome list',
        token,
      });

      expect(jsonData.metadata.original_repository).toBe(originalRepository);
      expect(jsonData.metadata.source_repository).toBe(sourceRepository);
      expect(jsonData.metadata.source_repository_description).toBe(
        'Enhanced awesome list',
      );
    });

    it('should set original_repository to null when not provided', async () => {
      const originalContent = '# Awesome Test List';

      const { jsonData } = await enhance({
        content: originalContent,
        token,
      });

      expect(jsonData.metadata.original_repository).toBeNull();
    });

    it('should set original_repository to null when empty string is provided', async () => {
      const originalContent = '# Awesome Test List';

      const { jsonData } = await enhance({
        content: originalContent,
        originalRepository: '',
        token,
      });

      expect(jsonData.metadata.original_repository).toBeNull();
    });
  });
});
