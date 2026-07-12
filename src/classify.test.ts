import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyKind,
  classifyRepo,
  countOutboundAnchors,
  createRepoLookup,
  parseAwesomeMembers,
  REGISTRY_CONTENT_BACKSTOP_LINKS,
} from './classify.js';
import * as github from './github.js';
import { RepoInfoDetails } from './github.js';
import { silentLog } from './logger.js';

// Mock only the networked surface: the ref parsers (parseOwnerRepo /
// parseGitHubUrl) are pure, and the lookup's whole job is resolving refs
// through them, so stubbing them out would test nothing.
vi.mock('./github.js', async () => {
  const actual =
    await vi.importActual<typeof import('./github.js')>('./github.js');
  return {
    ...actual,
    getReadme: vi.fn(),
    getRepoInfo: vi.fn(),
    makeOctokit: vi.fn(),
  };
});

function repoInfo(
  opts: { description?: null | string; topics?: string[] } = {},
): RepoInfoDetails {
  return {
    archived: false,
    description: opts.description ?? null,
    language: 'TypeScript',
    open_issues_count: 0,
    owner: 'o',
    pushed_at: '2025-01-01T00:00:00Z',
    repo: 'r',
    stargazers_count: 0,
    topics: opts.topics ?? [],
  };
}

// The content backstop counts anchors in the target's RENDERED HTML.
function readmeHtml(n: number): string {
  const links = Array.from(
    { length: n },
    (_, i) => `<a href="https://example.com/item-${i}">item-${i}</a>`,
  ).join('\n');
  return `<article><h1>Repo</h1>${links}</article>`;
}

describe('countOutboundAnchors (rendered-HTML target counter)', () => {
  it('counts each double-quoted href', () => {
    const html =
      '<a href="https://example.com/a">a</a><a href="https://example.com/b">b</a>';
    expect(countOutboundAnchors(html)).toBe(2);
  });

  it('excludes same-page anchors, including heading permalinks', () => {
    // GitHub prepends an octicon-link `<a href="#user-content-...">` before each
    // heading; those must not inflate the count.
    const html =
      '<a href="#user-content-install"></a><a href="#usage">Usage</a>' +
      '<a href="https://example.com/real">real</a>';
    expect(countOutboundAnchors(html)).toBe(1);
  });

  it('ignores an empty href value', () => {
    expect(countOutboundAnchors('<a href="">x</a>')).toBe(0);
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(
      countOutboundAnchors('<a href = "https://example.com/a">a</a>'),
    ).toBe(1);
  });

  it('does not count image src attributes (only href)', () => {
    const html =
      '<img src="https://example.com/logo.png">' +
      '<a href="https://example.com/link">link</a>';
    expect(countOutboundAnchors(html)).toBe(1);
  });

  it('does not count single-quoted href (GitHub renders double quotes)', () => {
    // Documents the intended assumption: the scan targets GitHub's rendered
    // HTML, which double-quotes attributes.
    expect(countOutboundAnchors("<a href='https://example.com/a'>a</a>")).toBe(
      0,
    );
  });

  it('counts a linked badge wrapper (an <a> around an <img>)', () => {
    const html =
      '<a href="https://ci.example.com/build"><img src="badge.svg"></a>';
    expect(countOutboundAnchors(html)).toBe(1);
  });
});

describe('parseAwesomeMembers (sindresorhus/awesome membership set)', () => {
  it('parses markdown links to github repos, lowercasing owner and repo', () => {
    const md =
      '- [Node.js](https://github.com/sindresorhus/awesome-nodejs)\n' +
      '- [Go](https://github.com/Avelino/awesome-Go)\n';
    expect(parseAwesomeMembers(md)).toEqual(
      new Set(['avelino/awesome-go', 'sindresorhus/awesome-nodejs']),
    );
  });

  it('excludes the sindresorhus/awesome registry itself', () => {
    const md = '- [self](https://github.com/sindresorhus/awesome)\n';
    expect(parseAwesomeMembers(md)).toEqual(new Set());
  });

  it('excludes non-repository GitHub path prefixes', () => {
    const md =
      '- [topic](https://github.com/topics/awesome)\n' +
      '- [org](https://github.com/orgs/nodejs)\n' +
      '- [real](https://github.com/o/r)\n';
    expect(parseAwesomeMembers(md)).toEqual(new Set(['o/r']));
  });

  it('strips a trailing .git suffix from the repo', () => {
    const md = '- [x](https://github.com/o/thing.git)\n';
    expect(parseAwesomeMembers(md)).toEqual(new Set(['o/thing']));
  });

  it('captures the repo when a path or fragment follows it', () => {
    const md =
      '- [tree](https://github.com/o/r/tree/main)\n' +
      '- [frag](https://github.com/a/b#readme)\n';
    expect(parseAwesomeMembers(md)).toEqual(new Set(['a/b', 'o/r']));
  });

  it('ignores HTML anchor links (sponsor badges are not members)', () => {
    // The README opens with HTML `<a href>` sponsor badges; only markdown
    // `[..](url)` links inside parens are parsed, so those are skipped.
    const md = '<a href="https://github.com/sindresorhus/sponsors">Sponsor</a>';
    expect(parseAwesomeMembers(md)).toEqual(new Set());
  });
});

