# Plan: item-level registry/repository typing in the action

_Status: **implemented** (steps 0–9 + 11 complete; step 10 optional/skipped). **D7 later revised** from strict-fatal to non-fatal-for-targets (see §6) — verified against `jbhuang0604/awesome-computer-vision` (`src/live.test.ts`). Track via the checkboxes in §8._
_Scope: **this repo only** (`enhansome/action`). The webapp/indexer is out of scope — it depends on this action, not the reverse. No breaking-change constraint (pre-users)._

> Companion to `PROBLEM.md` (the problem statement). This file is the decisions + build plan.

---

## 1. Context

The enhansome domain is three levels: **meta-list** (registry of registries) → **registry** (registry of repositories) → **repository** (concrete project). The system was hard-wired to two levels, so every linked GitHub repo gets force-typed as a `repository`. Mirroring a meta-list therefore lands registries in the `repositories` table next to real projects — silent, permanent corruption (e.g. `avelino/awesome-go` would appear as a 130k-star "repository"). See `PROBLEM.md` §1.

The fix lives in two places: the **action** emits each node's intrinsic kind; the **webapp** applies a membership backstop at index time. This plan covers the action half only.

---

## 2. The model (north star)

Model GitHub as a **graph of registries (directories) and repositories (files)**:

- Every node has **exactly one intrinsic kind**: `registry` (a directory — exists to enable discovery) or `repository` (a file — a terminal, consumable project).
- Every entry in a registry is typed **independently**. A registry may contain registries, repositories, or both. One entry's type never affects another's.
- Discovery = traversing registries. Nesting depth is unbounded.
- **Enhansome-awareness (do we mirror it?) is orthogonal to type** — it affects navigation, not what a node *is*.
- Registries are never stored as repositories.

Everything below follows from this. The hard part is not the model — it's *reliably assigning* the kind.

---

## 3. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Oracle is GitHub-only.** A target is a `registry` iff its README has ≥ **K** list items that each bear a `github.com/owner/repo` link; else `repository`. | Measures the defining property of a registry (it catalogs projects), not a proxy. GitHub-only by explicit choice. |
| D2 | **K = 20**, as a named **constant** (no action input). | Calibrated from data — see §4. Pinned, not per-mirror tunable. |
| D3 | **Per-mirror re-derivation.** No shared classification cache/manifest. Each action run fetches every linked target's README and classifies. | Simplest; matches "fix at source." Accepted cost. |
| D4 | **Action emits intrinsic kind only.** No `mirrored`/membership field — that's relational and webapp-owned (the action is per-mirror isolated and can't see other mirrors). | Orthogonality (model §2). |
| D5 | **The source document is also a node** and carries a kind (in `metadata`). | "Every node has a kind" — the root included. Free: source README is already in hand. |
| D6 | **`kind` is required on every emitted node** (`JsonItem` and `JsonMetadata` via a shared `JsonNode` base). | Honors "every node has exactly one kind." A target that can't be classified (dead README) is still emitted, with `kind` defaulting to `repository` — never omitted. |
| D7 | **Non-fatal dead-target handling** _(revised; was strict-fatal)_. A fetch failure on a linked target — `/repos` **or** README, 404/410/401/403/throttle-exhausted/5xx/network — is skipped (warning); the item is still emitted (no `repo_info`, `kind` defaults `repository`) and the run continues. Only the **source** README fetch is fatal (nothing to enhance without it). | Real awesome-lists carry endemic dead links; failing the run on the first one made daily mirrors unusable. Degradation is preferable; the webapp membership backstop (§5) recovers any registry mistyped by the default. `getRepoInfo`/`getReadme` still throw — the **pools** (`fetchAllRepoInfo`/`fetchAllKinds`) catch per-target. |
| D8 | **Throttle + retry are already wired** (`@octokit/plugin-throttling`, `@octokit/plugin-retry`). The kind-fetch reuses the existing shared throttled client. | No new plugin; just more calls through the existing throttle. |
| D9 | **Non-GitHub entries are dropped** from the typed graph (books/papers/courses). Every emitted `JsonItem` is a GitHub node. | Required-kind (D6) only holds if every emitted item has a GitHub kind. Preserving them is a future enhancement (§11). |
| D10 | **No `entries` count** is emitted — bare `kind` only. | Add later, additively, if K re-tuning without re-fetch is ever needed. |

