# Zero-width characters in link URLs parse to mojibake repo names

## Goal

A repo identity parsed from a URL ignores zero-width characters, so awesome-computer-vision's `karpathy/neuraltalk%EF%BB%BF` line emits `karpathy/neuraltalk` with the real repo's info. Done when the fix is merged to main and the TODO entry is gone.

## Current state

Merged to main as PR #<N> — implemented on branch `fix/zero-width-urls`: `stripZeroWidth` in `packages/core/src/github.ts` removes BOM/ZWSP/ZWNJ/ZWJ/LRM-RLM/word-joiner (raw and percent-encoded) from owner and repo in `parseGitHubUrl` and `parseOwnerRepo`. Four cases in `fixtures/url-parsing.json` (raw BOM, encoded BOM, ZWSP, config-input BOM). The awesome-computer-vision golden moved on the NeuralTalk row only: repo `karpathy/neuraltalk`, description fallback clean, offline repo info re-derived from the clean identity.

## Next step

None — closed on merge.
