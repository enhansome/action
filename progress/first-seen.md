# Emit first_seen per item — addition dates in the mirror contract

**Status: in progress — implemented 2026-08-28, awaiting release (1.11.0) and
one mirror cycle of real dates. Found in the 2026-08-26 webapp MCP capability
test.**

## The defect

Nothing in the pipeline knows when a curator added a listing. The webapp
wipes and re-ingests the whole forest per run, restamping every timestamp
(the test watched all registries sweep 05:46–06:54 in one morning), and
`registry_sources.last_updated` is the mirror's own stamp, swept the same
way. Result: "what got added to curated lists recently" — a core
curation-freshness question — is unanswerable through the product.

Proof of demand from the test: an agent answered "newest additions" anyway by
reverse-engineering GitHub's monotonically-increasing repo ids — clustering
id bands per registry to infer late additions (helm's 199k and 251.7k waves;
a 2.5M-id outlier as an airtight single-tree case). Clever, and it worked;
that it was necessary is the gap.

## Fix sketch

The knowledge lives here, not in the webapp: the enhancer updates each
mirror over time and commits over the previous run's output — the mirror's
history *is* the addition log.

- On each run, diff the parsed items against the previous run's JSON (already
  present in the repo being committed to) and emit `first_seen` per item:
  carried forward verbatim for existing entries, the run timestamp for new
  ones. Removed-then-readded items take the new date (simple, honest).
- Contract delta: `items[].first_seen` (ISO datetime), optional so pre-fix
  mirrors keep parsing.
- Webapp side (theirs, once the contract carries it): store on the
  occurrence row, expose `sort: 'added'` / `addedSince` — forest-wide reads
  the repo's earliest listing, scoped reads the listing's own date. No
  webapp timestamp machinery; their wipe-and-rebuild stays untouched.

Tests first: run the enhancer twice over a fixture with an item added between
runs; assert run-1 entries keep their original date and only the new entry
carries run-2's.

## Log

- **2026-08-28 — implemented (not yet released).** Listing identity: ancestor
  title path + `owner/name`, lowercased (the webapp occurrence row's own
  identity — both ends of the seam agree). New `packages/core/src/first-seen.ts`
  (`collectFirstSeen` walks the previous output tolerantly — any vintage or
  garbage; `stampFirstSeen` walks the fresh sections: carried verbatim, else
  the run timestamp). Contract: `items[].first_seen`, optional on the type so
  pre-v1.11 output keeps parsing; groups never stamped. `src/main.ts` reads
  the previous run's JSON at the output path before overwriting (missing =
  quiet, corrupt = warn + fresh; skipped entirely when JSON output is off).
  Tests written first and failing for the right reason: 9 in
  `first-seen.test.ts` (double-run fixture, carry/new/moved/re-added/case-only
  pre-fix/malformed), 4 in `main.test.ts` (pass-through, missing, corrupt,
  disabled). Goldens regenerated — 70 files, `first_seen` lines only.
  `make ci` + `yarn lint` green. Next: `feat:` commit → 1.11.0 via
  release-please; after one mirror cycle the dates are real and the webapp
  side (occurrence `first_seen`, `sort: 'added'` / `addedSince`) can be built.
- **2026-08-28 — identity switched to the repo's numeric GitHub id** (owner
  review). `owner/name` breaks on renames/transfers — even an unchanged link
  resolves to the new spelling after the API redirect, so the previous
  output's key would miss and reset the date; the id is stable, and it is the
  same inode identity the webapp's nodes use (`gh-{id}`). Discriminating test
  added (previous output carries a pre-rename spelling, id kept → date
  carries); verified it fails under `owner/name` keying before restoring the
  id key. Suite 247 green, `make ci` + lint clean.
- **2026-08-28 — identity simplified to the bare repo id** (owner review, two
  steps: drop the `listingKey` ceremony, then drop the ancestor path too).
  Per-repo, not per-slot: the date answers "when did this list start carrying
  this repo", so the same repo in two sections carries one date and section
  renames/moves/restructuring keep dates instead of resetting them. What
  resets: a repo absent from the whole previous output (dropped everywhere,
  then re-added). Collect keeps the earliest date on duplicate listings;
  walkers no longer thread ancestor paths at all — the index is
  `Map<repo_id, ISO date>`. Tests: 9 (path-move reset and case-only tests
  deleted as inverted; added "same repo in two sections → one carried date",
  the discriminating one). Suite 246 green, `make ci` + lint clean.
- **2026-08-28 — restructured on owner review.** (1) `previousJson` is typed
  `JsonOutput`, not `unknown`: shape validation lives at the one boundary that
  reads the file (`readPreviousJson` in main.ts — missing/corrupt/wrong-shape
  each warn and yield undefined), and core walks the previous output typed;
  the `isRecord` guards and the malformed-input test moved to main.test.ts.
  (2) No batch stamping pass: `first-seen.ts` is now a `(repoId) => ISO`
  resolver built once from the previous output, threaded to the two item
  construction sites (`emitEntryNodes`, `finalizeContainer`) the same way
  `repoInfoMap` is — `first_seen` is set in the literal, per item, at birth.
  Goldens unchanged. Suite 246 green, `make ci` + lint clean.
