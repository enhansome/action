// TECHNIQUE: the irreducible tail — PART 2.
// Production-realistic ceiling (NO inSindresorhus, which is a dataset artifact)
// + confirm content is redundant on top of anchors + provenance recommendation.

import { loadDataset, evaluate, fmt } from '../lib.mjs';

const { repos } = await loadDataset();
const cleanProjects = repos.filter((r) => r.truth === 'repository' && !r.ambiguous);

const hasTopic = (r, t) => (r.topics || []).includes(t);
const nameAwesome = (r) => /awesome/i.test(r.repo);
const descListlike = (r) =>
  !!r.description &&
  /curated|collection of|a list of|hand-?picked|collective list|list of (free|public|computer|useful|the best)|resources for|cheat.?sheet/i.test(
    r.description,
  );
const content = (r, t) => r.htmlLinks != null && r.htmlLinks >= t;

// Production anchors = signals available from repo metadata (topics/desc/name)
// + README content. inSindresorhus is EXCLUDED (dataset artifact, not in the
// classifyKind path).
const prodAnchors = (r) =>
  nameAwesome(r) || hasTopic(r, 'awesome-list') || descListlike(r);
const fullAnchors = (r) => r.inSindresorhus || prodAnchors(r);

console.log('# A. Ceiling WITH membership (dataset-honest, biased recall)\n');
const eFull = evaluate(repos, (r) => (fullAnchors(r) ? 'registry' : 'repository'), {
  label: 'full-anchors (incl membership)',
});
console.log('   ' + fmt(eFull));
const eFullClean = evaluate(cleanProjects, (r) => (fullAnchors(r) ? 'registry' : 'repository'));
console.log(
  `   clean-project FP: ${eFullClean.fp}/${cleanProjects.length}  -> honest precision vs clean = ${((cleanProjects.length - eFullClean.fp) / cleanProjects.length * 100).toFixed(2)}%`,
);

console.log('\n# B. Production-realistic ceiling (NO membership)\n');
const eProd = evaluate(repos, (r) => (prodAnchors(r) ? 'registry' : 'repository'), {
  label: 'prod-anchors (no membership)',
});
console.log('   ' + fmt(eProd));
for (const t of [50, 75, 100, 150, 200, 300, 400, 500]) {
  const cls = (r) => (prodAnchors(r) || content(r, t) ? 'registry' : 'repository');
  const e = evaluate(repos, cls, { label: `prod-anchors OR content>=${t}` });
  const eC = evaluate(cleanProjects, cls);
  console.log(
    `   ${e.label.padEnd(30)} F1 ${(e.f1 * 100).toFixed(2)}%  P ${(e.precision * 100).toFixed(1)}%  R ${(e.recall * 100).toFixed(1)}%  (fp ${e.fp}, fn ${e.fn})  cleanFP ${eC.fp}`,
  );
}

// Of the 87 low-link (<50) registries, how many do prod-anchors (no membership,
// no content) recover? This is the honest "residue recovered by metadata".
const residue = repos.filter(
  (r) => r.truth === 'registry' && r.htmlLinks != null && r.htmlLinks < 50,
);
const residueByProd = residue.filter((r) => prodAnchors(r));
const residueByFull = residue.filter((r) => fullAnchors(r));
console.log(
  `\n   residue (reg htmlLinks<50) n=${residue.length}: prod-anchors recover ${residueByProd.length}, full-anchors recover ${residueByFull.length}`,
);

// Does content add ANY net F1 on top of full anchors? Pairwise at every T.
console.log('\n# C. Content marginal value on top of FULL anchors\n');
for (const t of [50, 100, 200, 500]) {
  const cls = (r) => (fullAnchors(r) || content(r, t) ? 'registry' : 'repository');
  const e = evaluate(repos, cls, { label: `full-anchors OR content>=${t}` });
  const delta = (e.f1 - eFull.f1) * 100;
  console.log(
    `   ${e.label.padEnd(30)} F1 ${(e.f1 * 100).toFixed(2)}%  (delta vs full-anchors: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pts, fp ${e.fp} fn ${e.fn})`,
  );
}

// Tail of the production-realistic best.
console.log('\n# D. Tail of prod-anchors-only (production-realistic)\n');
console.log('## FNs (registries prod-anchors miss):');
const eProdFn = evaluate(repos, (r) => (prodAnchors(r) ? 'registry' : 'repository'));
for (const r of eProdFn.fnList.slice(0, 18)) {
  console.log(
    `   - ${r.owner}/${r.repo}  links=${r.htmlLinks}  src=${r.source}  inSind=${r.inSindresorhus}\n     desc: ${(r.description || '(null)').slice(0, 120)}`,
  );
}
console.log(`\n## FPs (projects prod-anchors flip): n=${eProdFn.fp}`);
for (const r of eProdFn.fpList.slice(0, 12)) {
  console.log(
    `   - ${r.owner}/${r.repo}  links=${r.htmlLinks}  ambig=${r.ambiguous}\n     desc: ${(r.description || '(null)').slice(0, 120)}  | matched: ${nameAwesome(r) ? 'name' : ''}${hasTopic(r, 'awesome-list') ? 'topic' : ''}${descListlike(r) ? 'desc' : ''}`,
  );
}
