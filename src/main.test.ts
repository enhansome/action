import * as core from '@actions/core';
import * as fs from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as githubClient from './github.js';
import { run } from './main.js';
import { enhance } from './orchestrator.js';

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

vi.mock('./github.js', () => ({
  getLatestCommitSha: vi.fn(),
  getReadme: vi.fn(),
  makeOctokit: vi.fn(() => ({ __client: true })),
  parseOwnerRepo: vi.fn(),
}));

vi.mock('./orchestrator.js', () => ({
  enhance: vi.fn(),
}));

function enhanceResult(overrides = {}) {
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
    expect(githubClient.makeOctokit).toHaveBeenCalledWith('test-token');
    expect(githubClient.getReadme).toHaveBeenCalledWith(
      { __client: true },
      'NARKOZ',
      'guides',
    );
    expect(vi.mocked(enhance).mock.calls[0][0]).toMatchObject({
      content: '# Source README',
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

  it('fails when the source has no README', async () => {
    vi.mocked(githubClient.getReadme).mockResolvedValue(null);

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      'No README found in NARKOZ/guides',
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
});
