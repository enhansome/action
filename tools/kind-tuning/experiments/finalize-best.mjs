// Finalize the best config: test dropping/tightening the weak desc layer.
import { loadDataset, evaluate, fmt } from '../lib.mjs';
const { repos } = await loadDataset();
const cleanProjects = repos.filter((r) => r.truth === 'repository' && !r.ambiguous);
const hasTopic = (r, t) => (r.topics || []).includes(t);
const nameAwesome = (r) => /awesome/i.test(r.repo);
const descListlike = (r) =>
  !!r.description &&
  /curated|collection of|a list of|hand-?picked|collective list|list of (free|public|computer|useful|the best)|resources for|cheat.?sheet/i.test(r.description);
// tighter: drop the ambiguous bare "collection of" / "curated" — require "list" nearby
const descTight = (r) =>
  !!r.description &&
  /(curated list|awesome list|list of (free|public|computer|useful|the best|awesome)|collective list|a list of|cheat.?sheet|curated collection)/i.test(
    r.description,
  );
const content = (r, t) => r.htmlLinks != null && r.htmlLinks >= t;

const configs = {
  'full: mem|name|topic|desc(Loose)': (r) => r.inSindresorhus || nameAwesome(r) || hasTopic(r, 'awesome-list') || descListlike(r),
  'full: mem|name|topic|desc(Tight)': (r) => r.inSindresorhus || nameAwesome(r) || hasTopic(r, 'awesome-list') || descTight(r),
  'full: mem|name|topic (no desc)': (r) => r.inSindresorhus || nameAwesome(r) || hasTopic(r, 'awesome-list'),
  'full: mem|name|topic|descTight|content>=400': (r) => r.inSindresorhus || nameAwesome(r) || hasTopic(r, 'awesome-list') || descTight(r) || content(r, 400),
};
console.log('# Config comparison (with membership)\n');
for (const [name, fn] of Object.entries(configs)) {
  const e = evaluate(repos, (r) => (fn(r) ? 'registry' : 'repository'), { label: name });
  const eC = evaluate(cleanProjects, (r) => (fn(r) ? 'registry' : 'repository'));
  console.log(
    `   ${name.padEnd(38)} F1 ${(e.f1 * 100).toFixed(2)}%  P ${(e.precision * 100).toFixed(1)}%  R ${(e.recall * 100).toFixed(1)}%  (fp ${e.fp}, fn ${e.fn})  cleanFP ${eC.fp}`,
  );
}

// Production (no membership) variants
console.log('\n# Config comparison (NO membership, production-realistic)\n');
const prodConfigs = {
  'prod: name|topic|desc(Loose)': (r) => nameAwesome(r) || hasTopic(r, 'awesome-list') || descListlike(r),
  'prod: name|topic|desc(Tight)': (r) => nameAwesome(r) || hasTopic(r, 'awesome-list') || descTight(r),
  'prod: name|topic (no desc)': (r) => nameAwesome(r) || hasTopic(r, 'awesome-list'),
  'prod: name|topic|descTight|content>=400': (r) => nameAwesome(r) || hasTopic(r, 'awesome-list') || descTight(r) || content(r, 400),
};
for (const [name, fn] of Object.entries(prodConfigs)) {
  const e = evaluate(repos, (r) => (fn(r) ? 'registry' : 'repository'), { label: name });
  const eC = evaluate(cleanProjects, (r) => (fn(r) ? 'registry' : 'repository'));
  console.log(
    `   ${name.padEnd(38)} F1 ${(e.f1 * 100).toFixed(2)}%  P ${(e.precision * 100).toFixed(1)}%  R ${(e.recall * 100).toFixed(1)}%  (fp ${e.fp}, fn ${e.fn})  cleanFP ${eC.fp}`,
  );
}

// Final tail of the chosen full config: mem|name|topic|descTight
console.log('\n# Chosen config tail: mem|name|topic|descTight\n');
const chosen = (r) => r.inSindresorhus || nameAwesome(r) || hasTopic(r, 'awesome-list') || descTight(r);
const eChosen = evaluate(repos, (r) => (chosen(r) ? 'registry' : 'repository'), { label: 'chosen' });
console.log('FPs (n=' + eChosen.fp + '):');
for (const r of eChosen.fpList) console.log(`  - ${r.owner}/${r.repo} links=${r.htmlLinks} ambig=${r.ambiguous} | ${(r.description||'').slice(0,90)}`);
console.log('FNs (n=' + eChosen.fn + '):');
for (const r of eChosen.fnList) console.log(`  - ${r.owner}/${r.repo} links=${r.htmlLinks} inSind=${r.inSindresorhus} | ${(r.description||'').slice(0,90)}`);
