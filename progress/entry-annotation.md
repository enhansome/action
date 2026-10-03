# Entry descriptions lose their annotation

## Goal

Every entry face's description carries its annotation: leading badge clusters (`(🥈27 · ⭐ 4.5K · 💀) - sentence`) are stripped at the shared description seam — list items, paragraph and blockquote entries, table rows, not just details summaries — and a table row's annotation cell reaches the emitted description instead of collapsing to the `owner/name` fallback. Done when the fix is merged to main and the two TODO entries it merges are gone.

## Current state

Two defects merged from the index (owner: fix all three found-work items, 2026-10-03; items 1 and 2 are the same subject):

1. Leading badge clusters survive in entry descriptions — best-of-python-dev's hidden rows emit `(🥈27 · ⭐ 4.5K · 💀) - Let your Python tests travel through time.` and its cross-ref rows `( ⭐ 2.6K · 💤) - Testing libraries…`. `stripBadgeClusters` runs on summary prose only.
2. Table annotation cells never reach item descriptions — android-root's category tables carry real annotation in a non-link cell, but some rows' items show the `owner/name` fallback or residue instead.

Nothing built yet.

## Next step

Branch `fix/entry-annotation`; investigate the table-cell loss on the android-root fixture (find the failing row shape, map it to `processTableRows`), then move the badge-cluster strip into `entryDescription` (dropping the details branch's own pre-strip — one way), regenerate goldens, census the moved descriptions.

## Design

- The badge strip belongs in `entryDescription`, before the degeneracy judgment: a cluster-only base becomes empty and falls to `owner/name`; a cluster-prefixed sentence keeps its sentence. The details-summary branch's own `stripBadgeClusters` call goes — the shared seam is the only stripper.
- The table fix's shape is not yet known; it is derived from the failing android-root rows, not fitted to the current code's assumptions.
