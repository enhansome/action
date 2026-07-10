// TECHNIQUE: the 'awesome-list' GitHub topic as a kind signal.
//
// classify = r => (r.topics || []).includes('awesome-list') ? 'registry' : 'repository'
//
// Questions answered with REAL measured numbers:
//   1. Standalone topic classifier: P/R/F1 over ALL repos, AND precision split
//      two ways (all projects vs. clean/non-ambiguous projects).
//   2. Inspect EVERY project false-positive (mis-tag or labeling edge case?).
//   3. Combined with content: registry if (topic) OR (htmlLinks >= T) for T in
//      a sweep. Does the topic add NEW precision, or just recall?
//   4. Residue recovery: how many of the registries with htmlLinks<50 does the
//      topic alone recover?
//   5. Topic-AND-content gating: registry only if (topic) AND (htmlLinks>=T) —
//      does intersecting tighten precision vs. OR?

import { loadDataset, evaluate, bySource, fmt } from '../lib.mjs';

const raw = await loadDataset();
const repos = raw.repos;

const hasTopic = (r) => (r.topics || []).includes('awesome-list');
const topicOnly = (r) => (hasTopic(r) ? 'registry' : 'repository');

// Precision reported BOTH ways per the task: all projects vs clean projects.
const cleanProjects = repos.filter(
  (r) => r.truth === 'repository' && !r.ambiguous,
);
const allProjects = repos.filter((r) => r.truth === 'repository');

// ---------------------------------------------------------------------------
// 1. Standalone awesome-list topic.
// ---------------------------------------------------------------------------
console.log('# 1. Standalone awesome-list topic (all 1004 repos)\n');
const eAll = evaluate(repos, topicOnly, { label: 'topic:awesome-list' });
console.log(fmt(eAll));
console.log(`   tp ${eAll.tp}  fp ${eAll.fp}  fn ${eAll.fn}  tn ${eAll.tn}`);

// Precision vs clean projects (recompute FP against the clean set only).
const eClean = evaluate(
  [...repos.filter((r) => r.truth === 'registry'), ...cleanProjects],
  topicOnly,
  { label: 'topic (vs clean projects)' },
);
const eAllP = evaluate(
  [...repos.filter((r) => r.truth === 'registry'), ...allProjects],
  topicOnly,
  { label: 'topic (vs all projects)' },
);
console.log(
  `   precision vs CLEAN projects: ${(eClean.precision * 100).toFixed(1)}%  (fp ${eClean.fp}/${cleanProjects.length})`,
);
console.log(
  `   precision vs ALL  projects: ${(eAllP.precision * 100).toFixed(1)}%  (fp ${eAllP.fp}/${allProjects.length})`,
);

console.log('\n   by source:');
for (const [, v] of Object.entries(bySource(repos, topicOnly))) {
  console.log('   ' + fmt(v));
}

// Coverage check: how many registries lack the topic entirely?
const regRepos = repos.filter((r) => r.truth === 'registry');
const regWithTopic = regRepos.filter(hasTopic).length;
const regNoTopic = regRepos.length - regWithTopic;
console.log(
  `\n   registry coverage: ${regWithTopic}/${regRepos.length} carry topic (${regNoTopic} do not)`,
);

// ---------------------------------------------------------------------------
// 2. Inspect EVERY project false-positive.
// ---------------------------------------------------------------------------
console.log(
  '\n# 2. PROJECT false-positives (truth=repository, topics includes awesome-list)\n',
);
const projFP = allProjects.filter(hasTopic);
console.log(`   count: ${projFP.length}`);
for (const r of projFP) {
  const contentSays = r.htmlLinks != null && r.htmlLinks >= 50 ? 'REGISTRY' : 'repository';
  console.log(
    `   - ${r.owner}/${r.repo}  source=${r.source}  ambiguous=${r.ambiguous}  stars=${r.stars}  htmlLinks=${r.htmlLinks}  lang=${r.language}`,
  );
  console.log(`     topics: ${(r.topics || []).join(', ') || '(none)'}`);
  console.log(`     desc: ${(r.description || '').slice(0, 160)}`);
  console.log(`     content(>=50) would say: ${contentSays}`);
}

// ---------------------------------------------------------------------------
// 3. Combined: registry if (topic) OR (htmlLinks >= T).
// ---------------------------------------------------------------------------
console.log('\n# 3. OR-combine: registry if (awesome-list topic) OR (htmlLinks >= T)\n');
console.log(
  '   ' +
    'config'.padEnd(26) +
    'P(all)%'.padStart(8) +
    'P(clean)%'.padStart(10) +
    'R%'.padStart(8) +
    'F1%'.padStart(8) +
    ' fp'.padStart(5) +
    ' fn'.padStart(5),
);
for (const t of [10, 20, 30, 40, 50, 60, 75, 100, 150, 200]) {
  const cls = (r) =>
    hasTopic(r) || (r.htmlLinks != null && r.htmlLinks >= t)
      ? 'registry'
      : 'repository';
  const label = `topic OR htmlLinks>=${t}`;
  const e = evaluate(repos, cls, { label });
  const ec = evaluate(
    [...repos.filter((r) => r.truth === 'registry'), ...cleanProjects],
    cls,
  );
  console.log(
    '   ' +
      label.padEnd(26) +
      (e.precision * 100).toFixed(1).padStart(7) +
      ' ' +
      (ec.precision * 100).toFixed(1).padStart(8) +
      ' ' +
      (e.recall * 100).toFixed(1).padStart(7) +
      ' ' +
      (e.f1 * 100).toFixed(1).padStart(7) +
      (e.fp + '').padStart(5) +
      (e.fn + '').padStart(5),
  );
}