describe('classifyKind (the layered decision, all inputs explicit)', () => {
  // getReadme is auto-mocked (vi.mock('./github.js')), so the octokit passed to
  // classifyKind is never actually used.
  const octokit = undefined as unknown as github.GithubClient;
  const BACKSTOP = REGISTRY_CONTENT_BACKSTOP_LINKS;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The precision anchors fire before any README fetch, so a target they catch
  // must NOT pay for a README round-trip.
  it('classifies a sindresorhus member as registry without fetching the README', async () => {
    const members = new Set(['vsitzmann/awesome-implicit-representations']);
    const result = await classifyKind(
      octokit,
      'vsitzmann',
      'awesome-implicit-representations',
      repoInfo(),
      members,
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'membership' });
    expect(github.getReadme).not.toHaveBeenCalled();
  });

  it('classifies by the awesome-list topic without fetching the README', async () => {
    const result = await classifyKind(
      octokit,
      'openMVG',
      'awesome_3DReconstruction_list',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result.registrySignal).toBe('topic');
    expect(github.getReadme).not.toHaveBeenCalled();
  });

  it('classifies an awesome-* name (and the Awsome misspelling) by name', async () => {
    for (const repo of ['awesome-foo', 'Awsome-Deep-Learning']) {
      const result = await classifyKind(
        octokit,
        'o',
        repo,
        repoInfo(),
        new Set(),
        BACKSTOP,
      );
      expect(result.registrySignal).toBe('name');
    }
    expect(github.getReadme).not.toHaveBeenCalled();
  });

  // Word-boundary: awesome_print (underscore = word char) is a project, not a list.
  it('does NOT fire the name layer for awesome_print', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(0));
    const result = await classifyKind(
      octokit,
      'awesome-print',
      'awesome_print',
      repoInfo({ description: 'Ruby pretty-printer' }),
      new Set(),
      BACKSTOP,
    );
    expect(result.kind).toBe('repository');
  });

  it('classifies a "curated list" description by the description layer', async () => {
    // Non-awesome name + no topic, so only the description anchor can fire.
    const result = await classifyKind(
      octokit,
      'jphall663',
      'ml-interpretability-resources',
      repoInfo({ description: 'A curated list of responsible ML resources' }),
      new Set(),
      BACKSTOP,
    );
    expect(result.registrySignal).toBe('description');
    expect(github.getReadme).not.toHaveBeenCalled();
  });

  // Pins the content-backstop boundary at a value between the two thresholds:
  // 600 anchors is a registry by the SOURCE threshold (50) but must stay a
  // repository as a TARGET, whose content backstop sits at 700. Guards against
  // the source/target thresholds collapsing (no anchor fires, so only the
  // backstop count decides).
  it('classifies a sub-backstop README (600 anchors) as a repository', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(600));
    const result = await classifyKind(
      octokit,
      'o',
      'some-project',
      repoInfo({ description: 'A normal project' }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
  });

  // Content is the last-resort backstop: only fetched when no anchor fires.
  it('falls back to content for a dense, convention-free README', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(BACKSTOP));
    const result = await classifyKind(
      octokit,
      'timzhang642',
      '3D-Machine-Learning',
      repoInfo({
        description: 'A resource repository for 3D machine learning',
      }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'content' });
  });

  it('defaults a sparse, anchor-less project to repository', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(
      '<article><h1>chalk</h1><p>Terminal string styling.</p></article>',
    );
    const result = await classifyKind(
      octokit,
      'chalk',
      'chalk',
      repoInfo({ description: 'Terminal string styling' }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
  });

  // README is only fetched when the content backstop is reached, so its failure
  // only surfaces there (the lookup's caller catches it and defaults the item).
  it('throws on an unreadable README when content is needed', async () => {
    vi.mocked(github.getReadme).mockRejectedValue(new Error('Not Found (404)'));
    await expect(
      classifyKind(octokit, 'o', 'r', repoInfo(), new Set(), BACKSTOP),
    ).rejects.toThrow('Not Found (404)');
  });

  it('tolerates a null repoInfo (dead link) by skipping topic/description anchors', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(0));
    const result = await classifyKind(
      octokit,
      'o',
      'some-project',
      null,
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
  });
});

