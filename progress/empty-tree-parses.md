# Empty-tree parses — parser yield fixes (all 8 causes)

**Goal:** stop the README parser from silently dropping registry content. It
today captures only 77.8% of the distinct GitHub repos linked across the
2,217-registry fleet (65,234 repos land in no tree; 336 registries parse to
`items: []` and still report success). Fix all 8 diagnosed causes, measured at
every step — no unverified "should work now" landings.

**Current state:** steps 0–2 landed 2026-08-24 (yield harness, minLinks per
section, implicit sections) — measured at every step on the fresh corpus
(below). Goldens regenerated and reviewed per step; items only ever ADDED.

**Next step:** step 3 (tables, cause 1 — the biggest bucket, ~18k repos),
then 4–8 in order. This file is the only thing a resuming session needs to
read.

## Baseline (2026-08-24, fleet = 2,217 fetched READMEs)

- Population yield **77.8%**: 293,605 distinct repos linked in READMEs,
  228,371 emitted by the offline parser (never-fail repo info). Production
  `repo_count + dupe-drops` = 230,955 — model validated within 1%.
- Yield bands (expected ≥ 10): 301 registries at 0 (42,596 repos lost) ·
  119 in (0, 0.5) · 662 in [0.5, 0.9) · 997 in [0.9, 1) — the partial bands
  lose another ~22.6k repos.
- Of the 413 hollow registries in the webapp mirror: 336 are action-side
  (parse produced nothing), 67 are webapp dupe-drops (Decision 2, not ours),
  10 other webapp slices.

## Root-cause taxonomy (the evidence the plan fixes)

Zero-stock and partial loss share the same causes; sizes below are
population-wide links lost (the fix-prioritizing metric).

