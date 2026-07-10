// TECHNIQUE: the irreducible tail.
//
// Build the best reasonable cheap-signal classifier from the available signals
// (content threshold + awesome-list topic + description regex + name regex +
// sindresorhus membership), sweep thresholds/configs, pick the best by F1, then
// ISOLATE the registries it still MISSES (false negatives) and the projects it
// still FLIPS (false positives) and explain why no cheap signal catches them.
//
// Question answered: what is the realistic F1 ceiling of a cheap-signal
// classifier, and is a 'kind provenance' field warranted?

import { loadDataset, evaluate, bySource, fmt } from '../lib.mjs';

const { repos } = await loadDataset();

// ---------------------------------------------------------------------------
// Signal primitives.
// ---------------------------------------------------------------------------
const hasTopic = (r, t) => (r.topics || []).includes(t);
const nameAwesome = (r) => /awesome/i.test(r.repo);
// "list-like" description phrasing — high precision, varied wording.
const descListlike = (r) =>
  !!r.description &&
  /curated|collection of|a list of|hand-?picked|collective list|list of (free|public|computer|useful|the best)|resources for|cheat.?sheet/i.test(
    r.description,
  );

// High-precision anchor layer. Each member has <3% project-FP individually.
const anchors = (r) =>
  r.inSindresorhus || nameAwesome(r) || hasTopic(r, 'awesome-list') || descListlike(r);

const content = (r, t) => r.htmlLinks != null && r.htmlLinks >= t;

// ---------------------------------------------------------------------------
// 1. Per-signal audit (recall on registries, FP rate on projects).
// ---------------------------------------------------------------------------
console.log('# 1. Per-signal strength (registry recall / project FP)\n');
const signals = {
  'inSindresorhus': (r) => r.inSindresorhus,
  'name~awesome': nameAwesome,
  'topic:awesome-list': (r) => hasTopic(r, 'awesome-list'),
  'desc~listlike': descListlike,
  'content>=50': (r) => content(r, 50),
  'content>=100': (r) => content(r, 100),
  'content>=150': (r) => content(r, 150),
};
for (const [name, fn] of Object.entries(signals)) {
  let rh = 0,
    rt = 0,
    ph = 0,
    pt = 0;
  for (const r of repos) {
    if (r.truth === 'registry') {
      rt++;
      if (fn(r)) rh++;
    } else {
      pt++;
      if (fn(r)) ph++;
    }
  }
  console.log(
    `   ${name.padEnd(18)} reg ${String(rh).padStart(3)}/${rt} (${((rh / rt) * 100).toFixed(1)}%)` +
      `  projFP ${String(ph).padStart(3)}/${pt} (${((ph / pt) * 100).toFixed(1)}%)`,
  );
}

// ---------------------------------------------------------------------------
// 2. Anchor union (no content) — the pure precision layer.
// ---------------------------------------------------------------------------
console.log('\n# 2. Anchor union (precision layer, no content)\n');
const eAnchors = evaluate(repos, (r) => (anchors(r) ? 'registry' : 'repository'), {
  label: 'anchors-only',
});
console.log('   ' + fmt(eAnchors));
const cleanProjects = repos.filter((r) => r.truth === 'repository' && !r.ambiguous);
const eAnchorsClean = evaluate(
  cleanProjects,
  (r) => (anchors(r) ? 'registry' : 'repository'),
  { label: 'anchors vs clean-proj' },
);
console.log(
  '   ' +
    fmt(eAnchorsClean).replace('anchors vs clean-proj', 'anchors FP-rate vs clean-proj') +
    `  (clean n=${cleanProjects.length})`,
);

// ---------------------------------------------------------------------------
// 3. Sweep: anchors OR content>=T. Does content add net F1 on top of anchors?
// ---------------------------------------------------------------------------
console.log('\n# 3. Sweep: anchors OR content>=T (content as recall booster)\n');
let best = null;
for (const t of [25, 35, 50, 60, 75, 100, 125, 150, 200, 300, 400, 500]) {
  const cls = (r) => (anchors(r) || content(r, t) ? 'registry' : 'repository');
  const e = evaluate(repos, cls, { label: `anchors OR content>=${t}` });
  // clean-project precision
  const eC = evaluate(cleanProjects, cls, { label: 'clean' });
  const cleanFP = eC.fp;
  console.log(
    `   ${e.label.padEnd(26)} P ${(e.precision * 100).toFixed(1)}%  R ${(e.recall * 100).toFixed(1)}%  F1 ${(e.f1 * 100).toFixed(1)}%` +
      `  (fp ${e.fp}, fn ${e.fn})  cleanProjFP ${cleanFP}`,
  );
  if (!best || e.f1 > best.e.f1) best = { e, t, cls, cleanFP };
}
console.log(
  `\n   BEST by F1: anchors OR content>=${best.t}  ->  F1 ${(best.e.f1 * 100).toFixed(2)}%`,
);

// ---------------------------------------------------------------------------
// 4. Does adding a HIGH content gate ALONE (no anchors) ever beat the anchor
//    union? Sanity check that content is not the precision answer.
// ---------------------------------------------------------------------------
console.log('\n# 4. Content-only baseline (sanity, production path)\n');
for (const t of [50, 100, 150]) {
  const e = evaluate(repos, (r) => (content(r, t) ? 'registry' : 'repository'), {
    label: `content>=${t}`,
  });
  console.log('   ' + fmt(e));
}

