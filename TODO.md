# TODO — open-work index (enhansome/action)

> **Work-tracking system: `TODO.md` (this file) → `progress/` → `archive/`** — a physical Kanban (same design as webapp).
> - **`TODO.md`** = the open-work INDEX (one line per thread). In-progress lines MUST carry a `→ progress/<slug>.md` pointer — added at task-start, by the task owner (rule ↓).
> - **`progress/<slug>.md`** = created ONLY when a task is picked up AND spans sessions / needs running state. Holds goal · current state · next step · append-only log. **A resuming session reads ONLY that file.** Authored to the task — no rigid template; let the shape emerge.
> - **`archive/`** = move the file there (verbatim) when done / killed / parked. Trivial one-shot completions → `archive/completed.md`.
>
> Trivial tasks skip `progress/` (TODO line → `archive/completed.md` on done). **One home per fact** — measured numbers and evidence live in the progress file that verified them; don't duplicate. Created 2026-08-17, seeded from the webapp indexer triage (`webapp/progress/indexer-perf.md`, log entry 2026-08-16e).

## P0 — critical path (pick in listed order; both gate webapp's index rebuild)

> **Fresh session:** pick the FIRST unchecked line below; when both are done,
> released, and cron-verified (see each item's progress file), archive them and
> switch to `../webapp/TODO.md` — its registry-rebuild line (step 3 of this
> path) unblocks.

- [ ] **Emit numeric GitHub `id` in `repo_info`** [P0 · 1st] — `toRepoInfo`
  (`packages/core/src/github.ts`) already receives the numeric id from
  `rest.repos.get` and drops it. Add the field + test; ships in the next
  release-please cycle. This is what lets webapp get `gh-{id}` node ids
  straight from mirrors and retire its scratch-map bridge. Trivial — do it
  first so it's never blocked behind the big change below.
- [ ] **README.json tree-shape overhaul** [P0 · 2nd] [NEXT] → `progress/tree-shape.md` — the parser destroys document structure and loses repos: all H2–H6 flattened to one level (`markdown.ts:693`), link-headings (`#### [Repo](github…)`) become empty section titles instead of items, empty sections emitted (47% of indexed groups are empty noise), dead links emitted. Measured: `awesome-snapmaker` 44 GitHub links → **0 items**; `awesome-machine-learning` → 25 identical sibling sections; DB-wide 935 same-parent-same-title clusters. Fix = nested sections by heading depth, link-headings → items, no empty sections, no dead links, contract + goldens in the same release. **Blocks webapp's schema-reset step** (user ordering decision 2026-08-17: action first).

## Later / parked

- [ ] **Non-repo resources in output (v2)** — YouTube/docs/app-site links produce nothing today; entire registries of them index as near-empty. Parked until webapp's v2 data model exists (webapp TODO "Index non-repo resources"); do not build the emission side before the consumer side wants it.
