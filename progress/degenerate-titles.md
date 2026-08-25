# Degenerate item titles

**Goal.** An emitted item's title must be usable as a title. When the text the
parser currently titles the item from is degenerate — a pure number/punctuation
run, a URL, or a bare tag word — fall back to the repo link's own label when
that is meaningful, else `owner/name`.

## Current state (measured, webapp mirror DB 2026-08-25)

Live D1 (`enhansome-registry`, post-v1.9-rebuild), `nodes WHERE node_type='item'`,
190,279 items total. Degenerate families:

| family | count | shape | example |
|---|---|---|---|
| bare URL | 6,479 (`http%`) + 1,084 (`www.`/`github.com/` scheme-less) | link label is the URL itself | `github.com/example/kernel-two` |
| year / numeric | 3,346 short (≤4 chars, letter-free) + tail of 4,526 letter-free total | number/year table column or leading text | `2023` ×213, `2025-05` ×54, `-` ×53 |
| bare tag word | 2,382 `GitHub` + ~260 other tag words | `[GitHub](repo)` list line (best-of generated READMEs) | best-of-crypto ×473 |
| numbered rank | 165 | `\| 15. \| [**Day.js**](repo) \| … \|` first cell | themeselection/Awesome-JavaScript-Libraries |

Not degenerate: CJK titles (`代码仓库` ×38 — `\p{L}` must cover them),
letter-bearing titles, empty titles (existing repo-name fallback).

Defect sources (all in `packages/core/src/markdown.ts`):
- `entryTitle` (line ~775) falls back only when the base title is EMPTY — a
  degenerate non-empty base wins.
- Table single-URL path (`processTableRows`, line ~800) titles from the FIRST
  cell; numbered/year tables put the noise there. The link cell's text lands in
  the description (echo once the title moves).
- The tag-word family titles from the link's own label `[GitHub]` via
  `splitEntryText`.

Out of scope, observed while measuring: heading-container items
(`finalizeContainer`) use raw heading text; degenerate heading titles are rare
and a different seam. Per-README dedupe and non-repo resources are separate
TODO lines.

## Fix sketch (landed as described)

One seam, the shared `entryTitle` chain every entry source already calls:
1. `isDegenerateTitle(t)` — letter-free (`/[\p{L}]/u` absent, keeps CJK safe),
   URL-shaped (`^(?:scheme://|www\.)\S+$` or `^github\.com/\S+`), or a bare
   `TAG_LINK_TEXT` word.
2. `isMeaningfulLinkText(t)` — non-empty and not degenerate.
3. `entryTitle`: keep base unless degenerate → meaningful link label → for a
   degenerate base `owner/name`; the EMPTY-base path keeps the repo-name
   fallback (image-only cards keep their clean titles).
4. Table single-URL path: a degenerate first cell moves the title source to
   the link's own cell; that cell and the degenerate cell stay out of the
   description (no echo, no rank/year noise).

Expected effect: ~12k of 190k items retitle; webapp needs no COALESCE fallback
(mcp-prod-health 2.6). Mirrors refresh once the fix is released and their
`enhance.yml` cron (23:55 daily) or dispatch re-runs.

## Next step

Push → release-please PR (`feat:` → 1.10.0) → merge cuts the tag, moves `v1`,
publishes `@enhansome/core`. Then dispatch a couple of offender mirrors
(themeselection/Awesome-JavaScript-Libraries, a best-of-*, an AnimeResearch
mirror) and verify 0 degenerate titles in the regenerated README.json — then
archive this file and delete the TODO line.

## Log

- 2026-08-25 a — Thread picked up from TODO. Families re-measured on live D1;
  found the fourth family (2,382 `GitHub`-tag titles, best-of generated READMEs)
  beyond the TODO's three — same mechanism, included. Anchor shapes verified
  against upstream READMEs (themeselection, SerialLain3170/AwesomeAnimeResearch,
  lukasmasuch/best-of-crypto) and one live mirror JSON (161 `N.` titles in
  enhansome-Awesome-JavaScript-Libraries; dayjs item titled `15.`).
- 2026-08-25 b — **Fix landed.** Failing tests first (6-case `Degenerate titles`
  describe block: rank table, year/tag table, URL label ×2, tag word ×2, CJK
  keeps, image-only keeps repo name) — all 4 defect cases red for the right
  reason, then green. 3-hunk change in `markdown.ts` (predicates + `entryTitle`
  chain + table path). Goldens: 6 fixtures changed, every diff an intended
  retitle found in real corpus READMEs (php `Github`→`KnpLabs/php-github-api`,
  go `github`/`docs`→owner/name, flutter `2048`→`anuranBarman/2048`,
  link-headings `Home`→owner/name, details-cards `2023`/`2022`/`2024`→owner/name
  + tag echo dropped from descriptions, bare-links URLs→owner/name). Raw
  markdown goldens unchanged — titles are JSON-only. End-to-end: parsed the real
  themeselection upstream README through the offline stand-in — 208 items,
  **0 degenerate titles** (was 161), dayjs titled `Day.js` with description
  `Fast 2kB alternative to Moment.js with the same modern API. JavaScript`.
  `make ci` green (typecheck + build + 233 tests). Not pushed.
