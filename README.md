# enhansome/action

A GitHub **composite action** that enhances an "awesome list" markdown file with
GitHub repo metadata — ⭐ stars, 🐛 open issues, 🌐 language, 📅 last push
(⚠️ Archived for archived repos) — and emits a structured `README.json`.

> **Private-use.** Maintained for the `enhansome` org's enhanced-list repos; not
> intended for third-party use.

It is a **thin action**: it only enhances a markdown file. Syncing the source
list, deriving `original_repository`, and committing live in the *consumer
workflow* below.

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

## Usage

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
| `make ci` | the Docker-free checks (vitest + tsc) |

Testing lives in `.github/workflows/test.yml`: the `unit` job runs the hermetic
vitest suite + `tsc`; the `e2e` job drives the full composition — orchestration +
action + asserts — through `act` and CI.

## Releasing

Releases are cut from **`main`** by [release-please][rp], driven by
[Conventional Commits][cc]:

| commit | bump |
|---|---|
| `fix: ...` | patch (`1.0.0 → 1.0.1`) |
| `feat: ...` | minor (`1.0.0 → 1.1.0`) |
| `feat!:` / `BREAKING CHANGE:` | major (`1.0.0 → 2.0.0`) |

1. Conventional-commit pushes to `main` accumulate.
2. release-please opens a *release PR* bumping `package.json` /
   `package-lock.json` and staging `CHANGELOG.md`.
3. Merging it creates the `vX.Y.Z` tag + GitHub Release, then the `release`
   workflow moves the `vN` / `vN.M` tags so `enhansome/action@v1` / `@v1.0`
   resolve to the latest release.

The workflow needs a `PAT_FOR_RELEASES` secret (`contents: write` +
`pull-requests: write`) — not `GITHUB_TOKEN`, because a `GITHUB_TOKEN`-authored
merge doesn't trigger the follow-on run that moves the tags.

[rp]: https://github.com/googleapis/release-please
[cc]: https://www.conventionalcommits.org
