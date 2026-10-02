# Best-of details entries lose their annotation and category

## Goal

A best-of `<details><summary>` entry emits as one item under its real category: title the summary link's label, description the summary's curated sentence with the badge cluster stripped and the license text kept; the inner GitHub bullet that re-mentions the same repo emits nothing. Any other details block opened inside an open container emits as a group under it, not a top-level section. Non-repo leaves stay markdown-only (owner, G1a — the parked contract is unchanged). Done when the fix is merged to main and issue #27 is closed.

## Current state

Ruled (owner, issue #27): G2a as scoped above; G1a leaves the non-repo contract parked on webapp v2.

Implemented on branch `fix/details-summary-entries`, all seams in `packages/core/src/markdown.ts`:

1. `parseDetailsSummary` reads a summary into `{title, identity, prose}` — the first GitHub anchor (label + href) and the tags-stripped text after it; `collectGitHubLinks` adds that href to the fetch set (summary anchors stay raw html).
2. The html walk promotes a summary whose identity resolved and whose label is meaningful to an item container (title = label, description = badge-stripped prose through `entryDescription`), gated by the same section gate its inner list would face; with an empty stack a synthesized section wraps the run. Any other details block opened inside a container finalizes as a group under it; with an empty stack it stays a top-level section. All details containers keep the old joinDepth and `</details>` closing.
3. A list directly inside a promoted item suppresses the entry restating that repo (`suppressRepo` in `processListRecursively`), lifting its children the way a dead link does. Inner prose does not append to a promoted item's description (`collectsProse`).

The fixture is a verbatim cut of ml-tooling/best-of-python-dev (owner asked for the filing registry; a first synthetic fixture was replaced by it) pinning pytest, pytest-xdist, the empty-href nox entry, the "Show 14 hidden projects…" toggle, and the category boundary. vinta/awesome-python was already fixture `python` — its openpyxl line pins the G1a side. Goldens regenerated (android-root, bare-links, details-cards, regex moved to the nested shapes).

Verified on the full live best-of-python-dev README offline: 18 top-level sections (was 154), 260 items (was 252 — 8 entries recovered, nox among them: its inner GitHub bullet has an empty href, so only the summary can carry it), pytest-xdist under "Testing Tools" with `pytest plugin for distributed testing and loop-on-failures.. MIT` as description, zero badge-titled or toggle-titled top-level sections.

## Next step

Owner: review and merge the `fix/details-summary-entries` PR, reply on issue #27 with both rulings, and close the issue when it lands.

## Design

- Promotion: a summary whose first GitHub anchor resolves and carries a meaningful label opens an item container — the heading-promotion precedent (`entryHeadingInfo` + openContainer's promotion branch) applied to the details face. The container carries `openedByDetails` so `</details>` closes it.
- Group nesting: a details block with no identity anchor, opened while a container is open, finalizes as a group under it (JsonGroup — the nesting shape the output already has); with an empty stack it stays a top-level section.
- Fetch: summary anchors stay raw html (`normalizeGitHubUrls` leaves block html alone), so their hrefs join the repo fetch set explicitly; promotion looks the repo up by the same href.
- Re-mention: the inner `- [GitHub](repo)` bullet shares the promoted repo's `repoInfo` object (per-repo memo), and the list walk suppresses entries whose own link matches the open item container's repo — the paragraph face's re-mention rule extended to lists.
- Badge strip: the description is the summary prose after the identity anchor, leading parenthesized badge clusters (symbols, digits, size letters) removed, then the shared leading-noise strip; the license text rides along (annotation, not a badge). Degenerate stripped prose falls back through the shared `entryDescription`.
