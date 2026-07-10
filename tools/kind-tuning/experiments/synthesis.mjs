// SYNTHESIS pass: the single best LAYERED classifier (ordered, first-match-wins)
// for the production classifyKind path, chosen from the investigation findings.
//
// Architecture (precision-first, first-match-wins):
//   1. sindresorhus membership  -> registry [sindresorhus]  (cached Set; degrade to skip if cold)
//   2. awesome-list topic       -> registry [topic]         (free on the /repos GET)
//   3. name ~= /awesome/        -> registry [name]          (gated behind 1+2)
//   4. description list-phrasing-> registry [description]   (tight, list-proximate regex)
//   5. content htmlLinks >= T   -> registry [content]       (recall backstop, SOFT)
//   6. else                     -> repository [default]
//
// Content (htmlLinks) is a precision-destructive gate (nodejs/node 662, openclaw 749
// flip at every threshold). The anchors recover 85/87 low-link registries, so content
// is redundant for recall on this dataset. We measure with content DISABLED (T=-1,
// the precision-priority proposal) and with a high soft backstop (T=500) so the
// caller can choose. Provenance is emitted on every decision because deciding-layer
// error rates span 0% -> ~50%.

import { loadDataset, evaluate, fmt } from '../lib.mjs';

const { repos } = await loadDataset();
const cleanProjects = repos.filter((r) => r.truth === 'repository' && !r.ambiguous);
const registries = repos.filter((r) => r.truth === 'registry');
// The HONEST evaluation set: all registries + only the non-ambiguous projects.
// FPs here are genuine software flips (no curated boundary cases padding the
// denominator), so this precision is the trustworthy one per the task protocol.
const cleanSet = [...registries, ...cleanProjects];

// Tight, list-proximate description regex. Rejects bare "collection of"/"curated"
// (those flip gitignore/PowerToys/iptv/SecLists for ~0 F1) and bare "awesome"
// (flips nerd-fonts via "Font Awesome"). Requires "list"/"cheat sheet" nearby.
const DESC_LIST_RE =
  /(curated list|awesome list|collective list|a list of|list of (free|public|computer|useful|the best|awesome)|cheat.?sheet|curated collection)/i;

// Build a classifier factory. withMembership toggles the cached-sindresorhus layer
// (dataset-honest vs production-realistic). contentT = -1 disables the content layer.
function makeClassifier({ withMembership, contentT }) {
  return (r) => {
    if (withMembership && r.inSindresorhus) return { kind: 'registry', via: 'sindresorhus' };
    if ((r.topics || []).includes('awesome-list')) return { kind: 'registry', via: 'topic' };
    // Word-boundary: catches hyphenated awesome-* lists, drops underscore/concatenated
    // libraries (awesome_print, awesome_nested_set) that plain /awesome/i would flip.
    if (/\bawesome\b/i.test(r.repo)) return { kind: 'registry', via: 'name' };
    if (r.description && DESC_LIST_RE.test(r.description)) return { kind: 'registry', via: 'description' };
    if (contentT > 0 && r.htmlLinks != null && r.htmlLinks >= contentT) return { kind: 'registry', via: 'content' };
    return { kind: 'repository', via: 'default' };
  };
}

// evaluate() expects a 'registry'|'repository' string; wrap the rich classifier.
function measure(repos, classify) {
  return evaluate(repos, (r) => classify(r).kind, { label: '' });
}

function pct(x) {
  return (x * 100).toFixed(1) + '%';
}

// ---------- baseline (current production: content htmlLinks >= 50) ----------
const baseline = (r) =>
  r.htmlLinks != null && r.htmlLinks >= 50 ? 'registry' : 'repository';
const eBaseAll = evaluate(repos, baseline, { label: 'baseline content>=50' });
const eBaseClean = evaluate(cleanSet, baseline);
console.log('=== BASELINE (production: htmlLinks >= 50) ===');
console.log('   vs ALL   : ' + fmt(eBaseAll));
console.log('   vs CLEAN : P ' + pct(eBaseClean.precision) + '  R ' + pct(eBaseClean.recall) + '  F1 ' + pct(eBaseClean.f1) + '  (fp ' + eBaseClean.fp + ', fn ' + eBaseClean.fn + ')');

// ---------- proposed configs ----------
const configs = [
  { name: 'PROPOSED (membership, no content)        ', opt: { withMembership: true, contentT: -1 } },
  { name: 'PROPOSED + content>=500 soft backstop    ', opt: { withMembership: true, contentT: 500 } },
  { name: 'PRODUCTION-realistic (no membership)     ', opt: { withMembership: false, contentT: -1 } },
  { name: 'PRODUCTION + content>=500 soft backstop  ', opt: { withMembership: false, contentT: 500 } },
];

