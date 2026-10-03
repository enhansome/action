# Zero-width characters in link URLs parse to mojibake repo names

## Goal

A repo identity parsed from a URL ignores zero-width characters, so awesome-computer-vision's `karpathy/neuraltalk%EF%BB%BF` line emits `karpathy/neuraltalk` with the real repo's info. Done when the fix is merged to main and the TODO entry is gone.

## Current state

Found in the degenerate-descriptions census (PR #26 review): the README's href carries a URL-encoded BOM (`%EF%BB%BF` → U+FEFF) on the repo segment, and it survives into `repo_info.repo`, the title/description fallbacks, and the emitted repo name.

Nothing built yet.

## Next step

Branch `fix/zero-width-urls`; strip zero-width characters (BOM, ZWSP, ZWNJ, ZWJ, word joiner) from owner and repo when `parseGitHubUrl` builds the identity, regenerate goldens, confirm the awesome-computer-vision row.
