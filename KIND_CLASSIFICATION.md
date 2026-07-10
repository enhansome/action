# `kind` classification: registry vs repository

Status of the per-item `kind` field introduced in commit `99fe942` ("feat: item
kinds"). That commit shipped a classifier that failed on the majority of real
awesome-lists; this doc records the failure, the intermediate fixes, and the
layered classifier + `kind_provenance` that replaced the content-only rule.

## TL;DR

- **Original bug:** a README was a `registry` iff it had ≥20 *GitHub* links in
  *Markdown list items*. Three independent blind spots misclassified ~29 of 49
  awesome-lists in `jbhuang0604/awesome-computer-vision` as `repository`.
- **Simple fixes applied (earlier session):** count *all* outbound links
  (structure- and target-agnostic), and judge targets by their **rendered HTML**
  (format-agnostic). Threshold recalibrated to **50**.
- **Fine-tuning (done):** content counting has a hard ceiling — popular software
  has link-heavy READMEs (`nodejs/node` ~662 anchors, `webpack` ~403), so no
  link threshold separates registries from projects. Replaced the content-only
  rule with a **layered, precision-first classifier** that emits `kind` *and*
  `kind_provenance`. See "Fine-tuning (done)" below.
- **Result:** every awesome-list target in the source now classifies as
  `registry` (50/50 live audit, including the 6 previously-deferred sparse-link
  ones); clean-project precision ~99.6%. Hermetic + live suites green.

---

## Background

Every item emitted to `README.json` carries a `kind`:

- **`registry`** — a directory that exists for discovery (an awesome-list).
- **`repository`** — a terminal, consumable project.

The source document also gets a `metadata.kind`, computed the same way each
target is classified. The intent (per the code comments) was for the emitted
`kind` to be **trustworthy standalone** — not requiring a downstream system to
fix it up.

## The problem, in detail

The classification primitive was `countListEntries` (`src/markdown.ts`):

> Count Markdown `listItem` nodes whose subtree contains a **GitHub** link. A
> README with ≥ `REGISTRY_MIN_ENTRIES` (20) of them is a `registry`.

That definition conflates *"is this an awesome-list"* with *"does this README
contain ≥20 GitHub links in a bulleted list."* It is wrong in three independent
ways, all observed in the computer-vision source:

### 1. Link-target bias (the big one)

A registry is a directory of **links**, not a directory of *GitHub* links.
Paper-lists, dataset-lists, survey-lists, and course-lists point at arXiv,
project pages, DOIs, and Kaggle — rarely GitHub. The GitHub-only counter scored
them near zero.

| Repo | Truth | GitHub list-items (old) |
|---|---|---|
| `ericjang/awesome-graphics` | registry (209 entries) | **0** GitHub links |
| `vsitzmann/awesome-implicit-representations` | registry (88 entries) | 13 |
| `openMVG/awesome_3DReconstruction_list` | registry (entries in a **table**) | 0 list-items |

### 2. Non-Markdown READMEs

`getReadme` fetched the raw README and the code parsed it with `remarkParse`
(Markdown). `awesomedata/awesome-public-datasets` is **reStructuredText**
(`README.rst`, 211 KB). Its links use RST syntax `` `text <url>`_ ``, which
remark does not recognize → **0 links counted** → `repository`. It is one of the
most-cited dataset registries on GitHub (922+ entries).

### 3. Markdown tables

`countListEntries` only visited `listItem` nodes. A registry rendered as a
Markdown **table** has no list items → count 0. (`openMVG` above is this case:
its entries literally say "Tables use alphabetical order.")

### Magnitude

Of 72 items in the enhanced computer-vision JSON, **47 were labeled `repository`**
and **29 of those were `Awesome*`-titled registries** (~40% of all items wrong).
The 25 that survived as `registry` were merely the narrow subset whose entries
*are* GitHub repos in a Markdown bulleted list.

### Why CI stayed green

The classifier never threw — a low count is a valid `repository` result, and a
dead link defaults to `repository`. The golden fixtures were regenerated in the
same commit that introduced the bug, so they asserted the broken output. The
only signal that anything was wrong was the JSON itself. One live test even
*pinned* the bug, asserting `openMVG/awesome_3DReconstruction_list` →
`repository` under a comment calling it "the accepted blind spot."

---

## Fixes applied (the "simple" pass)

### Fix 1 — count all outbound links

`countListEntries` → **`countResourceLinks`** (`src/markdown.ts`): counts every
link whose URL is not a same-page `#` anchor, regardless of structure (list,
table, prose) or target (GitHub, arXiv, dataset, project page). Same-page
anchors are excluded so a project README's Table of Contents does not inflate
the count.

This alone fixes the link-target bias **and** the table case (table-cell links
are `link` nodes in mdast): `openMVG` jumps from 0 to **176**.

`findFirstGitHubLink` is deliberately left untouched — it still drives item
*identity* and section sparsity, which must stay GitHub-specific.

### Fix 2 — format-agnostic via rendered HTML

`classifyKind` now fetches the target's **rendered HTML**
(`getReadme(octokit, owner, repo, 'html')`) and counts `<a href>` anchors via
**`countOutboundAnchors`**. GitHub renders every README format (Markdown, RST,
AsciiDoc) to the same HTML, so the counter sees the links a reader sees.

This is what fixes the RST case: `awesomedata/awesome-public-datasets` goes from
6 (raw Markdown) to **2645** HTML anchors.

No new dependency — GitHub's rendered HTML uses double-quoted `href`, so a
targeted scan is exact without an HTML parser.

> The **source** README is still counted from Markdown (`countResourceLinks`),
> because the source is always Markdown and the enhancer already holds it as a
> parsed tree. Both counters measure outbound links against the one threshold.

### Fix 3 — recalibrated threshold

`REGISTRY_MIN_ENTRIES = 20` → **`REGISTRY_MIN_LINKS = 50`**, calibrated against
real READMEs on the new counter:

| | Range | Examples |
|---|---|---|
| Projects | 2 – 37 links | `liuliu/ccv` 17, `chalk/chalk` 37 |
| Registries (content-detectable) | 66 – 2453 | `vsitzmann` 88 … `awesome-machine-learning` 1301 |

50 sits between them with double-digit margin on both sides.

---

## Where we are now

| Suite | State |
|---|---|
| Hermetic (`npm test`) | **222 passed**, 58 skipped (live tests skip without a token) |
| Live (`GITHUB_TOKEN` set) | representative suite green (source, registries, project guards, openMVG + ericjang + vsitzmann + awesomedata) |
| Full audit (`RUN_KIND_AUDIT=1`) | **50 / 50 registries green** — including the 6 formerly-deferred sparse-link ones |
| typecheck / lint / build | clean |

Every awesome-list target in the source now classifies as `registry` (the 6
sparse-link registries that content couldn't reach are recovered by the name/
description anchors). The four headline cases stay green: non-GitHub-link lists,
table-based lists, and the RST README. `openMVG` (the case that once *pinned*
the bug) asserts `registry`.

### Test layout (`src/live.test.ts`)

- `describeLive` — token-gated, runs with `GITHUB_TOKEN` set.
- `describeHeavy` — the full audit, additionally gated behind `RUN_KIND_AUDIT=1`
  (~50 README fetches; run on demand after a fix).
- The former `DEFERRED` `it.skip.each` block is now live — those 6 sparse-link
  registries pass on non-content anchors.

---

## The residue (resolved by the layered classifier)

Six registries have so few outbound links that **no link threshold can catch
them** — they overlap with or fall below real project READMEs:

| Repo | HTML links | Description | Why missed by content |
|---|---|---|---|
| `jphall663/awesome-machine-learning-interpretability` | 5 | "A curated list…" | below project range |
| `weihaox/awesome-image-translation` | 12 | "Collection of awesome resources…" | below project range |
| `weihaox/awesome-neural-rendering` | 16 | "Resources of Neural Rendering" | below project range |
| `subeeshvasu/Awesome-ImageHarmonization` | 29 | *(none)* | below threshold, no description |
| `heyalexej/awesome-images` | 37 | "A curated list…" | ties `chalk` (37) |
| `yenchenlin/awesome-adversarial-machine-learning` | 48 | "A curated list…" | just under 50 |

`chalk/chalk` (a project) has **37** HTML links; `heyalexej/awesome-images` (a
registry) has **37**. They are indistinguishable by link count — which is the
proof that **content counting is the wrong primary signal**. All six are now
recovered by non-content anchors (the `awesome-*` name, or the "curated list"
description); see the layered classifier below.

---

## Fine-tuning (done)

The classifier is **layered and precision-first**: the anchors that are ~0%
false-positive fire first (and need no README fetch), and content (`htmlLinks`)
is demoted to a high-threshold recall backstop that only runs when no anchor
fires. Each layer also emits `kind_provenance`, so a downstream consumer can
treat `membership`/`name`/`topic`-derived kinds as hard and
`description`/`content`-derived ones as soft.

The design was chosen by sweeping techniques against a 1004-repo labeled
dataset (746 registries from `sindresorhus/awesome` + the CV source, 258
projects from GitHub search) — the dataset, sweeps, and a synthesis are under
`tools/kind-tuning/` (see "How it was tuned" below).

### The classifier (`src/markdown.ts` `classifyKind`, first match wins)

1. **`sindresorhus/awesome` membership → `registry`** (`membership`). The cached
   member set is parsed from the `sindresorhus/awesome` README's markdown link
   list (scoped to list entries, NOT the HTML sponsor badges — those would import
   garbage and break the 0%-FP property). Fetched once per run; degrades to empty
   on failure. 0% project false-positives (the unbiased strength; its recall is
   inflated on the tuning set since most positives are sourced from it).
2. **`awesome-list` GitHub topic → `registry`** (`topic`). Free — `topics` rides
   on the `/repos` call `getRepoInfo` already makes for badges. ~0% FP.
3. **Name `/\bawesome\b|\bawsome\b/i` → `registry`** (`name`). Word-boundary so it
   does NOT fire on `awesome_print` (underscore = word char). The `\bawsome\b`
   alternation covers the common misspelling. This is the dominant recall signal
   for the CV lists (47/50 are `awesome-*`-named; only 12/50 carry the topic).
4. **Description regex → `registry`** (`description`).
   `/(curated (?:list|collection)|a list of|collective list|cheat\s?sheet)/i` —
   tight, list-proximate phrasing. Bare `collection of`/`curated` are excluded:
   they flip popular real projects (`gitignore`, `PowerToys`, `iptv`, `SecLists`)
   for ~0 recall gain.
5. **Content `htmlLinks ≥ REGISTRY_CONTENT_BACKSTOP_LINKS` (700) → `registry`**
   (`content`, soft). Only fetched when no anchor fires (most targets skip the
   README fetch entirely). Required for dense, convention-free lists no anchor
   signals (`timzhang642/3D-Machine-Learning` 810 links,
   `abhineet123/Deep-Learning-for-Tracking-and-Detection` 737). 700 sits above
   ~all software (clean-project p90 ≈ 106); the only clean FP is `openclaw` (749).
6. **Else → `repository`** (`default`).

The source README's own `metadata.kind` stays on the mdast counter
(`countResourceLinks ≥ REGISTRY_MIN_LINKS = 50`) — the source is always Markdown
and is almost always an awesome-list by construction; that path is unchanged.

### Why content is a backstop, not the primary signal

The earlier "projects top out at 37 (chalk/ccv)" was a small-sample artifact.
On the broad dataset, real software reaches hundreds-thousands of README links:
`nodejs/node` 662, `webpack` 403, `bun` 318, `openclaw` 749. The clean-project
link distribution (p50≈36, p90≈106) overlaps registries (p50≈142, p75≈278) so
heavily that **no content threshold separates the classes** — a low threshold
flips popular software (the old precision bug at scale), and a high one abandons
dense lists. Content is a recall backstop; precision comes from the anchors.

### Provenance

`kind_provenance` is emitted on every `JsonItem` and on `metadata`. Per-layer
error rates measured on the dataset: `membership` 0%, `name` 0%, `topic` ~12%
(all ambiguous boundary repos), `description` ~33%, `content` ~36%. That spread
is the point — downstream can grade confidence for free.

### Honest ceiling (clean projects, n=230)

Precision ~99.6%, recall ~98.9%, F1 ~99.3%. The ~3 clean false-positives
(`openclaw`, `nodejs/node` via the content backstop; `PayloadsAllTheThings` via
its "A list of useful payloads" description) and ~8 irreducible false-negatives
(non-English descriptions, generic descriptions like `modelcontextprotocol/servers`)
are the known boundary. The one subjective call — accepting `openclaw` as a soft
FP so the content backstop can catch dense lists the audit requires — is a single
threshold change if precision is ever prioritized over that recall.

## How it was tuned

`tools/kind-tuning/` holds the reproducible harness (data outputs gitignored):

- `build-dataset.mjs` — assembles + fetches the labeled corpus (positives from
  `sindresorhus/awesome` + CV; negatives from GitHub star-search, curated: 20
  relabeled link-directories → registry, 28 boundary cases flagged
  `ambiguous`). Parity-checks `countOutboundAnchors` against pinned values.
- `lib.mjs` — shared `evaluate()` (precision/recall/F1) so sweeps are comparable.
- `experiments/*.mjs` — the per-technique sweeps (threshold, topic, description,
  name, membership, irreducible tail) + `synthesis.mjs`.

The sweeps were run by parallel subagents (one per technique) over the dataset,
returning structured findings; the final layering + parameters are the judged
synthesis of those findings, not a single agent's proposal.

## Files of interest

- `src/markdown.ts` — `classifyKind` (layered), `parseAwesomeMembers` /
  `fetchAwesomeMembers`, `countResourceLinks` (source, mdast),
  `countOutboundAnchors` (targets, HTML), `REGISTRY_MIN_LINKS` (source),
  `REGISTRY_CONTENT_BACKSTOP_LINKS` (target backstop), `KindProvenance`.
- `src/github.ts` — `getRepoInfo` now also returns `description` + `topics`;
  `getReadme(octokit, owner, repo, format)`.
- `src/live.test.ts` — representative suite + full 50-target audit (the former
  `DEFERRED` block is now live — those sparse registries pass on the name/
  description anchors).
- `src/markdown.test.ts`, `src/markdown.golden.test.ts`, `src/orchestrator.test.ts`
  — updated to the new primitive (HTML mocks for targets).