| # | Cause | Links lost | Zero-stock | Mechanism (anchor) | Named case |
|---|---|---|---|---|---|
| 1 | Table format | 43,194 | 202 | `table` nodes never visited — the walk handles heading/paragraph/blockquote/list only | `scala` 268→2 |
| 2 | Paragraph entries | 14,650 | 72 | non-bullet paragraphs only ever feed container `description` | `3dbody-papers` 191→0 |
| 3 | minLinks gate per list | 12,004 | 10 | `itemsWithGitHubLinks.length < 2 → []` fires per top-level LIST; single-item lists (best-of format, single-entry sections) dropped whole | `best-of-react` 277→3; `cl` 682→565 |
| 4 | Link-headings at section depth | 4,241 | 8 | heading == sectionDepth is promoted to SECTION; closes childless → pruned (code comment admits the contract has no place for it) | `useful-javascript-libraries` 478→321 |
| 5 | No container opens | 2,869 | 25 | headingless docs / TOC-only headings / lists before first heading → no section ever opens, lists are AST-sorted but not emitted | `termux-hacking` 716→0; `football_analytics` 264→45 |
| 6 | Blockquote cards | 1,287 | 4 | `<details><summary>` sections + `> **[Name](github)**` cards; blockquotes are description-only, `<details>` is opaque html | **`java`** 786→0 |
| 7 | Own-link searched in first paragraph only | (5 zero + partials) | 5 | `findOwnGitHubLink` reads the item's FIRST paragraph; paper-list entries carry the `[[Code]]` link in a later one | `Awesome-Parameter-Efficient-Transfer-Learning` 64 items → 0 |
| 8 | Non-link URLs | (10 registries, invisible to the link model) | 10 | bare `github.com/owner/repo` text (GFM doesn't autolink scheme-less) and `<a href>` in raw HTML produce no `link` nodes | `windows-kernel-security-development` 1,636 mentions → 0 |

`java` specifically: `akullpan/awesome-java` switched its generated README
from bullets to the card layout on **2026-07-28** (commit `28f95157`). The
hollow stock drifts upward (403→413 in one day) because upstreams keep
switching to generated formats — this stock is not static, so the fixes are
worth it even where a bucket is small today.

## Constraints (do not relearn / do not break)

- **One way to do a thing** (repo rule): every new entry source — table row,
  paragraph, blockquote card, link-heading — must flow through the SAME
  emission path (own-link resolution → title/description split → item/group
  decision → sort). No per-format output shapes, no forked `processListRecursively`.
  Concretely: extract the existing title/description/identity logic from the
  list-item branch into one helper, and feed every source through it.
- **Identity stays honest**: only genuine GitHub nodes carry `repo_info`;
  groups never do (the identity-borrowing bug precedent). The own-link
  boundary is "the entry's OWN paragraphs", never nested lists' links — fix 7
  widens within that boundary only.
- **minLinks keeps its purpose** (noise protection — "## My Blog" with one
  link is not a registry entry). Fix 1 widens the gate's SCOPE to the section;
  it does not remove the gate.
- **Dead links behave as today**: a link that fails to resolve → that item is
  not emitted, its children lift to the nearest live parent. New sources
  inherit this via the shared emission path.
- **The JSON contract is the webapp's input**: `JsonSection{items}` stays the
  only top-level shape — new content lands inside sections (implicit ones if
  the document has none). Anything that would change the contract shape is a
  webapp-coordination point, flagged in its step.
- **Fixtures + goldens are the regression net**: each step adds fixtures
  FIRST (they fail — 0 items — before the fix), then fixes, then regenerates
  goldens (`UPDATE_GOLDENS=1 yarn test`) and reviews the diff: only the
  intended fixtures may change. New fixtures get a `source-repos.json` entry.
- **Re-ingest coordination**: the webapp's hollow gate (`check-hollow.ts`)
  only fails on had-repos→0, so item-ADDING fixes are safe to ship; but the
  next mirror rebuild will move fleet numbers a lot — tell the webapp thread
  before releasing (it owns `../webapp/TODO.md`'s rebuild line).
- **Badges follow content**: `addInfoBadges` inserts badge text after every
  resolved link — it will start touching table cells / blockquote cards once
  those parse. That is the product's point; review one rendered raw fixture
  per new source for readability.

## Steps

| # | step | change | verify |
|---|---|---|---|
| 0 | **Yield harness** (instrument) — ✅ done 2026-08-24 | permanent diag tool: `packages/core/src/yield.diag.test.ts`, skipped unless `YIELD_DIR` is set; reuses the golden suite's offline repo-info mock (shared helper `offline-github.ts` — one way); reads a corpus dir, runs the real `enhance()` per file, and emits the yield report (per-registry expected/got/loss-bucket + fleet totals). Corpus is fetched, not committed (command in Method) | run over a freshly fetched corpus: reproduces baseline 77.8% ± fleet drift; harness is skipped in normal `yarn test` |
| 1 | **minLinks per section** (cause 3) — ✅ done 2026-08-24 | aggregate the gate: a section's lists count together — decide emission per section subtree, not per top-level list. Gate stays ≥2 for the section | new fixture `single-item-sections.md` (best-of shape) fails pre-fix / passes; yield report: gated-list bucket ~12k → ~0; goldens: only intended diffs; watch false-positive noise (prose link lists under tiny sections must still be dropped) |
| 2 | **Implicit sections** (cause 5) — ✅ done 2026-08-24 | when a list (or later: any entry source) appears with no open container, synthesize one (title from the doc title / "Overview") instead of dropping | fixtures `headingless.md`, `toc-only.md` fail pre / pass; `termux-hacking` corpus case 716 links recover; goldens reviewed |
| 3 | **Tables** (cause 1) | walk `table` nodes: each row whose cells contain a GitHub repo link becomes an item under the nearest open container (implicit section from step 2 if none); title = first cell's leading text + link text, description = remaining cell text — via the shared emission helper | fixture `table-format.md` (scala-shaped); yield: table bucket 43k → ~0 (biggest single move); `scala` 268→~268 offline; goldens reviewed; raw fixture rendered sanely with badges |
| 4 | **Paragraph entries** (cause 2) | a top-level paragraph that behaves like an entry becomes an item: contains a repo link AND the link sits at/near the start (same leading-tag allowance as list items). Calibration against prose false-positives ("Contributions welcome, open an issue at [repo]" must stay description) is THE risk — tune on corpus, not intuition | fixture `paragraph-entries.md` (paper style + CJK style); yield: paragraph bucket 14.7k → mostly recovered; spot-check titles in the harness output for prose leaks; `3dbody-papers` 191→~191 |
| 5 | **Blockquote cards** (cause 6, incl. `java`) | a blockquote whose leading link resolves to a repo → item (reuse step 4's entry test on the card's first paragraph); `<summary>` text opens the section (treat a details-summary html block as a heading-equivalent container) | fixture `details-cards.md` (java-shaped); **`java` corpus case 786→~786** — the webapp eval's named failure; goldens reviewed |
| 6 | **Link-headings as items** (cause 4) | a link-heading at sectionDepth becomes an item (repo) under a synthesized section instead of an empty section that gets pruned; deeper link-headings keep today's item behavior. Webapp-visible shape change: sections appear that are one-item wrappers — flag in release notes | fixture `link-headings.md`; yield: heading bucket 4.2k → ~0; `useful-javascript-libraries` 478→~478; goldens reviewed |
| 7 | **Own-link across all own paragraphs** (cause 7) | `findOwnGitHubLink` scans every OWN paragraph of the item (still never nested lists) — title stays the first paragraph's text | fixture `paper-list.md`; `Awesome-Parameter-Efficient-Transfer-Learning` 64 items recover; existing paper-ish fixtures unchanged |
| 8 | **Normalize non-link URLs** (cause 8) | pre-parse pass (same stage family as `applyTextReplacements`/`fixRelativeLinks`): autolink scheme-less `github.com/owner/repo` text into proper links; extract `<a href>` GitHub anchors from raw html nodes. Fixes the INPUT, not the parser | fixture `bare-links.md`; the 10 A0 corpus registries go from 0 links seen to their true counts; no yield regression elsewhere (idempotent on already-linked docs) |

Sequence rationale: 0 is the instrument (nothing lands without it). 1 is the
cheapest scope change and recovers 12k links with no new reading ability. 2
introduces implicit containers that 3, 5, and 6 all lean on. 3–5 are the
entry-source family in impact order, sharing one emission helper (built once,
in 3). 6 needs the implicit-section notion. 7 and 8 are small and independent.

## Targets

After steps 1–5: yield 77.8% → **~95%+**; hollow stock 336 → under ~50
(residual: registries whose links are genuinely non-repo resources — the
webapp TODO's v2 non-repo item). After 6–8: **~97%+** and hollow stock mostly
the webapp-side 67. Record actuals in the log per step — the harness prints
them; do not re-derive by hand.

## Method (reproduce any measurement in this file)

1. **Corpus** (webapp local mirror → READMEs; ~5 min at `-P 12`):
   ```sh
   mkdir -p /tmp/yield/readmes && cd /tmp/yield
   sqlite3 -readonly <mirror.sqlite> "
   WITH latest AS (SELECT slug, coalesce(repo_dupes_dropped,0) dd,
     row_number() OVER (PARTITION BY slug ORDER BY id DESC) rn FROM ingest_log)
   SELECT r.slug || '|' || rp.owner || '/' || rp.name || '|' || r.repo_count || '|' || r.node_count || '|' || l.dd
   FROM registry_sources r JOIN nodes n ON n.id = r.root_node_id
   JOIN repositories rp ON rp.id = n.repository_id
   LEFT JOIN latest l ON l.slug = r.slug AND l.rn = 1" > all-registries.tsv
   # mirror path: webapp scripts/lib/local-db.ts → localDbPath()
   cat all-registries.tsv | xargs -P 12 -I{} sh -c \
     'slug="${1%%|*}"; repo="${1#*|}"; repo="${repo%%|*}"; gh api "repos/$repo/readme" \
      -H "Accept: application/vnd.github.raw" -X GET > "readmes/$slug.md" 2>>fetch-errors.log \
      || rm -f "readmes/$slug.md"' _ {}
   ```
2. **Yield report**: `YIELD_DIR=/tmp/yield/readmes yarn vitest run
   packages/core/src/yield.diag.test.ts` (step 0's permanent harness; ~4 min
   for the fleet). Full JSON lands at `$YIELD_DIR/../yield-report.json`.
   Metric note: the harness counts DISTINCT lost repos per bucket; the
   2026-08-24 diagnosis buckets counted links, so bucket magnitudes from the
   two eras are not comparable (registry-level and fleet yield are).
3. Expected vs got: expected = distinct `github.com/owner/repo` targets in
   the README AST; got = distinct `repo_info` in the offline parse. Loss
   buckets = link locations outside passing lists (table/paragraph/blockquote/
   heading/gated/preamble), attributed with the parser's own walk rules
   (title-slot skip, TOC skip, exact container open/close).

Known model limits (don't chase): upstream READMEs drift after the mirror
date (±1% fleet noise); cause-8 docs have no `link` nodes so they're invisible
to expected (counted by registry, not yield); offline repo info never fails,
so production dead-link drops (~1–2%) are excluded on purpose.

## Log (append-only)

- **2026-08-24: diagnosis complete.** All 336 pure no-items registries traced
  to 8 root causes (taxonomy above); every bucket verified against the real
  parser offline (never-fail repo info — the cause is structural, not links).
  `java` = upstream format switch 2026-07-28.
- **2026-08-24 (later): low-yield extension** at user direction — all 2,217
  registries measured: population yield 77.8%, 65,234 distinct repos lost;
  minLinks gate promoted from "10 registries" to #3 population cause (12k
  links; top residual in otherwise-healthy bands — 718 registries in
  [0.9,1) bleed on it). Priorities re-ranked by links lost.
- **2026-08-24 (later): plan approved by user** — all 8 fixes, "systematically
  and cleanly, DRY"; steps 0–8 written above; constraints section distilled
  from the repo's one-way rule and the parser's documented invariants.
  Scratch harness/scripts from the diagnosis sessions were NOT committed (the
  session-local corpus and tsvs are gone with /tmp); step 0 recreates the
  harness as the permanent instrument. Implementation not started.
- **2026-08-24 (later): step 0 landed — yield harness.**
  `packages/core/src/yield.diag.test.ts` (skipped without `YIELD_DIR`;
  ~4 min/fleet run) + `offline-github.ts` shared mock (golden suite now uses
  it too). Attribution imports the parser's own walk rules — markdown.ts now
  exports `findFirstGitHubLink`, `isStructuralHeading`, `findTitleSlotIndex`
  (extracted from processTree), and later `countLinkedItems` — so buckets
  can't drift from the parser. Corpus refetched: 2,293/2,294 (one 404; fleet
  grew from the diagnosis snapshot's 2,217). **Harness validation against the
  ad-hoc baseline: zero-band 301 = old 301, action-side got=0 stock 336 =
  old 336, `best-of-react` 3/277 matches.** Fresh-corpus baseline (per-list
  gate, distinct-repo metric): **yield 83.1%** (176,007/211,685); buckets
  table 18,204 · paragraph 6,093 · gated 7,094 · heading 1,076 · blockquote
  649 · preamble 330 · list 2,231; bands ≥10: 301/181/669/1000/99. The 77.8%
  population number below stays as the old-corpus record.
- **2026-08-24 (later): step 1 landed — minLinks per section.** Gate now
  decided per SECTION subtree (`sectionGatePasses` in markdown.ts: the span
  runs to the heading that would close the section; every top-level list's
  link-bearing items count together; preamble lists keep the per-list gate).
  Fixture `single-item-sections.md` written FIRST, confirmed failing
  (`items: []`), then fix, then goldens. **Measured (same corpus): yield
  83.1% → 85.8% (+5,640 distinct repos); gated bucket 7,094 → 1,705 — the
  residual is sections with <2 link-bearing entries total, i.e. the noise
  the gate exists to drop (checked: `android-kotlin-apps` 0/190's 45 gated
  are lone-entry sections; its other losses are table/paragraph = steps
  3–5).** Bands 301/181/669/1000/99 → 289/150/387/1188/236; hollow stock
  336 → 322. Named cases: `best-of-react` 3→275/277, `best-of-crypto`
  1→503, `python-machine-learning-resources` 0→816, `cl` 565→648. Goldens:
  37 fixtures changed, **+347 items, 0 removed**; 8 same-repo second
  occurrences appear (per-README dedupe stays parked — webapp owns it); one
  raw fixture (`guides`) now sorts two previously-gated lists. All other
  buckets flat or shrinking — no false-positive noise observed.
- **2026-08-24 (later): step 2 landed — implicit sections.** `openImplicitSection`
  (markdown.ts): the first containerless list opens an "Overview" section —
  headingDepth Infinity (any structural heading closes it), headingIndex one
  before the list (the section gate's scan counts the opening list), so the
  whole preamble aggregates for the gate exactly like a real section. Preamble
  lists switched from per-list gate to the implicit-section aggregate —
  monotone (aggregate ≥ per-list count), so nothing that emitted before can
  stop. Fixtures `headingless.md` + `toc-only.md` written first, confirmed
  failing (`items: []`). **Measured: yield 85.8% → 86.3% (+934); preamble
  bucket 323 → 19 (residual = aggregate < 2 noise, correct); hollow stock
  322 → 302; `termux-hacking` 0 → 352/354; `football_analytics` 45 →
  257/264.** Goldens: 4 fixtures changed (the 2 new + cakephp + quarto, both
  gaining an Overview section with their preamble list), additions only.
