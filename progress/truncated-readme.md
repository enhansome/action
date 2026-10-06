# Mirror silently ingests truncated READMEs — fix the GitHub fetch route and make truncation loud

## Goal

The mirror never ingests a prefix silently: `getReadme` fetches the whole file through a route without GitHub's ~512,000-byte raw cap, a byte-length guard makes truncation loud, and the live proof against `punkpeye/awesome-mcp-servers` returns 1,364,081 bytes parsing to 59 `^### ` sections and ~4,086 list entries. One PR to main. The mirror JSON contract gains no truncation flag — the throw is the signal.

## Current state

Branch `truncated-readme`, tree clean. U2 landed at `8686531` (131/150 ceiling): route + guard + tests green — 44/44 scoped, full gate green immediately before commit, enforcement all-PASS, blind review no findings (guard mutation-tested live; mock shapes grounded in octokit's openapi types). U3 not started.

## Next step

Dispatch U3 (sonnet): run the Plan's pinned live ritual against `punkpeye/awesome-mcp-servers`, record the three numbers in the scratch ritual dir, then the orchestrator opens the PR to `main`.

## Steps

| id | unit | model | review | close criteria |
|---|---|---|---|---|
| U1 | Harden the plan | | | Every anchor the spec names is re-verified against the tree (`packages/core/src/github.ts` `getReadme`, `getRepoFileOrNull` — line ranges corrected if drifted); Steps rows for U2/U3 carry testable close criteria, per-unit reading lists, an enforcement inventory (protected assertions, forbidden idioms, line ceiling), and the pinned live-ritual invocation; committed docs-only. Evidence: blind review no findings, closed at `docs: harden the truncated-readme plan`. |
| U2 | Fetch route + guard + tests | | | `getReadme` returns full content via a JSON resolve (`sha`) then `git.getBlob`; the surviving call surface `getReadme(octokit, owner, repo): Promise<string>` is unchanged for its only caller (`src/main.ts:56` needs no edit — the dead `format` param is deleted with the raw route it selected); decoded byte length ≠ blob `size` → `getReadme` throws (message carrying both byte counts), never returns a prefix; `getRepoFileOrNull` rides the same route, a mismatch landing in its existing catch → warn + null; `github.test.ts` serves a >512,000-byte multi-byte fixture truncated through the mocked fetch path asserting the throw (and null + warn for `getRepoFileOrNull`), and a full-length fixture asserting the content flows whole; diff within the Plan's line ceiling; full gate (`GITHUB_TOKEN="$(gh auth token)" make ci`) green immediately before handoff. Evidence: `8686531`, enforcement 131/150 all-PASS, blind review no findings. |
| U3 | Live ritual + PR | | | The Plan's pinned ritual commands run the new exported fetch path against `punkpeye/awesome-mcp-servers` and record 1,364,081 bytes, 59 `^### ` sections, ~4,086 list entries (about — the parser's real count stands) in `progress/.scratch/truncated-readme/`; PR open with base `main` carrying U2's diff and citing the three numbers. |

## Plan

**Run mechanics.** Branch `truncated-readme` off `main`. Full gate is `make ci` (Makefile: `typecheck build test` — tsc --noEmit, vite build, vitest run); it fires immediately before each commit that changes code it exercises. **Gate fact:** the unit suite embeds a live sanity test (`github.test.ts` `getRepoInfo` → microsoft/vscode, 15s timeout) — without `GITHUB_TOKEN` exported it stalls on the unauthenticated rate limit and fails the gate (observed today; with a token the file runs green in under a second). Always invoke it as `GITHUB_TOKEN="$(gh auth token)" make ci`. Scoped iteration inside U2: `GITHUB_TOKEN="$(gh auth token)" yarn vitest run packages/core/src/github.test.ts` (verified green, 40 tests) and `yarn workspace @enhansome/core typecheck`. Ritual records go to `progress/.scratch/truncated-readme/` (gitignored, never committed). One PR at the end, base named explicitly to `gh pr create`. The run never merges and never pushes to the default branch.

**Verified anchors (U1, 2026-10-06).**

