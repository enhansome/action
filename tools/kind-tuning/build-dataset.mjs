// Builds the labeled feature dataset that every fine-tuning experiment runs
// against. Ground truth comes from authoritative sources, NOT from the existing
// golden fixtures (those carry the kind labels we are trying to improve):
//
//   positives (registry): the 49 computer-vision awesome-lists (43 audit + 6
//     deferred in src/live.test.ts) + every awesome-list linked from the
//     sindresorhus/awesome README. Membership there *means* it is an
//     awesome-list, so the label is trustworthy.
//   negatives (repository): top-starred repos from GitHub search, filtered to
//     drop anything awesome-named, carrying the `awesome-list` topic, or already
//     in the positive set. These are overwhelmingly concrete projects.
//
// For each repo we capture the features a classifier could use: rendered-HTML
// outbound-anchor count (htmlLinks), the /repos description/stars/language/
// archived/topics, and sindresorhus membership. Raw fetches are cached per-repo
// so an interrupted run resumes.
//
//   GITHUB_TOKEN="$(gh auth token)" node tools/kind-tuning/build-dataset.mjs
//
// htmlLinks uses a byte-identical copy of src/markdown.ts#countOutboundAnchors;
// parity is asserted at the end against the four values pinned in
// KIND_CLASSIFICATION.md (awesomedata/openMVG/chalk/vsitzmann).

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url);
const CACHE_DIR = new URL('cache/', ROOT);
const DATASET_PATH = new URL('dataset.json', ROOT);

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
const API = 'https://api.github.com';
const CONCURRENCY = 8;

// --- countOutboundAnchors: identical to src/markdown.ts (parity target) ----
function countOutboundAnchors(html) {
  let count = 0;
  for (const match of html.matchAll(/href\s*=\s*"([^"]*)"/g)) {
    if (match[1] && !match[1].startsWith('#')) {
      count++;
    }
  }
  return count;
}

// The 43 audit + 6 deferred registries from src/live.test.ts.
const CV_REGISTRIES = [
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
  // From the representative live suite (not the 43-audit list above). openMVG's
  // entries live in a markdown table — the structure-agnostic headline case.
  ['openMVG', 'awesome_3DReconstruction_list'],
  ['heyalexej', 'awesome-images'],
  ['jphall663', 'awesome-machine-learning-interpretability'],
  ['subeeshvasu', 'Awesome-ImageHarmonization'],
  ['weihaox', 'awesome-image-translation'],
  ['weihaox', 'awesome-neural-rendering'],
  ['yenchenlin', 'awesome-adversarial-machine-learning'],
];

// Verified concrete projects seeded as negatives so the FP-measurement anchors
// are present regardless of where GitHub's star-ranked search cuts off. Includes
// the two project guards from src/live.test.ts plus an awesome-*-named project
// (awesome_print is a Ruby pretty-printer, not a list) to bound the name-regex
// false-positive risk the doc flags.
const NEGATIVE_SEEDS = [
  ['chalk', 'chalk'],
  ['liuliu', 'ccv'],
  ['awesome-print', 'awesome_print'],
];

// Star-search surfaces high-star repos that are actually curated link
// directories or content anthologies, not consumable software. Left as
// `repository`, they register as phantom false-positives and corrupt the
// threshold analysis. These are relabeled by SEMANTIC judgment (is the repo a
// discovery index vs. installable software) — not by regex — so labeling is
// independent of the description/name signals under test.
//
// Relabel → registry: the repo exists primarily to point you at (or anthologize
//   discoverable) external resources.
const RELABEL_TO_REGISTRY = new Set([
  'developer-y/cs-video-courses',
  'public-apis/public-apis',
  'bradtraversy/design-resources-for-developers',
  'trimstray/the-book-of-secret-knowledge',
  'sdmg15/best-websites-a-programmer-should-visit',
  'justjavac/free-programming-books-zh_cn',
  'practical-tutorials/project-based-learning',
  'mtdvio/every-programmer-should-know',
  'codecrafters-io/build-your-own-x',
  '521xueweihan/hellogithub',
  'jlevy/the-art-of-command-line',
  'ruanyf/weekly',
  'florinpop17/app-ideas',
  'lydiahallie/javascript-questions',
  'f/prompts.chat',
  'leonardomso/33-js-concepts',
  'tldr-pages/tldr',
  'modelcontextprotocol/servers',
  'goldbergyoni/nodebestpractices',
  'thedaviddias/front-end-checklist',
]);