// The ergonomic surface external callers get: they name a repo, and the lookup
// resolves the repo info, the membership set and the content threshold itself.
describe('createRepoLookup', () => {
  const awesomeReadme =
    '- [Go](https://github.com/avelino/awesome-go)\n' +
    '- [Papers](https://github.com/papers-we-love/papers-we-love)\n';

  function lookup(overrides: Parameters<typeof createRepoLookup>[0] = {}) {
    return createRepoLookup({ log: silentLog, ...overrides });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // `makeOctokit` is mocked, so it returns the sink the real one would have
    // installed on the client — which is where everything below reads it from.
    vi.mocked(github.makeOctokit).mockImplementation(
      (_token, log = silentLog) => ({ log }) as unknown as github.GithubClient,
    );
    vi.mocked(github.getRepoInfo).mockResolvedValue(repoInfo());
    vi.mocked(github.getReadme).mockImplementation((_ok, owner, repo, format) =>
      Promise.resolve(
        owner === 'sindresorhus' && repo === 'awesome'
          ? awesomeReadme
          : format === 'html'
            ? readmeHtml(0)
            : '# project\n',
      ),
    );
  });

  it('classifies from an owner/repo slug with no membership or threshold plumbing', async () => {
    const result = await lookup().classify('avelino/awesome-go');
    expect(result).toEqual({ kind: 'registry', registrySignal: 'membership' });
  });

  it('classifies from a github.com URL, including a deep tree link', async () => {
    const result = await lookup().classify(
      'https://github.com/papers-we-love/papers-we-love/tree/main/comp_sci',
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'membership' });
  });

  it('fetches the membership list at most once across many classifications', async () => {
    const repos = lookup();
    await Promise.all([
      repos.classify('o/project-a'),
      repos.classify('o/project-b'),
      repos.classify('o/project-c'),
    ]);

    const memberFetches = vi
      .mocked(github.getReadme)
      .mock.calls.filter(([, owner]) => owner === 'sindresorhus');
    expect(memberFetches).toHaveLength(1);
  });

  it('memoizes per canonical repo, so aliased refs cost one round-trip', async () => {
    const repos = lookup();
    await Promise.all([
      repos.classify('facebook/jest'),
      repos.classify('https://github.com/facebook/jest'),
      repos.classify('https://github.com/facebook/jest/tree/main/packages'),
    ]);

    expect(github.getRepoInfo).toHaveBeenCalledTimes(1);
  });

  it('accepts a pre-resolved membership set instead of fetching one', async () => {
    const repos = lookup({ members: new Set(['o/hand-curated']) });
    const result = await repos.classify('o/hand-curated');

    expect(result.registrySignal).toBe('membership');
    expect(github.getReadme).not.toHaveBeenCalled();
  });

  it('honors a lowered content backstop', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(10));
    const repos = lookup({ contentBackstopMin: 5, members: new Set() });

    expect(await repos.classify('o/dense-list')).toEqual({
      kind: 'registry',
      registrySignal: 'content',
    });
  });

  it('classifies a dead link (no repo info) rather than failing', async () => {
    vi.mocked(github.getRepoInfo).mockRejectedValue(new Error('Not Found'));
    const repos = lookup({ members: new Set() });

    expect(await repos.classify('o/deleted')).toEqual({ kind: 'repository' });
  });

  it('rejects a ref that names no repository', async () => {
    await expect(lookup().classify('not a repo')).rejects.toThrow(
      /not a github repository/i,
    );
  });

  it('exposes the memoized repo info it classified with', async () => {
    const repos = lookup({ members: new Set() });
    await repos.classify('o/r');
    await repos.getRepoInfo('o/r');

    expect(github.getRepoInfo).toHaveBeenCalledTimes(1);
  });

  // Diagnostics ride on the client (`octokit.log`), the object already handed to
  // everything that logs. An embedder that supplies its own sink must see them
  // land there rather than on the library's console default.
  it('installs a caller-supplied sink on the client it builds', async () => {
    const lines: string[] = [];
    function collect(message: string): void {
      lines.push(message);
    }
    const log = {
      debug: collect,
      error: collect,
      info: collect,
      warn: collect,
    };

    // Membership is unreachable, so the layer degrades with a warning — the one
    // diagnostic classification emits on its own.
    vi.mocked(github.getReadme).mockRejectedValue(new Error('Not Found'));

    const repos = createRepoLookup({ log, token: 'test-token' });
    expect(await repos.classify('o/awesome-things')).toEqual({
      kind: 'registry',
      registrySignal: 'name',
    });

    expect(github.makeOctokit).toHaveBeenCalledWith('test-token', log);
    expect(repos.client.log).toBe(log);
    expect(lines.some(l => l.includes('membership unavailable'))).toBe(true);
  });

  // An injected client already carries its own sink, so it is used as-is.
  it('logs through an injected client, using the sink it already carries', async () => {
    const lines: string[] = [];
    const client = {
      log: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: (m: string) => lines.push(m),
      },
    } as unknown as github.GithubClient;

    vi.mocked(github.getReadme).mockRejectedValue(new Error('Not Found'));

    await createRepoLookup({ client }).classify('o/awesome-things');

    expect(github.makeOctokit).not.toHaveBeenCalled();
    expect(lines.some(l => l.includes('membership unavailable'))).toBe(true);
  });
});

describe('classifyRepo (one-shot)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(github.makeOctokit).mockImplementation(
      (_token, log = silentLog) => ({ log }) as unknown as github.GithubClient,
    );
    vi.mocked(github.getRepoInfo).mockResolvedValue(repoInfo());
    vi.mocked(github.getReadme).mockResolvedValue('');
  });

  it('classifies a single repo with only a ref and a token', async () => {
    const result = await classifyRepo('o/awesome-things', {
      log: silentLog,
      token: 'test-token',
    });
    expect(result).toEqual({ kind: 'registry', registrySignal: 'name' });
  });
});