---

## 4. The oracle and K (calibrated)

**`countListEntries(tree)`**: visit every `listItem`; count those whose subtree contains ≥1 link whose URL passes `parseGitHubUrl` (`github.ts:227` — `hostname === 'github.com'`, ≥2 path parts). Read-only (do **not** reuse `processListRecursively` — it mutates/sorts). This matches the existing `findFirstGitHubLink`/`collectGitHubLinks` semantics (`markdown.ts:262`, `:289`).

**`kind = countListEntries(targetReadme) ≥ 20 ? "registry" : "repository"`.**

### Calibration data (real READMEs)

- **Known registries** (60 fixtures in `src/fixtures/original/`): `userscripts`=0, `complex`=7, `free-for-dev`=13, `falsehood`=19, `unity`=19, `engineering-team-management`=22 … median 112, max 2570 (`go`).
- **Concrete projects** (28 fetched): max **17** (`chalk`), p90 = 5, median 1. Next-highest: `vscode`=11.

Projects never exceed 17; registries (bulk) start at ~18. **K=20** sits just above `chalk`(17) with margin. The contested band `[7,17]` is interleaved (`complex`=7 reg < `vscode`=11 proj < `free-for-dev`=13 reg < `chalk`=17 proj) — no threshold separates it perfectly; 20 sits above it so the action's emitted kind is trustworthy standalone, and the webapp backstop owns the long tail.

### Accepted blind spot (consequence of D1, GitHub-only)

Registries whose entries are mostly **non-GitHub** links are structurally invisible to the oracle at any K: `userscripts`=0 (greasyfork links), `free-for-dev`=13 (SaaS links). These are typed `repository` by the action. The webapp membership backstop recovers the ones we mirror. This is the accepted cost of GitHub-only.

### Re-calibration

The throwaway script was deleted. To re-calibrate, recreate `scripts/calibrate-k.mjs`: import `parseGitHubUrl`, parse each fixture + a sample of project READMEs with `unified().use(remarkParse).use(remarkGfm)`, count list items with a github-link descendant, print the distribution. (Optional task §8.10.)

---

## 5. Final JSON schema

One structural change: a shared `JsonNode` base. `kind` is **required** on both node types. `JsonSection` does **not** extend `JsonNode` (a section is a category heading, not a GitHub node — it has no kind).

```ts
interface RepoInfo {
  archived: boolean;
  language: null | string;
  last_commit: null | string;
  owner: string;
  repo: string;
  stars: number;
}

interface JsonNode {
  kind: "registry" | "repository";
  title: string;
}

interface JsonItem extends JsonNode {
  children: JsonItem[];
  description: null | string;
  repo_info?: RepoInfo;
}

interface JsonMetadata extends JsonNode {
  enhanced_repository: null | string;
  enhanced_repository_description: null | string;
  last_updated: string;
  original_repository: string;
  original_repository_sha: null | string;
}

interface JsonSection {          // unchanged shape — NOT a node
  description: null | string;
  items: JsonItem[];
  title: string;
}

interface JsonOutput {
  items: JsonSection[];
  metadata: JsonMetadata;
}
```

`kind` is a bare enum — **no `entries` count is emitted** (can be added later, additively, if K re-tuning without re-fetch is ever needed).

---

## 6. Failure handling (non-fatal targets — D7, revised)

**Rule: a dead/inaccessible *target* link degrades; only the *source* README fetch fails the run.**

- **Target links (`/repos` and per-target README): non-fatal.** `getRepoInfo`/`getReadme` throw as before, but `fetchAllRepoInfo`/`fetchAllKinds` (`markdown.ts`) wrap each call in a per-URL `try/catch`: on failure they `core.warning(...)` and skip — the URL is absent from the map. Downstream, a skipped target's item is still emitted (`processListRecursively`): with no `repo_info`, and `kind = kindsMap.get(url) ?? 'repository'`. The run continues.
- **Source README (`main.ts`): fatal.** `getReadme` throws → the top-level catch (`main.ts` ~`:119`) → `core.setFailed`. There is nothing to enhance without the source README.

