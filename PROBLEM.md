# Design: reliable item-level registry/repository typing

_Status: **locked.** Decisions + build plan live in `PLAN.md`; this file is the
problem statement / rationale. Supersedes the repo-level meta/list classifier in
`FINDINGS.md`._

---

## 1. Problem

The enhansome domain is **three levels**:

```
meta-list   (sindresorhus/awesome)   = a registry OF registries
registry    (avelino/awesome-go)     = a registry OF repositories
repository  (gin-gonic/gin)          = a concrete project
```

The system is hard-wired to **two levels** (`registry_metadata` → `registry_repositories` → `repositories`, `migrations/0001_initial_schema.sql`). There is no registry→registry relationship anywhere.

Consequence: every linked GitHub repo is force-typed as a `repository`. The indexer (`src/lib/indexer.ts:731-751`) unconditionally turns every item that has `repo_info` into a `repositories` row, and silently drops items without one (`:733`). So if a meta-list is ever mirrored, its entries — which are themselves registries — land in the `repositories` table next to real projects. `avelino/awesome-go` would appear as a 130k-star "repository," double-typed (a registry in `registry_metadata`, a repository in `repositories`). This is silent, permanent corruption, and it is the *deterministic* outcome of mirroring any meta-list — independent of how good a classifier is.

### Two root causes

1. **Wrong unit of classification.** "Is this *repo* meta-or-list?" is unanswerable for mixed repos. `jbhuang0604/awesome-computer-vision` is simultaneously a registry *of repositories* (its Software/SLAM sections) and a registry *of registries* (its "Awesome Lists" section). No feature, threshold, or LLM cleanly bins a mixed repo — which is exactly why the `[0.54, 0.60]` boundary overlap (`FINDINGS.md` §4) was never going to be tuned away.

2. **Unreliable proxies.** `awesomeLinkFraction` is fuzzy because it asks a fuzzy question on the source repo. `topics`/`description`/name have poor coverage: our own data shows `topic:awesome-list` surfaces only ~1/4 of canonical metas (`FINDINGS.md` §9/§10.4). Name-matching is leaky (`FINDINGS.md` §6 baselines — `nameOnly` train F0.5 = 0.077).

---

## 2. Goals / non-goals

- **G1** Each *item* (link) in a registry is correctly typed as `repository` (concrete project) or `registry` (a reference to another list).
- **G2** Mixed repos are the normal case, handled without special-casing.
- **G3** Typing is reliable (ground-truth, not a proxy), deterministic, and injection-immune.
- **G4** No silent permanent corruption; residual errors are bounded, visible, and self-correcting.

**Non-goal:** a sharp repo-level meta/list classifier. That concept is dissolved. "Meta-ness" survives only as a *derived* property ("a registry whose items are mostly registries"), never as a type or a routing gate.

---

## 3. Core insight

**Move the link-density signal from the source repo to each target repo.**

On the source repo, link-density answers "is this meta or list?" — fuzzy, because mixed. On a target repo, the same signal answers "is *this target* itself a list, or a single project?" — clean, because atomic. The technique that was unreliable in `FINDINGS.md` becomes reliable purely by pointing it at a well-posed question.

This also means README-fetching (ground truth) is now justified: it is the same method that produced the gold labels (labelers judged by *reading* READMEs, `FINDINGS.md` §3), just applied per-target instead of per-source.

---

## 4. The typing definition

A linked repo is a **registry** iff our own enhancement parser, run on its README, yields **≥ K entries** (the same parser the action already uses to extract list items from an awesome-list). Otherwise it is a **repository** (a single project). **K is pinned at 20** (`REGISTRY_MIN_ENTRIES`, a code constant — not an action input); the count is of GitHub-linked list items specifically.

