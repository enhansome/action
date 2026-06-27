# PLAN: Fetch source list in-action + Octokit + optional commit

**Source of truth for a multi-session implementation.** Each phase is executed in
its own fresh session. Read this whole file first, do the named phase, update the
**Status ledger** below when it merges, then stop.

Discipline for editors of this file: reference **symbols** (`getRepoInfo` in
`src/github.ts`), not line numbers — they rot. State **contracts/signatures**, not
pasted code. The decisions in **Settled decisions** are closed; do not reopen them.

---

## Status ledger

Tick a phase only when it is merged to `main` and green on `make test` + `make e2e`.

- [x] **Phase 0** — Bump all deps to latest; repair eslint/vitest after the upgrade
- [x] **Phase 1** — Swap axios → Octokit (implemented; green on `make ci`, e2e pending)
- [x] **Phase 2** — Add `getReadme` + `parseOwnerRepo` (implemented; green on `make ci`)
- [x] **Phase 3** — Wire fetch mode into `main.ts` (**green on `make ci` + `make e2e`**). **Amended (no backward compatibility):** fetch is the *only* mode — `original_repository` is required (D4 superseded); the dead `isChanged` changed-only-write flag was removed end-to-end; the source commit SHA is recorded as `metadata.original_repository_sha`; and `metadata.source_repository*` was **renamed to `enhanced_repository` / `enhanced_repository_description`** (the publishing repo, auto-derived from `github.context`; distinct from the upstream `original_repository`).
- [x] **Phase 4** — Commit inside the action (**as-built deviates from the original
  contract**): uses `stefanzweifel/git-auto-commit-action@v7` as a nested composite
  step rather than a hand-rolled bash/Node committer; gated by a single new boolean
  input `auto_commit` (**default `true`** — opt-*out*, reversing D2's opt-in default);
  message/identity are hardcoded. Green on `make test` (110, unchanged — YAML-only)
  **and `make e2e`** (act/Docker; the nested `git-auto-commit-action@v7` resolves and
  is correctly skipped under the e2e's `auto_commit: false`).
- [x] **Phase 5** — Docs, e2e simplification, consumer migration. **e2e simplification
  DONE** earlier (job is `checkout → action → assert`, asserts the SHA). README
  rewritten to `checkout → action`, Inputs table updated (`original_repository`
  required, `auto_commit` added, `markdown_file` = output path), "thin action" reworded
  to "self-contained", and a **Migrating from the submodule model** section added
  (covers D3 `relative_link_prefix`). Remaining: **release** (lands as `feat:` via
  release-please on merge to `main`).

When picking up a session: do the **first unchecked** phase. Phases are ordered;
1 unlocks 2; 3/4 are independent features atop 2; 5 is docs/migration last.

---

## Context primer (for a cold session)

`enhansome/action` is a **composite GitHub Action** that enhances an "awesome list"
markdown file with GitHub repo metadata (⭐ stars, 🐛 issues, 🌐 language, 📅 last
push) and emits a structured `README.json`. Private-use, for the `enhansome` org's
enhanced-list repos.

Relevant code:

- `src/main.ts` — the I/O boundary / orchestrator entrypoint. Reads inputs via
  `@actions/core`, reads the markdown file, calls the pure `enhance()`, writes the
  markdown back (only when changed) and the JSON output.
- `src/orchestrator.ts` — `enhance(...)`, a **pure transform** on a content string.
  Keep it pure; all network/disk I/O stays in `main.ts`.
- `src/github.ts` — GitHub API client. Today: `getRepoInfo(owner, repo, token)`
  (axios against `https://api.github.com`, hand-rolled retry honoring `Retry-After`
  / `x-ratelimit-*`, anonymous fallback when `token` is empty) and `parseGitHubUrl`.
- `src/markdown.ts` — markdown transform internals; `fetchAllRepoInfo` fans out
  metadata calls (concurrency-limited to 10) and writes `metadata.original_repository`
  into the JSON.
- Tests: `src/github.test.ts`, `src/markdown.test.ts`, `src/orchestrator.test.ts`
  (vitest; hermetic; today mocks the API via `axios-mock-adapter`).
- `action.yml` — composite action: setup-node, cache, build, then runs
  `dist/main.js`. Inputs include `github_token`, `markdown_file`,
  `working_directory`, `json_output_file`, `sort_by`, `relative_link_prefix`,
  `original_repository` (today metadata-only).
- `.github/workflows/test.yml` — `unit` job (hermetic vitest + tsc) and `e2e` job
  (drives the full composition; anonymous; runnable via `make e2e` under `act`).
- Releases: release-please on `main`, Conventional Commits. `feat:` ⇒ minor.

Dev commands: `make test` (vitest), `make e2e` (integration under `act`),
`make ci` (vitest + tsc).

---

## The change, in one paragraph

Today each consumer repo embeds the source awesome-list as a **git submodule** and
runs a ~12-line `fetch / resolve-default-branch / pull / rsync` shell ritual to copy
the source `README.md` before calling the action, deriving `original_repository` by
`sed`-parsing the remote URL. The action already holds a `github_token` and an
authenticated API client. So: **let the action fetch the source README itself via
one API call**, keyed off the already-existing `original_repository` input, and
**optionally commit** the result. Consumer workflows collapse to
`checkout → action [→ commit]`. No submodule, no clone, no shell.

Target consumer workflow:

```yaml
permissions:
  contents: write
steps:
  - uses: actions/checkout@v7
  - uses: enhansome/action@v1
    with:
      github_token: ${{ secrets.GITHUB_TOKEN }}
      original_repository: <owner>/<repo>   # action fetches source README + enhances
      sort_by: stars
      commit_message: 'docs(enhance): ✨ Auto-update list with latest content & stars'
```

---

## Settled decisions (do not reopen)

- **D0 — Mechanism: API fetch, not git clone.** The action fetches the source
  README with a single GitHub API call (`GET /repos/{owner}/{repo}/readme`, raw
  media type), reusing the existing client. No `git clone`, no submodule, no new
  subprocess/network dependency class. (This is design "B"; design "A" proposed a
  clone and is rejected — heavier, new failure surface, muddled auth story.)
- **D1 — Octokit + throttling plugin.** Replace axios with Octokit (already bundled
  via `@actions/github`) plus `@octokit/plugin-throttling` and
  `@octokit/plugin-retry`. **Delete** the hand-rolled retry loop in `getRepoInfo`;
  the throttling plugin's `onRateLimit` / `onSecondaryRateLimit` is the battle-tested
  version of that logic and honors `Retry-After` automatically. Preserve the intent
  of the existing `MAX_WAIT_TIME_SECONDS` cap by bounding retries.
- **D2 — Commit is opt-in, gated by input.** ~~The action commits/pushes **only** when
  `commit_message` is non-empty. Empty ⇒ today's no-side-effect behavior. Committing
  is never unconditional.~~ **SUPERSEDED (Phase 4):** committing is gated by a single
  boolean `auto_commit` that **defaults to `true`** (opt-out), since the action's only
  purpose now is publishing enhanced lists; the implementation reuses
  `stefanzweifel/git-auto-commit-action@v7` rather than `commit_message`. The
  loop-safety claim still holds: a `GITHUB_TOKEN`-authored push does not re-trigger
  workflows, so this is safe even with a `push:` trigger.
- **D3 — `relative_link_prefix` migration.** Under the old submodule model the source
  lived in a local `origin/` dir and consumers passed `relative_link_prefix: origin`.
  In fetch mode there is no local `origin/` dir, so that value must change to a
  source-repo URL prefix (e.g. `https://github.com/<owner>/<repo>/blob/<default>/`)
  or be dropped. The action input itself is unchanged; the **consumer-supplied value**
  changes. This is the one non-trivial migration step.
- **D4 — Backward compatibility.** ~~Local-file mode (`original_repository` unset) is
  byte-for-byte unchanged. Fetch mode and commit mode are both opt-in.~~
  **SUPERSEDED (Phase 3 amendment):** `original_repository` is now **required** and
  fetch is the only mode; local-file mode was removed. Commit mode (Phase 4) is still
  opt-in via `commit_message`.

---

## Fetch-mode contract (Phases 2–3)

> **Superseded by the Phase 3 amendment** (`original_repository` is now required;
> local-file mode removed). The "empty" row below is historical — only the "set" row
> applies as-built. Kept for context.

| `original_repository` | Source of markdown | `markdown_file` role | Write |
|---|---|---|---|
| set (`owner/repo`) | `GET /repos/{owner}/{repo}/readme` (raw) | **output path only** | unconditional |
| empty | `fs.readFile(markdown_file)` (today) | input **and** output | only when changed |

- Action **fetches + enhances**; it does not push unless `commit_message` is set
  (D2). The fetch is I/O and lives at the `main.ts` boundary; `enhance()` stays pure.
- `metadata.original_repository` continues to be emitted into the JSON output, so the
  e2e assertion `metadata.original_repository == "NARKOZ/guides"` still holds.
- Non-goal: fetching sibling files (images, other `.md`) from the source repo. Only
  the README is fetched, matching today's `rsync origin/README.md` behavior.

---

## Phases

### Phase 0 — Dependency upgrade + toolchain repair (DONE)

**Goal:** all `package.json` deps at latest; lint/test toolchain green again so the
axios→octokit swap lands on a clean baseline.

- Bumped every dep to latest via `npm-check-updates -u`. Notable majors:
  `@actions/github` 6→9 (Octokit core 5→**7**), `@actions/core` 1→3, `eslint` 9→10,
  `eslint-plugin-perfectionist` 4→5, `typescript` 5→6, `vitest`/`@vitest/coverage-v8`
  3→4, `@types/node` 22→26.
- Removed `axios` + `axios-mock-adapter`; added `@octokit/plugin-retry` and
  `@octokit/plugin-throttling` (peer-compatible with Octokit core 7) for Phase 1.
- **eslint repaired** (`eslint.config.js` rewritten to mirror
  `legacy/enhansome-webapp`, minus React):
  - `@eslint/js` + `globals` are no longer transitive under eslint 10 → added as
    explicit devDeps.
  - perfectionist v5 changed `sort-imports`: `customGroups` is now an array and the
    group tokens were renamed (`value-builtin`, `type-internal`, …). Updated.
  - Adopted the legacy stack: `eslint-plugin-n` (`flat/recommended-module`) +
    `@stylistic/eslint-plugin` + `eslint-config-prettier`, `globals.node`. Stylistic
    aligned to this repo's prettier (`semi: true`, single quotes). `lint` script →
    `eslint .` (flat config owns globbing/ignores).
- **vitest v4 regression fixed:** v4 dropped `**/dist/**` from `defaultExclude`
  (now only `node_modules`/`.git`), so the `*.test.ts` files `tsc` compiles into
  `dist/` were being double-collected. Restored via
  `exclude: [...configDefaults.exclude, 'dist/**']` in `vitest.config.ts`.
- **State after Phase 0:** lint is clean on every file except `github.ts` /
  `github.test.ts`; `tsc` + `vitest` fail *only* on the now-uninstalled `axios`
  imports in those two files — i.e. exactly the Phase 1 work, nothing else regressed.

### Phases 1 & 2 — as-built notes (DONE)

Implemented together. Green on `make ci` (tsc + 100 vitest tests, incl. the live
`microsoft/vscode` integration check) and `npm run lint`. `make e2e` not run here
(needs `act`/Docker) — unchanged, should still pass.

**Deviation from the original Phase 1/2 contract — dependency injection.** Instead
of `getRepoInfo(owner, repo, token)` / `getReadme(owner, repo, token)` each building
their own Octokit, the client is now **injected**, mirroring the proven pattern in
`legacy/enhansome-webapp` (`src/lib/github/*` + `tests/.../_octokit-mock.ts`):

- `makeOctokit(token): GithubClient` — factory; authenticated when `token` set,
  anonymous when `''` (branches around `getOctokitOptions`, which throws on empty
  token). Wired with `@octokit/plugin-retry` + `@octokit/plugin-throttling` on top of
  `GitHub` from `@actions/github/lib/utils`. Exported `GithubClient` type.
- **`getRepoInfo(octokit, owner, repo)`** and **`getReadme(octokit, owner, repo)`**
  take the client as the first arg. `markdown.ts#fetchAllRepoInfo(urls, token)` keeps
  its signature but now builds **one** client and shares it across all workers, so the
  throttling plugin actually coordinates rate limits (a real improvement over the old
  per-call axios path). **Phase 3 `main.ts` must `makeOctokit(token)` once and pass it
  to `getReadme`.**
- Retry/rate-limit logic lives in `createRateLimitHandler('primary'|'secondary')`
  (exported, unit-tested): honors the old `MAX_WAIT_TIME_SECONDS` (300s) cap and
  `MAX_RETRIES` (3) budget; the plugin owns the actual `Retry-After`/backoff waiting.
  `retry.doNotRetry` includes 429 so throttling solely owns rate-limit retries.
- **Tests use a tiny `mockOctokit(handlers)`** (dispatch by `repos.get`/`repos.getReadme`,
  throw `RequestError` to simulate failures) — *not* fetch/`axios-mock-adapter` and
  *not* fake timers. This sidesteps fighting Bottleneck's internal timers; the
  cap/budget logic is covered directly via `createRateLimitHandler`. `@octokit/core`
  added as a direct dep (imported type); `@octokit/request-error` as a dev dep (tests).
- `markdown.test.ts` / `orchestrator.test.ts` only needed their `getRepoInfo` mock
  call-sites/assertions updated for the new arg order; their `vi.mock('./github.js')`
  strategy is unchanged.

### Phase 1 — Swap axios → Octokit (pure refactor, zero behavior change)

**Goal:** identical external behavior, axios gone, retry logic delegated to plugins.

- Deps: remove `axios` and `axios-mock-adapter`; add `@octokit/plugin-throttling`
  and `@octokit/plugin-retry`. (Octokit core comes via `@actions/github`.)
- `src/github.ts`:
  - Extract a `makeOctokit(token)` factory: when `token` is non-empty use the
    authenticated client; when empty construct an **anonymous** client. Both wired
    with the throttling + retry plugins.
  - Rewrite `getRepoInfo(owner, repo, token)` to use `octokit.rest.repos.get(...)`,
    mapping the response to the existing `RepoInfoDetails` shape. Preserve the
    contract: returns `RepoInfoDetails | null`; `null` on non-retriable failure.
  - **Delete** the manual retry/`Retry-After`/`x-ratelimit` loop. Configure the
    throttling plugin to retry and to give up past the existing max-wait intent.
  - Keep `parseGitHubUrl` as-is.
- `src/github.test.ts`: replace the `axios-mock-adapter` harness with `fetch`-layer
  mocking (inject a custom `request.fetch` into the Octokit instance, or stub
  `global.fetch`). Keep every existing case green: 200 → mapped details, 404 → null,
  429 → retry → success, no-token → no `Authorization` header sent.
- **Acceptance:** `make test` + `make ci` + `make e2e` green. No `action.yml` /
  `README.md` changes.
- **Commit:** `refactor: replace axios with octokit`

### Phase 2 — Add `getReadme` + `parseOwnerRepo` (additive, unwired)

**Goal:** the fetch primitives exist and are unit-tested; `main.ts` not yet touched.

- `src/github.ts`:
  - `getReadme(owner, repo, token): Promise<string | null>` — uses
    `octokit.rest.repos.getReadme({ owner, repo, mediaType: { format: 'raw' } })` so
    the response body **is** the markdown text (no base64 decode). `404` ⇒ `null`.
    Reuses `makeOctokit` (so retry/throttle come for free). Note: raw responses are
    typed as the JSON shape — cast the body to `string`.
  - `parseOwnerRepo(value): { owner, repo } | null` — accepts `owner/repo` and a full
    `github.com/owner/repo` URL (reuse `parseGitHubUrl`). Strict-validate; reject
    `owner` alone and empty.
- `src/github.test.ts`: red/green for `getReadme` (200 raw → string, 404 → null,
  429 → retry → success, no-token → anonymous) and `parseOwnerRepo`
  (`owner/repo` ✓, full URL ✓, `owner` alone ✗, empty ✗).
- **Acceptance:** `make test` + `make ci` green; `make e2e` unaffected.
- **Commit:** `feat: add source README fetch primitives`

### Phase 3 — Wire fetch mode into `main.ts` (DONE — amended)

**As-built deviation from the original contract.** The user revised the requirement
mid-phase: `original_repository` is **always set**, so fetch mode is the *only* mode
and the source repo's **commit SHA is recorded in `README.json`**. This supersedes
**D4** (local-mode backward compatibility) and the dual-row fetch-mode contract table
above — the "empty `original_repository`" row no longer exists.

As built:

- `src/main.ts` (`run`, now **exported** for unit tests; auto-invoke guarded by an
  `import.meta.url === process.argv[1]` check so importing it in vitest does not run
  it):
  - `original_repository` is **required**. `parseOwnerRepo(...)` failure (including
    empty/missing) → `core.setFailed(...)` and return. No `fs.readFile` path remains.
  - `makeOctokit(token)` once, then `Promise.all([getReadme(...), getLatestCommitSha(...)])`.
    `getReadme === null` → `core.setFailed('No README found in {owner}/{repo}')`.
    `getLatestCommitSha === null` → `core.warning(...)` and proceed (SHA omitted).
  - Treats `markdown_file` as the **output path**; writes **unconditionally**.
  - `enhance()` stays pure; the fetch is I/O at the boundary.
- `src/github.ts`: added `getLatestCommitSha(octokit, owner, repo)` — `repos.listCommits`
  with `per_page: 1`, returns `data[0]?.sha ?? null`; same retry/throttle client.
- SHA threading: new `metadata.original_repository_sha` field in `markdown.ts`
  (`JsonMetadata` + new trailing `originalRepositorySha?` param on
  `processMarkdownContent`); `EnhanceOptions.originalRepositorySha` in `orchestrator.ts`.
- `action.yml`: `original_repository` now `required: true` (no default); `markdown_file`
  description reworded to "output path".
- **No-backward-compat follow-ups (same session):**
  - Removed the dead `isChanged` flag end-to-end (`processMarkdownContent` return,
    `EnhanceResult`, `main.ts`) — writes are always unconditional now.
  - `originalRepository` is now **required** through the pure layer
    (`EnhanceOptions.originalRepository: string`, `processMarkdownContent` param), so
    `metadata.original_repository` is a non-null `string` (dropped the `|| null`).
  - **Renamed** `metadata.source_repository` → `enhanced_repository` and
    `source_repository_description` → `enhanced_repository_description` (camelCase API
    identifiers too). Rationale: "source" misleadingly read as the upstream; these
    fields are the **publishing/enhanced** repo, auto-derived from `github.context`
    (still also used as the no-H1 title fallback). `original_repository` remains the
    upstream content origin.
  - `.github/workflows/test.yml` e2e job simplified to `checkout → action → assert`
    (Phase 5 work pulled forward); it now also asserts the 40-char SHA. Verified green
    via `make e2e` (fetched `NARKOZ/guides`, 12 sections, star badges present).
- Tests: `src/main.test.ts` (new) covers fetch/SHA/failure paths via mocked
  `getReadme`/`getLatestCommitSha`; `getLatestCommitSha` unit tests added to
  `github.test.ts` (mock harness gained `repos.listCommits`).
- **Acceptance:** green on `make ci` (tsc + 110 vitest tests) + `npm run lint`.
  `make e2e` not run here (needs `act`/Docker); it already passes `original_repository`
  so the fetch path is exercised — Phase 5 removes the now-dead submodule/rsync ritual.
- **Commit:** `feat: fetch source list via original_repository`

### Phase 4 — Commit inside the action (DONE — amended)

**Goal:** consumers drop their own commit step; the action publishes the result.

**As-built deviation from the original contract.** The original plan hand-rolled the
commit (first a bash composite step, then a discussion of a Node `execFile` committer).
The user chose instead to **reuse the proven `stefanzweifel/git-auto-commit-action@v7`
as a nested composite step** — composite actions support nested `uses:` — so this
action does not own git-push edge cases (detached HEAD, nothing-to-commit, file
patterns). Trade: one well-maintained third-party action vs. self-owned git plumbing.

Also: a **single new input** `auto_commit` (boolean string, **default `'true''`**)
gates the step; message and identity are **hardcoded** (not inputs).

As built (`action.yml`, YAML-only — no TS/test changes):

- New input `auto_commit` (default `'true'`). The commit step runs under
  `if: ${{ inputs.auto_commit == 'true' }}`.
- Final step `Commit enhanced output` → `stefanzweifel/git-auto-commit-action@v7`:
  - `commit_message` embeds `original_repository` (lightly dynamic, no extra input):
    `docs(enhance): ✨ Auto-update <owner/repo> with latest content & stars`.
  - `commit_user_name: Enhansome`, `commit_user_email:
    actions-bot@users.noreply.github.com`, and `commit_author:
    'Enhansome <…>'` so **both** author and committer read as Enhansome (otherwise
    author defaults to the triggering actor).
  - The third-party action handles `git add -A` / no-op-when-clean / push.
- `.github/workflows/test.yml` e2e job sets `auto_commit: false` (act/local cannot
  push); asserts stay on file content + SHA.
- Requires consumer `permissions: contents: write` and checkout's default
  `persist-credentials: true` — **Phase 5 README must document both**.

**Reverses D2.** D2 made committing strictly opt-in (`commit_message` empty ⇒ no side
effect; "never unconditional"). `auto_commit` now **defaults to `true`** (opt-out),
because the action's sole purpose in the amended model is *publishing* enhanced lists.
Loop-safety argument from D2 still holds: a `GITHUB_TOKEN`-authored push does not
re-trigger workflows.

- **Acceptance:** `make test` green (110, unchanged). `make e2e` not run locally
  (needs act/Docker); the fetch path is exercised with `auto_commit: false`.
- **Commit:** `feat: commit enhanced output via git-auto-commit-action`

### Phase 5 — Docs, e2e simplification, consumer migration, release (DONE — release pending merge)

**Goal:** one consistent story; remove the submodule ritual; ship.

As built:

- `.github/workflows/test.yml`: already simplified in Phase 3 — `checkout → action →
  assert`, no submodule/clone/rsync, no `relative_link_prefix: origin`. Phase 4 added
  `auto_commit: false` so act doesn't attempt a push. Verified green via `make e2e`.
- `README.md` rewritten:
  - **Usage** → `checkout → action` (no submodule, no shell, no separate commit step);
    notes the `auto_commit: false` escape hatch and `GITHUB_TOKEN` loop-safety.
  - **Inputs** table reordered/updated: `original_repository` **required** and listed
    first; `markdown_file` documented as the **output** path; `auto_commit` (default
    `true`) added with its `permissions`/`persist-credentials` requirements. (No
    `commit_message`/`commit_user_*` inputs — those were dropped in favor of the single
    `auto_commit` toggle with hardcoded identity, per the Phase 4 deviation.)
  - "thin action" paragraph reworded to **self-contained**.
  - New **Migrating from the submodule model** section: the
    `submodule deinit / rm / rm -rf .git/modules/origin` + `.gitmodules` removal, the
    `checkout(submodules)+sync → plain checkout` swap, dropping the external commit
    step, and the **D3** `relative_link_prefix` change (drop or set to a source-repo
    URL prefix).
- **Acceptance:** `make test` (110) + `make e2e` green; README usage matches
  `action.yml`.
- **Release:** not yet — lands as `feat:` ⇒ minor bump via release-please once these
  changes merge to `main`.

---

## Risk notes

- **Phase 1** carries the only real production-logic risk: deleting the hand-tuned
  retry loop in favor of the plugin. Verify the 429/`Retry-After` path explicitly in
  tests.
- **Phase 1 test rewrite** (axios-mock-adapter → fetch-layer) is the bulk of the
  effort, not the production change.
- **Phase 4** re-introduces a side effect (push) the action previously avoided;
  gating by `commit_message` (D2) is what keeps that safe and opt-in.
- **e2e is non-hermetic** (hits the live GitHub API). Adding the README fetch is
  consistent with that; the unit suite stays hermetic and mocked.

---

## Edge cases to honor (Phases 2–4)

- Source repo has no README → `getReadme` returns `null` → `core.setFailed`.
- Malformed `original_repository` → `parseOwnerRepo` returns `null` → `core.setFailed`.
- Both `original_repository` and a local `markdown_file` present → fetch wins;
  `markdown_file` is the output and is overwritten. Document this.
- Private source repo → needs a token with `repo` scope; `GITHUB_TOKEN` is
  repo-scoped and cannot read other private repos. Source awesome-lists are public —
  documented caveat, not a blocker.
- Anonymous fetch (no token) → works for public repos, rate-limited (60/hr vs
  5000/hr). Same trade-off as today's metadata fetch.
