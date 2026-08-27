# repo_info data quality — wrong fields, stale/NULL metadata, rename currency

**Status: fix implemented 2026-08-27 (this repo) — `metadata` now carries the
root as `original_repository_info` alone (`original_repository` and
`original_repository_id` deleted, breaking). NOT releasable until the webapp
reads `original_repository_info`: the daily mirror cron propagates the new
shape within a day of release, and the webapp fails every tree whose root id
it cannot resolve (full ingest outage). See log.**

## The defect (as suspected 2026-08-26 — see log for verdicts)

`toRepoInfo` (`packages/core/src/markdown.ts`) is the sole metadata source
for the whole catalog: stars, language, last_commit, archived, owner/name.
Observed failure classes, all served to end users as truth:

- **Wrong fields** — openinterpreter/openinterpreter served as `language:
  "Rust"` (Python in reality); moment/luxon as `JavaScript` (TypeScript);
  fish-shell surfaces under a Rust filter (C++).
- **Stale/suspect flags** — localstack (65,147★) and minio (61,378★) both
  serve `archived: 1`. Both were famously active as of the test date;
  unverified against live GitHub (the test barred web access).
- **NULL metadata = invisible** — repos with unfetched stars silently drop
  out of every `minStars` filter. Sharpest case: searching `joplin` with
  `minStars: 1000` returned zero rows while `get_repository_details` showed
  laurent22/joplin at 56,108★ — cause unclassified (NULL-stars row vs a
  rename twin vs something else). zadam/trilium carries no fetched metadata
  at all.
- **Rename currency** — mirror repo_info freezes pre-rename owner/name, so a
  moved project splits: `joplin/joplin` not found (only `laurent22/joplin`),
  `stoatchat/stoat` absent, `revoltchat/revolt` a zero-listing shell. The
  webapp's `github_id` merge resolves twins — but only once mirrors carry
  current names to merge on.

## Next step — diagnose before fixing

Each class implies a different repair, so classify first:

1. Pull the mirror JSON for two or three suspect registries (selfhosted;
   whichever carries localstack/minio/openinterpreter) and read what
   repo_info actually recorded for them — distinguishes field-choice (wrong
   value fetched/kept) from staleness (old snapshot) from fetch-failure
   (NULLs).
2. Two webapp D1 queries to pin the catalog-side symptoms (run from
   `../webapp`, read-only):
   - both joplin rows: `SELECT id, owner, name, stars, archived, github_id,
     fetched_at FROM repositories WHERE name = 'joplin' OR owner IN
     ('joplin','laurent22');`
   - the suspect archived set: `SELECT owner, name, stars, last_commit,
     archived FROM repositories WHERE archived = 1 AND stars > 50000;`

## Fix directions by class

- Field-choice → correct the source field selection in `toRepoInfo`.
- Staleness → mirror refresh policy/cadence for metadata independent of list
  content changes.
- Fetch-failure → completeness: retry/resolve so live repos never emit NULL
  stars/last_commit.
- Rename currency → refresh owner/name at enhance time (the numeric id is
  the stable key the webapp already merges on).

The webapp stays a pure consumer — no second fetcher there
(action-before-webapp, `../webapp/archive/indexer-perf.md` Decision 10).

## Verdicts and the real gap (2026-08-27 diagnosis)

Verified each class against live GitHub (`gh api repos/…`), the remote D1
catalog, and mirror JSON at the source. Numbers in the log below.

- **Wrong fields — NOT a defect.** Live GitHub itself reports
  `language: Rust` for openinterpreter and fish-shell, `JavaScript` for
  luxon. The mirror faithfully serves the API's `language` field; the test's
  priors were stale, not the data.
- **Stale/suspect flags — NOT a defect.** Live GitHub confirms
  `archived: true` for every suspect over 50k★ (localstack, minio, Flowise,
  gpt-engineer, maybe, get-shit-done, awesome-interview-questions,
  Best-websites, atom). Mirrors re-enhance daily (cron `20 15 * * *`),
  fetched_at within ~1 day of live.