- Reuses the existing, trusted markdown parser (`action/src/markdown.ts`). The only new tunable is **K**.
- Self-consistent definition: *"a list is whatever we successfully parse as a list."* No invented heuristic to argue about.
- A "meta-list" is no longer a type — it is the derived property "a registry whose items are mostly registries."
- **Injection-immune:** classification counts entries; it does not interpret prose. Even reading an untrusted README (cf. the `0pandadev` injection, `FINDINGS.md` §8.5) cannot affect the result. Do **not** route classification through an LLM — that would reintroduce both cost and an injection surface for zero reliability gain over the parser.

---

## 5. Where classification lives

Split into the intrinsic signal (action) and the relational signal (indexer):

| Concern | Lives in | Why |
| --- | --- | --- |
| **Intrinsic** — "is this target itself a list?" | **Action**, per mirror | The action already makes a per-link `GET /repos` call (`action/src/github.ts:113`). Adding one README fetch + a parser pass per link is the marginal cost. Emits `kind` per item → `README.json` becomes self-describing. |
| **Relational** — "is this target one of *our* registries?" | **Indexer**, read-time | The action runs isolated inside one mirror and cannot see the other mirrors. "Do we mirror X?" is a global property only the webapp holds (`registry_metadata`). Structurally unavailable to the action. |

**Final type at index time:**

```
kind = registry   if  target README parses to ≥ K entries
                OR  target ∈ our mirrored-registry set   (membership backstop)
kind = repository otherwise
```

Membership is a **backstop**, not the primary signal: it catches lists whose README is too sparse/non-standard to parse (e.g. `public-apis`, `jnv/lists`) but that we nonetheless mirror. The action owns the reliable majority; the indexer owns the global minority the action cannot see.

### Review question Q1 (flagged)

Per-mirror fetching is **redundant**: `awesome-deep-vision`'s README gets fetched by every mirror that links it. Alternative: a dedicated, deduped **classification manifest** job that fetches each unique repo *once*, classifies, and persists; both the action and indexer consume it. Trades action-locality for dedupe + caching (a repo's list-ness rarely changes, so caching is high-value).

**Recommendation:** ship per-mirror first (simplest, matches "fix at source"), evolve to the manifest if/when API cost or staleness bites. The reviewer should pressure-test this sequencing.

---

## 6. Data model (additive)

New migration:

```sql
-- item-level typing on the existing junction
ALTER TABLE registry_repositories
  ADD COLUMN item_kind TEXT NOT NULL DEFAULT 'repository';   -- 'repository' | 'registry'
  -- optional: ADD COLUMN ref_registry_name TEXT;             -- resolved at index time

-- registry → registry edges (the missing third level)
CREATE TABLE registry_registry_links (
  parent_registry_name TEXT NOT NULL,
  child_registry_name  TEXT NOT NULL,   -- our registry_name if mirrored; else 'owner/repo'
  title                TEXT,
  mirrored             INTEGER NOT NULL DEFAULT 0,  -- 1 if child is one of our registries
  PRIMARY KEY (parent_registry_name, child_registry_name),
  FOREIGN KEY (parent_registry_name) REFERENCES registry_metadata(registry_name) ON DELETE CASCADE
);
```

