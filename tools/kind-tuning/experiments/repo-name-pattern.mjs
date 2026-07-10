// TECHNIQUE: repo-name pattern. classify = r => /awesome/i.test(r.repo) ? 'registry' : 'repository'
//
// Question: is the name 'awesome' a usable kind signal, or does its FP risk
// (real projects named 'awesome-*', e.g. awesome-print/awesome_print) disqualify it?
//
// We measure, over ALL repos:
//   1. Four name variants: /awesome/i (anywhere), /\bawesome\b/i (word-boundary),
//      case-sensitive 'Awesome', and prefix /^awesome/i. P/R/F1 + every project FP.
//   2. The canonical trap awesome-print/awesome_print: does it fire per variant?
//   3. Precision reported BOTH ways: vs all projects AND vs non-ambiguous (clean) projects.
//   4. Residue recovery: of the ~83 registries with htmlLinks<50, how many does the
//      name catch (i.e. is it a useful RECALL layer atop content)?
//   5. Combined: name OR content(>=50) — recall/FP delta vs content alone.

import { readFile } from 'node:fs/promises';
import { loadDataset, evaluate, fmt } from '../lib.mjs';

const raw = await loadDataset();
const repos = raw.repos ?? raw;

const variants = {
  'name: /awesome/i (anywhere, ci)': (r) => /awesome/i.test(r.repo),
  'name: /\\bawesome\\b/i (word-bdy)': (r) => /\bawesome\b/i.test(r.repo),
  'name: /Awesome/ (case-sensitive)': (r) => /Awesome/.test(r.repo),
  'name: /^awesome/i (prefix, ci)': (r) => /^awesome/i.test(r.repo),
};

const cleanProjects = repos.filter((r) => r.truth === 'repository' && !r.ambiguous);
const allProjects = repos.filter((r) => r.truth === 'repository');

// ---------------------------------------------------------------------------
// 1. Each variant standalone: P/R/F1, both precision framings, and project FPs.
// ---------------------------------------------------------------------------
console.log('# 1. Name-pattern variants, standalone (ALL repos)\n');
const summary = {};
for (const [label, pred] of Object.entries(variants)) {
  const classify = (r) => (pred(r) ? 'registry' : 'repository');
  const e = evaluate(repos, classify, { label });
  summary[label] = e;
  // precision vs clean projects only (the honest number)
  const fpClean = e.fpList.filter((r) => !r.ambiguous).length;
  const pAll = e.precision; // vs all projects (incl ambiguous)
  const pClean = e.tp + fpClean === 0 ? 0 : e.tp / (e.tp + fpClean);
  console.log(fmt(e));
  console.log(
    `     precision: ${ (pAll * 100).toFixed(2) }% vs all projects  |  ${ (pClean * 100).toFixed(2) }% vs clean (non-ambiguous) projects  [fpAll=${ e.fp }, fpClean=${ fpClean }]`,
  );
}

// ---------------------------------------------------------------------------
// 2. The canonical trap — does it fire?
// ---------------------------------------------------------------------------
console.log('\n# 2. Canonical trap: awesome-print/awesome_print (truth=repository)\n');
const trap = repos.find((r) => r.owner === 'awesome-print' && r.repo === 'awesome_print');
if (trap) {
  for (const [label, pred] of Object.entries(variants)) {
    console.log(`   ${ label.padEnd(34) } -> ${ pred(trap) ? 'REGISTRY (FP!)' : 'repository (correct)' }`);
  }
} else {
  console.log('   (trap not present in dataset)');
}

// ---------------------------------------------------------------------------
// 3. Every project false-positive, per variant (full enumeration; counts are tiny).
// ---------------------------------------------------------------------------
console.log('\n# 3. Project false-positives per variant\n');
for (const [label, pred] of Object.entries(variants)) {
  const classify = (r) => (pred(r) ? 'registry' : 'repository');
  const e = evaluate(repos, classify, { label });
  console.log(`   --- ${ label } : ${ e.fp } project FP ---`);
  for (const r of e.fpList) {
    console.log(
      `       ${ r.owner }/${ r.repo }  source=${ r.source }  ambiguous=${ r.ambiguous }  stars=${ r.stars }  htmlLinks=${ r.htmlLinks }  desc="${ (r.description || '').slice(0, 90) }"`,
    );
  }
  if (e.fpList.length === 0) console.log('       (none)');
}

// ---------------------------------------------------------------------------
// 4. Recall ceiling vs content: how many registries does EACH signal miss,
//    and what name-only catches that content(>=50) misses (the residue).
// ---------------------------------------------------------------------------
console.log('\n# 4. Residue recovery (registries with htmlLinks < 50)\n');
const contentBaseline = (r) =>
  r.htmlLinks != null && r.htmlLinks >= 50 ? 'registry' : 'repository';
const residue = repos.filter(
  (r) => r.truth === 'registry' && r.htmlLinks != null && r.htmlLinks < 50,
);
console.log(`   residue size (registries, htmlLinks<50): ${ residue.length }`);
for (const [label, pred] of Object.entries(variants)) {
  const caught = residue.filter(pred).length;
  console.log(`   caught by ${ label }: ${ caught } / ${ residue.length }`);
}

// Cross-check: the baseline residue count the doc cites is 83; print the realized number.
const eContent50 = evaluate(repos, contentBaseline, { label: 'content htmlLinks>=50 (baseline)' });
console.log(`\n   content(>=50) alone: ${ fmt(eContent50) }`);

// ---------------------------------------------------------------------------
// 5. Combined: name(pattern) OR content(>=50). Does adding the name layer change
//    recall or FP count meaningfully vs content alone?
// ---------------------------------------------------------------------------
console.log('\n# 5. Combined: (name match) OR (htmlLinks >= 50)\n');
for (const [label, pred] of Object.entries(variants)) {
  const cls = (r) =>
    pred(r) || (r.htmlLinks != null && r.htmlLinks >= 50) ? 'registry' : 'repository';
  const e = evaluate(repos, cls, { label: label + ' OR htmlLinks>=50' });
  const fpDelta = e.fp - eContent50.fp;
  const fnDelta = e.fn - eContent50.fn;
  console.log(fmt(e));
  console.log(
    `     vs content-only: fp ${ fpDelta >= 0 ? '+' : '' }${ fpDelta }  fn ${ fnDelta >= 0 ? '+' : '' }${ fnDelta }`,
  );
}

// ---------------------------------------------------------------------------
// 6. Honest precision check at scale: pretend the project population were larger
//    by reweighting. The single-trap FP looks like ~0% FP only because the
//    dataset has 258 projects. Report the per-variant empirical project-FP RATE
//    and what it implies. Also: how many of the 258 projects contain 'awesome'
//    anywhere in owner OR repo (a looser proxy for real-world exposure)?
// ---------------------------------------------------------------------------
console.log('\n# 6. Empirical project-FP rate & exposure\n');
for (const [label, pred] of Object.entries(variants)) {
  const fp = allProjects.filter(pred).length;
  const rate = (100 * fp) / allProjects.length;
  console.log(
    `   ${ label.padEnd(34) } project hits: ${ fp } / ${ allProjects.length } = ${ rate.toFixed(2) }%`,
  );
}
const looseAw = allProjects.filter(
  (r) => /awesome/i.test(r.repo) || /awesome/i.test(r.owner),
);
console.log(
  `\n   projects with 'awesome' in owner OR repo: ${ looseAw.length } / ${ allProjects.length } (looser exposure proxy)`,
);
console.log(
  JSON.stringify(looseAw.map((r) => `${ r.owner }/${ r.repo }`)),
);
