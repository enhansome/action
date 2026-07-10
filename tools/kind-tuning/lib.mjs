// Shared evaluation helpers for the kind-classifier fine-tuning experiments.
// Every experiment agent imports these so precision/recall/F1 are computed
// identically and results stay comparable across techniques.
//
// The dataset models *target* repos (the classifyKind path), whose content
// signal is htmlLinks (rendered-HTML outbound anchors). The source-README path
// (countResourceLinks over mdast) is out of scope here — it stays as-is.

import { readFile } from 'node:fs/promises';

const DATASET_PATH = new URL('dataset.json', import.meta.url);

export async function loadDataset() {
  const raw = JSON.parse(
    await readFile(DATASET_PATH, 'utf8'),
  );
  return raw;
}

// A classifier maps a repo record to 'registry' | 'repository'. Repos whose
// htmlLinks fetch failed (null) are still passed; a content-only classifier
// should treat null as "no evidence" (i.e. repository) — same as production,
// where a dead link defaults to repository.
export function evaluate(repos, classify, { label = '' } = {}) {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  const fpList = [];
  const fnList = [];
  for (const r of repos) {
    const pred = classify(r);
    const truth = r.truth;
    if (pred === 'registry' && truth === 'registry') tp++;
    else if (pred === 'registry' && truth === 'repository') {
      fp++;
      fpList.push(r);
    } else if (pred === 'repository' && truth === 'registry') {
      fn++;
      fnList.push(r);
    } else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    label,
    precision,
    recall,
    f1,
    tp,
    fp,
    fn,
    tn,
    fpList,
    fnList,
  };
}

// Break metrics down by dataset source so we can see whether misses concentrate
// in the CV residue, the broad sindresorhus population, or the project negatives.
export function bySource(repos, classify) {
  const groups = new Map();
  for (const r of repos) {
    if (!groups.has(r.source)) groups.set(r.source, []);
    groups.get(r.source).push(r);
  }
  const out = {};
  for (const [src, rs] of groups) {
    out[src] = evaluate(rs, classify, { label: src });
  }
  return out;
}

// Pretty-print a result for quick scanning.
export function fmt(e) {
  const p = (e.precision * 100).toFixed(1);
  const r = (e.recall * 100).toFixed(1);
  const f = (e.f1 * 100).toFixed(1);
  return `${(e.label || '').padEnd(28)} P ${p.padStart(5)}%  R ${r.padStart(5)}%  F1 ${f.padStart(5)}%  (fp ${e.fp}, fn ${e.fn})`;
}
