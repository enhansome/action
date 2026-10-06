# Mirror silently ingests truncated READMEs — fix the GitHub fetch route and make truncation loud

## Goal

The mirror never ingests a prefix silently: `getReadme` fetches the whole file through a route without GitHub's ~512,000-byte raw cap, a byte-length guard makes truncation loud, and the live proof against `punkpeye/awesome-mcp-servers` returns 1,364,081 bytes parsing to 59 `^### ` sections and ~4,086 list entries. One PR to main. The mirror JSON contract gains no truncation flag — the throw is the signal.

## Current state

Plan minted from the owner's verified spec (verified 2026-10-06). Base is `main` at `ce31e3b` (the fork-links branch `fork-to-source` is abandoned — PR #32 closed unmerged as wrong-by-design; its `github.ts` changes are not in the base). Tree clean; start gate (`make ci`) launched. Nothing built yet.

## Next step

Dispatch U1 (hardening): re-verify the spec's anchors against the tree and write this file's Steps close criteria, reading lists, enforcement inventory, and the pinned live-ritual invocation.

## Steps

| id | unit | model | review | close criteria |
|---|---|---|---|---|
| U1 | Harden the plan | | | Every anchor the spec names is re-verified against the tree (`packages/core/src/github.ts` `getReadme`, `getRepoFileOrNull` — line ranges corrected if drifted); Steps rows for U2/U3 carry testable close criteria, per-unit reading lists, an enforcement inventory (protected assertions, forbidden idioms, line ceiling), and the pinned live-ritual invocation; committed docs-only. |
| U2 | Fetch route + guard + tests | | | `getReadme` returns full content via JSON resolve (`sha` + `size`) then `git.getBlob`, exported signature unchanged; decoded byte length ≠ blob size → `getReadme` throws, never returns a prefix; `getRepoFileOrNull` takes the same route through its documented best-effort channel; `github.test.ts` serves a >512,000-byte fixture truncated through the fetch path asserting the throw, and a full-length fixture asserting the content flows whole; full gate (`make ci`) green immediately before the commit. |
| U3 | Live ritual + PR | | | The new fetch path run against `punkpeye/awesome-mcp-servers` records 1,364,081 bytes, 59 `^### ` sections, ~4,086 list entries (about — the parser's real count stands) in `progress/.scratch/truncated-readme/`; PR open with base `main` carrying U2's diff. |

## Plan

**Run mechanics.** Branch `truncated-readme` off `main`. Full gate is `make ci` (typecheck + vite build + vitest); it fires immediately before each commit that changes code it exercises. Scoped iteration inside U2: `yarn vitest run packages/core/src/github.test.ts` and `yarn workspace @enhansome/core typecheck`. Ritual records go to `progress/.scratch/truncated-readme/` (never committed). One PR at the end, base named explicitly to `gh pr create`. The run never merges and never pushes to the default branch.

**Stop rules.** If the code contradicts the spec's guard semantics (getReadme strict-throw; followed files best-effort through their documented channel), U1 reports it and the run stops for the owner before U2 dispatches. A live-ritual number that misses its expectation is a finding, not a re-tune.

**Open questions.** None carried into the run.

## Design

Root cause (owner-verified 2026-10-06, three reproductions): `getReadme` fetches via `octokit.rest.repos.getReadme` with `mediaType { format: 'raw' }`, and GitHub caps that route at ~512,000 bytes — `gh api …/readme -H "Accept: application/vnd.github.raw"` returned 512,002 bytes ending mid-emoji inside section 21 of 59, while `raw.githubusercontent.com` and `contents/README.md --jq .size` both return 1,364,081. Nothing downstream notices: the mirror of `punkpeye/awesome-mcp-servers` serves 21 of 59 sections and 1,595 of 4,086 entries as fact.

Fix shape:

- Resolve via `getReadme` in the default JSON media type (gives `sha` + `size`), then `git.getBlob` (base64, exact bytes up to 100 MB). Keep the exported signature returning the content string.
- `getRepoFileOrNull` hits the same cap through `getContent` with raw media for followed content files — same treatment.
- Guard: after decoding, compare byte length against the blob's `size`; on mismatch, fail through the helper's own channel — `getReadme` throws (it already throws on failure, strict mode), followed files stay best-effort as documented. Never ingest a prefix silently. No truncation flag on the mirror JSON contract — a second mechanism for the same signal.

Rejected: the raw route (the cap is the defect), `contents` raw route (same cap), a truncation flag in the mirror JSON (second mechanism; the throw is the signal).

The webapp post-mortem that surfaced this owns the follow-through: after this lands, webapp re-mirrors per `../webapp/AGENTS.md` ordering (action before webapp). Out of this run's scope.
