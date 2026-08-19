# TODO — open-work index (enhansome/action)

> **Work-tracking system: `TODO.md` (this file) → `progress/` → `archive/`** — a physical Kanban (same design as webapp).
> - **`TODO.md`** = the open-work INDEX (one line per thread). In-progress lines MUST carry a `→ progress/<slug>.md` pointer — added at task-start, by the task owner (rule ↓).
> - **`progress/<slug>.md`** = created ONLY when a task is picked up AND spans sessions / needs running state. Holds goal · current state · next step · append-only log. **A resuming session reads ONLY that file.** Authored to the task — no rigid template; let the shape emerge.
> - **`archive/`** = move the file there (verbatim) when done / killed / parked. Trivial one-shot completions → `archive/completed.md`.
>
> Trivial tasks skip `progress/` (TODO line → `archive/completed.md` on done). **One home per fact** — measured numbers and evidence live in the progress file that verified them; don't duplicate. Created 2026-08-17, seeded from the webapp indexer triage (`webapp/progress/indexer-perf.md`, log entry 2026-08-16e).

## P0 — critical path (gates webapp's index rebuild)

> **Both P0 steps are done and released** (`repo_info.id` in 1.7.1, tree-shape
> in 1.8.0 — verified live 2026-08-19, see `archive/tree-shape.md` and
> `archive/completed.md`). The path continues in `../webapp/TODO.md`: its
> registry-rebuild line (step 3) is unblocked — pick that up next.

## Later / parked

- [ ] **Per-README repo dedupe** — the same repo linked in multiple sections emits multiple items (snapmaker: 88 items / 36 distinct repos). Skipped in the tree-shape overhaul (user decision 2026-08-19): the webapp rebuild's global one-node-per-repo dedupe owns this (~62k dupe drops accepted there). Revisit only if mirrors should be dupe-free in themselves.
- [ ] **Non-repo resources in output (v2)** — YouTube/docs/app-site links produce nothing today; entire registries of them index as near-empty. Parked until webapp's v2 data model exists (webapp TODO "Index non-repo resources"); do not build the emission side before the consumer side wants it.
