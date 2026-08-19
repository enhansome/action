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
| `sort_by` | no | `stars` | `stars` (default) or `last_commit`. Leave empty to keep source order. |
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

## Items vs. groups (`node_type`)

The JSON tree mirrors the source README's heading hierarchy. The shallowest
heading depth present (H1s count — many lists use `# Section` after the title)
opens top-level **sections**; deeper headings nest as `node_type: "group"`
containers, so `section.items → node.children → children…` recurses the document
outline. Two heading kinds are deliberately not structure: text-less headings
(spacers) and table-of-contents headings — a `# Table of Contents` must not wrap
the document.

A node's identity is its **own** link only — a nested descendant's link belongs
to a child, not to the node. So each emitted node is one of two shapes,
discriminated by `node_type`:

- `node_type: "item"` — a genuine GitHub node: a list item whose own paragraph
  links a repo, or a heading that *is* one link to a repo (the
  `#### [Repo](github…)` pattern — emitted as an item with the following prose
  as `description` and the following content as `children`, not as a section
  title). Always carries `repo_info`.
- `node_type: "group"` — a **container** with no GitHub identity of its own: a
  subheading, a "see also" cluster, an entry linked via its website, a category
  wrapping nested GitHub items. Carries `children` only — never a
  `repo_info`, which would amount to borrowing a child's identity.

Both `section.items` and node `children` are arrays of `item | group`. Children
keep document order; under a stars/last-commit sort, groups (which have no repo
data of their own) sink below the items within their list.

Three consequences worth knowing:

- **Dead target links degrade, never fail the run.** A fetch failure on a linked
  target (404 / 401 / 403 / throttle-exhausted / 5xx / network) is skipped with a
  warning and the run continues — awesome-lists carry endemic dead links, so
  failing the whole run on the first one would make daily mirrors unusable. A
  dead link emits nothing: its nested children lift to the nearest live parent.
  (The *source* README fetch is still fatal — there is nothing to enhance
  without it.)
- **Empty containers are dropped.** A section or group with no items anywhere
  beneath it is omitted — structural noise (a heading followed by a heading, a
  TOC, prose-only sections) never reaches `README.json`.
- **Non-GitHub leaves are dropped from the JSON.** A book/paper/note with no
  GitHub link and no nested GitHub children is neither an item nor a group, so it
  is omitted from `README.json` (it remains in the enhanced markdown). Preserving
  these leaves in a separate shape is a future enhancement.

## Root identity

`metadata.original_repository_id` is the source repo's numeric GitHub id — the
stable identity consumers key a tree's root node on (items carry theirs in
`repo_info.id`). It is `null` only when the lookup failed; the run continues and
`original_repository` ("owner/name") stays authoritative for display.

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
   `yarn.lock` and staging `CHANGELOG.md`.
3. Merging it creates the `vX.Y.Z` tag + GitHub Release, then the `release`
   workflow moves the `vN` / `vN.M` tags so `enhansome/action@v1` / `@v1.0`
   resolve to the latest release.

The workflow needs a `PAT_FOR_RELEASES` secret (`contents: write` +
`pull-requests: write`) - not `GITHUB_TOKEN`, because a `GITHUB_TOKEN`-authored
merge doesn't trigger the follow-on run that moves the tags.

[rp]: https://github.com/googleapis/release-please
[cc]: https://www.conventionalcommits.org
