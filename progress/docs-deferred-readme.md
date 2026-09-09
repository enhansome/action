# Fetch gap — sources that move their content out of the README

**Status: OPENED 2026-09-09 — diagnosed, fix not designed. One known
instance (android-root); its mirror commits a skeleton daily and the
downstream registry is frozen at Sept 6 content.**

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

## Next step

Owner design call on the three directions; then implement in `packages/core`
(`markdown.ts` / `github.ts` / `src/main.ts`), verify on android-root —
the mirror repopulates, and the webapp applies it on its next run.

## Append-only log

- **2026-09-09** — Thread opened from the webapp indexer's android-root
  investigation (full evidence in
  `../webapp/progress/indexer-rolling.md`'s same-day entry).
