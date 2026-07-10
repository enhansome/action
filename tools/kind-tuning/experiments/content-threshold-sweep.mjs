// TECHNIQUE: content-threshold sweep on the TARGET (rendered-HTML) signal.
//
// classify = r => (r.htmlLinks != null && r.htmlLinks >= T) ? 'registry' : 'repository'
//
// We vary REGISTRY_MIN_LINKS over a wide range and, for each T, report P/R/F1
// BOTH against the clean (non-ambiguous) project set AND against all projects.
// The clean-project precision is the honest number: the 28 ambiguous repos are
// link-heavy-but-consumed-in-place educational/interview/style-guide content,
// not software, so counting them as FP inflates the apparent error rate.
//
// Three questions:
//   (a) F1-optimal T on the clean-project set.
//   (b) Precision-optimal T (highest clean-project precision subject to recall>=80%).
//   (c) How many of the 87-registry residue (registries with htmlLinks<50) each T
//       catches, and how many clean projects each T flips.
//
// The key finding the sweep is designed to surface: real popular software has
// link-heavy READMEs (nodejs/node 662, webpack 403, openclaw 749), so NO content
// threshold is precision-safe. Content is therefore a RECALL signal, not a
// precision gate — it belongs at a low threshold behind the precision anchors
// (topic / sindresorhus membership / description), not as the sole classifier.

import { loadDataset, evaluate, fmt } from '../lib.mjs';

const data = await loadDataset();
const repos = data.repos;

// Restrict to repos whose content signal exists (production default = repository
// when the README fetch failed, so a content-only classifier cannot say anything
// about the 1 null). 1003 repos survive.
const withContent = repos.filter((r) => r.htmlLinks != null);

// Clean eval set = all registries + non-ambiguous projects. Excludes the 28
// ambiguous repos so precision reflects the genuine software population.
const cleanSet = withContent.filter(
  (r) => r.truth === 'registry' || !r.ambiguous,
);
// All-project eval set = everyone with content (includes ambiguous as negatives).
const allSet = withContent;

// The "residue": registries whose content is below the current production T=50.
// These are the registries a content-only classifier structurally CANNOT see at
// T=50 and above. Lowering T below 50 trades precision for residue recall.
const RESIDUE = withContent.filter(
  (r) => r.truth === 'registry' && r.htmlLinks < 50,
);

const Ts = [10, 20, 30, 40, 50, 60, 75, 90, 110, 130, 160, 200, 300];

const content = (T) => (r) =>
  r.htmlLinks != null && r.htmlLinks >= T ? 'registry' : 'repository';

const rows = [];
console.log('# Content-threshold sweep (TARGET htmlLinks >= T)\n');
console.log(
  'T     | clean P  clean R  clean F1 cleanFP | all P   all R   all F1  allFP | residueCaught/87 | allProjFlipped',
);
console.log('-'.repeat(120));
for (const T of Ts) {
  const cls = content(T);
  const eClean = evaluate(cleanSet, cls, { label: `clean T=${T}` });
  const eAll = evaluate(allSet, cls, { label: `all T=${T}` });
  // residue caught by THIS threshold = registries with T <= htmlLinks < 50
  const residueCaught = RESIDUE.filter((r) => r.htmlLinks >= T).length;
  const allProjFlipped = withContent.filter(
    (r) => r.truth === 'repository' && cls(r) === 'registry',
  ).length;
  rows.push({
    T,
    eClean,
    eAll,
    residueCaught,
    allProjFlipped,
    cleanFP: eClean.fp,
    allFP: eAll.fp,
  });
  const p = (x) => (x * 100).toFixed(1).padStart(5);
  console.log(
    `${String(T).padStart(5)} | ${p(eClean.precision)}% ${p(eClean.recall)}% ${p(eClean.f1)}% ${String(eClean.fp).padStart(7)} | ${p(eAll.precision)}% ${p(eAll.recall)}% ${p(eAll.f1)}% ${String(eAll.fp).padStart(5)} | ${String(residueCaught).padStart(3)}/87            | ${allProjFlipped}`,
  );
}

// ---------------------------------------------------------------------------
// (a) F1-optimal T on the clean set.
// ---------------------------------------------------------------------------
const f1Best = rows.reduce((a, b) => (b.eClean.f1 > a.eClean.f1 ? b : a));
console.log(
  `\n# (a) F1-optimal (clean set): T=${f1Best.T}  clean P ${(f1Best.eClean.precision * 100).toFixed(1)}%  R ${(f1Best.eClean.recall * 100).toFixed(1)}%  F1 ${(f1Best.eClean.f1 * 100).toFixed(1)}%  cleanFP=${f1Best.cleanFP}  residueCaught=${f1Best.residueCaught}/87`,
);