- `getReadme` — `packages/core/src/github.ts:228-244`. Signature `(octokit, owner, repo, format: 'html' | 'raw' = 'raw')`; the single fetch is `octokit.rest.repos.getReadme({ mediaType: { format }, owner, repo })`, body cast to string. Its only runtime caller is `src/main.ts:56` — three arguments, default format, inside `Promise.all` — and the strict-throw channel is load-bearing there (`src/main.ts:60-61`: getReadme throws on failure, the top-level catch surfaces it via setFailed, no null branch). No caller anywhere passes `format`; webapp has its own GitHub lib and imports neither function. Design drift corrected in this hardening: the plan was silent on the `format` param — it exists only to select the capped raw/html media route this run deletes, so it goes with that route. "Signature unchanged" means the surviving surface `getReadme(octokit, owner, repo): Promise<string>`; `src/main.ts:56` needs no edit.
- `getRepoFileOrNull` — `github.ts:252-273`. `octokit.rest.repos.getContent({ mediaType: { format: 'raw' }, owner, path, repo })` inside try/catch → warn + null: the documented best-effort channel. Caller `packages/core/src/markdown.ts:363` skips on null.
- Guard semantics hold in the code — no stop-rule trigger. `getReadme` has no internal catch, so a thrown guard propagates to main.ts's setFailed; `getRepoFileOrNull`'s existing catch is exactly the channel a mismatch takes there (warn + null), so no new channel is needed.
- Tests today: the mock factory `github.test.ts:35-60` dispatches by `'group.method'` and its `rest` surface is only `repos.{get, getReadme, listCommits}` — no `git` group, no `repos.getContent`. The `getReadme` suite is `:308-344`: the success test asserts the raw mediaType (`:321-323`), the 404 test (`:326-343`) asserts the RequestError propagates. `getRepoFileOrNull` is untested and not even imported. `markdown.test.ts` and `markdown.golden.test.ts` mock the module's exports (`vi.mocked(github.getRepoFileOrNull)`), never the REST route.

**U2 briefing — fetch route + guard + tests.**

Reading list, nothing else: this file; `packages/core/src/github.ts`; `packages/core/src/github.test.ts`; `src/main.ts:30-70`; `packages/core/src/index.ts`. `markdown.test.ts` and `markdown.golden.test.ts` are explicitly out — they mock the module exports and must remain byte-identical.

Route shape — one shared mechanism, both helpers ride it:

- New unexported helper (name it in the file's voice, e.g. `fetchBlobText`): given the client, owner, repo, and the resolved file `sha`, call `octokit.rest.git.getBlob({ file_sha: sha, owner, repo })`; decode `data.content` as base64; guard the decoded byte length against the blob response's own `size` field; on mismatch throw a plain Error whose message carries both byte counts (got vs expected) — loud, never a prefix; otherwise return the decoded bytes as utf-8 text.
- `getReadme`: resolve via `octokit.rest.repos.getReadme({ owner, repo })` in the default JSON media type, feed `data.sha` to the helper, return its string. The `format` param and the raw mediaType are deleted; no try/catch is added — strict stays strict.
- `getRepoFileOrNull`: resolve via `octokit.rest.repos.getContent({ owner, path, repo })` in the default JSON media type (a single-file response carries `sha`; an array/directory response has none and fails through the existing channels), then the same helper inside the existing try/catch — a mismatch lands in the catch and returns null with the warn.

Test enforcement inventory:

- Byte-for-byte survivors: every existing suite except `getReadme`'s success test — URL parsing, `createRateLimitHandler`, `makeOctokit`, `getRepoInfo` (including the live sanity test), `getLatestCommitSha`, `getRepoInfoOrNull` — plus the `getReadme` 404 test (`:326-343`), all unchanged and passing. No file outside `packages/core/src/github.ts` + `packages/core/src/github.test.ts` is touched.
- Legitimate reshapes, named: (a) the success test's `expect.objectContaining({ mediaType: { format: 'raw' }, … })` assertion (`:321-323`) — the new resolve sends no raw mediaType; assert instead the JSON resolve plus `git.getBlob` called with the resolved `file_sha`; (b) the `'repos.getReadme'` handler's return value — JSON metadata `{ sha, … }` instead of the markdown string; (c) the mock factory's `rest` gains `git.getBlob`, and `repos.getContent` for the new `getRepoFileOrNull` tests — `createMethod` already generalizes over group and name.
- New tests, fixtures generated in-test (no checked-in fixture files): a payload whose blob content decodes shorter than the declared `size` — the truncation shape, sized over 512,000 bytes so the modelled regression is the real one — rejects from `getReadme` and resolves null (warn logged) from `getRepoFileOrNull`; a full-length payload where decoded bytes equal `size` flows out whole. The fixture must include multi-byte characters so a guard comparing JavaScript string length instead of byte length fails the test — the two interpretations must not coincide.
- Forbidden idioms: no `mediaType: { format: 'raw' | 'html' }` request remains as a content source on these paths — the raw route is the defect (`getRootEntryNames`'s mediaType-less directory listing, `github.ts:279-292`, is untouched); no truncation/partial flag is added to any output JSON or type — the throw is the signal; `getReadme` gains no catch, null, or log channel.
- Line ceiling: at most 150 inserted lines across the whole U2 diff, deletions free — measured with `git diff --numstat` against HEAD before handoff.

**U3 ritual — pinned invocation.** Reading list: this file only; the ritual below is self-contained (it names the build target and every import of the script it has you write). From the repo root, on the branch carrying U2:

```
mkdir -p progress/.scratch/truncated-readme
yarn workspace @enhansome/core run build
GITHUB_TOKEN="$(gh auth token)" node progress/.scratch/truncated-readme/fetch-ritual.mjs
```

`fetch-ritual.mjs` is written by U3 into that scratch dir (gitignored, never committed) and exercises the real exported path, not `gh api`:

```js
import { writeFileSync } from 'node:fs';
import { getReadme, makeOctokit } from '../../../packages/core/dist/index.js';

const readme = await getReadme(
  makeOctokit(process.env.GITHUB_TOKEN ?? ''),
  'punkpeye',
  'awesome-mcp-servers',
);
const stats = {
  bytes: Buffer.byteLength(readme, 'utf8'),
  entries: (readme.match(/^[ \t]*[-*+] /gm) ?? []).length,
  sections: (readme.match(/^### /gm) ?? []).length,
  ts: new Date().toISOString(),
};
writeFileSync(new URL('./readme-full.md', import.meta.url), readme);
writeFileSync(new URL('./stats.json', import.meta.url), JSON.stringify(stats, null, 2) + '\n');
console.log(stats);
```

Expected: `bytes` 1,364,081 (exact), `sections` 59 (exact), `entries` ~4,086 (about — the parser's real count stands). The README can move under us; a miss is a finding, not a re-tune. The PR (`gh pr create --base main`, per Run mechanics) cites the three recorded numbers with the run timestamp.

**Stop rules.** A live-ritual number that misses its expectation is a finding, not a re-tune. Any pressure to keep a raw-mediaType fetch as a content source, add a truncation flag to the mirror JSON, or give `getReadme` a null channel stops the run for the owner.

**Open questions.** None carried into the run.

## Design

Root cause (owner-verified 2026-10-06, three reproductions): `getReadme` fetches via `octokit.rest.repos.getReadme` with `mediaType { format: 'raw' }`, and GitHub caps that route at ~512,000 bytes — `gh api …/readme -H "Accept: application/vnd.github.raw"` returned 512,002 bytes ending mid-emoji inside section 21 of 59, while `raw.githubusercontent.com` and `contents/README.md --jq .size` both return 1,364,081. Nothing downstream notices: the mirror of `punkpeye/awesome-mcp-servers` serves 21 of 59 sections and 1,595 of 4,086 entries as fact.

Fix shape:

- Resolve via `getReadme` in the default JSON media type (gives `sha`; `size` comes along but the guard reads the blob response's own), then `git.getBlob` (base64, exact bytes up to 100 MB). Keep the exported surface `getReadme(octokit, owner, repo): Promise<string>` — the `format` param existed only to pick the capped media route and is deleted with it (no caller passes it; verified `src/main.ts:56`).
- `getRepoFileOrNull` hits the same cap through `getContent` with raw media for followed content files — same treatment.
- Guard: after decoding, compare byte length against the blob's `size`; on mismatch, fail through the helper's own channel — `getReadme` throws (it already throws on failure, strict mode), followed files stay best-effort as documented. Never ingest a prefix silently. No truncation flag on the mirror JSON contract — a second mechanism for the same signal.

Rejected: the raw route (the cap is the defect), `contents` raw route (same cap), a truncation flag in the mirror JSON (second mechanism; the throw is the signal).

The webapp post-mortem that surfaced this owns the follow-through: after this lands, webapp re-mirrors per `../webapp/AGENTS.md` ordering (action before webapp). Out of this run's scope.
