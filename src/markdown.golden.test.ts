import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { RepoInfoDetails } from './github.js';

import { enhance } from './orchestrator.js';

// Golden-file suite: pins the full `jsonData` (structure) for every fixture and
// the final rendered markdown (raw) for a few representative ones. Output is
// fully deterministic:
//   - `now` is fixed, so metadata.last_updated and the enhansomed footer never drift;
//   - repo metadata is derived from a stable hash of owner/repo (see below), so star
//     counts / languages / push dates are varied but immutable — sorting and badges
//     are genuinely exercised without depending on live GitHub data that drifts weekly.
//
// Regenerate the on-disk goldens after an intentional parser change:
//   UPDATE_GOLDENS=1 npm test      (or:  npm run test:update-goldens)

// --- deterministic repo-info generator -------------------------------------

// FNV-1a 32-bit. Pure, stable across runs and platforms (Math.imul keeps the
// 32-bit multiply exact; >>> 0 forces unsigned).
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const BASE_PUSHED_MS = Date.UTC(2024, 0, 1);
const MS_PER_DAY = 86_400_000;
// A fixed palette that includes `null` so the "no language" badge branch is hit.
const LANGUAGES: (null | string)[] = [
  'TypeScript',
  'JavaScript',
  'Go',
  'Python',
  'Rust',
  'C++',
  'Java',
  'Ruby',
  'Shell',
  null,
];

function generateRepoInfo(owner: string, repo: string): RepoInfoDetails {
  const hash = hashString(`${owner}/${repo}`);
  const offsetDays = hash % 1000;
  return {
    archived: hash % 17 === 0,
    description: null,
    language: LANGUAGES[hash % LANGUAGES.length],
    open_issues_count: hash % 100,
    owner,
    pushed_at: new Date(BASE_PUSHED_MS - offsetDays * MS_PER_DAY).toISOString(),
    repo,
    stargazers_count: 1 + (hash % 50_000),
    topics: [],
  };
}

// Mock only the networked surface of ./github.js: keep the REAL parseGitHubUrl
// (it's pure — github.ts:227 — and faithful to production link detection) and
// replace makeOctokit + getRepoInfo with deterministic stand-ins.
vi.mock('./github.js', async () => {
  const actual =
    await vi.importActual<typeof import('./github.js')>('./github.js');
  return {
    ...actual,
    makeOctokit: (() => ({})) as unknown as typeof actual.makeOctokit,
    getRepoInfo: deterministicGetRepoInfo,
    getReadme: deterministicGetReadme,
  };
});

// Force one known repo to return null so the "no repoInfo -> sorts last" branch
// (markdown.ts:421 / :695) is exercised deterministically in the `complex` fixture.
function deterministicGetRepoInfo(
  _octokit: unknown,
  owner: string,
  repo: string,
): Promise<null | RepoInfoDetails> {
  const info =
    `${owner}/${repo}` === 'user/repo-b' ? null : generateRepoInfo(owner, repo);
  return Promise.resolve(info);
}

// Deterministic per-item README so the golden suite stays offline AND exercises
// the per-item `registry` classification path end-to-end. classifyKind reads a
// target's rendered HTML only at the content backstop — the precision anchors
// (membership/topic/name/description) fire first, without a fetch — so an
// awesome-list-named target classifies as a registry via the NAME layer before
// its README is ever fetched; everything else gets a plain project README and
// falls through to `repository`. Real awesome-lists overwhelmingly classify as
// registries, so this matches production behavior for the bulk of those targets.
function deterministicGetReadme(
  _octokit: unknown,
  _owner: string,
  repo: string,
): Promise<string> {
  if (/awesome/i.test(repo)) {
    const links = Array.from(
      { length: 60 },
      (_, i) => `<a href="https://github.com/example/item-${i}">item-${i}</a>`,
    );
    return Promise.resolve(`<article>${links.join('')}</article>`);
  }
  return Promise.resolve('<p>project</p>');
}

// --- fixture inputs ---------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'original');
const STRUCTURE_DIR = path.join(__dirname, 'fixtures', 'expected', 'structure');
const RAW_DIR = path.join(__dirname, 'fixtures', 'expected', 'raw');

const FIXED_NOW = new Date('2025-01-01T00:00:00.000Z');
const RAW_FIXTURES = new Set(['complex', 'guides', 'pinned-gists']);

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
      `If this is intentional, regenerate with:  UPDATE_GOLDENS=1 npm test`,
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