// ---------------------------------------------------------------------------
// (b) Precision-optimal T (highest clean precision subject to recall>=80%).
// ---------------------------------------------------------------------------
const eligible = rows.filter((r) => r.eClean.recall >= 0.8);
const pBest = eligible.reduce((a, b) =>
  b.eClean.precision > a.eClean.precision ? b : a,
);
console.log(
  `# (b) Precision-optimal (clean, recall>=80%): T=${pBest.T}  clean P ${(pBest.eClean.precision * 100).toFixed(1)}%  R ${(pBest.eClean.recall * 100).toFixed(1)}%  F1 ${(pBest.eClean.f1 * 100).toFixed(1)}%  cleanFP=${pBest.cleanFP}  residueCaught=${pBest.residueCaught}/87  (note: T>=50 catches ZERO residue by construction)`,
);

// ---------------------------------------------------------------------------
// (c) Residue recovery + clean projects flipped, with the precision ceiling.
// Even at T=300 (far past clean p90=113), some popular software still flips.
// ---------------------------------------------------------------------------
console.log(
  '\n# (c) Residue recovery vs clean-project flips — there is no precision-safe T',
);
const residueDist = [...RESIDUE].sort((a, b) => a.htmlLinks - b.htmlLinks);
const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  const i = (q / 100) * (s.length - 1);
  const lo = Math.floor(i),
    hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const cleanProjLinks = withContent
  .filter((r) => r.truth === 'repository' && !r.ambiguous)
  .map((r) => r.htmlLinks);
console.log(
  `   clean-project htmlLinks: p50=${pct(cleanProjLinks, 50)} p75=${pct(cleanProjLinks, 75)} p90=${pct(cleanProjLinks, 90)} p95=${pct(cleanProjLinks, 95)} max=${Math.max(...cleanProjLinks)} (n=${cleanProjLinks.length})`,
);
console.log(
  `   residue htmlLinks: min=${residueDist[0].htmlLinks} p25=${pct(residueDist.map((r) => r.htmlLinks), 25)} p50=${pct(residueDist.map((r) => r.htmlLinks), 50)} p75=${pct(residueDist.map((r) => r.htmlLinks), 75)} max=${residueDist[residueDist.length - 1].htmlLinks} (n=${RESIDUE.length})`,
);

// Concrete popular-software FPs that survive even high thresholds.
console.log(
  '\n   Clean projects that flip (content>=T says registry) at each high T:',
);
for (const T of [50, 90, 130, 200, 300]) {
  const flipped = withContent.filter(
    (r) =>
      r.truth === 'repository' &&
      !r.ambiguous &&
      r.htmlLinks != null &&
      r.htmlLinks >= T,
  );
  const top = [...flipped]
    .sort((a, b) => b.htmlLinks - a.htmlLinks)
    .slice(0, 5)
    .map((r) => `${r.owner}/${r.repo}(${r.htmlLinks})`)
    .join(', ');
  console.log(
    `   T=${String(T).padStart(3)}: ${String(flipped.length).padStart(3)} clean projects flip. Top: ${top}`,
  );
}

// ---------------------------------------------------------------------------
// Where content should sit: content BEHIND the precision anchor.
// Compare (content>=T alone) vs (awesome-list topic) and the OR combination,
// to show content's marginal contribution when topic carries precision.
// ---------------------------------------------------------------------------
console.log(
  '\n# Layering: content as a recall clause behind the awesome-list precision anchor',
);
const topic = (r) =>
  (r.topics || []).includes('awesome-list') ? 'registry' : 'repository';
const eTopic = evaluate(cleanSet, topic, { label: 'topic:awesome-list' });
console.log(fmt(eTopic) + `  (clean set)`);
for (const T of [30, 40, 50, 75]) {
  const orCls = (r) =>
    (r.topics || []).includes('awesome-list') ||
    (r.htmlLinks != null && r.htmlLinks >= T)
      ? 'registry'
      : 'repository';
  const e = evaluate(cleanSet, orCls, { label: `topic OR htmlLinks>=${T}` });
  const marginalRecall = e.tp - eTopic.tp;
  const marginalFP = e.fp - eTopic.fp;
  console.log(
    fmt(e) +
      `  (clean set)  content adds +${marginalRecall} recall TP, +${marginalFP} clean FP`,
  );
}

// ---------------------------------------------------------------------------
// Summary recommendation constants, for the report.
// ---------------------------------------------------------------------------
console.log('\n# Summary');
console.log(`   clean set size: ${cleanSet.length} (registries + non-ambiguous projects)`);
console.log(`   all set size:   ${allSet.length}`);
console.log(`   residue size:   ${RESIDUE.length} (registries with htmlLinks<50)`);
console.log(
  `   F1-optimal T=${f1Best.T} (clean F1 ${(f1Best.eClean.f1 * 100).toFixed(1)}%, residueCaught=${f1Best.residueCaught}/87)`,
);
console.log(
  `   precision-optimal T=${pBest.T} @ recall>=80% (clean P ${(pBest.eClean.precision * 100).toFixed(1)}%, residueCaught=${pBest.residueCaught}/87)`,
);
console.log(
  `   ceiling: at T=300, ${rows.find((r) => r.T === 300).cleanFP} clean projects still flip — content is never precision-safe.`,
);
