# Entry descriptions lose their annotation

## Goal

Every entry face's description carries its annotation: leading badge clusters (`(🥈27 · ⭐ 4.5K · 💀) - sentence`) are stripped at the shared description seam — list items, paragraph and blockquote entries, table rows, not just details summaries — and a table row's annotation cell reaches the emitted description instead of collapsing to the `owner/name` fallback. Done when the fix is merged to main and the two TODO entries it merges are gone.

## Current state

Implemented on branch `fix/entry-annotation`, both halves in `packages/core/src/markdown.ts`:

1. The badge-cluster strip moved into `entryDescription` (the details branch's own pre-strip deleted); the leading-noise strip runs only behind a stripped cluster, so `-equivalent` and `:bird:` table descriptions keep their leading characters and `()` in prose stays (an empty pair is not a cluster).
2. The investigation overturned the entry's framing: the failing rows were not losing cells — they were borrowing the source repo's identity. android-root's index and Starter Kit link the source's own doc pages (`root-management.md` → rewritten to `github.com/<source>/blob/HEAD/…`), so 21 navigation rows and every MiXplorer-class website row emitted items for `awesome-android-root/awesome-android-root`. Links into the source repository are now excluded from the target fetch, and every emission path reads them as dead links: no item, children lifted, the row markdown-only (the G1a contract for its non-repo rows).

Census of the golden transitions: self-repo items removed across 9 fixtures (android-root 21, copilot-agents 36, cakephp 4, R/cl/cpp/frontend-gis/quarto/static-analysis 1-2 each — every removal's repo equals its fixture's source); badge and year clusters stripped in best-of-python-dev, cl (`(2025) - Hand-written bindings…` → the sentence), regex; raw markdown no longer badges the registry's own links. First cut of the strip mangled `()` and `:bird:`/`-equivalent` leads — the golden census caught both before landing.

## Next step

Owner: review and merge the `fix/entry-annotation` PR; close this thread when it lands.

## Design

- Links into the source repository are navigation, never entry identity. Implemented at the fetch seam (the source repo never enters the target map) rather than by threading a skip predicate through every resolver: each emission path already treats an unresolved own link as dead, and the gates prune the emptied sections.
- The badge strip stays summary-shaped (parenthesized, symbols/digits/size letters, at least one character); a parenthetical with any other word is prose.