// Ambiguous boundary class: authored, in-repo educational/interview/style-guide
// content that is link-heavy but consumed in-place rather than a discovery
// index. Kept as `repository` but flagged `ambiguous: true` so experiments can
// report precision both including and excluding this honest fuzz.
const AMBIGUOUS_PROJECT = new Set([
  'jwasham/coding-interview-university',
  'donnemartin/system-design-primer',
  'bytebyteohq/system-design-101',
  'snailclimb/javaguide',
  'doocs/advanced-java',
  'labuladong/fucking-algorithm',
  'trekhleb/javascript-algorithms',
  'iluwatar/java-design-patterns',
  'microsoft/ml-for-beginners',
  'microsoft/web-dev-for-beginners',
  'microsoft/generative-ai-for-beginners',
  'microsoft/ai-agents-for-beginners',
  'asabeneh/30-days-of-python',
  'jackfrued/python-100-days',
  'mlabonne/llm-course',
  'rasbt/llms-from-scratch',
  'ryanmcdermott/clean-code-javascript',
  'airbnb/javascript',
  'yangshun/tech-interview-handbook',
  'kdn251/interviews',
  'cyc2018/cs-notes',
  'bregman-arie/devops-exercises',
  'labmlai/annotated_deep_learning_paper_implementations',
  'misterbooo/leetcodeanimation',
  'datawhalechina/hello-agents',
  'dair-ai/prompt-engineering-guide',
  'anduin2017/howtocook',
  'fighting41love/funnlp',
  'chalarangelo/30-seconds-of-code',
]);

async function ghFetch(pathname, { headers = {}, accept } = {}) {
  const url = pathname.startsWith('http') ? pathname : `${API}${pathname}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: accept ?? 'application/vnd.github+json',
        'User-Agent': 'enhansome-kind-tuning',
        ...headers,
      },
    });
    if (res.status === 404) return { status: 404, data: null };
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const retryAfter = Number(res.headers.get('retry-after'));
      if (remaining === 0 || Number.isFinite(retryAfter)) {
        const wait =
          retryAfter > 0
            ? retryAfter
            : Math.max(reset - Math.floor(Date.now() / 1000), 1);
        console.error(
          `rate-limited; sleeping ${Math.min(wait, 60)}s (remaining=${remaining})`,
        );
        await sleep(Math.min(wait, 60) * 1000);
        continue;
      }
    }
    if (res.ok) {
      const data = accept?.includes('html') ? await res.text() : await res.json();
      return { status: 200, data, headers: res.headers };
    }
    lastErr = `${res.status} ${res.statusText}`;
    if (res.status >= 500) await sleep(1000 * (attempt + 1));
  }
  throw new Error(`fetch failed ${url}: ${lastErr}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cachePath(owner, repo) {
  return new URL(`cache/${owner}__${repo}.json`, ROOT);
}

async function loadCacheIndex() {
  await mkdir(CACHE_DIR, { recursive: true });
  const files = await readdir(CACHE_DIR);
  const cached = new Map();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const obj = JSON.parse(await readFile(join(CACHE_DIR.pathname, f), 'utf8'));
      if (obj?.owner && obj?.repo) cached.set(`${obj.owner}/${obj.repo}`, obj);
    } catch {
      /* ignore malformed cache entry */
    }
  }
  console.error(`cache: ${cached.size} repos already fetched`);
  return cached;
}

