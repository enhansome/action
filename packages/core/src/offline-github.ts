import type * as GithubModule from './github.js';
import type { RepoInfoDetails } from './github.js';
import { silentLog } from './logger.js';

// Test-only offline stand-in for the networked surface of ./github.js, shared
// by the golden suite and the yield harness (yield.diag.test.ts) so both run
// the real parser against deterministic repo metadata — star counts, languages
// and push dates vary (via a stable hash of owner/repo) but never drift, which
// exercises sorting and badges without live GitHub data.

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

// Derives metadata from the literal requested casing. Case-variant aliases
// (ReactiveX/RxJS vs reactivex/rxjs) collapse upstream in the lookup's
// case-insensitive memo, so this runs once per canonical repo and both
// spellings share a record — as the real API answers both. Lowercasing the
// hash here would reshuffle every mixed-case repo's star-derived sort position
// across the fixtures, not just aliased pairs.
export function generateRepoInfo(owner: string, repo: string): RepoInfoDetails {
  const hash = hashString(`${owner}/${repo}`);
  const offsetDays = hash % 1000;
  return {
    archived: hash % 17 === 0,
    description: null,
    id: hash,
    language: LANGUAGES[hash % LANGUAGES.length],
    open_issues_count: hash % 100,
    owner,
    pushed_at: new Date(BASE_PUSHED_MS - offsetDays * MS_PER_DAY).toISOString(),
    repo,
    stargazers_count: 1 + (hash % 50_000),
    topics: [],
  };
}

export const offlineGetRepoInfo = (
  _octokit: unknown,
  owner: string,
  repo: string,
): Promise<RepoInfoDetails> => Promise.resolve(generateRepoInfo(owner, repo));

// A real client always carries a `log`; the code under test reads its sink
// back off it (`octokit.log`), so the stand-in has to have one too.
export const offlineMakeOctokit = (() => ({
  log: silentLog,
})) as unknown as typeof GithubModule.makeOctokit;
