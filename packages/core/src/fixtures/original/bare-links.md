# Awesome Bare Links

Intro prose mentioning github.com/example/not-an-entry mid-sentence stays
description: the linkified URL must lead an entry line to become one.

## Kernel Tools

- github.com/example/kernel-tool ![stars](https://example.com/stars.svg) - a bare scheme-less URL with shields badges, the windows-kernel shape; a URL label is not a title, so the item takes owner/name.
- github.com/example/kernel-two - a second bare-URL entry so the section gate passes.
- github.com/user/repo-b - a dead bare target drops its entry.

## Prose Mentions

For the canonical upstream see github.com/example/prose-mention — a
mid-sentence URL linkifies but never leads, so this paragraph is description.

github.com/example/leading-url - a paragraph led by a bare URL is an entry.

github.com/example/leading-two - a second leading entry for the gate.

## Html Anchors

- <a href="https://github.com/example/anchor-tool">anchor-tool</a> - an inline html anchor pair becomes the item's identity.
- <a href="https://github.com/example/badge-anchor"><img src="https://example.com/badge.svg" alt="badge"></a> - an image-only anchor carries the list face's identity, titled by the repo name.
- <a href="https://github.com/example">org-profile</a> - an org-only anchor is not a repo link; it stays raw html and emits nothing.
- <a href="https://github.com/user/repo-b">dead-anchor</a> - a dead anchor drops the entry and lifts its child.
  - [anchor-child](https://github.com/example/anchor-child) - the lifted child.

A split anchor: <a href="https://github.com/example/split-anchor">the open tag's paragraph

</a> and its close tag sit in different paragraphs, so no pair forms and no entry appears.

## Inline Code And Labels

- [github.com/example/inline-code](https://github.com/example/inline-code) - a URL text inside a link label is never double-linkified.
- [plain-tool](https://github.com/example/plain-tool) - keeps this section above the gate.
- `github.com/example/in-code` - a URL inside inline code never linkifies.

<details><summary><b><a href="https://github.com/example/details-anchor">details-anchor</a></b> stays block html</summary>

The anchor inside a details-summary block html is not rewritten; the summary
text stays the section title and the section holds no items.

</details>
