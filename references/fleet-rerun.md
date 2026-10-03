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

2026-10-03 (v1.12.0): fleet 2,345 · 2,345 × HTTP 204 · 0 dispatch errors ·
~30 min. Queue drains ~40 min after the last dispatch.

## 4. Status pass — mind the API budget

Per-repo latest run (`gh run list --repo … --workflow enhance.yml --limit 1`)
via `xargs -P 4`. The wave plus a full pass plus log views can exhaust the
5,000/hr core quota **and** trip the secondary (abuse) rate limiter — the
secondary fires even with quota showing full, and retrying extends it.
Stage the pass, sample the drained tail, and back off ~30 min on the first
403 instead of retrying.

## 5. Failure families

| family | signature | remedy |
|---|---|---|
| push race | `failed to push some refs` / `! [rejected] main -> main (non-fast-forward)` — a concurrent run pushed between checkout and push | re-dispatch; succeeds |
| hollow-guard refusal | `Refusing to write a hollow mirror: … under 5% of the previous output's items` when the release legitimately removes items (v1.12's self-link exclusion: old trees that were 100% self-repo nav items — cms 69/69, iptv 37/37, package-manager 1/1) | investigate confirms the collapse is the release working → owner-consented baseline reset: commit `README.json` with `items: []` and metadata kept (`contents` PUT), re-dispatch → the honest tree writes |
| dead upstream | source fetch 404s | nothing to fix; add to the exclusion list above |

2026-10-03 final: 2,343 success · 1 dead upstream · 2 push races re-dispatched
to green · 3 baseline resets (owner-consented) writing near-empty trees.
