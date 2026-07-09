import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { beforeAll, describe, expect, it } from 'vitest';

import { getReadme, GithubClient, makeOctokit } from './github.js';
import { classifyKind, countListEntries } from './markdown.js';

// Live (network) integration tests for the per-item kind oracle against real
// GitHub data from jbhuang0604/awesome-computer-vision — the genuinely mixed
// source this whole feature exists for.
//
// These hit the real API, so they are token-gated and skip by default (no
// network in CI — the unit suite stays hermetic). Run locally with a token:
//
//   GITHUB_TOKEN="$(gh auth token)" npx vitest run src/live.test.ts
//
// (or `GITHUB_TOKEN=... npm test` — the file self-skips when the token is absent).

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

// jest/vitest each() needs a real describe reference for the gated suite.
const describeLive = token ? describe : describe.skip;

describeLive(
  'Live oracle: jbhuang0604/awesome-computer-vision (real GitHub)',
  () => {
    let octokit: GithubClient;

    beforeAll(() => {
      octokit = makeOctokit(token);
    });

    // Each real target is classified independently; a generous timeout because
    // these are genuine network round-trips through the throttled client.
    const TIMEOUT = 30_000;

    it(
      'classifies the real source README itself as a registry (>= 20 entries)',
      async () => {
        const readme = await getReadme(
          octokit,
          'jbhuang0604',
          'awesome-computer-vision',
        );
        const entries = countListEntries(
          unified().use(remarkParse).use(remarkGfm).parse(readme),
        );
        expect(entries).toBeGreaterThanOrEqual(20);
      },
      TIMEOUT,
    );

    // Targets pulled from the source's "Awesome Lists" section — each is itself an
    // awesome-list, so each must classify as a registry.
    it.each([
      ['josephmisiti', 'awesome-machine-learning'],
      ['amusi', 'awesome-object-detection'],
    ])(
      'classifies the registry target %s/%s as a registry',
      async (owner, repo) => {
        const { kind, entries } = await classifyKind(octokit, owner, repo, 20);
        expect(entries).toBeGreaterThanOrEqual(20);
        expect(kind).toBe('registry');
      },
      TIMEOUT,
    );

    // A target pulled from the source's "Software" section — a concrete project,
    // so it must classify as a repository.
    it(
      'classifies the concrete project liuliu/ccv as a repository',
      async () => {
        const { kind, entries } = await classifyKind(
          octokit,
          'liuliu',
          'ccv',
          20,
        );
        expect(entries).toBeLessThan(20);
        expect(kind).toBe('repository');
      },
      TIMEOUT,
    );

    // openMVG/awesome_3DReconstruction_list is a curated list of *papers* — its
    // entries are arXiv/paper links, not GitHub links. The GitHub-only oracle
    // therefore counts 0 and classifies it a `repository`: the accepted blind
    // spot of D1 (PLAN.md §4), recovered by the webapp membership backstop, not
    // by the action. Pinning this keeps the limitation honest and visible.
    it(
      'hits the GitHub-only blind spot: a paper-link registry (openMVG/awesome_3DReconstruction_list) classifies as a repository',
      async () => {
        const { kind, entries } = await classifyKind(
          octokit,
          'openMVG',
          'awesome_3DReconstruction_list',
          20,
        );
        expect(entries).toBeLessThan(20);
        expect(kind).toBe('repository');
      },
      TIMEOUT,
    );
  },
);
