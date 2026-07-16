import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnchorCounts, ClassifierConfig } from './classify.js';

import {
  classifyKind,
  classifyRepo,
  countAnchors,
  createRepoLookup,
  decideClassification,
  DEFAULT_CLASSIFIER_CONFIG,
  parseAwesomeMembers,
  REGISTRY_CONFIRM_MIN_OUTBOUND,
  REGISTRY_CONTENT_BACKSTOP_LINKS,
  REGISTRY_NAME_BREADTH_MIN,
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
    getRootEntryNames: vi.fn(),
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

// The content backstop counts anchors in the target's RENDERED HTML. All links
// share one host (example.com), so distinctTargets is always 1 — the helper for
// cases that exercise the outbound/total split or a LOW-breadth README.
function readmeHtml(n: number): string {
  const links = Array.from(
    { length: n },
    (_, i) => `<a href="https://example.com/item-${i}">item-${i}</a>`,
  ).join('\n');
  return `<article><h1>Repo</h1>${links}</article>`;
}

// A README whose outbound links point at DISTINCT github repos (owner-i/repo-i),
// so distinctTargets == n. The helper for cases that need a BROAD directory
// (name confirmation past the breadth veto, or the backstop's breadth guard).
function readmeHtmlDistinct(n: number): string {
  const links = Array.from(
    { length: n },
    (_, i) => `<a href="https://github.com/owner-${i}/repo-${i}">item-${i}</a>`,
  ).join('\n');
  return `<article><h1>Repo</h1>${links}</article>`;
}

describe('countAnchors (rendered-HTML target counter)', () => {
  const self = { owner: 'o', repo: 'r' };

  it('counts each double-quoted href', () => {
    const html =
      '<a href="https://example.com/a">a</a><a href="https://example.com/b">b</a>';
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 1,
      outbound: 2,
      total: 2,
    });
  });

  it('excludes same-page anchors, including heading permalinks', () => {
    // GitHub prepends an octicon-link `<a href="#user-content-...">` before each
    // heading; those must not inflate either count.
    const html =
      '<a href="#user-content-install"></a><a href="#usage">Usage</a>' +
      '<a href="https://example.com/real">real</a>';
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 1,
      outbound: 1,
      total: 1,
    });
  });

  it('ignores an empty href value', () => {
    expect(countAnchors('<a href="">x</a>', self)).toEqual({
      distinctTargets: 0,
      outbound: 0,
      total: 0,
    });
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(
      countAnchors('<a href = "https://example.com/a">a</a>', self),
    ).toEqual({ distinctTargets: 1, outbound: 1, total: 1 });
  });

  it('does not count image src attributes (only href)', () => {
    const html =
      '<img src="https://example.com/logo.png">' +
      '<a href="https://example.com/link">link</a>';
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 1,
      outbound: 1,
      total: 1,
    });
  });

  it('does not count single-quoted href (GitHub renders double quotes)', () => {
    // Documents the intended assumption: the scan targets GitHub's rendered
    // HTML, which double-quotes attributes.
    expect(countAnchors("<a href='https://example.com/a'>a</a>", self)).toEqual(
      { distinctTargets: 0, outbound: 0, total: 0 },
    );
  });

  it('counts a linked badge wrapper (an <a> around an <img>) as outbound', () => {
    const html =
      '<a href="https://ci.example.com/build"><img src="badge.svg"></a>';
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 1,
      outbound: 1,
      total: 1,
    });
  });

  // A README links into its own tree via /blob/ and /tree/ deep paths; those are
  // internal navigation, not outbound resources. They stay in `total`, because the
  // ratio that confirms an anchor is outbound-over-ALL — a README of self-links is
  // the veto's whole subject, so it cannot be counted out of the denominator.
  it('separates deep links into the repo itself from outbound ones', () => {
    const html =
      '<a href="https://github.com/o/r/blob/main/patterns/singleton.md">singleton</a>' +
      '<a href="https://github.com/o/r/tree/main/docs">docs</a>' +
      '<a href="https://github.com/other/repo">external</a>';
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 1,
      outbound: 1,
      total: 3,
    });
  });

  it('matches self case-insensitively (GitHub is)', () => {
    const html = '<a href="https://github.com/O/R/blob/main/x.md">x</a>';
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 0,
      outbound: 0,
      total: 1,
    });
  });

  // GitHub renders a markdown `[x](docs/patterns.md)` self-tree link as a
  // RELATIVE href (no scheme) — the form actually observed in rendered READMEs
  // (iluwatar/java-design-patterns emits `localization/ar/README.md`), not the
  // absolute https://github.com/<self>/... form the cases above use. A relative
  // href resolves within the repo's own tree, so like the absolute self-links
  // it is internal navigation: in `total`, never `outbound`. countResourceLinks
  // (mdast) already excludes relative links via isRelative; the target counter
  // must agree, or a content repo linking its own files inflates its outbound
  // ratio and can defeat the facesOutward veto.
  it('counts relative self-tree links as internal, not outbound', () => {
    const html =
      '<a href="docs/patterns.md">docs</a>' +
      '<a href="./LICENSE">license</a>' +
      '<a href="/o/r/blob/main/guide.md">guide</a>' +
      '<a href="https://github.com/other/repo">external</a>';
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 1,
      outbound: 1,
      total: 4,
    });
  });

  // distinctTargets dedupes: a README that repeats one github repo and one
  // external host many times collapses to 2 targets, while a mix of distinct
  // github repos + distinct external hosts sums the two sets. This is the
  // breadth signal the name veto and backstop guard read — a gallery whose 880
  // outbound hrefs are one CDN + one social site scores 2 here.
  it('dedupes github targets and external hosts into distinctTargets', () => {
    const html =
      '<a href="https://github.com/a/b">a/b</a>'.repeat(5) +
      '<a href="https://cdn.example.com/img1">img1</a>'.repeat(5) +
      '<a href="https://github.com/c/d">c/d</a>' +
      '<a href="https://other.example.com">other</a>' +
      '<a href="https://github.com/features">gh-section</a>';
    // outbound=13 (5 a/b + 5 cdn + c/d + other + gh-section). distinctTargets:
    // github owner/repo set {a/b, c/d} (github.com/features has no repo segment)
    // + external host set {cdn.example.com, other.example.com} = 4.
    expect(countAnchors(html, self)).toEqual({
      distinctTargets: 4,
      outbound: 13,
      total: 13,
    });
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
  // getReadme is auto-mocked (vi.mock('./github.js')), so the client is never
  // used to fetch — only as the sink classification degrades to when a README is
  // unreadable.
  const warn = vi.fn();
  const octokit = { log: { warn } } as unknown as github.GithubClient;
  const BACKSTOP = REGISTRY_CONTENT_BACKSTOP_LINKS;

  beforeEach(() => {
    vi.clearAllMocks();
    // An empty root by default: outward candidates pass through the
    // compile-manifest gate unvetoed. Gate-specific tests override this.
    vi.mocked(github.getRootEntryNames).mockResolvedValue([]);
  });

  // Membership is the only terminal anchor: hand-curated and FP-free, so a
  // member never pays for a README round-trip.
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

  // The soft anchors (topic/name/description) are candidates: an outward-facing
  // README confirms them, so they DO fetch.
  it('confirms a topic candidate whose README faces outward', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(60));
    const result = await classifyKind(
      octokit,
      'openMVG',
      'awesome_3DReconstruction_list',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'topic' });
    expect(github.getReadme).toHaveBeenCalledTimes(1);
  });

  it('confirms an awesome-* name (and the Awsome misspelling) whose README faces outward', async () => {
    // Distinct github targets so the name candidate clears the breadth veto
    // (60 distinct repos >= REGISTRY_NAME_BREADTH_MIN).
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtmlDistinct(60));
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
    expect(github.getReadme).toHaveBeenCalledTimes(2);
  });

  // The name layer matches the awesome-list convention (`awesome-` prefix), not
  // "awesome" as any word token — so products bearing the word are not candidates.
  it('does NOT treat a bare awesome / Font-Awesome / vue-awesome-swiper as a name candidate', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(0));
    for (const [owner, repo] of [
      ['awesomeWM', 'awesome'],
      ['FortAwesome', 'Font-Awesome'],
      ['surmon-china', 'vue-awesome-swiper'],
    ] as const) {
      const result = await classifyKind(
        octokit,
        owner,
        repo,
        repoInfo(),
        new Set(),
        BACKSTOP,
      );
      expect(result.kind).toBe('repository');
    }
  });

  // No hyphen ⇒ not the awesome-list convention, whatever the owner implies.
  it('does NOT fire the name layer for awesome_print (no hyphen)', async () => {
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

  it('confirms a "curated list" description candidate whose README faces outward', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(60));
    const result = await classifyKind(
      octokit,
      'jphall663',
      'ml-interpretability-resources',
      repoInfo({ description: 'A curated list of responsible ML resources' }),
      new Set(),
      BACKSTOP,
    );
    expect(result.registrySignal).toBe('description');
    expect(github.getReadme).toHaveBeenCalledTimes(1);
  });

  // The veto that fixes the head-of-distribution FPs: a repo named/tagged like a
  // list whose README links into its OWN tree (its own code, patterns, files) is
  // the deliverable, not a directory of external resources. Self-anchors in the
  // majority ⇒ veto, regardless of the anchor. This exercises that mechanism
  // directly: 60 self-links vs 1 outbound is an unambiguous inward-facing README.
  it('vetoes an awesome-* name when the README points mostly into its own tree', async () => {
    const selfLinks = Array.from(
      { length: 60 },
      (_, i) =>
        `<a href="https://github.com/iluwatar/java-design-patterns/tree/main/patterns/p${i}">p${i}</a>`,
    ).join('');
    const outbound = '<a href="https://example.com/docs">docs</a>';
    vi.mocked(github.getReadme).mockResolvedValue(
      `<article>${selfLinks}${outbound}</article>`,
    );
    const result = await classifyKind(
      octokit,
      'iluwatar',
      'java-design-patterns',
      repoInfo({ description: 'Design patterns implemented in Java' }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
  });

  // Modeled on iluwatar/java-design-patterns: its real README faces OUTWARD, so
  // the inward-majority veto cannot catch it. 16 outbound vs 10 self clears the
  // 0.5 outward bar (16 >= 13 of 26). The root is empty here so the compile-
  // manifest gate does not veto either; the live test exercises the real root
  // (pom.xml) where the gate is what flips it.
  it('confirms a topic candidate whose README links outward more than inward', async () => {
    const selfLinks = Array.from(
      { length: 10 },
      (_, i) =>
        `<a href="https://github.com/iluwatar/java-design-patterns/tree/main/patterns/p${i}">p${i}</a>`,
    ).join('');
    const outbound = Array.from(
      { length: 16 },
      (_, i) => `<a href="https://example.com/resource-${i}">resource-${i}</a>`,
    ).join('');
    vi.mocked(github.getReadme).mockResolvedValue(
      `<article>${selfLinks}${outbound}</article>`,
    );
    const result = await classifyKind(
      octokit,
      'iluwatar',
      'java-design-patterns',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'topic' });
  });

  // Name-scoped breadth veto: an `awesome-*` name whose outward README points at
  // a NARROW target set (below REGISTRY_NAME_BREADTH_MIN) is a content repo
  // carrying the prefix, not a directory. The outward majority clears
  // facesOutward, but the veto flips it to repository. Would be RED without the
  // veto (the name + outward README alone would confirm).
  it('breadth-vetoes an awesome-* name whose README points at few distinct targets', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(
      readmeHtmlDistinct(REGISTRY_NAME_BREADTH_MIN - 1),
    );
    const result = await classifyKind(
      octokit,
      'o',
      'awesome-foo',
      repoInfo(),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
    // The breadth veto fires before the compile gate, so the root is never listed.
    expect(github.getRootEntryNames).not.toHaveBeenCalled();
  });

  // The same name candidate with a BROAD README (>= REGISTRY_NAME_BREADTH_MIN)
  // and no compile manifest confirms as a registry.
  it('confirms an awesome-* name with a broad README and no compile manifest', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(
      readmeHtmlDistinct(REGISTRY_NAME_BREADTH_MIN + 40),
    );
    const result = await classifyKind(
      octokit,
      'o',
      'awesome-foo',
      repoInfo(),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'name' });
    expect(github.getRootEntryNames).toHaveBeenCalledTimes(1);
  });

  // The breadth veto is NAME-scoped only: a topic candidate with the same
  // low-breadth README still confirms (a topic is a stronger, hand-set signal).
  it('does NOT breadth-veto a topic candidate with low distinctTargets', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(
      readmeHtmlDistinct(REGISTRY_NAME_BREADTH_MIN - 1),
    );
    const result = await classifyKind(
      octokit,
      'openMVG',
      'awesome_3DReconstruction_list',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'topic' });
  });

  // Compile-manifest product-gate: an outward candidate whose root carries a
  // compiled-language build manifest is the deliverable itself, so the gate
  // vetoes the confirmation and it falls through to repository (60 anchors is
  // well under the backstop).
  it('vetoes an outward candidate whose root carries a compile manifest', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtmlDistinct(60));
    vi.mocked(github.getRootEntryNames).mockResolvedValue([
      'README.md',
      'pom.xml',
      'src',
    ]);
    const result = await classifyKind(
      octokit,
      'iluwatar',
      'java-design-patterns',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
    expect(github.getRootEntryNames).toHaveBeenCalledTimes(1);
  });

  // A root-listing failure (404, rate limit) cannot establish product-ness — a
  // fetch fact, not a repo fact — so the outward verdict is kept and a warn is
  // emitted, mirroring the unreadable-README path.
  it('keeps the outward verdict when the root listing fails', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtmlDistinct(60));
    vi.mocked(github.getRootEntryNames).mockRejectedValue(
      new Error('API rate limit exceeded'),
    );
    const result = await classifyKind(
      octokit,
      'o',
      'awesome-foo',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'topic' });
    expect(warn).toHaveBeenCalled();
  });

  it('vetoes a topic candidate when the README has no outbound links at all', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(
      '<article><h1>snippets</h1><p>inline content, no links.</p></article>',
    );
    const result = await classifyKind(
      octokit,
      'o',
      'awesome-foo',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
    // Under the default gateScope ('any-admission') a sub-ratio candidate still
    // reaches the compile-manifest gate, so the root is listed even with zero
    // outbound links — an empty root is not a manifest, so it falls through to
    // repository unchanged.
    expect(github.getRootEntryNames).toHaveBeenCalledTimes(1);
  });

  // The content backstop now carries a breadth guard: outbound >= backstopMin
  // AND distinctTargets >= REGISTRY_CONTENT_BACKSTOP_DISTINCT. A dense README
  // whose links collapse to one host (a gallery's CDN) is NOT a directory.
  it('falls back to content for a dense, broad, convention-free README', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtmlDistinct(BACKSTOP));
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

  // The breadth guard excludes the prompt-gallery shape: many outbound hrefs
  // (>= backstopMin) all on one host — distinctTargets = 1, well below
  // REGISTRY_CONTENT_BACKSTOP_DISTINCT.
  it('vetoes the content backstop when distinctTargets is below the breadth guard', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(BACKSTOP));
    const result = await classifyKind(
      octokit,
      'o',
      'some-gallery',
      repoInfo({ description: 'A gallery of prompts' }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
  });

  // Below the backstop bar entirely: even a broad README stays a repository.
  it('classifies a sub-backstop README as a repository', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtmlDistinct(100));
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

  // An anchor-less target has nothing to fall back ON: the backstop is a claim
  // about the README, and without one there is no claim to make. The failure
  // propagates and the lookup's caller defaults the item.
  it('throws on an unreadable README when only the content backstop could decide', async () => {
    vi.mocked(github.getReadme).mockRejectedValue(new Error('Not Found (404)'));
    await expect(
      classifyKind(octokit, 'o', 'r', repoInfo(), new Set(), BACKSTOP),
    ).rejects.toThrow('Not Found (404)');
  });

  // The README confirms an anchor; it must never be able to REFUTE one by being
  // absent. A 404/5xx/rate-limit exhaustion is a fact about the fetch, not about
  // the repo, so an unconfirmable candidate keeps its anchor verdict rather than
  // silently shipping as a repository.
  it('keeps the anchor verdict when the README is unreadable', async () => {
    vi.mocked(github.getReadme).mockRejectedValue(new Error('Not Found (404)'));
    const result = await classifyKind(
      octokit,
      'o',
      'awesome-foo',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'topic' });
    expect(warn).toHaveBeenCalledOnce();
  });

  // The majority rule alone is degenerate at small counts: one badge and no
  // self-links is a 100% outbound README. A directory of resources has to point
  // at a plausible NUMBER of them, so the ratio carries a floor.
  it('does not confirm a candidate whose README holds a single outbound anchor', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtml(1));
    const result = await classifyKind(
      octokit,
      'o',
      'awesome-foo',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'repository' });
  });

  it('confirms a candidate that clears the floor and the majority', async () => {
    vi.mocked(github.getReadme).mockResolvedValue(
      readmeHtml(REGISTRY_CONFIRM_MIN_OUTBOUND),
    );
    const result = await classifyKind(
      octokit,
      'o',
      'awesome-foo',
      repoInfo({ topics: ['awesome-list'] }),
      new Set(),
      BACKSTOP,
    );
    expect(result).toEqual({ kind: 'registry', registrySignal: 'topic' });
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

// The pure core takes pre-computed anchors + a lazy root-listing callback, so a
// non-default config can be exercised without a README fetch. These prove the
// knobs actually move a verdict (red without the refactor's config plumbing).
describe('decideClassification (config-driven core)', () => {
  function anchors(
    outbound: number,
    total: number,
    distinct: number,
  ): AnchorCounts {
    return { distinctTargets: distinct, outbound, total };
  }

  it('flips an outward candidate to repository when outwardRatio is raised past its ratio', async () => {
    // 60 outbound of 90 total ⇒ ratio 0.67: clears the default 0.5 bar (so the
    // topic candidate confirms as a registry) but not 0.9 (so it collapses to a
    // repository, the backstop being unreachable at outbound=60).
    const a = anchors(60, 90, 1);
    const repo = 'whatever';
    const info = repoInfo({ topics: ['awesome-list'] });
    const getRootNames = vi.fn().mockResolvedValue([]);

    const atDefault = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      DEFAULT_CLASSIFIER_CONFIG,
    );
    expect(atDefault).toEqual({ kind: 'registry', registrySignal: 'topic' });

    const raised: ClassifierConfig = {
      ...DEFAULT_CLASSIFIER_CONFIG,
      outwardRatio: 0.9,
    };
    const raisedResult = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      raised,
    );
    expect(raisedResult).toEqual({ kind: 'repository' });
    // Both verdicts reach the gate under the default 'any-admission' — the
    // outward path via the candidate+outward branch, the collapsed path via the
    // sub-ratio branch — so the lazy fetch is paid once per call (twice here).
    expect(getRootNames).toHaveBeenCalledTimes(2);
  });

  // A sub-ratio candidate: a candidate whose README is below the outward bar (so
  // 'post-facesOutward' never reaches the gate) but whose root carries a compile
  // manifest. The content backstop admits it under that narrow scope; widening
  // to 'any-candidate' (and the default 'any-admission') reaches the gate and
  // vetoes it to repository.
  it("gateScope 'any-candidate' vetoes a sub-ratio candidate with a compile manifest", async () => {
    // 210 outbound of 450 ⇒ ratio 0.47 (below the 0.5 outward bar), so the
    // topic candidate is sub-ratio; dense + broad enough to clear the content
    // backstop (210 >= 200, 210 distinct >= 15).
    const a = anchors(210, 450, 210);
    const repo = 'whatever';
    const info = repoInfo({ topics: ['awesome-list'] });
    const getRootNames = vi.fn().mockResolvedValue(['pom.xml']);

    const atPostFacesOutward = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      { ...DEFAULT_CLASSIFIER_CONFIG, gateScope: 'post-facesOutward' },
    );
    expect(atPostFacesOutward).toEqual({
      kind: 'registry',
      registrySignal: 'content',
    });

    const anyCandidate: ClassifierConfig = {
      ...DEFAULT_CLASSIFIER_CONFIG,
      gateScope: 'any-candidate',
    };
    const result = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      anyCandidate,
    );
    expect(result).toEqual({ kind: 'repository' });
    // 'post-facesOutward' never gates a sub-ratio candidate; 'any-candidate'
    // pays the fetch exactly once.
    expect(getRootNames).toHaveBeenCalledTimes(1);
  });

  // A candidate-less, dense README backstops into registry under the narrow
  // 'post-facesOutward' scope; 'also-backstop' (and the default 'any-admission')
  // run the gate inside the backstop so a compile-manifest root vetoes it.
  it("gateScope 'also-backstop' vetoes a dense candidate-less README with a compile manifest", async () => {
    const a = anchors(250, 250, 250);
    const repo = 'some-dense-repo';
    const info = repoInfo({ description: 'A project for things' });
    const getRootNames = vi.fn().mockResolvedValue(['go.mod']);

    const atPostFacesOutward = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      { ...DEFAULT_CLASSIFIER_CONFIG, gateScope: 'post-facesOutward' },
    );
    expect(atPostFacesOutward).toEqual({
      kind: 'registry',
      registrySignal: 'content',
    });

    const alsoBackstop: ClassifierConfig = {
      ...DEFAULT_CLASSIFIER_CONFIG,
      gateScope: 'also-backstop',
    };
    const result = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      alsoBackstop,
    );
    expect(result).toEqual({ kind: 'repository' });
    expect(getRootNames).toHaveBeenCalledTimes(1);
  });

  // 'any-admission' is the union of the two widened scopes: the gate fires at
  // every admission point. A candidate-less dense README backstops into registry
  // under 'any-candidate' (the backstop gate stays off there), but the same repo
  // is vetoed to repository under 'any-admission' once its root carries a
  // manifest. This is the disjoint-coverage gap unioning the scopes closes.
  it("gateScope 'any-admission' vetoes a backstop admission that 'any-candidate' leaves as registry", async () => {
    const a = anchors(250, 250, 250);
    const repo = 'some-dense-repo';
    const info = repoInfo({ description: 'A project for things' });
    const getRootNames = vi.fn().mockResolvedValue(['go.mod']);

    const viaAnyCandidate = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      { ...DEFAULT_CLASSIFIER_CONFIG, gateScope: 'any-candidate' },
    );
    expect(viaAnyCandidate).toEqual({
      kind: 'registry',
      registrySignal: 'content',
    });

    const viaAnyAdmission = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      { ...DEFAULT_CLASSIFIER_CONFIG, gateScope: 'any-admission' },
    );
    expect(viaAnyAdmission).toEqual({ kind: 'repository' });
    // 'any-candidate' never gates an anchor-less repo; 'any-admission' pays the
    // fetch once inside the backstop.
    expect(getRootNames).toHaveBeenCalledTimes(1);
  });

  // topicBreadthMin mirrors nameBreadthMin: a topic candidate whose outward
  // README collapses to fewer distinct targets than the floor is a narrow-link
  // repo (the prompt-gallery shape), vetoed to repository. Default 0 disables
  // it — a topic is a stronger, hand-set signal than a name prefix — so the
  // default verdict is unchanged.
  it('breadth-vetoes a topic candidate below topicBreadthMin and is inert at the default 0', async () => {
    // 20 outbound of 25 (ratio 0.8) clears facesOutward; distinctTargets 10.
    const a = anchors(20, 25, 10);
    const repo = 'awesome-prompts';
    const info = repoInfo({ topics: ['awesome-list'] });
    const getRootNames = vi.fn().mockResolvedValue([]);

    const atDefault = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      DEFAULT_CLASSIFIER_CONFIG,
    );
    expect(atDefault).toEqual({ kind: 'registry', registrySignal: 'topic' });

    const atVeto = await decideClassification(
      repo,
      info,
      new Set(),
      a,
      getRootNames,
      { ...DEFAULT_CLASSIFIER_CONFIG, topicBreadthMin: 20 },
    );
    expect(atVeto).toEqual({ kind: 'repository' });
    // The breadth veto fires before the compile gate; only the default-path
    // call reaches the root listing.
    expect(getRootNames).toHaveBeenCalledTimes(1);
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
    vi.mocked(github.getRootEntryNames).mockResolvedValue([]);
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

  // GitHub repo names are case-insensitive: ReactiveX/RxJS and reactivex/rxjs
  // are one repo, answered with one canonical record. The memo must key on a
  // case-normalized identity, not the literal casing, or a README linking both
  // spellings pays for two /repos round-trips (the nodejs fixture does exactly
  // this). The same-casing aliases above collapse today but prove nothing about
  // casing; this pair is the case that actually crosses the seam.
  it('collapses case-variant aliases of one repo into a single fetch', async () => {
    const repos = lookup({ members: new Set() });
    const [mixed, lower] = await Promise.all([
      repos.getRepoInfo('ReactiveX/RxJS'),
      repos.getRepoInfo('reactivex/rxjs'),
    ]);

    expect(github.getRepoInfo).toHaveBeenCalledTimes(1);
    expect(mixed).toBe(lower);
  });

  it('accepts a pre-resolved membership set instead of fetching one', async () => {
    const repos = lookup({ members: new Set(['o/hand-curated']) });
    const result = await repos.classify('o/hand-curated');

    expect(result.registrySignal).toBe('membership');
    expect(github.getReadme).not.toHaveBeenCalled();
  });

  it('honors a lowered content backstop', async () => {
    // 20 distinct github targets: outbound=20 >= 5 and distinctTargets=20 >= 15,
    // so the breadth-guarded backstop fires.
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtmlDistinct(20));
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

    // Membership is unreachable (the sindresorhus/awesome fetch rejects), so the
    // layer degrades with a warning — the one diagnostic classification emits on
    // its own. Other READMEs resolve to an outward-facing list, so awesome-things
    // confirms its name anchor rather than throwing on the rejected membership fetch.
    vi.mocked(github.getReadme).mockImplementation((_ok, owner) =>
      owner === 'sindresorhus'
        ? Promise.reject(new Error('Not Found'))
        : Promise.resolve(readmeHtmlDistinct(60)),
    );

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

    vi.mocked(github.getReadme).mockImplementation((_ok, owner) =>
      owner === 'sindresorhus'
        ? Promise.reject(new Error('Not Found'))
        : Promise.resolve(readmeHtmlDistinct(60)),
    );

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
    vi.mocked(github.getRootEntryNames).mockResolvedValue([]);
    vi.mocked(github.getReadme).mockResolvedValue('');
  });

  it('classifies a single repo with only a ref and a token', async () => {
    // awesome-things is a name candidate; a broad outward-facing README confirms
    // it past the breadth veto and the (empty-root) compile gate.
    vi.mocked(github.getReadme).mockResolvedValue(readmeHtmlDistinct(60));
    const result = await classifyRepo('o/awesome-things', {
      log: silentLog,
      token: 'test-token',
    });
    expect(result).toEqual({ kind: 'registry', registrySignal: 'name' });
  });
});
