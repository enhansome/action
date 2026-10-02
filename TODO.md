# TODO — open-work index

## core
- **Best-of details entries lose their annotation and category** · HIGH · [packages/core] → progress/details-summary-entries.md
- **Table annotation cells never reach item descriptions** · MEDIUM · [packages/core]
  Rows like android-root's category tables carry real annotation in a non-link cell, but the emitted item shows the owner/name fallback instead — the cell's text is dropped on the floor.
- **Zero-width characters in link URLs parse to mojibake repo names** · LOW · [packages/core]
  An item linked by a URL with an invisible zero-width character (awesome-computer-vision's NeuralTalk line) shows `%EF%BB%BF` in its repo name and description.

## Parked
- **Non-repo resources in output** — revisit when webapp's v2 data model exists and its "Index non-repo resources linked from registries" thread asks for the emission side
  Registry links to non-repo resources (YouTube, docs, app sites) emit no items, so registries made of them index as near-empty.

## Out of scope
- **Per-README repo dedupe** — webapp's global one-node-per-repo dedupe owns it, unless mirrors must be dupe-free in themselves