const results = {};
for (const c of configs) {
  const cls = makeClassifier(c.opt);
  const eAll = measure(repos, cls);
  const eClean = measure(cleanSet, cls);
  results[c.name.trim()] = { cls, eAll, eClean };
  console.log('\n=== ' + c.name.trim() + ' ===');
  console.log('   vs ALL   : ' + fmt(eAll));
  console.log('   vs CLEAN : P ' + pct(eClean.precision) + '  R ' + pct(eClean.recall) + '  F1 ' + pct(eClean.f1) + '  (fp ' + eClean.fp + ', fn ' + eClean.fn + ')');
}

// ---------- PROVENANCE error breakdown for the chosen proposal (membership, no content) ----------
const chosen = makeClassifier({ withMembership: true, contentT: -1 });
console.log('\n=== PROVENANCE error rates (PROPOSED: membership, no content) ===');
const viaCounts = {};
const viaErrors = {};
for (const r of repos) {
  const { kind, via } = chosen(r);
  viaCounts[via] = (viaCounts[via] || 0) + 1;
  if (kind !== r.truth) viaErrors[via] = (viaErrors[via] || 0) + 1;
}
console.log('   layer        decisions   errors   err-rate');
for (const via of ['sindresorhus', 'topic', 'name', 'description', 'content', 'default']) {
  const d = viaCounts[via] || 0;
  const e = viaErrors[via] || 0;
  const rate = d ? ((e / d) * 100).toFixed(1) + '%' : '-';
  console.log('   ' + via.padEnd(14) + String(d).padStart(8) + String(e).padStart(9) + '   ' + rate.padStart(8));
}

// ---------- misclassified tail of the chosen proposal (vs CLEAN projects) ----------
const chosenKey = 'PROPOSED (membership, no content)';
const eChosenClean = results[chosenKey].eClean;
const eChosenAll = results[chosenKey].eAll;
console.log('\n=== Chosen proposal — FALSE POSITIVES (projects flipped to registry), n=' + eChosenAll.fp + ' ===');
for (const r of eChosenAll.fpList.slice(0, 15)) {
  console.log('   - ' + r.owner + '/' + r.repo + '  links=' + r.htmlLinks + '  ambig=' + r.ambiguous + '  via=' + chosen(r).via + '\n       ' + (r.description || '(null)').slice(0, 110));
}
console.log('\n=== Chosen proposal — FALSE NEGATIVES (registries missed), n=' + eChosenAll.fn + ' ===');
for (const r of eChosenAll.fnList.slice(0, 15)) {
  console.log('   - ' + r.owner + '/' + r.repo + '  links=' + r.htmlLinks + '  inSind=' + r.inSindresorhus + '  src=' + r.source + '\n       ' + (r.description || '(null)').slice(0, 110));
}

// ---------- what does the content>=500 soft backstop cost / buy? ----------
const softKey = 'PROPOSED + content>=500 soft backstop';
const eSoftAll = results[softKey].eAll;
console.log('\n=== content>=500 soft backstop — additional FPs over the no-content proposal (n=' + eSoftAll.fp + ') ===');
for (const r of eSoftAll.fpList.slice(0, 15)) {
  console.log('   - ' + r.owner + '/' + r.repo + '  links=' + r.htmlLinks + '  stars=' + r.stars + '  ambig=' + r.ambiguous + '  via=' + makeClassifier({ withMembership: true, contentT: 500 })(r).via);
}
const softRecovered = eSoftAll.fnList.length;
console.log('   (content>=500 leaves fn=' + softRecovered + ' vs no-content fn=' + eChosenAll.fn + '; recovers ' + (eChosenAll.fn - softRecovered) + ' high-link registries)');

// ---------- residue recovery sanity (registries with htmlLinks < 50) ----------
const residue = registries.filter((r) => r.htmlLinks != null && r.htmlLinks < 50);
const residueCaught = residue.filter((r) => chosen(r).kind === 'registry').length;
console.log('\n=== Residue (registries with htmlLinks < 50): n=' + residue.length + ', caught by anchors = ' + residueCaught + ' ===');

// ---------- name regex variant check: plain /awesome/i vs word-boundary ----------
console.log('\n=== Name-regex variant (with membership + topic + descTight, no content) ===');
for (const [label, nameFn] of [
  ['plain /awesome/i   ', (r) => /awesome/i.test(r.repo)],
  ['word-bdy \\bawesome\\b', (r) => /\bawesome\b/i.test(r.repo)],
]) {
  const cls = (r) => {
    if (r.inSindresorhus) return { kind: 'registry', via: 'sindresorhus' };
    if ((r.topics || []).includes('awesome-list')) return { kind: 'registry', via: 'topic' };
    if (nameFn(r)) return { kind: 'registry', via: 'name' };
    if (r.description && DESC_LIST_RE.test(r.description)) return { kind: 'registry', via: 'description' };
    return { kind: 'repository', via: 'default' };
  };
  const eA = measure(repos, cls);
  const eC = measure(cleanSet, cls);
  console.log('   ' + label + ' vsALL F1 ' + pct(eA.f1) + ' (fp ' + eA.fp + ', fn ' + eA.fn + ')  vsCLEAN P ' + pct(eC.precision) + ' (cleanFP ' + eC.fp + ')');
}
