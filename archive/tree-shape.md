# Tree-shape overhaul — README.json must faithfully represent the source README

**Goal:** `README.json` trees that preserve heading hierarchy, capture every
repo link (including link-headings), contain no empty sections and no dead
links. (The `repo_info.id` half of the original goal landed separately —
2026-08-19, root cause 5 below.)

**Current state:** **done — released in 1.8.0 and verified live 2026-08-19**
(manual `workflow_dispatch` of the five offender mirrors' enhance workflows;
all green, numbers in the last log entry). Archived.

**Next step:** none here. Webapp's P0-3 registry rebuild is unblocked
(`../webapp/TODO.md`).

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
5. **Numeric id dropped.** ~~`repo_info` has no `id` field.~~ **Landed
   2026-08-19** — `RepoInfoDetails.id` / `RepoInfo.id` + goldens; entry in
   `archive/completed.md`. Ships in the same release-please cycle as this
   overhaul, so the post-cron check below covers both.

## Fix design (as implemented)

- **Nesting:** walk headings with a depth stack; the JSON *node* tree mirrors
  the README's heading tree. Sub-headings nest as `node_type: "group"`
  containers (recursion `section.items → node.children → children…`) —
  **user decision 2026-08-19**: reuse the existing group abstraction so the
  emitted types are unchanged and today's webapp `parseNode` already recurses
  into groups correctly (a nested-`JsonSection` shape would have needed webapp
  changes first or silently dropped nested content).
- **Section level = shallowest heading depth present, H1s included.** Corpus
  sample (150 of 2,318 mirrors): 30 docs use `# Section` after the title H1
  (e.g. awesome-mlops: 23 H1 sections → all items lost today); 2 have H3 as
  shallowest. The title slot (valid title H1, else first H1 — the same node
  branding replaces) never becomes a section; text-less headings (bare `#`
  spacers, 14× in one mirror) and TOC headings ("Contents"/"Table of
  Contents", the free-for-dev `# Table of Contents` wrapper) are transparent
  to the walk. Boilerplate patterns beyond TOC ("Tools", "Guides", …) are NOT
  skipped — they're only title-invalid, and `## Tools` is real content
  (pinned by an orchestrator test).
- **Link-headings → items:** a heading whose only link is a live GitHub link
  emits an **item** (repo_info always present) with the following prose
  (paragraphs AND blockquotes — snapmaker/toptout descriptions are `> …`) as
  description and following lists/deeper headings as children. Non-repo or
  dead link-headings stay containers (groups) — pruned if their subtree has no
  items. A link-heading at section level becomes a section (the corpus has 3,
  all prose notes; the contract has no top-level items).
- **No dead links:** an own GitHub link absent from repoInfoMap emits nothing
  for the item; its children lift to the nearest live parent at its position.
  `JsonItem.repo_info` is now REQUIRED — every emitted item is a live repo.
  (Caveat accepted: a throttled fetch looks dead for that run; the daily cron
  self-heals.)
- **No empty containers:** pruning falls out of finalize — a section/group
  whose children array is empty (no items anywhere beneath) is dropped; lists
  only return item-bearing nodes, so emptiness = children.length === 0.
- **All lists in a container append** (the old walk closed a section at its
  first list — a second list was silently dropped; static-analysis.md lost
  247 of its 283 items to exactly this).
- **Dedupe: deliberately NOT done here** — user decision 2026-08-19; the
  webapp rebuild owns dedupe globally (~62k dupe drops accepted). Parked TODO
  line added. Consequence for webapp cross-verification: its prune/merge/skip
  counters should read zero after the cron pass, but the repo-drop counter
  stays non-zero by design.
- **Contract + goldens moved together:** README "Items vs. groups" rewritten;
  goldens regenerated and audited (below). Webapp `registry.ts`/`indexer.ts`
  mirror stays valid as-is (types unchanged); its stale "§2.7/§2.8" comments
  fold into webapp's own rebuild step.

## Measured results (local, deterministic repo-info mock)

- 60 goldens: **zero empty containers, zero duplicate same-parent titles**
  across all fixtures; item totals: 17 fixtures gain (static-analysis +247,
  cl +209, Awesome-CoreML-Models +15 …), only `complex` loses 1 (its forced
  dead link `user/repo-b` — by design).
- Live offender READMEs (fetched 2026-08-19): snapmaker **0 → 88 items / 36
  distinct repos** (dupes across machine categories are real; image `blob/`
  links parse as the list's own repo — pre-existing `parseGitHubUrl`
  semantics); toptout 11 → 69 items, template headings nested under apps;
  machine-learning 845 items, 0 duplicate siblings (was 25 identical
  sections); agent-memory 240 (orphan `### Start Here` promoted to section);
  mlops 0 → 36 (H1 sections); appsec 11 (non-repo articles correctly absent —
  v2).
- Known pre-existing quirks, unchanged and out of scope: empty-title items
  from backtick-wrapped link text (`[`gitleaks`](…)` → inlineCode → no text;
  identical counts before/after); HTML `<h2>` headings (static-analysis
  languages) invisible to mdast — content captured flat.

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
- **2026-08-19:** root cause 5 (`repo_info.id`) landed on main — test-first,
  goldens regenerated (diff verified: only `"id": <n>` lines added); TODO line
  closed to `archive/completed.md`. Tree-shape work (root causes 1–4) remains.
- **2026-08-19 (b):** tree-shape overhaul implemented (root causes 1–4).
  Grounded in live data first: 150-mirror sample (H1-section docs 20%,
  link-headings ≈2/doc, spacer/TOC headings) + all five offender READMEs
  fetched and inspected (machine-learning nests H4 directly under H2;
  agent-memory opens with an orphan `### Start Here`; offender list from
  webapp `progress/indexer-perf.md` log 2026-08-16e). User decisions: groups
  encoding (contract unchanged); dedupe skipped → parked TODO line. Test-first
  (12 `Tree shape` cases), `processTree` rewritten as a depth-stack walk,
  dead-link skip + child lifting in `processListRecursively`, `repo_info` now
  required. Golden review drove three extra rules: title-slot exclusion
  (guides.md `# Guides`), spacer/TOC-heading transparency (StarryDivineSky,
  free-for.dev), and NOT skipping INVALID_TITLE_PATTERNS beyond TOC (`##
  Tools` is content — caught by two orchestrator tests failing). Results in
  the Measured results section above.
- **2026-08-19 (c):** released in **1.8.0** (commit fbfc33c; `v1`/`v1.8` tags
  verified → 4f147b7) and verified live by dispatching the five offender
  mirrors' `enhance.yml` (runs 32226450092, …4175, …8259, …1579, …5577 — all
  success; same workflow the daily cron runs). Regenerated README.json at each
  new HEAD, all checks green across all five: **0 empty sections/groups, 0
  duplicate same-parent titles, every item has `repo_info.id`**. Numbers:
  machine-learning 875 items / 834 distinct (section `C` > group
  `General-Purpose Machine Learning` > items with id+stars, depth 4); snapmaker
  89 items / 37 distinct repos (57/57 repo-info ok — 0 dead there; was 0
  items); toptout 70 items / 52 distinct, apps as items with template-heading
  children, depth 5; agent-memory 252 items; AI-for-time-series-papers 180
  items. Archived → `archive/tree-shape.md`; webapp P0-3 unblocked.
