# Tree-shape overhaul — README.json must faithfully represent the source README

**Goal:** `README.json` trees that preserve heading hierarchy, capture every
repo link (including link-headings), contain no empty sections and no dead
links, and carry the numeric GitHub `id` in `repo_info`.

**Current state:** not started. Root causes fully diagnosed 2026-08-16 from
the webapp side (mirror JSON + local DB measurements); evidence and fix design
below. **Blocks webapp's schema-reset step** (user ordering 2026-08-17: action
lands first; webapp ingest guards make the pipeline order-safe either way).

**Next step:** decide the nesting model (stack-based heading-depth walk) and
rewrite `buildSections` in `packages/core/src/markdown.ts`.

## Root causes (all verified against live mirrors + webapp's local DB mirror)

1. **All heading levels treated identically.** `packages/core/src/markdown.ts`
   ~line 693: `node.type === 'heading' && node.depth > 1` — the depth value is
   never used. Every H2–H6 opens a flat section; a heading immediately followed
   by another heading closes as an **empty section**; nesting is never built.
   - `josephmisiti/awesome-machine-learning`: organized by language (`## C`,
     `## C++`, … ×23), each repeating the same topic headings → JSON has 37
     empty top-level sections + **25 identical "General-Purpose Machine
     Learning" sections**, each with different items.
   - `beatcracker/toptout`: 5,555-line generated README, per-app template
     headings (`#### Usage data` ×146, `##### 1. Set environment variable`,
     `###### Scope: ⧉ process`) → 629 sections, 625 empty, 11 items.
   - Webapp DB: **935 same-parent-same-title group clusters**; 25,469 of
     53,962 groups (47%) have no items beneath them; 198 groups have empty
     titles.
2. **Link-headings lose the repo.** A heading whose text is a single link —
   `#### [SnapRemote](https://github.com/mrtayguney/snapremote-server)` —
   becomes a *section titled "SnapRemote"*; only links inside `list` nodes are
   ever captured (`markdown.ts:713` → `processListRecursively`).
   - `shurushetr/awesome-snapmaker`: **44 GitHub links in the source → 0 items
     in README.json**; the tree is 737 groups, all empty. (Discovery
     classified it correctly — 44 ≥ 15 repo links — so this is purely an
     extraction failure.)
   - Same mechanism drops toptout's per-app headings (`### [Atom](…)`).
3. **Empty sections are emitted** (contract §2.7; webapp indexer preserves
   them per `webapp/src/lib/indexer.ts:368`). With (1)+(2) this fills the
   index with structural noise — entire registries of nothing.
4. **Dead links are emitted** (contract §2.8), including the "dead link as
   parent of its resolved children" shape (8 such cases in the DB).
5. **Numeric id dropped.** `toRepoInfo` (`packages/core/src/github.ts`)
   receives the numeric GitHub id from `rest.repos.get` and discards it —
   `repo_info` has no `id` field. (Tracked as its own TODO line; smallest
   change, biggest unlock for webapp.)

## Fix design

- **Nesting:** walk headings with a depth stack — H2..H6 nest by their level;
  the JSON section tree mirrors the README's heading tree.
- **Link-headings → items:** a heading that is (or contains exactly) one repo
  link emits an **item** node (repo_info from the existing repoInfoMap), with
  the following content as its children/description — not a section title.
  Non-repo link headings (toptout's `### [Atom](https://atom.io)`) stay
  sections until v2 models non-repo resources.
- **No empty sections:** after extraction, drop sections with no items
  anywhere beneath (the intermediates from nesting carry their children, so
  they survive; only true leaves vanish). Replaces §2.7.
- **No dead links:** unresolvable GitHub links are skipped at emit; their list
  children attach to the nearest live parent. Replaces §2.8.
- **Optional:** dedupe a repo repeated within one README (first occurrence
  wins) — webapp enforces this regardless; doing it here too keeps mirrors
  honest. 5,407 repo+tree duplicate pairs measured.
- **Contract + goldens move together:** the §2 contract notes in
  `README.md`/webapp `indexer.ts` refs and `markdown.golden.test.ts` are
  updated in the same release. Regenerate goldens deliberately (review the
  diffs — they are the spec), never blind-snapshot-accept.

## Release & rollout

release-please → tag → the daily cron (04:54 UTC) re-enhances all ~2,300
mirrors in ~30 min. No new API calls anywhere — the id was already fetched;
hierarchy/link extraction is pure parsing.

## Verification (post-cron spot checks)

- `enhansome-snapmaker` README.json: >0 items (expect ≈44 repos).
- `enhansome-machine-learning`: language sections nest (C > General-Purpose
  ML), zero duplicate sibling titles, zero empty sections.
- `enhansome-toptout`: app sections present; template headings nested under
  their apps.
- `repo_info.id` present on items.
- Webapp side after its schema-reset step lands: the ingest invariant counters
  (prunes/merges/missing-ids) log **zero** across a full run.

## Out of scope

- Non-repo resources (YouTube/docs/app links) — v2, parked (webapp TODO).
- Webapp's id scheme / schema reset — webapp repo, gated on this release.

## Log (append-only)

- **2026-08-16:** root-cause triage performed from the webapp session
  (trigger: "identical sibling groups" question). Measurements: 47% empty
  groups, 935 twin clusters, snapmaker 44→0 links, machine-learning 25×GPML.
  Mechanisms confirmed by reading `markdown.ts` (`buildSections` walk +
  `processListRecursively`) and the original READMEs. Full trail in
  `webapp/progress/indexer-perf.md` log 2026-08-16e.
- **2026-08-17:** this file + `../TODO.md` created; user ordering decision —
  action overhaul lands BEFORE webapp's schema reset; scratch-map bridge on
  the webapp side becomes conditional on mirror coverage after the cron pass.
