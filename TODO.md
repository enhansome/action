# TODO — open-work index (enhansome/action)

> **Work-tracking system: `TODO.md` (this file) → `progress/` → `archive/`** — a physical Kanban (same design as webapp).
> - **`TODO.md`** = the open-work INDEX (one line per thread). In-progress lines MUST carry a `→ progress/<slug>.md` pointer — added at task-start, by the task owner (rule ↓).
> - **`progress/<slug>.md`** = created ONLY when a task is picked up AND spans sessions / needs running state. Holds goal · current state · next step · append-only log. **A resuming session reads ONLY that file.** Authored to the task — no rigid template; let the shape emerge.
> - **`archive/`** = move the file there (verbatim) when done / killed / parked. Trivial one-shot completions → `archive/completed.md`.
>
> Trivial tasks skip `progress/` (TODO line → `archive/completed.md` on done). **One home per fact** — measured numbers and evidence live in the progress file that verified them; don't duplicate. Created 2026-08-17, seeded from the webapp indexer triage (`webapp/progress/indexer-perf.md`, log entry 2026-08-16e).

## P0 — critical path (gates webapp's index rebuild)

> **Both P0 steps are done and released in 1.8.0** (`repo_info.id` + tree-shape
> — verified live 2026-08-19, see `archive/tree-shape.md` and
> `archive/completed.md`). The path continues in `../webapp/TODO.md`: its
> registry-rebuild line (step 3) is unblocked — pick that up next.

## Later / parked

- [ ] **Empty-tree parses — registries whose README yields zero items** — 413 of 2,295 enhansomed registries ingest as root-only trees (webapp mirror 2026-08-23, drifted from 403 on 08-22); e.g. `java` (awesome-java) parses to nothing while its README has list content. The action currently emits an empty `items: []` tree and exits clean, so the webapp pipeline counts it "succeeded" (its `ingest_log` records `warn / no-items`, nothing fails). Surfaced as webapp mcp-prod-health issue 2.1 — the eval's worst failure mode (a registry served as success-shaped empty). Webapp adds the regression gate (pipeline red when a registry that HAD repos goes empty); fixing the STOCK is action-side: per-parser investigation of why list content produces no items, starting with `java`.
- [ ] **Per-README repo dedupe** — the same repo linked in multiple sections emits multiple items (snapmaker: 88 items / 36 distinct repos). Skipped in the tree-shape overhaul (user decision 2026-08-19): the webapp rebuild's global one-node-per-repo dedupe owns this (~62k dupe drops accepted there). Revisit only if mirrors should be dupe-free in themselves.
- [ ] **Non-repo resources in output (v2)** — YouTube/docs/app-site links produce nothing today; entire registries of them index as near-empty. Parked until webapp's v2 data model exists (webapp TODO "Index non-repo resources"); do not build the emission side before the consumer side wants it.
