# repo_info data quality — wrong fields, stale/NULL metadata, rename currency

**Status: open — not picked up. Found in the 2026-08-26 webapp MCP capability
test (20 questions, fresh subagents barred from web/local files). The webapp
ingest consumes mirror JSON verbatim and never fetches — every metadata
defect below originates in what this repo's enhancer emits.**

## The defect

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