Why revised (was strict-fatal): mirroring real awesome-lists hits endemic dead links on the first run (verified: a full `enhance()` over `jbhuang0604/awesome-computer-vision` failed within ~1s on a dead `/repos` 404 under strict mode). Failing the whole daily run on one dead link is operationally untenable. Skipping + defaulting loses nothing the webapp backstop can't recover.

Semantics unchanged:
- Definitive errors (`404/401/403/422`) throw immediately (`doNotRetry` at `github.ts:84`) — now caught per-target.
- Rate limits (`403/429`) are retried by the throttle plugin; they throw only after exhaustion (`MAX_RETRIES=3`, 300s cap) — now caught per-target.
- Verified live: after the change, the full `awesome-computer-vision` run succeeds (33 sections, 72 items, 70 with `repo_info` → 2 dead links degraded).

---

## 7. Key files

| File | What | Relevant lines |
|---|---|---|
| `src/markdown.ts` | parser + JSON builder | `JsonOutput`:21, `JsonItem`:45-57, `JsonMetadata`:59-66, `JsonSection`:68-72, `fetchAllRepoInfo`:79-123, `processMarkdownContent`:125, `collectGitHubLinks`:262, `findFirstGitHubLink`:289, `processListRecursively`:348 |
| `src/github.ts` | octokit + fetchers | `HardenedOctokit`(retry+throttle):14, `makeOctokit`:79, `getRepoInfo`:106 (catch:124), `getReadme`:139 (catch:155), throttle cfg:87-90, `parseGitHubUrl`:227 |
| `src/orchestrator.ts` | `enhance()` entry | :28 |
| `src/main.ts` | action entry | source `getReadme`:50, `enhance` call:72, JSON write:103, top-level catch:119 |
| `src/markdown.test.ts` | existing tests | `fetchAllRepoInfo` "continue on failure" test:126-153 (must change under D7); fixture tests mock `getRepoInfo` but **not** `getReadme` (must add when classification lands) |
| `action.yml` | action inputs | no change (K is a code constant, not an input) |
| `src/fixtures/original/*.md` | 60 real awesome-list READMEs (calibration corpus + test fixtures) | — |

---

## 8. Build plan (TDD, red→green; check off as you go)

