import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { enhance } from './orchestrator.js';

// Golden-file suite: pins the full `jsonData` (structure) for every fixture and
// the final rendered markdown (raw) for a few representative ones. Output is
// fully deterministic:
//   - `now` is fixed, so metadata.last_updated and the enhansomed footer never drift;
//   - repo metadata comes from the shared offline stand-in (offline-github.ts), so
//     star counts / languages / push dates are varied but immutable — sorting and
//     badges are genuinely exercised without depending on live GitHub data that
//     drifts weekly.
//
// Regenerate the on-disk goldens after an intentional parser change:
//   UPDATE_GOLDENS=1 yarn test      (or:  yarn test:update-goldens)

// Mock only the networked surface of ./github.js: keep the REAL parseGitHubUrl
// (it's pure and faithful to production link detection) and replace
// makeOctokit + getRepoInfo with the shared deterministic stand-ins.
vi.mock('./github.js', async () => {
  const actual =
    await vi.importActual<typeof import('./github.js')>('./github.js');
  const { offlineGetRepoInfo: getRepoInfo, offlineMakeOctokit } =
    await import('./offline-github.js');
  return {
    ...actual,
    makeOctokit: offlineMakeOctokit,
    // Force one known repo to return null so the "no repoInfo -> sorts last"
    // branch is exercised deterministically in the `complex` fixture.
    getRepoInfo: (octokit: unknown, owner: string, repo: string) =>
      `${owner}/${repo}` === 'user/repo-b'
        ? Promise.resolve(null)
        : getRepoInfo(octokit, owner, repo),
  };
});

// --- fixture inputs ---------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'original');
const STRUCTURE_DIR = path.join(__dirname, 'fixtures', 'expected', 'structure');
const RAW_DIR = path.join(__dirname, 'fixtures', 'expected', 'raw');

const FIXED_NOW = new Date('2025-01-01T00:00:00.000Z');
const RAW_FIXTURES = new Set([
  'complex',
  'guides',
  'paragraph-entries',
  'pinned-gists',
  'table-format',
]);

const sourceRepos = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'source-repos.json'),
    'utf-8',
  ),
) as Record<string, string>;

const fixtureNames = fs
  .readdirSync(FIXTURES_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => f.slice(0, -3))
  .sort();

const UPDATE_GOLDENS = !!process.env.UPDATE_GOLDENS;

// Compare actual output to the on-disk golden; write instead of comparing when
// UPDATE_GOLDENS is set (first-time generation + intentional regen).
function expectGolden(filePath: string, actual: string): void {
  if (UPDATE_GOLDENS) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, actual, 'utf-8');
    return;
  }
  const expected = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8')
    : '';
  expect(
    actual,
    `golden mismatch for ${path.relative(__dirname, filePath)}.\n` +
      `If this is intentional, regenerate with:  UPDATE_GOLDENS=1 yarn test`,
  ).toBe(expected);
}

describe('golden: structure + raw output for README fixtures', () => {
  it.each(fixtureNames.map(name => [name] as [string]))('%s', async name => {
    const content = fs.readFileSync(
      path.join(FIXTURES_DIR, `${name}.md`),
      'utf-8',
    );

    // `complex` is a hand-crafted edge fixture with no source-repos entry; the
    // fallback keeps metadata.original_repository populated.
    const originalRepository = sourceRepos[name] ?? 'example/complex-list';

    const { finalContent, jsonData } = await enhance({
      content,
      enhancedRepository: `enhansome/enhansome-${name}`,
      enhancedRepositoryDescription: 'enhanced list',
      now: FIXED_NOW,
      originalRepository,
      originalRepositoryId: 4242,
      originalRepositorySha: 'deadbeef',
      sortBy: 'stars',
      token: 'test-token',
    });

    expectGolden(
      path.join(STRUCTURE_DIR, `${name}.json`),
      `${JSON.stringify(jsonData, null, 2)}\n`,
    );

    if (RAW_FIXTURES.has(name)) {
      expectGolden(path.join(RAW_DIR, `${name}.md`), finalContent);
    }
  });
});
