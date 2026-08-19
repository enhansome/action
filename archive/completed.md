# Completed — trivial one-shots

- **2026-08-19 · Emit numeric GitHub `id` in `repo_info`** — `RepoInfoDetails.id`
  + passthrough in `getRepoInfo` (`packages/core/src/github.ts`; the id was
  already fetched by `rest.repos.get` and dropped), `RepoInfo.id` + passthrough
  in `toRepoInfo` (`packages/core/src/markdown.ts`). Test-first: mapping tests
  extended before the fix. Goldens regenerated and the diff verified line-by-line
  — all 17,303 added lines are `"id": <n>` inside `repo_info`, nothing else
  moved. Ships in the next release-please cycle; post-cron check: `repo_info.id`
  present on mirror items after the 04:54 UTC pass. Unlocks webapp's `gh-{id}`
  node ids straight from mirrors (retires its scratch-map bridge).