async function fetchFeatures(owner, repo) {
  const { status, data } = await ghFetch(`/repos/${owner}/${repo}`);
  if (status === 404 || !data) {
    return {
      owner,
      repo,
      description: null,
      stars: null,
      language: null,
      archived: null,
      topics: [],
      htmlLinks: null,
      readmeBytes: null,
      fetchError: 'repo 404',
    };
  }
  let html = null;
  let htmlLinks = null;
  let readmeBytes = null;
  let fetchError = null;
  try {
    const readme = await ghFetch(`/repos/${owner}/${repo}/readme`, {
      accept: 'application/vnd.github.html',
    });
    if (readme.status === 200 && typeof readme.data === 'string') {
      html = readme.data;
      readmeBytes = html.length;
      htmlLinks = countOutboundAnchors(html);
    }
  } catch (e) {
    fetchError = `readme: ${e.message}`;
  }
  return {
    owner: data.owner?.login ?? owner,
    repo: data.name ?? repo,
    description: data.description ?? null,
    stars: data.stargazers_count ?? null,
    language: data.language ?? null,
    archived: data.archived ?? null,
    topics: data.topics ?? [],
    htmlLinks,
    readmeBytes,
    fetchError,
  };
}

async function getFeatures(owner, repo, cache) {
  const key = `${owner}/${repo}`;
  if (cache.has(key)) return cache.get(key);
  const feats = await fetchFeatures(owner, repo);
  cache.set(key, feats);
  await writeFile(cachePath(owner, feats.repo), JSON.stringify(feats, null, 2));
  return feats;
}