// Reference: content-only baseline at production T=50.
const content50 = (r) =>
  r.htmlLinks != null && r.htmlLinks >= 50 ? 'registry' : 'repository';
const eC50 = evaluate(repos, content50, { label: 'content htmlLinks>=50 (baseline)' });
const eC50c = evaluate(
  [...repos.filter((r) => r.truth === 'registry'), ...cleanProjects],
  content50,
);
console.log('\n# Reference: content-only baseline (production T=50)\n');
console.log(fmt(eC50));
console.log(
  `   precision vs CLEAN projects: ${(eC50c.precision * 100).toFixed(1)}%`,
);

// ---------------------------------------------------------------------------
// 4. Residue recovery (registries with htmlLinks < 50).
// ---------------------------------------------------------------------------
console.log('\n# 4. Residue recovery (registries with htmlLinks < 50)\n');
const residue = regRepos.filter(
  (r) => r.htmlLinks != null && r.htmlLinks < 50,
);
const residueTopic = residue.filter(hasTopic);
console.log(`   residue size: ${residue.length} registries with htmlLinks<50`);
console.log(
  `   recovered by TOPIC alone: ${residueTopic.length} / ${residue.length}`,
);
const combined50 = (r) => hasTopic(r) || (r.htmlLinks != null && r.htmlLinks >= 50);
const residueCombined = residue.filter(combined50);
console.log(
  `   recovered by (topic OR htmlLinks>=50): ${residueCombined.length} / ${residue.length}`,
);

// ---------------------------------------------------------------------------
// 5. AND-combine: registry only if (topic) AND (htmlLinks >= T).
//    Tests whether intersecting tightens precision vs the topic alone.
// ---------------------------------------------------------------------------
console.log('\n# 5. AND-combine: registry if (awesome-list topic) AND (htmlLinks >= T)\n');
console.log(
  '   ' +
    'config'.padEnd(26) +
    'P(all)%'.padStart(8) +
    'P(clean)%'.padStart(10) +
    'R%'.padStart(8) +
    'F1%'.padStart(8) +
    ' fp'.padStart(5) +
    ' fn'.padStart(5),
);
for (const t of [0, 10, 20, 30, 50]) {
  const cls = (r) =>
    hasTopic(r) && (r.htmlLinks != null && r.htmlLinks >= t)
      ? 'registry'
      : 'repository';
  const label = `topic AND htmlLinks>=${t}`;
  const e = evaluate(repos, cls, { label });
  const ec = evaluate(
    [...repos.filter((r) => r.truth === 'registry'), ...cleanProjects],
    cls,
  );
  console.log(
    '   ' +
      label.padEnd(26) +
      (e.precision * 100).toFixed(1).padStart(7) +
      ' ' +
      (ec.precision * 100).toFixed(1).padStart(8) +
      ' ' +
      (e.recall * 100).toFixed(1).padStart(7) +
      ' ' +
      (e.f1 * 100).toFixed(1).padStart(7) +
      (e.fp + '').padStart(5) +
      (e.fn + '').padStart(5),
  );
}

// ---------------------------------------------------------------------------
// 6. Topic as a PRECISION gate BEFORE content:
//    Does restricting content>=50 to ONLY topic-tagged repos cut the
//    content baseline's false positives (popular software)? I.e., how many of
//    the 82 clean-project content FPs also lack the topic?
// ---------------------------------------------------------------------------
console.log(
  '\n# 6. Would gating content on the topic cut the baseline clean-project FPs?\n',
);
const cleanContentFP = cleanProjects.filter(
  (r) => r.htmlLinks != null && r.htmlLinks >= 50,
);
const cleanContentFPnoTopic = cleanContentFP.filter((r) => !hasTopic(r));
console.log(
  `   clean projects content(>=50) flags as FP: ${cleanContentFP.length}`,
);
console.log(
  `   of those, LACK the awesome-list topic: ${cleanContentFPnoTopic.length}  (gating on topic would REMOVE these FPs)`,
);
console.log(
  `   BUT this also means a topic-gated classifier would MISS these registries...`,
);
const regBelowTopicGate = regRepos.filter(
  (r) => !hasTopic(r) && (r.htmlLinks == null || r.htmlLinks < 50),
);
console.log(
  `   registries with NEITHER topic NOR htmlLinks>=50 (unrecoverable by either): ${regBelowTopicGate.length}`,
);