- `repositories` table **unchanged**. Registry-refs are **never** inserted into `repositories`.
- `indexer.ts:collectRegistryData` branches on `item_kind`:
  - `repository` → `repositories` row + `registry_repositories` (today's behavior).
  - `registry` + membership hit → `registry_registry_links` edge, `mirrored=1`.
  - `registry` + no membership → `registry_registry_links` edge, `mirrored=0` (also a discovery signal — feed to `extract`).
- **Backward-compatible:** items without `kind` (old `README.json`) default to `'repository'` = today's exact behavior. No big-bang migration; re-running actions backfills `kind`.

---

## 7. Pipeline changes

```
search:awesome   ──find awesome-* repos──────────────────────┐
filter:awesome   ──worth-mirroring curation──────────────────┤
setup:batch      ──create enhansome-* mirror + action────────┤
                                                              ▼
action (per mirror, daily):
   enhance README  +  per-link README fetch → parser → kind  →  README.json
                                                              │
indexer (webapp):  load README.json ──branch on kind + membership──► D1
       repositories  /  registry_registry_links (mirrored | unmirrored→discovery)
                                                              │
extract:awesome  ◄── unmirrored registry-refs feed back as discovery candidates
```

- **`search:awesome`**: drop the meta/list classifier and the routed `meta.txt`/`lists.txt`/`other.txt` files. It finds awesome-* repos, full stop. (A loose "is this worth mirroring" *curation* filter may stay — but it is not a type gate and its precision no longer matters for correctness.)
- **`extract:awesome`**: demoted from a correctness-routing stage to **pure discovery** — harvest registry-refs (post-index) as mirror candidates. Out of the critical path.
- **`filter:awesome` / `setup:batch`**: unchanged.
- **Action**: gains the per-link README fetch + parser-based `kind` emission (§5).
- **Indexer**: branches on `kind` + applies the membership backstop (§5).

---

## 8. Failure modes & limitations (honest)

- **API cost.** A per-link README fetch ~doubles the action's per-link calls and is heavier than `/repos` JSON. Bounded per-run (one mirror per workflow), and the retry/throttle plugins (`action/src/github.ts:14`) already exist. Mitigated further by the manifest dedupe (Q1) and caching (a repo's list-ness is stable).
- **Unmirrored registries.** A registry-ref whose target we don't mirror → recorded as `mirrored=0`, surfaced as a discovery candidate. Not corrupted. Self-corrects to `mirrored=1` the next index pass after we mirror it.
- **Non-GitHub entries** (books/papers/courses): no README → not typed → out of scope (dropped, as today).
- **K threshold.** The one tunable. Set conservatively. False positives (a project with a long "related projects" section mistyped as a registry) are low-harm; false negatives (small legit lists) are caught by the membership backstop if mirrored.
- **Churn.** Target READMEs change; re-classify each action run, or cache via the manifest.
- **Fetch failures** (404/private/rate-limited): **non-fatal for targets.** A fetch failure on a linked target (`/repos` **or** README) is skipped with a warning; the item is still emitted (no `repo_info`, `kind` defaults to `repository`), and the run continues. Endemic dead links must not break daily mirrors. Only the *source* README fetch is fatal. See `PLAN.md` §6 (D7).

---

## 9. Why this resolves the original concerns

- **"Registries in meta-lists treated as repos"** → solved: a meta-list's registry-entries become `registry_registry_links` edges, not `repositories` rows.
- **"Boundary overlap [0.54, 0.60] is unavoidable"** → dissolved: there is no repo-level boundary. Typing is per-item from ground truth.
- **Mixed repos (`jbhuang0604`)** → the normal case: it indexes as one registry containing both registry-refs (its "Awesome Lists" section) and repositories (its Software section). No conflict.
- **The tuning apparatus** (`best-config.json`, FLOOR sweep, F0.5) → no longer a correctness artifact. The meta/list classifier it tuned is removed. At most a loose curation filter remains.

---

## 10. Open questions for review

> **All resolved** — see `PLAN.md` §10 (Resolved decisions) and §3 (Locked
> decisions D1–D10). The action-scope items (1, 2, 6) are locked; items 3–5 are
> webapp-side and out of scope for the action half.

1. **Per-mirror vs deduped-manifest classification (§5/Q1)?** Cost/simplicity tradeoff — the most important call to pressure-test.
2. **K threshold** value, and whether to weight by entry-count, link-density, or both.
3. **Curation:** keep any repo-level "should we mirror" filter, or mirror everything `filter` passes?
4. **UI rendering** of registry-refs: mirrored → clickable card to the registry page; unmirrored → ? (link out / "not yet mirrored" / hide).
5. **Discovery loop:** should `extract` harvest registry-refs from *all* indexed registries (post-index), or stay a separate search-time pass?
6. **Action coupling:** emitting `kind` bakes enhansome domain semantics into the action. Acceptable (it is already enhansome-branded), but the reviewer should confirm the action is not expected to stay a generic markdown enhancer.
