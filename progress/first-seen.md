# Emit first_seen per item — addition dates in the mirror contract

**Status: open — not picked up. Found in the 2026-08-26 webapp MCP capability
test.**

## The defect

Nothing in the pipeline knows when a curator added a listing. The webapp
wipes and re-ingests the whole forest per run, restamping every timestamp
(the test watched all registries sweep 05:46–06:54 in one morning), and
`registry_sources.last_updated` is the mirror's own stamp, swept the same
way. Result: "what got added to curated lists recently" — a core
curation-freshness question — is unanswerable through the product.

Proof of demand from the test: an agent answered "newest additions" anyway by
reverse-engineering GitHub's monotonically-increasing repo ids — clustering
id bands per registry to infer late additions (helm's 199k and 251.7k waves;
a 2.5M-id outlier as an airtight single-tree case). Clever, and it worked;
that it was necessary is the gap.

## Fix sketch

The knowledge lives here, not in the webapp: the enhancer updates each
mirror over time and commits over the previous run's output — the mirror's
history *is* the addition log.

- On each run, diff the parsed items against the previous run's JSON (already
  present in the repo being committed to) and emit `first_seen` per item:
  carried forward verbatim for existing entries, the run timestamp for new
  ones. Removed-then-readded items take the new date (simple, honest).
- Contract delta: `items[].first_seen` (ISO datetime), optional so pre-fix
  mirrors keep parsing.
- Webapp side (theirs, once the contract carries it): store on the
  occurrence row, expose `sort: 'added'` / `addedSince` — forest-wide reads
  the repo's earliest listing, scoped reads the listing's own date. No
  webapp timestamp machinery; their wipe-and-rebuild stays untouched.

Tests first: run the enhancer twice over a fixture with an item added between
runs; assert run-1 entries keep their original date and only the new entry
carries run-2's.
