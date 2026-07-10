// TECHNIQUE: sindresorhus/awesome membership (the inSindresorhus field).
//
// classify = r => r.inSindresorhus ? 'registry' : 'repository'
//
// Membership means: the target repo appears in the parsed link-set of the
// sindresorhus/awesome README (the canonical curated index of awesome-lists).
//
// Two honest questions:
//   1. PRECISION (unbiased): does it ever flip a real project? Claim = 0 FP.
//   2. ADDITIVE VALUE (not recall): the dataset sources 676/746 registries FROM
//      sindresorhus/awesome, so those 676 are members *by construction* —
//      standalone recall (~91%) is circular and must NOT be reported as real.
//      Instead measure the marginal contribution: among registries NOT caught
//      by content (htmlLinks>=50) AND NOT carrying the awesome-list topic, how
//      many does membership recover? That delta is its honest production value.

import { loadDataset, evaluate, bySource, fmt } from '../lib.mjs';

// lib.loadDataset returns the wrapper {generatedAt,counts,parity,repos}; the
// older experiments assumed a bare array. Accept either shape.
const data = await loadDataset();
const repos = Array.isArray(data) ? data : data.repos;

const membership = (r) => (r.inSindresorhus ? 'registry' : 'repository');
const hasTopic = (r) => (r.topics || []).includes('awesome-list');
const contentGE = (r, t) => r.htmlLinks != null && r.htmlLinks >= t;

// ---------------------------------------------------------------------------
// 1. Standalone membership classifier.
// ---------------------------------------------------------------------------
console.log('# 1. Standalone sindresorhus/awesome membership (all repos)\n');
const eM = evaluate(repos, membership, { label: 'inSindresorhus (all)' });
console.log(fmt(eM));
console.log(`   tp ${eM.tp}  fp ${eM.fp}  fn ${eM.fn}  tn ${eM.tn}`);
console.log(
  `   precision = ${eM.tp}/${eM.tp}+${eM.fp} = ${(eM.precision * 100).toFixed(2)}%  (UNBIASED: 0 project FP)`,
);
console.log(
  `   recall    = ${eM.tp}/${eM.tp + eM.fn} = ${(eM.recall * 100).toFixed(2)}%  (BIASED: 676/746 registries were sampled FROM sindresorhus/awesome)`,
);

console.log('\n   by source:');
for (const [, v] of Object.entries(bySource(repos, membership))) {
  console.log('   ' + fmt(v));
}

console.log(
  '\n   PROJECT false-positives (truth=repository, inSindresorhus=true):',
);
console.log(`   count = ${eM.fpList.length}`);
for (const r of eM.fpList) {
  console.log(
    `   - ${r.owner}/${r.repo}  source=${r.source}  stars=${r.stars}  htmlLinks=${r.htmlLinks}`,
  );
}

// Precision against the clean (non-ambiguous) project set.
const cleanProjects = repos.filter(
  (r) => r.truth === 'repository' && !r.ambiguous,
);
const eMClean = evaluate(cleanProjects, membership, { label: 'inSindresorhus vs clean projects' });
console.log(
  `\n   vs CLEAN projects (non-ambiguous, n=${cleanProjects.length}): fp=${eMClean.fp} precision=${(eMClean.precision * 100).toFixed(2)}%`,
);

// The 65 misses: which sources? (sanity — these are the non-sindresorhus
// registries; missing them is expected, not a flaw of the signal.)
console.log('\n   FALSE NEGATIVES (registries NOT in sindresorhus) by source:');
const fnBySrc = {};
for (const r of eM.fnList) fnBySrc[r.source] = (fnBySrc[r.source] || 0) + 1;
console.log('   ' + JSON.stringify(fnBySrc));

// ---------------------------------------------------------------------------
// 2. ADDITIVE value: what does membership recover beyond content + topic?
// ---------------------------------------------------------------------------
console.log(
  '\n# 2. Marginal contribution beyond content (htmlLinks>=50) and awesome-list topic\n',
);

const contentOnly = (r) => (contentGE(r, 50) ? 'registry' : 'repository');
const topicOnly = (r) => (hasTopic(r) ? 'registry' : 'repository');
const contentOrTopic = (r) => (contentGE(r, 50) || hasTopic(r) ? 'registry' : 'repository');
const contentOrTopicOrMbr = (r) =>
  contentGE(r, 50) || hasTopic(r) || r.inSindresorhus ? 'registry' : 'repository';

