# Fleet rerun — sweeping a new action release across every mirror

Mirrors pin `enhansome/action@v1`, so a released tag rolls out on each
mirror's next run. To sweep the whole fleet at once instead of waiting for
the daily cron:

## 1. Enumerate the fleet by exclusion

Mirror naming is **not** uniformly `enhansome-*` (49 repos like
`go-enhansome`, `enhansome_3DReconstruction_list`) — enumerate by
exclusion, never by prefix:

```sh
gh api users/enhansome/repos --paginate -q '.[].name' \
  | grep -vE '^(action|webapp|enhansome)$' > /tmp/fleet.txt
```

Also exclude mirrors whose upstream is gone — currently
`enhansome-minecraft-hack-clients` (source repo 404s; every run fails at
the source fetch). Their runs fail forever and pollute the status pass.

## 2. Smoke three mirrors, verified at HEAD

Dispatch three mirrors whose content exercises the release's change, wait
~2 min, and verify **at the exact HEAD sha** (the raw CDN serves stale
content right after the push — fetch `README.json?ref=<sha>`):

```sh
gh api -X POST repos/enhansome/<mirror>/actions/workflows/enhance.yml/dispatches \
  -f ref=main        # 204 expected
```

## 3. The wave

One dispatch per repo, **3 parallel workers** with jitter (a single worker
runs ~15 repos/min — 2.5 h; three run ~78/min — ~30 min):

```sh
# per worker: sleep 0.$((RANDOM % 20)); gh api -X POST .../dispatches -f ref=main
```

2026-10-06 (v1.12.1): 2,342 dispatched · 2,342 × HTTP 204 · 0 dispatch
errors · 30 min (10:12–10:42 UTC). Queue drains ~40 min after the last
dispatch.

## 4. Status pass — mind the API budget

Per-repo latest run (`gh run list --repo … --workflow enhance.yml --limit 1`)
via `xargs -P 4`. The wave plus a full pass plus log views can exhaust the
5,000/hr core quota **and** trip the secondary (abuse) rate limiter — the
secondary fires even with quota showing full, and retrying extends it.
Stage the pass, sample the drained tail, and back off ~30 min on the first
403 instead of retrying. The block can outlast 35 min and covers the actions
endpoints only — graphql and the repos/contents endpoints stay free, so a
commit census (graphql, 50 repo aliases per call: an Enhansome commit on the
default branch inside the wave window = the run pushed) tallies the
remainder without touching the blocked path.

## 5. Failure families

| family | signature | remedy |
|---|---|---|
| push race | `failed to push some refs` / `! [rejected] main -> main (non-fast-forward)` — a concurrent run pushed between checkout and push | re-dispatch; succeeds |
| hollow-guard refusal | `Refusing to write a hollow mirror: … under 5% of the previous output's items` when the source legitimately collapses (v1.12's self-link exclusion: old trees that were 100% self-repo nav items — cms 69/69, iptv 37/37, package-manager 1/1; v1.12.1: sources that archived or rescoped away from repo links) | investigate confirms the collapse is real → owner-consented baseline reset: commit `README.json` with `items: []` and metadata kept (`contents` PUT), re-dispatch → the honest tree writes |
| corepack fetch flake | `corepack enable` dies fetching yarn — `Error when performing the request to https://repo.yarnpkg.com/…` / `ECONNRESET` — in setup, before the action runs | re-dispatch; succeeds |
| dead upstream | source fetch 404s | nothing to fix; add to the exclusion list above |

2026-10-06 (v1.12.1) final: 2,340 green on first run · 1 push race and 4
corepack flakes re-dispatched to green · 3 hollow refusals (upstreams
archived or rescoped away from repo links) reset owner-consented, honest
trees written · 2,345/2,345.
