import * as core from '@actions/core';
import * as githubClient from '@enhansome/core';
import { enhance, type EnhanceResult } from '@enhansome/core';
import * as fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { actionsLog } from './actions-log.js';
import { parseReplacementRules, run } from './main.js';

let inputs: Record<string, string> = {};

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  error: vi.fn(),
  getInput: vi.fn((name: string) => inputs[name] ?? ''),
  info: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  context: {
    payload: { repository: { description: 'enhanced list' } },
    repo: { owner: 'me', repo: 'my-list' },
  },
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@enhansome/core', () => ({
  enhance: vi.fn(),
  getLatestCommitSha: vi.fn(),
  getReadme: vi.fn(),
  makeOctokit: vi.fn(() => ({ __client: true })),
  parseOwnerRepo: vi.fn(),
}));

function enhanceResult(overrides: Partial<EnhanceResult> = {}): EnhanceResult {
  return {
    finalContent: 'enhanced',
    jsonData: {
      items: [],
      metadata: {
        last_updated: '2026-06-27T00:00:00.000Z',
        original_repository: 'NARKOZ/guides',
        original_repository_sha: 'abc123',
        enhanced_repository: 'me/my-list',
        enhanced_repository_description: 'enhanced list',
        title: 'My List',
      },
    },
    ...overrides,
  };
}

describe('main: run()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inputs = {
      github_token: 'test-token',
      markdown_file: 'README.md',
      original_repository: 'NARKOZ/guides',
    };
    vi.mocked(enhance).mockResolvedValue(enhanceResult());
    vi.mocked(githubClient.parseOwnerRepo).mockReturnValue({
      owner: 'NARKOZ',
      repo: 'guides',
    });
    vi.mocked(githubClient.getReadme).mockResolvedValue('# Source README');
    vi.mocked(githubClient.getLatestCommitSha).mockResolvedValue('abc123');
  });

  it('fetches the source README rather than reading the local file', async () => {
    await run();

    expect(fs.readFile).not.toHaveBeenCalled();
    expect(githubClient.makeOctokit).toHaveBeenCalledWith('test-token', {
      log: actionsLog,
    });
    expect(githubClient.getReadme).toHaveBeenCalledWith(
      { __client: true },
      'NARKOZ',
      'guides',
    );
    expect(vi.mocked(enhance).mock.calls[0][0]).toMatchObject({
      content: '# Source README',
      log: actionsLog,
    });
  });

  it('passes the source commit SHA through to enhance()', async () => {
    await run();

    expect(githubClient.getLatestCommitSha).toHaveBeenCalledWith(
      { __client: true },
      'NARKOZ',
      'guides',
    );
    expect(vi.mocked(enhance).mock.calls[0][0]).toMatchObject({
      originalRepositorySha: 'abc123',
    });
  });

  it('proceeds (with a warning) when the SHA cannot be determined', async () => {
    vi.mocked(githubClient.getLatestCommitSha).mockResolvedValue(null);

    await run();

    expect(core.warning).toHaveBeenCalled();
    expect(vi.mocked(enhance).mock.calls[0][0]).toMatchObject({
      originalRepositorySha: undefined,
    });
    expect(fs.writeFile).toHaveBeenCalledWith('README.md', 'enhanced', 'utf-8');
  });

  it('writes the enhanced output to markdown_file', async () => {
    await run();

    expect(fs.writeFile).toHaveBeenCalledWith('README.md', 'enhanced', 'utf-8');
  });

  it('fails when the source README cannot be fetched (strict mode)', async () => {
    vi.mocked(githubClient.getReadme).mockRejectedValue(
      new Error('Not Found (404)'),
    );

    await run();

    // getReadme now throws; the top-level catch surfaces the error message
    // instead of a dedicated null branch.
    expect(core.setFailed).toHaveBeenCalledWith(
      'Action failed with error: Not Found (404)',
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('fails when original_repository is missing', async () => {
    delete inputs.original_repository;
    vi.mocked(githubClient.parseOwnerRepo).mockReturnValue(null);

    await run();

    expect(core.setFailed).toHaveBeenCalled();
    expect(githubClient.getReadme).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('fails on a malformed original_repository', async () => {
    inputs.original_repository = 'not-a-repo';
    vi.mocked(githubClient.parseOwnerRepo).mockReturnValue(null);

    await run();

    expect(core.setFailed).toHaveBeenCalled();
    expect(githubClient.getReadme).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  // The `:::`-separated Actions inputs are reshaped into structured rules at
  // this boundary, so enhance() receives ReplacementRule[] (the library's own
  // type), not the raw strings.
  it('parses find_and_replace / regex_find_and_replace into structured replacements', async () => {
    inputs.find_and_replace = 'foo:::bar';
    inputs.regex_find_and_replace = '\\d+:::N';

    await run();

    expect(vi.mocked(enhance).mock.calls[0][0]).toMatchObject({
      replacements: [
        { find: 'foo', replace: 'bar', type: 'literal' },
        { find: '\\d+', replace: 'N', type: 'regex' },
      ],
    });
  });
});

describe('main: parseReplacementRules (Actions-input parsing)', () => {
  it('parses literal find:::replace lines into literal rules', () => {
    expect(parseReplacementRules('a:::1\nb:::2', '')).toEqual([
      { find: 'a', replace: '1', type: 'literal' },
      { find: 'b', replace: '2', type: 'literal' },
    ]);
  });

  it('parses regex lines into regex rules', () => {
    expect(parseReplacementRules('', '\\d+:::N')).toEqual([
      { find: '\\d+', replace: 'N', type: 'regex' },
    ]);
  });

  it('emits literal rules before regex rules', () => {
    expect(parseReplacementRules('lit:::L', 'reg:::R')).toEqual([
      { find: 'lit', replace: 'L', type: 'literal' },
      { find: 'reg', replace: 'R', type: 'regex' },
    ]);
  });

  it('skips blank lines and lines without the separator', () => {
    expect(
      parseReplacementRules('\nno-separator here\nkeep:::me\n   \n', ''),
    ).toEqual([{ find: 'keep', replace: 'me', type: 'literal' }]);
  });

  // The replace side may legitimately contain `:::`; only the first split is
  // the find, the rest is rejoined verbatim.
  it('preserves `:::` in the replacement by joining the remainder', () => {
    expect(parseReplacementRules('a:::b:::c', '')).toEqual([
      { find: 'a', replace: 'b:::c', type: 'literal' },
    ]);
  });

  it('returns no rules when both inputs are empty', () => {
    expect(parseReplacementRules('', '')).toEqual([]);
  });
});
