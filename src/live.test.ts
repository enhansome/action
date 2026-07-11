import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { beforeAll, describe, expect, it } from 'vitest';

import { getReadme, getRepoInfo, GithubClient, makeOctokit } from './github.js';
import {
  classifyKind,
  countResourceLinks,
  fetchAwesomeMembers,
  REGISTRY_CONTENT_BACKSTOP_LINKS,
  REGISTRY_MIN_LINKS,
} from './markdown.js';

// Live (network) integration tests for the per-item kind classifier against real
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

// The full audit — every "awesome"-titled target in the source asserted as a
// registry — is ~50 README fetches, so it is off by default and run on demand to
// validate a fix across the whole population, not just hand-picked cases:
//
//   GITHUB_TOKEN="$(gh auth token)" RUN_KIND_AUDIT=1 npx vitest run src/live.test.ts
const describeHeavy =
  token && process.env.RUN_KIND_AUDIT ? describe : describe.skip;

// classifyKind now takes the target's repo info (description/topics) and the
// sindresorhus membership set, so the live tests fetch both the way production
// does rather than calling the classifier with empty inputs.
async function classifyReal(
  octokit: GithubClient,
  members: Set<string>,
  owner: string,
  repo: string,
) {
  const info = await getRepoInfo(octokit, owner, repo).catch((): null => null);
  return classifyKind(
    octokit,
    owner,
    repo,
    info,
    members,
    REGISTRY_CONTENT_BACKSTOP_LINKS,
  );
}

describeLive(
  'Live classifier: jbhuang0604/awesome-computer-vision (real GitHub)',
  () => {
    let octokit: GithubClient;
    let members: Set<string>;

    beforeAll(async () => {
      octokit = makeOctokit(token);
      members = await fetchAwesomeMembers(octokit);
    });

    // Each real target is classified independently; a generous timeout because
    // these are genuine network round-trips through the throttled client.
    const TIMEOUT = 30_000;

    it(
      'classifies the real source README itself as a registry (>= REGISTRY_MIN_LINKS outbound links)',
      async () => {
        const readme = await getReadme(
          octokit,
          'jbhuang0604',
          'awesome-computer-vision',
        );
        const links = countResourceLinks(
          unified().use(remarkParse).use(remarkGfm).parse(readme),
        );
        expect(links).toBeGreaterThanOrEqual(REGISTRY_MIN_LINKS);
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
        const { kind } = await classifyReal(octokit, members, owner, repo);
        expect(kind).toBe('registry');
      },
      TIMEOUT,
    );

    // Concrete projects — a README that documents the project rather than
    // indexing other resources — must stay `repository` once the counter is
    // broadened beyond GitHub links. They guard against over-classification and
    // pin the threshold recalibration: chalk's README carries enough outbound
    // links (badges, etc.) to trip a naive "any link" counter, so the threshold
    // has to clear a real project's link volume.
    it.each([
      ['liuliu', 'ccv'],
      ['chalk', 'chalk'],
    ])(
      'classifies the concrete project %s/%s as a repository',
      async (owner, repo) => {
        const { kind } = await classifyReal(octokit, members, owner, repo);
        expect(kind).toBe('repository');
      },
      TIMEOUT,
    );

    // Registries whose entries are NOT GitHub links — papers, datasets,
    // resources — point at arXiv / project pages / DOIs instead. A registry is a
    // directory of links, not a directory of *GitHub* links, so these must
    // classify as `registry`. (openMVG's entries live in a markdown table, so the
    // counter must be structure-agnostic, not list-only.)
    it.each([
      ['openMVG', 'awesome_3DReconstruction_list'],
      ['ericjang', 'awesome-graphics'],
      ['vsitzmann', 'awesome-implicit-representations'],
    ])(
      'classifies the non-GitHub-link registry %s/%s as a registry',
      async (owner, repo) => {
        const { kind } = await classifyReal(octokit, members, owner, repo);
        expect(kind).toBe('registry');
      },
      TIMEOUT,
    );

    // Registry whose README is reStructuredText, not Markdown. Parsing it as
    // Markdown sees none of its `` `text <url>`_ `` links, so the classifier
    // must be format-agnostic rather than assume the README is Markdown.
    it(
      'classifies the reST-README registry awesomedata/awesome-public-datasets as a registry',
      async () => {
        const { kind } = await classifyReal(
          octokit,
          members,
          'awesomedata',
          'awesome-public-datasets',
        );
        expect(kind).toBe('registry');
      },
      TIMEOUT,
    );
  },
);

