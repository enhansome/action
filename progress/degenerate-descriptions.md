# Degenerate item descriptions

## Goal

An emitted item's description carries annotation, not residue. When the split's trailing text is degenerate — a bare tag word, a URL, or empty — it falls back to `owner/name`. The own link's label is never consulted: in the corpus it only ever echoed the title back. Mirrors `archive/degenerate-titles.md` (72d5c02) one seam over: the same entry sources, the description half of `splitEntryText`. Done when the fix is merged to main.

Out of scope: `][PyTorch]`-style non-tag remnants (real word, kept), prose quality beyond degeneracy, heading-container descriptions.

## Current state

The fix, its tests and regenerated goldens sit on branch `fix/degenerate-item-descriptions`, reworked after review; PR against main not merged.

The fix is one seam, `entryDescription(base, repoInfo)` in `packages/core/src/markdown.ts`, called wherever `entryTitle` is (list items, both table paths, paragraph/blockquote entries): a non-degenerate base wins, else `owner/name`, else the base stands (groups, no repo link). Degeneracy is empty, `isDegenerateTitle` (URL, no letters, tag word), or a description-only tag word (`website`, `homepage`, `home page`, `link`, `here`, `documentation`, `repository`).

The first cut also fell back to the own link's label, guarded by exact string equality with the title. Review of the goldens killed it (owner, G1a): all 57 label landings repeated the title once emoji codes and symbols were stripped — `:tada: [Doom](…)` carried "Doom" as both title and description, `🛠️ Root Management` carried "Root Management" twice, and the tag words "pull request", "discussion", "issues", "MIT", "RE" leaked through the same hole. The guard only caught a title that came *from* the label; the echo always arrives decorated. The branch was deleted, not widened: no golden or census family shows a label that helps.

Census the fix was sized on — webapp snapshot `tmp/v6-build/snapshot` (Layerbase restore, 203k repos), `entries` table, 340,532 entries, 74,997 null descriptions. Degenerate non-null families (`node_type='item'`, short-value census):

| family | count | shape | example registry |
|---|---|---|---|
| trailing tag-cluster remnant | ~10k (`] [Code]` 1.4k+1.2k, `][code]`, `][PyTorch]`…) | paper-list tag columns leaking past the title split | paper collections |
| bare tag word | ~430 (`github` 139, `demo` 96, `code` 83, `website` 59, `repo` 30, `documentation` 10, `project` 7, `source` 5) | `- [Homepage](site) - [Repo](github.com/o/r)` — the GitHub link is second, its label lands as the description | alternative-frontends, Awesome-NextJs (136), Awesome-Deepfakes-Detection (65) |
| bare numbers | 245 (237 in ALL-about-RSS alone; rest are paper-year annotations like `2023`) | README line references written into the annotation slot | ALL-about-RSS (`huginn` `264, 272`, `n8n` `901`, `api.rss.ui` `527`) |

The bare-number family reached the serving surface — blind MCP callers reading scoped search rows saw `676, 746` as repo descriptions (the webapp wears the listing annotation on scoped rows). No-letters (`!/[\p{L}]/u`) catches every one, including the paper-year `2023` annotations — a year is replaced by `owner/name` under the fix; if years should survive, the review carves them out.

Not degenerate: real prose (even one word like "Yes"/"available"/"MIT"), tag-adjacent multi-word runs ("Arxiv Human-Art"), CJK.

Golden-transition census of the reworked fix (diff old vs new golden trees, paired by position): 334 transitions — 333 land on `owner/name`, 1 on `owner/name` with a BOM (`karpathy/neuraltalk%EF%BB%BF`, awesome-computer-vision; pre-existing in `repo_info.repo`). Zero label landings, zero echoes.

Found work filed as its own index entries before close: table annotation cells dropped on non-link columns (android-root's category tables), zero-width characters in link URLs parsing to mojibake repo names (owner, G2a: shipped as-is here).

## Next step

Owner: review and merge the reworked `fix/degenerate-item-descriptions` PR, then close this thread.
