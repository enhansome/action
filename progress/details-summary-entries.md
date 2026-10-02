# Best-of details entries lose their annotation and category

## Goal

A best-of `<details><summary>` entry emits as one item under its real category: title the summary link's label, description the summary's curated sentence with the badge cluster stripped and the license text kept; the inner GitHub bullet that re-mentions the same repo emits nothing. Any other details block opened inside an open container emits as a group under it, not a top-level section. Non-repo leaves stay markdown-only (owner, G1a — the parked contract is unchanged). Done when the fix is merged to main and issue #27 is closed.

## Current state

Ruled (owner, issue #27): G2a as scoped above; G1a leaves the non-repo contract parked on webapp v2. Evidence: the live enhansome/enhansome-best-of-python-dev mirror emits pytest-xdist as `item{title: pytest-dev/pytest-xdist, description: (👨‍💻 120 · 🔀 290 · 📦 140K):}` inside a badge-titled wrapper section; 154 top-level sections for a 23-category source (135 badge wrappers, 17 "Show N hidden projects" toggles holding 114 items, 2 real categories with 3).

Nothing built yet.

## Next step

Implement the walk changes in `packages/core/src/markdown.ts`: summary parsing (identity anchor, label, prose), the promotion and group branches of the html walk, summary-anchor hrefs in the repo fetch set, and the list-walk re-mention suppression; then the best-of fixture and regenerated goldens.

## Design

- Promotion: a summary whose first GitHub anchor resolves and carries a meaningful label opens an item container — the heading-promotion precedent (`entryHeadingInfo` + openContainer's promotion branch) applied to the details face. The container carries `openedByDetails` so `</details>` closes it.
- Group nesting: a details block with no identity anchor, opened while a container is open, finalizes as a group under it (JsonGroup — the nesting shape the output already has); with an empty stack it stays a top-level section.
- Fetch: summary anchors stay raw html (`normalizeGitHubUrls` leaves block html alone), so their hrefs join the repo fetch set explicitly; promotion looks the repo up by the same href.
- Re-mention: the inner `- [GitHub](repo)` bullet shares the promoted repo's `repoInfo` object (per-repo memo), and the list walk suppresses entries whose own link matches the open item container's repo — the paragraph face's re-mention rule extended to lists.
- Badge strip: the description is the summary prose after the identity anchor, leading parenthesized badge clusters (symbols, digits, size letters) removed, then the shared leading-noise strip; the license text rides along (annotation, not a badge). Degenerate stripped prose falls back through the shared `entryDescription`.
