import type * as GithubModule from './github.js';
import type { RepoInfoDetails } from './github.js';
import { silentLog } from './logger.js';

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

const TOPICS: string[][] = [
  [],
  ['cli'],
  ['rust'],
  ['go'],
  ['python'],
  ['awesome-list'],
  ['machine-learning'],
  ['react', 'ui'],
  ['api', 'http'],
  ['cli', 'developer-tools', 'productivity'],
];

const DESCRIPTIONS: (null | string)[] = [
  null,
  'A curated list of awesome things.',
  'Fast, small, and dependency-free.',
  'The toolkit behind a thousand build pipelines.',
  'One-line utility, zero configuration.',
];

const LICENSES: (null | string)[] = [
  null,
  'MIT',
  'Apache-2.0',
  'GPL-3.0',
  'NOASSERTION',
];

const HOMEPAGES: (null | string)[] = [
  null,
  'https://example.dev',
  'https://example.io/docs',
];

export function generateRepoInfo(owner: string, repo: string): RepoInfoDetails {
  const hash = hashString(`${owner}/${repo}`);
  const offsetDays = hash % 1000;
  return {
    archived: hash % 17 === 0,
    description: DESCRIPTIONS[(hash >>> 4) % DESCRIPTIONS.length],
    homepage: HOMEPAGES[(hash >>> 16) % HOMEPAGES.length],
    id: hash,
    language: LANGUAGES[hash % LANGUAGES.length],
    license: LICENSES[(hash >>> 12) % LICENSES.length],
    open_issues_count: hash % 100,
    owner,
    pushed_at: new Date(BASE_PUSHED_MS - offsetDays * MS_PER_DAY).toISOString(),
    repo,
    stargazers_count: 1 + (hash % 50_000),
    topics: TOPICS[(hash >>> 8) % TOPICS.length],
  };
}

export const offlineGetRepoInfo = (
  _octokit: unknown,
  owner: string,
  repo: string,
): Promise<RepoInfoDetails> => Promise.resolve(generateRepoInfo(owner, repo));

export const offlineMakeOctokit = (() => ({
  log: silentLog,
})) as unknown as typeof GithubModule.makeOctokit;
