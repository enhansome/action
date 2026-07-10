// TECHNIQUE: the 'awesome-list' GitHub topic as a kind signal.
//
// classify = r => (r.topics || []).includes('awesome-list') ? 'registry' : 'repository'
//
// Two questions:
//   1. Standalone topic classifier: P/R/F1 over ALL repos + inspect every project FP.
//   2. Combined with content: registry if (topic) OR (htmlLinks >= T) for several T.
//      Does the topic carry enough recall to be a PRIMARY layer, or only a precision
//      backstop that lifts the content baseline?

import {
  loadDataset,
  evaluate,
  bySource,
  fmt,
} from '../lib.mjs';

const repos = await loadDataset();

// ---------------------------------------------------------------------------
// 1. Standalone 'awesome-list' topic.
// ---------------------------------------------------------------------------
const topicOnly = (r) =>
  (r.topics || []).includes('awesome-list') ? 'registry' : 'repository';

const eTopic = evaluate(repos, topicOnly, { label: 'topic:awesome-list (all)' });
console.log('# 1. Standalone awesome-list topic (all repos)\n');
console.log(fmt(eTopic));
console.log(
  `   tp ${eTopic.tp}  fp ${eTopic.fp}  fn ${eTopic.fn}  tn ${eTopic.tn}`,
);

console.log('\n   by source:');
for (const [, v] of Object.entries(bySource(repos, topicOnly))) {
  console.log('   ' + fmt(v));
}

console.log('\n   PROJECT false-positives (truth=repository, topic=awesome-list):');
for (const r of eTopic.fpList) {
  console.log(
    `   - ${r.owner}/${r.repo}  source=${r.source}  stars=${r.stars}  htmlLinks=${r.htmlLinks}  lang=${r.language}  archived=${r.archived}`,
  );
  console.log(`     topics: ${(r.topics || []).join(', ') || '(none)'}`);
  console.log(`     desc: ${(r.description || '').slice(0, 140)}`);
}

// Of those project FPs, how many would content (>=50) ALSO misclassify?
// i.e. is the topic adding NEW false positives beyond the content baseline?
const contentBaseline = (r, t) =>
  r.htmlLinks != null && r.htmlLinks >= t ? 'registry' : 'repository';
console.log('\n   Project FPs that content (>=50) would ALSO flag (topic adds no NEW fp):');
for (const r of eTopic.fpList) {
  const contentSays = contentBaseline(r, 50);
  console.log(
    `   - ${r.owner}/${r.repo}  htmlLinks=${r.htmlLinks}  content>=50 => ${contentSays}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Combined: registry if topic OR htmlLinks >= T.
// ---------------------------------------------------------------------------
console.log('\n# 2. Combined: registry if (awesome-list topic) OR (htmlLinks >= T)\n');
for (const t of [10, 20, 30, 40, 50, 60, 75, 100]) {
  const cls = (r) =>
    (r.topics || []).includes('awesome-list') ||
    (r.htmlLinks != null && r.htmlLinks >= t)
      ? 'registry'
      : 'repository';
  const e = evaluate(repos, cls, { label: `topic OR htmlLinks>=${t}` });
  console.log(fmt(e));
}

// For reference: content-only baseline at the production T=50.
const eContent50 = evaluate(repos, (r) => contentBaseline(r, 50), {
  label: 'content htmlLinks>=50 (baseline)',
});
console.log('\n# Reference: content-only baseline (production T=50)\n');
console.log(fmt(eContent50));

// ---------------------------------------------------------------------------
// 3. How much of the 83-registry residue does the topic recover?
//    Residue = registries with htmlLinks < 50. How many of THOSE carry the topic?
// ---------------------------------------------------------------------------
console.log('\n# 3. Residue recovery (registries with htmlLinks < 50)\n');
const residue = repos.filter(
  (r) => r.truth === 'registry' && r.htmlLinks != null && r.htmlLinks < 50,
);
const residueWithTopic = residue.filter((r) =>
  (r.topics || []).includes('awesome-list'),
);
console.log(
  `   residue size: ${residue.length}  (registries with htmlLinks<50)`,
);
console.log(
  `   of those, carry awesome-list topic: ${residueWithTopic.length}  (=> recovered by topic layer)`,
);

// And the combined OR at T=50: how many residue registries does it catch that
// content alone misses?
const combined50 = (r) =>
  (r.topics || []).includes('awesome-list') ||
  (r.htmlLinks != null && r.htmlLinks >= 50)
    ? 'registry'
    : 'repository';
const residueCaughtByCombined = residue.filter((r) => combined50(r) === 'registry');
console.log(
  `   residue caught by (topic OR htmlLinks>=50): ${residueCaughtByCombined.length} / ${residue.length}`,
);