// Master audit: every "awesome"-titled target linked from the source is, by
// definition, an awesome-list and must be a registry. Extracted from the
// enhanced README.json so the population stays anchored to the real source.
describeHeavy(
  'Live classifier: every awesome-list target is a registry (full audit)',
  () => {
    let octokit: GithubClient;
    let members: Set<string>;

    beforeAll(async () => {
      octokit = makeOctokit(token);
      members = await fetchAwesomeMembers(octokit);
    });

    const TIMEOUT = 60_000;

    it.each([
      ['ChanChiChoi', 'awesome-Face_Recognition'],
      ['ChanganVR', 'awesome-embodied-vision'],
      ['ChristosChristofidis', 'awesome-deep-learning'],
      ['EthicalML', 'awesome-production-machine-learning'],
      ['HuaizhengZhang', 'Awsome-Deep-Learning-for-Video-Analysis'],
      ['XindiWu', 'Awesome-Machine-Learning-in-Biomedical-Healthcare-Imaging'],
      ['abhineet123', 'Deep-Learning-for-Tracking-and-Detection'],
      ['amusi', 'awesome-object-detection'],
      ['awesome-NeRF', 'awesome-NeRF'],
      ['awesomedata', 'awesome-public-datasets'],
      ['bertjiazheng', 'awesome-scene-understanding'],
      ['chbrian', 'awesome-adversarial-examples-dl'],
      ['danieljf24', 'awesome-video-text-retrieval'],
      ['datamllab', 'awesome-fairness-in-ai'],
      ['dk-liang', 'Awesome-Visual-Transformer'],
      ['ericjang', 'awesome-graphics'],
      ['fepegar', 'awesome-medical-imaging'],
      ['hoya012', 'awesome-anomaly-detection'],
      ['jinwchoi', 'awesome-action-recognition'],
      ['josephmisiti', 'awesome-machine-learning'],
      ['jsbroks', 'awesome-dataset-tools'],
      ['kiloreux', 'awesome-robotics'],
      ['kjw0612', 'awesome-deep-vision'],
      ['matthewvowels1', 'Awesome-Video-Generation'],
      ['mint-lab', 'awesome-robotics-datasets'],
      ['nashory', 'gans-awesome-applications'],
      ['polarisZhao', 'awesome-face'],
      ['subeeshvasu', 'Awesome-Deblurring'],
      ['subeeshvasu', 'Awesome-Image-Distortion-Correction'],
      ['subeeshvasu', 'Awesome-Learning-with-Label-Noise'],
      ['subeeshvasu', 'Awesome-Neuron-Segmentation-in-EM-Images'],
      ['thaoshibe', 'awesome-makeup-transfer'],
      ['timzhang642', '3D-Machine-Learning'],
      ['tstanislawek', 'awesome-document-understanding'],
      ['vinthony', 'awesome-deep-hdr'],
      ['vsitzmann', 'awesome-implicit-representations'],
      ['wangyongjie-ntu', 'Awesome-explainable-AI'],
      ['wangzheallen', 'awesome-human-pose-estimation'],
      ['weiaicunzai', 'awesome-image-classification'],
      ['yuewang-cuhk', 'awesome-vision-language-pretraining-papers'],
      ['zengyh1900', 'Awesome-Image-Inpainting'],
      ['zhaoxin94', 'awesome-domain-adaptation'],
      ['zhoubolei', 'awesome-generative-modeling'],
    ])(
      'audit: %s/%s is a registry',
      async (owner, repo) => {
        const { kind } = await classifyReal(octokit, members, owner, repo);
        expect(kind).toBe('registry');
      },
      TIMEOUT,
    );

    // Sparse-link registries (5-48 outbound links) the old content-only
    // classifier missed. The layered classifier catches them on non-content
    // anchors — name (`awesome-*`) and the "curated list" description — so they
    // are now part of the green audit rather than a deferred skip.
    it.each([
      ['heyalexej', 'awesome-images'],
      ['jphall663', 'awesome-machine-learning-interpretability'],
      ['subeeshvasu', 'Awesome-ImageHarmonization'],
      ['weihaox', 'awesome-image-translation'],
      ['weihaox', 'awesome-neural-rendering'],
      ['yenchenlin', 'awesome-adversarial-machine-learning'],
    ])(
      'sparse-link registry %s/%s is recovered by a non-content anchor',
      async (owner, repo) => {
        const { kind } = await classifyReal(octokit, members, owner, repo);
        expect(kind).toBe('registry');
      },
      TIMEOUT,
    );
  },
);