- [x] **0. Schema refactor (no behavior change).** Extract `RepoInfo` and `JsonNode`; make `JsonItem` and `JsonMetadata` `extends JsonNode`. `JsonSection` stays as-is. Update any code referencing the old inline shapes. `npm run typecheck`.
- [x] **1. `countListEntries(tree): number`** (pure, read-only, in `markdown.ts`). Export it. **Tests first** against known fixture counts: `go`→2570, `free-for-dev`→13, `complex`→7, `userscripts`→0. _(Verified counts match the deleted calib script exactly once the test uses the real `parseGitHubUrl` — see test note on mock contamination.)_
- [x] **2. `classifyKind(octokit, owner, repo, minEntries): { kind, entries }`** wrapping `getReadme` + `countListEntries` + threshold. **Tests** with `getReadme` mocked: a README with ≥20 github-linked list items → `registry`; a project README → `repository`. (Returns entries internally; only `kind` is emitted.)
- [x] **3. `fetchAllKinds(urls, token, minEntries): Map<url, kind>`** — mirror `fetchAllRepoInfo` (shared throttled octokit, concurrency 10). **Tests** mirror the `fetchAllRepoInfo` concurrency tests.
- [x] **4. Strict failure mode (D7).** Remove `try/catch→null` in **both** `getRepoInfo` (`/repos`) and `getReadme` (README); remove the per-URL catch in `fetchAllRepoInfo`. Strict applies to both fetch paths. **Update the existing "continue on failure" test** (`markdown.test.ts:126`) — it now asserts propagation, not continuation. _(Also removed the now-dead `if (readme === null)` branch in `main.ts` + updated `main.test.ts`/`github.test.ts` for the throwing signatures — wider blast radius than §6 implied.)_ **↺ Reversed later:** D7 is now non-fatal for target links (§6); the pool tests were flipped back to assert skip-and-continue.
- [x] **5. Wire classification into `enhance()`.** Stamp `metadata.kind` from `countListEntries(tree)` and each GitHub-linked item's `kind` from `fetchAllKinds`, threaded into `processTree`/`processListRecursively` alongside `repoInfoMap` (kept `processMarkdownContent`'s fetching at the orchestration level). Key items by their first github URL (`findFirstGitHubLink`).
- [x] **6. Update existing fixture tests.** `processMarkdownContent` (via `enhance`) now calls `getReadme` per item; `getReadme` is mocked in every `enhance`/`processMarkdownContent` `beforeEach` that emits GitHub items (minimal README → `repository`).
- [x] **7. Drop non-GitHub entries (D9).** In `processListRecursively`, GitHub-linked items enter the typed JSON graph; non-GitHub entries are kept in the enhanced markdown (`processedItems`) but omitted from `jsonData`. `// TODO(future)` left at the drop site. Dropped the non-GitHub assertions from `expected-items.json` (`guides` ×2, `R`/RStudio) + rewrote the link-less-note orchestrator test.
- [x] **8. Pin K = 20 (D2).** `REGISTRY_MIN_ENTRIES = 20` defined in `markdown.ts`; documented in `README.md`.
- [x] **9. Kind fixtures/tests.** Added `kind-registry.md` (25 items → `registry`) + `kind-repository.md` (project → `repository`) target fixtures; `classifyKind` fixture tests + an `enhance()` integration test asserting `metadata.kind` (source) and per-item `kind` (targets).
- [ ] **10. (Optional) Commit `scripts/calibrate-k.mjs`** for re-calibration as READMEs drift. _(Skipped — optional.)_
- [x] **11. Docs.** Updated `README.md` (Item kinds section), `PROBLEM.md` (locked status, K=20, strict failure mode, resolved Qs). `PLAN.md` §4 calibration re-verified correct.

Run gates after each step: `npm run typecheck && npm test && npm run lint`.

---

## 9. Accepted risks / tradeoffs

1. **Endemic dead links → degraded, not fatal** _(resolved; was a strict-mode risk)_. Dead target links are skipped + defaulted to `repository` (D7 revised); the run succeeds. A few items may carry no `repo_info` or a defaulted kind until pruned via `find_and_replace` / upstream PRs.
2. **GitHub-only blind spot → registries of non-GitHub links mistyped `repository`.** Accepted (D1). Webapp backstop recovers mirrored ones.
3. **Per-mirror re-derivation cost ≈ 2× per-link calls, heavier README payloads.** Accepted (D3). Throttle plugin handles rate limits; concurrency 10 (`markdown.ts:85`) may need tuning for big lists — watch it.
4. **False-positive ceiling = projects with big endorsement lists** (`chalk`=17). Low-harm: a project mistyped `registry` becomes a discovery candidate, not a `repositories` row — no corruption, reversible.

---

## 10. Resolved decisions

All four open items resolved:

- **Non-GitHub entries → dropped** (D9). Every emitted `JsonItem` is a typed GitHub node → required-kind holds. Preserving them is a future enhancement (§11).
- **K = 20, hardcoded constant** (D2). No action input.
- **Target-link failures non-fatal** (D7, revised). A dead target is skipped + defaulted to `repository`; only the source README fetch is fatal. (Was strict-fatal; reversed after a real run on `awesome-computer-vision` failed in ~1s on a dead `/repos`.)
- **No `entries` field** (D10). Bare `kind` only.

---

## 11. Future enhancements

- **Preserve non-GitHub entries** (books/papers/courses) currently dropped (D9) — e.g. a separate `links`/`other` array, or a non-GitHub item shape. TODO marker left at the drop site (task 7).
- **Emit `entries`** alongside `kind` if K re-tuning without re-fetch becomes desirable (additive, non-breaking).
- **Shared/deduped classification manifest** (`PROBLEM.md` §5 Q1) if per-mirror re-derivation cost or staleness bites.
- ~~Relax strict mode (drop+log on 404 instead of fatal)~~ — **done** (D7 revised, §6).