- **NULL metadata hiding repos — NOT action data.** 0 of 222,516 catalog
  rows with NULL stars have a single listing; every listed item carries
  stars. The 21,988 NULL rows are orphans: root rows the webapp creates
  NULL by design (see real gap) + legacy id-less residue from pre-v1.8
  mirrors. The joplin `minStars:1000` zero-rows symptom no longer
  reproduces (same MCP query today returns laurent22/joplin at 56,108★) —
  test-day timing, before that mirror's ingest.
- **Rename currency — already correct.** `toRepoInfo` emits
  `data.owner.login`/`data.name` from the GET response, and GitHub follows
  renames: the trilium mirror's own JSON carries `TriliumNext/Trilium`
  (id 92111509) for every `zadam/trilium` link; `revoltchat/revolt` is in
  the catalog as `stoatchat/discussions`. The absent `stoatchat/stoat` is a
  hard 404 — the repo was deleted; dropping it is correct.

**The real gap — root repositories emit no metadata.** The mirror's
`metadata` carries only `original_repository` + `_id` + `_sha`; stars,
language, archived, last_commit for the root are fetched and discarded
(`getRepoId` does the full repo GET and keeps only the id,
`src/main.ts:56`). The webapp therefore inserts every registry root with
all-NULL metadata (`collectTreeRefs` builds the root ref with
`stars: null`), so all 2,295 registry roots are invisible to minStars/
language/archived filters downstream. Zero extra API calls needed — the
data is already in hand at emit time.

Secondary (webapp-side, hand over): ~22k orphan repositories rows with NULL
github_id/stars — legacy residue outside the id-keyed sync; prune there
after roots carry data.

## Log

- **2026-08-27** Diagnosis session. Live-API checks: 9 archived suspects all
  genuinely archived; 3 language suspects match live exactly. D1:
  `repositories` 222,516 rows / 21,988 NULL stars / 22,142 NULL id;
  NULL-with-occurrences = 0; orphan NULLs include every sampled registry
  root (awesome-tmux, awesome-java, go-recipes…). Mirror source check:
  enhansome-trilium README.json (enhanced 2026-08-26T16:35) lists
  `TriliumNext/Trilium` for zadam/trilium links. Mirror run log:
  `Target fetch: 144/147 repo-info ok` — all 3 skips are true 404s. Fix
  direction: emit the root's `RepoInfo` in metadata (data already fetched
  in `getRepoId`); awaiting go-ahead.
- **2026-08-27** Fix landed in-tree (failing test first: orchestrator
  metadata test). `getRepoId` replaced by `getRepoInfoOrNull` (same
  null-on-failure contract, full `RepoInfoDetails` — the data was already
  fetched and discarded); `JsonMetadata.original_repository_info:
  RepoInfo | null` (same shape as an item's `repo_info`). main.ts passes
  it through. Breaking export change: `getRepoId` deleted from
  @enhansome/core (no consumer outside main.ts).
- **2026-08-27** Follow-up (user decision, breaking ok): collapsed the
  redundant root fields. `original_repository` and `original_repository_id`
  deleted from `JsonMetadata`, `originalRepository` from `EnhanceOptions` /
  `processMarkdownContent` (title fallback now reads `info.repo`;
  `repoNameFromIdentifier` deleted with it). SHA kept — it is independent
  data (separate listCommits fetch, webapp provenance), not a projection of
  info. e2e assert updated to `original_repository_info.owner/repo` + stars.
  `make ci` + lint + `make e2e` (live, act) green; goldens regenerated
  (-2 metadata lines per fixture).
- **2026-08-27** BLOCKING handover created by the collapse. The webapp
  reads `metadata.original_repository_id` (`rootGithubIdFromMetadata`) and
  keys its GraphQL fallback on `metadata.original_repository`
  (`indexer.ts:1682-1687`); a tree with an unresolved root id fails loudly
  (`indexer.ts:604-611`). Both fields are gone from new mirror JSON, so
  release of this action → one daily cron cycle → every webapp tree fails.
  The webapp change (read `original_repository_info` for root id, owner,
  repo, stars in `rootGithubIdFromMetadata` + `collectTreeRefs`) MUST land
  before this repo's release. Then also: prune the ~22k NULL-github_id
  orphan rows outside the id-keyed sync.
