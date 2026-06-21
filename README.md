# enhansome/action

A GitHub **Docker action** that enhances an "awesome list" markdown file with
GitHub repo metadata — ⭐ stars, 🐛 open issues, 🌐 language, 📅 last push
(⚠️ Archived for archived repos) — and emits a structured `README.json`.

> **Private-use.** Maintained for the `enhansome` org's enhanced-list repos; not
> intended for third-party use.

## Design

This is a **thin action**: it only enhances a markdown file. The surrounding
orchestration — syncing the source list from an `origin` submodule, deriving
`original_repository`, and committing — lives in the **consumer workflow**
(see *Usage*). Keeping the action thin removes the composite/symlink machinery
and lets `act` exercise the orchestration directly in a plain workflow.

## Inputs

| input | required | default | description |
|---|---|---|---|
| `github_token` | no | — | Token for metadata. Omit to fetch anonymously (rate-limited). |
| `markdown_file` | yes | `README.md` | File to enhance, relative to `working_directory`. |
| `working_directory` | no | `.` | Directory containing the file. |
| `json_output_file` | no | `auto` | `auto` → `<base>.json`; empty disables JSON output. |
| `find_and_replace` | no | — | Lines of `find_string:::replace_string`. |
| `regex_find_and_replace` | no | — | Lines of `pattern:::replacement_string` (`gm` flags). |
| `disable_branding` | no | `false` | Suppress the " with stars" title suffix. |
| `sort_by` | no | — | `stars` or `last_commit`. |
| `relative_link_prefix` | no | — | Prefix prepended to relative links. |
| `original_repository` | no | — | `owner/repo` of the source list. |

## Usage (consumer workflow)

This is also the template Phase C generates for each enhanced repo:

```yaml
name: Enhance Awesome List
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  enhance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          submodules: 'true'
      - name: Update + sync origin
        id: origin
        run: |
          set -euo pipefail
          cd origin
          git fetch --all --tags
          DEFAULT_BRANCH=$(git remote show origin | sed -n 's/^.*HEAD branch: //p')
          git checkout "$DEFAULT_BRANCH"
          git pull origin "$DEFAULT_BRANCH" --ff-only
          OWNER_REPO=$(git config --get remote.origin.url \
            | sed -E 's|.*github.com[/:]([^/]+/[^/]+).*|\1|' | sed 's/\.git$//')
          cd ..
          rsync -a origin/README.md ./README.md
          echo "repo=$OWNER_REPO" >> "$GITHUB_OUTPUT"
      - uses: enhansome/action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          markdown_file: README.md
          original_repository: ${{ steps.origin.outputs.repo }}
          sort_by: stars
      - uses: stefanzweifel/git-auto-commit-action@v7
        with:
          commit_message: 'docs(enhance): ✨ Auto-update list with latest content & stars'
          commit_user_name: Enhansome
          commit_user_email: actions-bot@users.noreply.github.com
```

## Development

| command | what |
|---|---|
| `make test` | vitest unit suite — hermetic, no network |
| `make e2e` | run the integration e2e under `act` |
| `make ci` | unit + shellcheck (the Docker-free checks) |

All testing lives in `.github/workflows/test.yml` (see `MIGRATION.md` §A5): the
`unit` job runs the hermetic vitest suite; the `e2e` job drives the full
composition — orchestration + Docker action + asserts — through `act` and CI.

## Releasing

Releases are cut from the **`release/v1`** lane, not `main`:

- `main` keeps `action.yml` → `image: 'Dockerfile'`, so CI (`uses: ./`) and
  `make e2e` (act) build at runtime.
- `release/v1` carries `action.yml` →
  `image: 'docker://ghcr.io/enhansome/enhance-readme:v<version>'`, so consumers
  of `enhansome/action@v1.0.x` pull the prebuilt image instead of rebuilding.
  release-please bumps `<version>` in that line each release.

**To cut a release** (manual sync):

1. Merge `main` into `release/v1`. `action.yml` auto-resolves to the pinned
   image — `main` never edits that line, so the merge won't conflict on it.
2. Push `release/v1`. The `release` workflow runs release-please; on the release
   PR merge it builds + pushes `ghcr.io/enhansome/enhance-readme:vX.Y.Z` (plus
   `vN`, `latest`) and moves the `vN` / `vN.M` git tags so `@v1` stays current.

The `ghcr.io/enhansome/enhance-readme` package must be **Public** (consumers'
runners pull it anonymously). The release workflow needs a `PAT_FOR_RELEASES`
secret (`contents: write`) for release-please and the major-tag move.
