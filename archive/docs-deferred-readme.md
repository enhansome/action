# Fetch gap — sources that move their content out of the README

**Status: IMPLEMENTED 2026-09-09 — auto-follow + hollow guard built and
tested (275 green, android-root heals to 617 items offline); awaiting owner
review before commit/deploy.**

## Goal

Enhance sources whose entries no longer live in the README — the README has
become a landing page and the content moved to `docs/**/*.md` — without
emitting hollow mirrors.

## Diagnosis (2026-09-09)

- `awesome-android-root/awesome-android-root` restructured: its 600+ entries
  moved from `README.md` into `docs/apps-and-modules/*.md`; the README is
  now badges + link tables (8.5 KB, zero list entries). The source is alive
  and daily-active (pushed 2026-09-08T20:28Z).
- The enhancer reads the source README only — `src/main.ts:55` is the one
  source fetch (`getReadme`, `packages/core/src/github.ts`; `markdown.ts`
  names it "the source README fetch … can fail the run"). Result: the
  mirror `enhansome/enhansome-android-root` commits daily with a skeleton
  tree (4 titles — the README's own link tables) over what used to be a
  642-item mirror.
- Downstream (webapp indexer): its applier refuses to hollow a registry
  with stored items, so `android-root` froze at its Sept 6 state (642
  entries / 538 repos / 674k stars in Layerbase) and reddened every index
  run Sept 8–9. The webapp now warn-skips hollow mirrors instead
  (`../webapp/progress/indexer-rolling.md`, 2026-09-09) — runs go green,
  the registry stays frozen until this thread heals its mirror.

## Fix directions (owner design call)

1. **General, not a special case:** when the parsed README carries
   (near-)zero entries but links into `docs/` files, follow them — keyed on
   structure, never on this source's name.
2. **Mirror-side guard:** refuse to emit a hollow tree over a
   previously-full mirror (the webapp's refusal, one step earlier) — a
   parse regression then fails loudly at enhancement time instead of
   surfacing as silent downstream staleness.
3. **Sweep for other instances:** mirrors whose README.json item count is
   far below their registry's stored count carry the same disease;
   android-root is today's only refusal, but a near-empty README over an
   EMPTY registry would apply silently and stay wrong.

## Built rules (fleet-census-grounded, 2,345 mirrors → 2,218 live sources)

- **Auto-follow trigger:** README carries `< minLinks` (2) distinct GitHub
  repos → skeleton → follow. 2,212 of 2,218 sources never reach the path
  (byte-identical output); the cliff is 1 (android-root) vs 15 (next
  source) — nothing between. n-links/m-repos rules were rejected: the
  biggest n×m sources are website dumps and notes corpora with healthy
  READMEs (toolsdk 793/readme vs 1,987 in docs; trackawesomelist 687 links).
- **Skip list:** root/`.github` meta files (CONTRIBUTING, SECURITY,
  CHANGELOG, …) and root `README*` variants (self/translations). Path-
  scoped, not basename: android-root's `docs/apps-and-modules/security.md`
  IS the Security category. 532 of 728 link-bearing sources are meta-only.
- **Splice gate:** a followed file joins the document only with ≥ minLinks
  distinct GitHub repos; nav pages are still parsed for their links.
- **Assembly:** breadth-first in document order, visited set (nesting
  included), caps 50 files / 1 MB; frontmatter stripped; file H1 replaced
  by a heading from the link text (file H1 text when the label is
  filename-shaped); relative links/images rewritten to source-repo blob
  URLs; spliced at document end; the existing walk/badges/sort unchanged.
- **Hollow guard:** `countItems(next) < countItems(previous) × 0.05` →
  red run, nothing written. Always on, no input.
- **No new action inputs.**

## Next step

Owner reviews the diff; commit; release. android-root heals on its next
scheduled run (no workflow edit needed — auto trigger); the webapp applies
the repopulated mirror on its next index run. Fleet follow-ups: 127
mirrors with deleted/renamed sources; born-empty mirrors are a separate
format-blindness disease (direction 3).

## Append-only log

- **2026-09-09** — Thread opened from the webapp indexer's android-root
  investigation (full evidence in
  `../webapp/progress/indexer-rolling.md`'s same-day entry).
- **2026-09-09 (2nd)** — Census + build. Auto-follow + hollow guard
  implemented in `packages/core` (`internal-links.ts` new;
  `markdown.ts`, `github.ts`, `orchestrator.ts`, `src/main.ts` touched).
  android-root is a golden fixture: real README at
  `src/fixtures/original/android-root.md`, its docs files at real paths
  under `original/android-root/` (served by the golden harness's
  `getRepoFileOrNull` stand-in), structure + raw goldens under `expected/`.
  Verified: 617 items / 22 sections / 188 KB, 91 relative links rewritten
  to source-repo URLs; no pre-existing golden changed.
