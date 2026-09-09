import { describe, expect, it } from 'vitest';

import {
  isFilenameLabel,
  isSkippedPath,
  parseSameRepoBlobPath,
  resolveRepoPath,
} from './internal-links.js';

describe('resolveRepoPath', () => {
  it('resolves repo-relative targets from the root', () => {
    expect(resolveRepoPath('docs/tools.md', '')).toBe('docs/tools.md');
  });

  it('resolves targets against the referring file directory', () => {
    expect(resolveRepoPath('../guides/x.md', 'docs/apps')).toBe(
      'docs/guides/x.md',
    );
    expect(resolveRepoPath('sibling.md', 'docs/apps')).toBe(
      'docs/apps/sibling.md',
    );
  });

  it('treats a leading slash as repo-root-absolute', () => {
    expect(resolveRepoPath('/README_cn.md', 'docs')).toBe('README_cn.md');
  });

  it('returns null for anything that is not an in-repo path', () => {
    expect(resolveRepoPath('https://github.com/a/b', '')).toBeNull();
    expect(resolveRepoPath('mailto:x@y.z', '')).toBeNull();
    expect(resolveRepoPath('#anchor', '')).toBeNull();
    expect(resolveRepoPath('', '')).toBeNull();
  });

  it('returns null when .. escapes the repo root', () => {
    expect(resolveRepoPath('../outside.md', '')).toBeNull();
    expect(resolveRepoPath('../../outside.md', 'docs')).toBeNull();
  });
});

describe('isSkippedPath', () => {
  it('skips root meta documents wherever GitHub convention puts them', () => {
    expect(isSkippedPath('CONTRIBUTING.md')).toBe(true);
    expect(isSkippedPath('contributing.md')).toBe(true);
    expect(isSkippedPath('.github/PULL_REQUEST_TEMPLATE.md')).toBe(true);
    expect(isSkippedPath('CHANGELOG.md')).toBe(true);
  });

  it('keeps a content file that merely shares a meta name', () => {
    // android-root's Security category — a basename rule would drop it.
    expect(isSkippedPath('docs/apps-and-modules/security.md')).toBe(false);
    expect(isSkippedPath('docs/contributing.md')).toBe(false);
  });

  it('skips the root README and its translations, keeps directory READMEs', () => {
    expect(isSkippedPath('README.md')).toBe(true);
    expect(isSkippedPath('README_cn.md')).toBe(true);
    expect(isSkippedPath('README.en.md')).toBe(true);
    expect(isSkippedPath('CLI/README.md')).toBe(false);
  });

  it('skips non-markdown paths', () => {
    expect(isSkippedPath('docs/logo.svg')).toBe(true);
    expect(isSkippedPath('docs/')).toBe(true);
  });
});

describe('parseSameRepoBlobPath', () => {
  it('extracts the path from a same-repo blob or raw URL', () => {
    expect(
      parseSameRepoBlobPath(
        'https://github.com/o/r/blob/main/docs/full.md',
        'o',
        'r',
      ),
    ).toBe('docs/full.md');
    expect(
      parseSameRepoBlobPath('https://github.com/o/r/raw/v1/a.md', 'O', 'R'),
    ).toBe('a.md');
  });

  it('returns null for other repos and non-file GitHub URLs', () => {
    expect(
      parseSameRepoBlobPath('https://github.com/x/y/blob/main/a.md', 'o', 'r'),
    ).toBeNull();
    expect(
      parseSameRepoBlobPath('https://github.com/o/r/tree/main/docs', 'o', 'r'),
    ).toBeNull();
    expect(parseSameRepoBlobPath('https://example.com/a.md', 'o', 'r')).toBeNull();
  });
});

describe('isFilenameLabel', () => {
  it('flags the basename, the full path, and path/extension-shaped labels', () => {
    expect(isFilenameLabel('tools.md', 'docs/tools.md')).toBe(true);
    expect(isFilenameLabel('docs/tools.md', 'docs/tools.md')).toBe(true);
    expect(isFilenameLabel('archived.md', 'archived.md')).toBe(true);
  });

  it('keeps real category labels', () => {
    expect(isFilenameLabel('Root Management', 'docs/root-management.md')).toBe(
      false,
    );
    expect(isFilenameLabel('full list', 'docs/full.md')).toBe(false);
  });
});
