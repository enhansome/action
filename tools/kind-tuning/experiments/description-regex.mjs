// TECHNIQUE: description regex as a RECALL layer for the content residue.
//
// The content baseline (htmlLinks >= 50 => registry) misses the "residue":
// genuine awesome-lists whose READMEs are short / link-light. Those lists
// almost always describe themselves as "A curated list of ...". We test
// several case-insensitive regexes over r.description and measure, for each:
//
//   - residue recall : of registries with htmlLinks < 50, how many the regex
//                      matches (i.e. would be RECOVERED if we OR it onto content)
//   - clean-project FP : of NON-ambiguous projects (the honest precision set),
//                      how many descriptions match (the danger cases)
//   - all-project FP   : same over all projects (incl. ambiguous)
//
// We then build the COMBINED classifier  registry if (htmlLinks>=50) OR (regex)
// and report overall P/R/F1 (full dataset) plus precision vs clean projects.

import { loadDataset, evaluate, fmt } from '../lib.mjs';

const data = await loadDataset();
const repos = data.repos;

// null descriptions must never match.
const match = (r, re) => {
  const d = r.description;
  return d != null && re.test(d);
};

// --- population slices -------------------------------------------------------
const registries = repos.filter((r) => r.truth === 'registry');
const projects = repos.filter((r) => r.truth === 'repository');
const cleanProjects = repos.filter(
  (r) => r.truth === 'repository' && !r.ambiguous,
);
const ambiguousProjects = projects.filter((r) => r.ambiguous);

// Residue = registries the content baseline (>=50) misses. Match the existing
// experiment's definition (non-null htmlLinks, < 50). Also note null-htmlLinks
// registries (fetch failed) separately — those are content-blind too.
const residue = registries.filter(
  (r) => r.htmlLinks != null && r.htmlLinks < 50,
);
const residueNull = registries.filter((r) => r.htmlLinks == null);

console.log(`# populations`);
console.log(
  `   registries=${registries.length}  projects=${projects.length}  cleanProjects=${cleanProjects.length}  ambiguousProjects=${ambiguousProjects.length}`,
);
console.log(
  `   residue (registry, htmlLinks<50) = ${residue.length}   + null-htmlLinks registries = ${residueNull.length}`,
);
console.log(
  `   residue without a description: ${residue.filter((r) => r.description == null).length}`,
);

// --- candidate regexes ------------------------------------------------------
const candidates = [
  { name: '\\bcurated list\\b', re: /\bcurated list\b/i },
  { name: '\\bcurated\\b', re: /\bcurated\b/i },
  { name: '\\bawesome list\\b', re: /\bawesome list\b/i },
  { name: '\\bawesome\\b', re: /\bawesome\b/i },
  { name: '\\b(collection|list|resources) of\\b', re: /\b(collection|list|resources) of\b/i },
  { name: '\\blist of\\b', re: /\blist of\b/i },
  { name: '\\bcurated\\b|\\bawesome list\\b', re: /\bcurated\b|\bawesome list\b/i },
  { name: '\\bcurated\\b|\\bawesome\\b', re: /\bcurated\b|\bawesome\b/i },
  // Recommended family: "curate/curated/curation" covers common typos + the
  // noun form; "awesome" catches awesome-lists that don't say "curated".
  {
    name: '\\bcurat(e|ed|ion)\\b|\\bawesome\\b',
    re: /\bcurat(e|ed|ion)\b|\bawesome\b/i,
  },
  {
    name: '\\bcurated\\b|\\bcuration\\b|\\bawesome\\b',
    re: /\bcurated\b|\bcuration\b|\bawesome\b/i,
  },
  // Higher-recall but precision-costly: "(collection|resources) of" flips
  // popular software (gitignore, PowerToys, iptv, SecLists). Kept for contrast.
  {
    name: '\\bcurat(e|ed|ion)\\b|\\bawesome\\b|\\b(collection|resources) of\\b',
    re: /\bcurat(e|ed|ion)\b|\bawesome\b|\b(collection|resources) of\b/i,
  },
];

// --- per-regex measurement --------------------------------------------------
console.log(`\n# per-regex: residue recall + project FP`);
console.log(
  '   regex'.padEnd(58) +
    'resRecall'.padStart(10) +
    'cleanFP'.padStart(8) +
    'allFP'.padStart(7),
);
const summary = [];
for (const { name, re } of candidates) {
  const resHits = residue.filter((r) => match(r, re)).length;
  const resRecall = resHits / residue.length;
  const cleanFP = cleanProjects.filter((r) => match(r, re));
  const allFP = projects.filter((r) => match(r, re));
  summary.push({ name, re, resHits, resRecall, cleanFP, allFP });
  console.log(
    '   ' +
      name.padEnd(54) +
      `${(resRecall * 100).toFixed(1)}% (${resHits}/${residue.length})`.padStart(18) +
      String(cleanFP.length).padStart(8) +
      String(allFP.length).padStart(7),
  );
}