// ---------------------------------------------------------------------------
// 5. Isolate the tail of the BEST config: FPs + FNs.
// ---------------------------------------------------------------------------
const BEST = best.cls;
const eBest = evaluate(repos, BEST, { label: `BEST anchors OR content>=${best.t}` });
console.log(
  `\n# 5. Irreducible tail of best config (${eBest.label}): fp=${eBest.fp} fn=${eBest.fn}\n`,
);

console.log('## False POSITIVES (projects flipped to registry):\n');
for (const r of eBest.fpList) {
  console.log(
    `   - ${r.owner}/${r.repo}  links=${r.htmlLinks}  stars=${r.stars}  src=${r.source}  ambig=${r.ambiguous}  lang=${r.language}`,
  );
  console.log(`     topics: ${(r.topics || []).join(', ') || '(none)'}`);
  console.log(`     desc:   ${(r.description || '(null)').slice(0, 160)}`);
  console.log(
    `     why:   inSind=${r.inSindresorhus} name~awesome=${nameAwesome(r)} topic=${hasTopic(r, 'awesome-list')} descList=${descListlike(r)} content>=${best.t}=${content(r, best.t)}`,
  );
}

console.log('\n## False NEGATIVES (registries missed):\n');
for (const r of eBest.fnList) {
  console.log(
    `   - ${r.owner}/${r.repo}  links=${r.htmlLinks}  stars=${r.stars}  src=${r.source}  lang=${r.language}`,
  );
  console.log(`     topics: ${(r.topics || []).join(', ') || '(none)'}`);
  console.log(`     desc:   ${(r.description || '(null)').slice(0, 160)}`);
  console.log(
    `     why:   inSind=${r.inSindresorhus} name~awesome=${nameAwesome(r)} topic=${hasTopic(r, 'awesome-list')} descList=${descListlike(r)} content>=${best.t}=${content(r, best.t)}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Provenance: how many predictions come from each signal as the DECIDING
//    (first-matching) layer, and what's their per-layer error rate.
// ---------------------------------------------------------------------------
console.log('\n# 6. Provenance — deciding layer composition & per-layer accuracy\n');
// Order matters: most-precise first (so provenance reflects the strongest reason).
const layers = [
  ['sindresorhus', (r) => r.inSindresorhus],
  ['topic:awesome-list', (r) => hasTopic(r, 'awesome-list')],
  ['name~awesome', nameAwesome],
  ['desc~listlike', descListlike],
  [`content>=${best.t}`, (r) => content(r, best.t)],
];
const layerStats = layers.map(([name, _]) => ({
  name,
  decided: 0,
  tp: 0,
  fp: 0,
}));
for (const r of repos) {
  for (let i = 0; i < layers.length; i++) {
    const [, fn] = layers[i];
    if (fn(r)) {
      const s = layerStats[i];
      s.decided++;
      if (r.truth === 'registry') s.tp++;
      else s.fp++;
      break;
    }
  }
}
console.log('   layer                       decided   tp    fp   err-rate');
for (const s of layerStats) {
  const err = s.decided === 0 ? 0 : (s.fp / s.decided) * 100;
  console.log(
    `   ${s.name.padEnd(26)}  ${String(s.decided).padStart(6)}  ${String(s.tp).padStart(4)}  ${String(s.fp).padStart(4)}   ${err.toFixed(1)}%`,
  );
}
const undecided = repos.filter((r) => !layers.some(([, fn]) => fn(r)));
console.log(
  `   ${'(repository default)'.padEnd(26)}  ${String(undecided.length).padStart(6)}  (truth: ${undecided.filter((r) => r.truth === 'registry').length} reg, ${undecided.filter((r) => r.truth === 'repository').length} proj)`,
);

// ---------------------------------------------------------------------------
// 7. Summary numbers for the report.
// ---------------------------------------------------------------------------
console.log('\n# 7. Summary\n');
console.log(`   best F1:       ${(eBest.f1 * 100).toFixed(2)}%  (config: anchors OR content>=${best.t})`);
console.log(`   precision:     ${(eBest.precision * 100).toFixed(2)}%  (all projects)`);
const eBestClean = evaluate(cleanProjects, BEST, { label: 'clean' });
console.log(
  `   precision:     ${(eBestClean.precision === 0 && eBestClean.tp === 0 ? 1 : eBestClean.precision) * 100}%  (clean projects — honest, n=${cleanProjects.length}, fp=${eBestClean.fp})`,
);
console.log(`   recall:        ${(eBest.recall * 100).toFixed(2)}%`);
console.log(`   fp: ${eBest.fp}   fn: ${eBest.fn}`);
// Residue recovery: of registries with htmlLinks<50, how many does BEST catch via anchors?
const lowLinkReg = repos.filter((r) => r.truth === 'registry' && r.htmlLinks != null && r.htmlLinks < 50);
const lowLinkCaught = lowLinkReg.filter((r) => BEST(r) === 'registry');
console.log(`   residue (reg htmlLinks<50): ${lowLinkReg.length}; caught by best: ${lowLinkCaught.length}`);