async function pool(items, limit, task) {
  const queue = items.slice();
  let done = 0;
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      try {
        await task(item);
      } catch (e) {
        console.error(`error ${item.owner}/${item.repo}: ${e.message}`);
      }
      done++;
      if (done % 25 === 0) console.error(`progress: ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

// Parse owner/repo pairs out of the sindresorhus/awesome README. Links there use
// the form `github.com/<owner>/<repo>#readme`, so each segment is matched as a
// greedy token (alnum, with internal . _ -) that naturally stops at `#`, `/`, or
// any other non-token char — no brittle terminator class.
async function getSindresorhusLists() {
  const raw = await (
    await fetch(
      'https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md',
      { headers: { 'User-Agent': 'enhansome-kind-tuning' } },
    )
  ).text();
  const token = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
  const seen = new Set();
  const out = [];
  for (const m of raw.matchAll(new RegExp(`github\\.com/(${token})/(${token})`, 'g'))) {
    const owner = m[1];
    let repo = m[2];
    if (owner === 'sindresorhus' && repo === 'awesome') continue;
    if (
      ['topics', 'orgs', 'features', 'settings', 'search', 'blog'].includes(
        owner,
      )
    )
      continue;
    if (repo.endsWith('.git')) repo = repo.slice(0, -4);
    const key = `${owner}/${repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, repo });
  }
  return out;
}

// Top-starred repos as a pool of likely-concrete-projects, filtered.
async function getProjectNegatives(exclude) {
  const out = [];
  for (const page of [1, 2, 3]) {
    const { data } = await ghFetch(
      `/search/repositories?q=stars:>20000&sort=stars&order=desc&per_page=100&page=${page}`,
    );
    if (!data?.items) break;
    for (const it of data.items) {
      const owner = it.owner?.login;
      const repo = it.name;
      if (!owner) continue;
      if (exclude.has(`${owner}/${repo}`.toLowerCase())) continue;
      out.push({ owner, repo });
    }
  }
  return out;
}

async function main() {
  if (!TOKEN) {
    console.error('GITHUB_TOKEN required');
    process.exit(1);
  }
  const cache = await loadCacheIndex();

  // --- assemble the labeled population ---
  const sindLists = await getSindresorhusLists();
  console.error(`sindresorhus/awesome: ${sindLists.length} linked repos`);

  const byKey = new Map();
  const include = (owner, repo, truth, source, inSindresorhus) => {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    if (byKey.has(key)) {
      // A CV repo also listed in sindresorhus: upgrade its membership flag.
      if (inSindresorhus) byKey.get(key).inSindresorhus = true;
      return;
    }
    byKey.set(key, {
      owner,
      repo,
      truth,
      source,
      inSindresorhus,
    });
  };

  const sindKeys = new Set(
    sindLists.map(r => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`),
  );
  for (const [owner, repo] of CV_REGISTRIES) {
    include(
      owner,
      repo,
      'registry',
      'cv',
      sindKeys.has(`${owner.toLowerCase()}/${repo.toLowerCase()}`),
    );
  }
  for (const { owner, repo } of sindLists) {
    include(owner, repo, 'registry', 'sindresorhus', true);
  }

  const excludeForNeg = new Set(byKey.keys());
  const negCandidates = await getProjectNegatives(excludeForNeg);
  // Drop awesome-named candidates (those are registries, not project negatives).
  const negatives = negCandidates.filter(({ repo }) => !/awesome/i.test(repo));
  for (const { owner, repo } of negatives) {
    include(owner, repo, 'repository', 'search', false);
  }
  for (const [owner, repo] of NEGATIVE_SEEDS) {
    include(owner, repo, 'repository', 'seed', false);
  }

  const population = [...byKey.values()];

  // Apply the curated relabel / ambiguous flags (see comments on the sets).
  for (const p of population) {
    const k = `${p.owner.toLowerCase()}/${p.repo.toLowerCase()}`;
    if (RELABEL_TO_REGISTRY.has(k) && p.truth !== 'registry') {
      p.truth = 'registry';
      p.relabeled = true;
    }
    if (AMBIGUOUS_PROJECT.has(k) && p.truth === 'repository') {
      p.ambiguous = true;
    }
  }
  console.error(
    `population: ${population.length} (${population.filter(p => p.truth === 'registry').length} registry, ${population.filter(p => p.truth === 'repository').length} repository; ${population.filter(p => p.relabeled).length} relabeled, ${population.filter(p => p.ambiguous).length} ambiguous)`,
  );

  // --- fetch features for everyone (resumable via cache) ---
  await pool(population, CONCURRENCY, async entry => {
    entry.features = await getFeatures(entry.owner, entry.repo, cache);
  });

  const repos = population.map(p => ({
    owner: p.features.owner,
    repo: p.features.repo,
    truth: p.truth,
    source: p.source,
    inSindresorhus: p.inSindresorhus,
    htmlLinks: p.features.htmlLinks,
    description: p.features.description,
    stars: p.features.stars,
    language: p.features.language,
    archived: p.features.archived,
    topics: p.features.topics,
    readmeBytes: p.features.readmeBytes,
    fetchError: p.features.fetchError,
    relabeled: p.relabeled ?? false,
    ambiguous: p.ambiguous ?? false,
  }));

  // --- parity check against KIND_CLASSIFICATION.md pinned values ---
  const parityTargets = {
    'awesomedata/awesome-public-datasets': 2645,
    'openMVG/awesome_3DReconstruction_list': 176,
    'chalk/chalk': 37,
    'vsitzmann/awesome-implicit-representations': 88,
  };
  const parity = {};
  let parityOk = true;
  for (const [k, expected] of Object.entries(parityTargets)) {
    const r = repos.find(
      x => `${x.owner}/${x.repo}`.toLowerCase() === k.toLowerCase(),
    );
    const got = r?.htmlLinks;
    const ok = got === expected;
    if (!ok) parityOk = false;
    parity[k] = { expected, got, ok };
  }

  const dataset = {
    generatedAt: new Date().toISOString(),
    counts: {
      total: repos.length,
      registry: repos.filter(r => r.truth === 'registry').length,
      repository: repos.filter(r => r.truth === 'repository').length,
      fetchFailed: repos.filter(r => r.fetchError).length,
    },
    parity: { ok: parityOk, targets: parity },
    repos,
  };

  await writeFile(DATASET_PATH, JSON.stringify(dataset, null, 2));
  console.error(`\nwrote ${DATASET_PATH.pathname}`);
  console.error(JSON.stringify(dataset.counts, null, 2));
  console.error(`parity ${parityOk ? 'OK' : 'MISMATCH'}: ${JSON.stringify(parity)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