// --- the recommended regex: show its clean-project danger cases -------------
// Pick the candidate that maximises residue recall subject to minimal clean FP,
// preferring the smallest alternation when tied. We inspect the strongest
// recall options explicitly.
const REC_NAME = '\\bcurat(e|ed|ion)\\b|\\bawesome\\b';
const rec = summary.find((s) => s.name === REC_NAME);

console.log(`\n# RECOMMENDED regex: ${REC_NAME}`);
console.log(
  `   residue recall: ${(rec.resRecall * 100).toFixed(1)}% (${rec.resHits}/${residue.length})`,
);
console.log(
  `   clean-project FP: ${rec.cleanFP.length}   all-project FP: ${rec.allFP.length}`,
);

console.log(`\n   clean-project (non-ambiguous) descriptions it matches:`);
for (const r of rec.cleanFP) {
  console.log(
    `   - ${r.owner}/${r.repo}  stars=${r.stars}  htmlLinks=${r.htmlLinks}  lang=${r.language}`,
  );
  console.log(`     desc: ${(r.description || '').slice(0, 160)}`);
}
console.log(`\n   ambiguous-project descriptions it matches (expected, kept as repository):`);
for (const r of rec.allFP.filter((r) => r.ambiguous)) {
  console.log(
    `   - ${r.owner}/${r.repo}  stars=${r.stars}  htmlLinks=${r.htmlLinks}`,
  );
  console.log(`     desc: ${(r.description || '').slice(0, 160)}`);
}

// --- combined classifier: registry if (htmlLinks>=50) OR (regex) ------------
const REC_RE = rec.re;
const combined = (r) =>
  (r.htmlLinks != null && r.htmlLinks >= 50) || match(r, REC_RE)
    ? 'registry'
    : 'repository';

const eAll = evaluate(repos, combined, { label: 'content>=50 OR desc-regex (all)' });
console.log(`\n# COMBINED classifier: registry if (htmlLinks>=50) OR desc-regex`);
console.log('   ' + fmt(eAll));
console.log(`   tp ${eAll.tp}  fp ${eAll.fp}  fn ${eAll.fn}  tn ${eAll.tn}`);

// Precision vs CLEAN projects only (negatives = registries ∪ clean projects).
const cleanEvalSet = repos.filter((r) => r.truth === 'registry' || !r.ambiguous);
const eClean = evaluate(cleanEvalSet, combined, {
  label: 'content>=50 OR desc-regex (clean)',
});
console.log('   ' + fmt(eClean));
console.log(`   (clean-project precision = ${(eClean.precision * 100).toFixed(1)}%)`);

// Reference: content-only baseline.
const baseOnly = (r) =>
  r.htmlLinks != null && r.htmlLinks >= 50 ? 'registry' : 'repository';
const eBaseAll = evaluate(repos, baseOnly, { label: 'content>=50 baseline (all)' });
const eBaseClean = evaluate(cleanEvalSet, baseOnly, {
  label: 'content>=50 baseline (clean)',
});
console.log(`\n# reference: content-only baseline`);
console.log('   ' + fmt(eBaseAll));
console.log('   ' + fmt(eBaseClean));

// Net effect: how many NEW clean-project FPs does the regex introduce vs baseline?
const baseCleanFP = baseOnly ? eBaseClean.fp : 0;
console.log(
  `\n# net: regex adds ${eClean.fp - baseCleanFP} clean-project FP vs baseline (${eClean.fp} vs ${baseCleanFP});`,
);
console.log(
  `   and recovers ${rec.resHits} of ${residue.length} residue registries (+ any null-htmlLinks it catches).`,
);
const nullRecovered = residueNull.filter((r) => match(r, REC_RE));
console.log(
  `   null-htmlLinks registries recovered by regex: ${nullRecovered.length}/${residueNull.length}`,
);

// Which residue registries are STILL missed by the combined classifier?
const stillMissed = residue.filter((r) => combined(r) !== 'registry');
console.log(
  `\n# residue STILL missed after regex (${stillMissed.length}/${residue.length}):`,
);
for (const r of stillMissed.slice(0, 25)) {
  console.log(
    `   - ${r.owner}/${r.repo}  htmlLinks=${r.htmlLinks}  src=${r.source}  inSindresorhus=${r.inSindresorhus}`,
  );
  console.log(`     desc: ${(r.description || '(null)').slice(0, 160)}`);
}
