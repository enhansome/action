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

- [ ] **Empty-tree parses — parser yield fixes** → `progress/empty-tree-parses.md` — the parser captures only 77.8% of distinct GitHub repos linked across the fleet (65,234 land in no tree; 336 registries parse to `items: []` and still report success — webapp mcp-prod-health 2.1, `java` = upstream card-format switch 2026-07-28). **Diagnosis complete (2026-08-24): 8 root causes, all traced to specific parser rules; plan approved by user — steps 0–8 in the progress file (0 = yield harness, then minLinks-per-section, implicit sections, tables, paragraph entries, blockquote cards, link-headings, own-link scope, URL normalization). Steps 0–2 landed 2026-08-24 (harness validated vs ad-hoc baseline; per-section gate 83.1%→85.8%; implicit Overview sections →86.3%, hollow stock 336→302, `termux-hacking` 0→352/354; goldens additive only). Next = step 3 (tables).**
- [ ] **Per-README repo dedupe** — the same repo linked in multiple sections emits multiple items (snapmaker: 88 items / 36 distinct repos). Skipped in the tree-shape overhaul (user decision 2026-08-19): the webapp rebuild's global one-node-per-repo dedupe owns this (~62k dupe drops accepted there). Revisit only if mirrors should be dupe-free in themselves.
- [ ] **Non-repo resources in output (v2)** — YouTube/docs/app-site links produce nothing today; entire registries of them index as near-empty. Parked until webapp's v2 data model exists (webapp TODO "Index non-repo resources"); do not build the emission side before the consumer side wants it.
