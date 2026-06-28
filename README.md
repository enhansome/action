# enhansome/action

A GitHub **composite action** that enhances an "awesome list" markdown file with
GitHub repo metadata - ⭐ stars, 🐛 open issues, 🌐 language, 📅 last push
(⚠️ Archived for archived repos) - and emits a structured `README.json`.

> **Private-use.** Maintained for the `enhansome` org's enhanced-list repos; not
> intended for third-party use.

It is **self-contained**: given an `original_repository`, it fetches that repo's
README over the GitHub API, enhances it, writes `README.md` + `README.json`, and -
unless `auto_commit: false` - commits and pushes the result. The consumer workflow
is just `checkout → action`.

## Inputs

| input | required | default | description |
|---|---|---|---|
| `original_repository` | **yes** | - | Source list to fetch + enhance: `owner/repo` or a `github.com` URL. Its README is fetched over the API. |
| `github_token` | no | - | Token for API calls (README + metadata). Omit to fetch anonymously (rate-limited, 60/hr). |
| `markdown_file` | no | `README.md` | **Output** path for the enhanced markdown, relative to `working_directory`. |
| `working_directory` | no | `.` | Directory to operate in / write to. |
| `json_output_file` | no | `auto` | `auto` → `<base>.json`; empty disables JSON output. |
| `find_and_replace` | no | - | Lines of `find_string:::replace_string`. |
| `regex_find_and_replace` | no | - | Lines of `pattern:::replacement_string` (`gm` flags). |
| `disable_branding` | no | `false` | Suppress the " with stars" title suffix. |
| `sort_by` | no | - | `stars` or `last_commit`. |
| `relative_link_prefix` | no | - | Prefix prepended to relative links in the source README, e.g. `https://github.com/<owner>/<repo>/blob/<branch>/` so they resolve against the source repo. |
| `auto_commit` | no | `true` | Commit & push the result via `git-auto-commit-action`. Needs `permissions: contents: write` + checkout `persist-credentials: true`. Set `false` to only write files. |

## Usage

```yaml
name: Enhance Awesome List
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
permissions:
  contents: write          # required for the default auto_commit
jobs:
  enhance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7   # persist-credentials defaults to true
      - uses: enhansome/action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          original_repository: NARKOZ/guides
          sort_by: stars
```

The action fetches `NARKOZ/guides`'s README, enhances it, writes `README.md` +
`README.json`, and pushes the result. To produce the files without committing
(e.g. to inspect them or commit them yourself), set `auto_commit: false`. The bot
push is authored by `GITHUB_TOKEN`, which does not re-trigger workflows - so this is
loop-safe even under a `push:` trigger.

## Development

| command | what |
|---|---|
| `make test` | vitest unit suite - hermetic, no network |
| `make e2e` | run the integration e2e under `act` |
| `make ci` | the Docker-free checks (vitest + tsc) |

Testing lives in `.github/workflows/test.yml`: the `unit` job runs the hermetic
vitest suite + `tsc`; the `e2e` job drives the full composition - orchestration +
action + asserts - through `act` and CI.

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
`pull-requests: write`) - not `GITHUB_TOKEN`, because a `GITHUB_TOKEN`-authored
merge doesn't trigger the follow-on run that moves the tags.

[rp]: https://github.com/googleapis/release-please
[cc]: https://www.conventionalcommits.org