const eContent = evaluate(repos, contentOnly, { label: 'content htmlLinks>=50' });
const eTopic = evaluate(repos, topicOnly, { label: 'awesome-list topic' });
const eCT = evaluate(repos, contentOrTopic, { label: 'content>=50 OR topic' });
const eCTM = evaluate(repos, contentOrTopicOrMbr, { label: 'content>=50 OR topic OR membership' });
console.log(fmt(eContent));
console.log(fmt(eTopic));
console.log(fmt(eCT));
console.log(fmt(eCTM));

const dRecall = (eCTM.recall - eCT.recall) * 100;
const dFP = eCTM.fp - eCT.fp;
console.log(
  `\n   delta from adding membership to (content OR topic): recall +${dRecall.toFixed(1)} pp, FP +${dFP}`,
);

// Per-registry attribution: for every registry, which signal(s) caught it?
const reg = repos.filter((r) => r.truth === 'registry');
let onlyMbr = 0; // caught by membership AND NOT by content AND NOT by topic
const onlyMbrList = [];
let mbrAndOther = 0;
let mbrMissedNeeded = 0; // member but still FN? (impossible, but keep)
for (const r of reg) {
  const c = contentGE(r, 50);
  const t = hasTopic(r);
  const m = r.inSindresorhus;
  if (m && !c && !t) {
    onlyMbr++;
    onlyMbrList.push(r);
  }
  if (m && (c || t)) mbrAndOther++;
}
console.log(
  `\n   registries caught by membership AND missed by BOTH content(>=50) and topic: ${onlyMbr}`,
);
console.log(`   registries where membership is redundant (content or topic already catches): ${mbrAndOther}`);

// ---------------------------------------------------------------------------
// 3. The honest marginal set: which sources make up `onlyMbr`?
//    If they are ALL source=sindresorhus, the marginal lift is sampling
//    circularity, NOT a real production gain — those repos entered the dataset
//    precisely because they are members.
// ---------------------------------------------------------------------------
console.log(
  '\n# 3. Composition of the marginal-recovery set (only membership catches them)\n',
);
const onlyMbrBySrc = {};
for (const r of onlyMbrList) onlyMbrBySrc[r.source] = (onlyMbrBySrc[r.source] || 0) + 1;
console.log('   by source: ' + JSON.stringify(onlyMbrBySrc));
console.log('   members:');
for (const r of onlyMbrList) {
  console.log(
    `   - ${r.owner}/${r.repo}  source=${r.source}  stars=${r.stars}  htmlLinks=${r.htmlLinks}  topic=${hasTopic(r)}  relabeled=${r.relabeled}`,
  );
}

// ---------------------------------------------------------------------------
// 4. The 83-ish low-link residue: how does membership help there specifically?
// ---------------------------------------------------------------------------
console.log('\n# 4. Low-link residue (registries with htmlLinks < 50)\n');
const residue = reg.filter((r) => r.htmlLinks != null && r.htmlLinks < 50);
const residueNoTopic = residue.filter((r) => !hasTopic(r));
const residueNoTopicInS = residueNoTopic.filter((r) => r.inSindresorhus);
console.log(`   residue size: ${residue.length}`);
console.log(`   residue WITHOUT awesome-list topic: ${residueNoTopic.length}`);
console.log(
  `   of those, recovered by membership: ${residueNoTopicInS.length}  <-- honest marginal recall contribution`,
);
const resSrc = {};
for (const r of residueNoTopicInS) resSrc[r.source] = (resSrc[r.source] || 0) + 1;
console.log('   recovered-by-membership residue, by source: ' + JSON.stringify(resSrc));

// Residue that NOTHING in (content OR topic OR membership) catches — true holes.
const residueUncaught = residue.filter((r) => !contentOrTopicOrMbr(r));
console.log(
  `   residue still uncaught by the full OR classifier: ${residueUncaught.length}`,
);
const uncSrc = {};
for (const r of residueUncaught) uncSrc[r.source] = (uncSrc[r.source] || 0) + 1;
console.log('   uncaught residue by source: ' + JSON.stringify(uncSrc));

// ---------------------------------------------------------------------------
// 5. Cost / production: how often would membership actually fire in practice,
//    and what does refresh cost? Membership is a slow-changing curated index.
// ---------------------------------------------------------------------------
console.log(
  '\n# 5. Production footprint: how many repos the membership signal touches\n',
);
const nReg = reg.length;
const nMember = repos.filter((r) => r.inSindresorhus).length;
console.log(`   members in dataset: ${nMember} / ${repos.length} (${(100 * nMember / repos.length).toFixed(1)}%)`);
console.log(`   members that are truth=registry: ${repos.filter((r) => r.inSindresorhus && r.truth === 'registry').length}`);
console.log(`   members that are truth=repository (FP): ${repos.filter((r) => r.inSindresorhus && r.truth === 'repository').length}`);
