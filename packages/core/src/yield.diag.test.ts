import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import type { Heading, Link, List, Root } from 'mdast';
import type { Node, Parent } from 'unist';

import { parseGitHubUrl } from './github.js';
import type { JsonNode, JsonOutput } from './markdown.js';
import {
  countLinkedItems,
  findTitleSlotIndex,
  isStructuralHeading,
  normalizeGitHubUrls,
} from './markdown.js';
import { silentLog } from './logger.js';
import { enhance } from './orchestrator.js';

// Yield harness — the measurement instrument for parser-yield work
// (progress/empty-tree-parses.md). Runs the real `enhance()` (offline repo
// info) over a corpus of fetched READMEs and reports, per registry and
// fleet-wide, how many distinct GitHub repos the document links vs how many
// the parser emits, with every lost repo attributed to the structural location
// that lost it. Attribution reuses the parser's own walk rules (exported from
// markdown.ts) so the buckets stay true as those rules change.
//
// Skipped unless YIELD_DIR points at the corpus — normal `yarn test` never
// runs it. Corpus fetch command and report interpretation: the progress file's
// Method section.

vi.mock('./github.js', async () => {
  const actual =
    await vi.importActual<typeof import('./github.js')>('./github.js');
  const { offlineGetRepoInfo, offlineMakeOctokit } = await import(
    './offline-github.js'
  );
  return {
    ...actual,
    makeOctokit: offlineMakeOctokit,
    getRepoInfo: offlineGetRepoInfo,
  };
});

// The gate the harness attributes "gated" links by; must match the minLinks
// the orchestrator passes in SortOptions.
const MIN_LINKS = 2;

const LOSS_BUCKETS = [
  'table',
  'blockquote',
  'heading',
  'paragraph',
  'preamble',
  'gated',
  'list',
  'other',
] as const;
type LossBucket = (typeof LOSS_BUCKETS)[number];
type BucketCounts = Record<LossBucket, number>;

function emptyBuckets(): BucketCounts {
  return Object.fromEntries(LOSS_BUCKETS.map(b => [b, 0])) as BucketCounts;
}

// The index of the first node a container is open for: the first structural
// heading after the title slot. Before it, top-level lists are preamble — the
// walk never opens a section for them (processTree's open rule).
function firstContainerIndex(tree: Root, titleSlotIndex: number): number {
  return tree.children.findIndex(
    (node, i) =>
      node.type === 'heading' &&
      i !== titleSlotIndex &&
      isStructuralHeading(node as Heading),
  );
}

interface WalkContext {
  inBlockquote: boolean;
  inHeading: boolean;
  inTable: boolean;
  // The outermost enclosing list, the unit the minLinks gate decides on.
  outerList: List | null;
  outerListRootIndex: number;
  rootParagraph: boolean;
}

function repoKeyOf(url: string): null | string {
  const id = parseGitHubUrl(url);
  return id ? `${id.owner}/${id.repo}`.toLowerCase() : null;
}

function bucketFor(
  ctx: WalkContext,
  firstContainerIdx: number,
): LossBucket {
  if (ctx.inTable) {
    return 'table';
  }
  if (ctx.inBlockquote) {
    return 'blockquote';
  }
  if (ctx.inHeading) {
    return 'heading';
  }
  if (ctx.outerList) {
    if (ctx.outerListRootIndex < firstContainerIdx) {
      return 'preamble';
    }
    return countLinkedItems(ctx.outerList) < MIN_LINKS ? 'gated' : 'list';
  }
  if (ctx.rootParagraph) {
    return 'paragraph';
  }
  return 'other';
}

// Maps every distinct repo linked in the document to the bucket of its FIRST
// occurrence in document order — the bucket held responsible when the repo is
// lost overall.
function classifyFirstOccurrences(
  tree: Root,
  firstContainerIdx: number,
): Map<string, LossBucket> {
  const first = new Map<string, LossBucket>();

  const walk = (node: Node, ctx: WalkContext): void => {
    if (node.type === 'link') {
      const key = repoKeyOf((node as Link).url);
      if (key && !first.has(key)) {
        first.set(key, bucketFor(ctx, firstContainerIdx));
      }
    }
    let childCtx = ctx;
    if (node.type === 'table') {
      childCtx = { ...ctx, inTable: true };
    } else if (node.type === 'blockquote') {
      childCtx = { ...ctx, inBlockquote: true };
    } else if (node.type === 'heading') {
      childCtx = { ...ctx, inHeading: true };
    } else if (node.type === 'list' && !ctx.outerList) {
      childCtx = { ...ctx, outerList: node as List };
    }
    const children = (node as Parent).children;
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child, childCtx);
      }
    }
  };

  tree.children.forEach((child, index) => {
    walk(child, {
      inBlockquote: false,
      inHeading: false,
      inTable: false,
      outerList: null,
      outerListRootIndex: index,
      rootParagraph: child.type === 'paragraph',
    });
  });
  return first;
}

function gotRepos(json: JsonOutput): Set<string> {
  const got = new Set<string>();
  const visitNode = (node: JsonNode): void => {
    if (node.node_type === 'item') {
      got.add(
        `${node.repo_info.owner}/${node.repo_info.repo}`.toLowerCase(),
      );
    }
    for (const child of node.children) {
      visitNode(child);
    }
  };
  for (const section of json.items) {
    for (const node of section.items) {
      visitNode(node);
    }
  }
  return got;
}

interface RegistryRow {
  slug: string;
  expected: number;
  got: number;
  lostByBucket: BucketCounts;
}

const corpusDir = process.env.YIELD_DIR;
const describeYield = corpusDir ? describe : describe.skip;

describeYield('yield harness', () => {
  it(
    'fleet yield report',
    async () => {
      const files = fs
        .readdirSync(corpusDir!)
        .filter(f => f.endsWith('.md'))
        .sort();
      expect(files.length).toBeGreaterThan(0);

      const processor = unified().use(remarkParse).use(remarkGfm);
      const unionExpected = new Set<string>();
      const unionGot = new Set<string>();
      // First fleet-wide occurrence of each repo -> the bucket charged with it.
      const fleetFirstBucket = new Map<string, LossBucket>();
      const rows: RegistryRow[] = [];

      for (const [fileNumber, file] of files.entries()) {
        const content = fs.readFileSync(path.join(corpusDir!, file), 'utf-8');
        // The parser linkifies bare URLs and inline anchors before walking
        // (normalizeGitHubUrls), so the expected model must too — otherwise
        // repos that only exist as text/anchors land in `got` while being
        // invisible to `expected`.
        const tree = processor.parse(content) as Root;
        normalizeGitHubUrls(tree);
        const titleSlotIndex = findTitleSlotIndex(tree);
        const first = classifyFirstOccurrences(
          tree,
          firstContainerIndex(tree, titleSlotIndex),
        );
        const expected = new Set(first.keys());

        const { jsonData } = await enhance({
          content,
          disableBranding: true,
          log: silentLog,
          originalRepository: `corpus/${file}`,
          token: 'yield-harness',
        });
        const got = gotRepos(jsonData);

        const lostByBucket = emptyBuckets();
        for (const repo of expected) {
          if (!got.has(repo)) {
            lostByBucket[first.get(repo) as LossBucket]++;
          }
          unionExpected.add(repo);
          if (!fleetFirstBucket.has(repo)) {
            fleetFirstBucket.set(repo, first.get(repo) as LossBucket);
          }
        }
        for (const repo of got) {
          unionGot.add(repo);
        }
        rows.push({
          slug: file.slice(0, -3),
          expected: expected.size,
          got: got.size,
          lostByBucket,
        });

        if ((fileNumber + 1) % 500 === 0) {
          console.log(`yield: ${fileNumber + 1}/${files.length} files`);
        }
      }

      const fleetLost = emptyBuckets();
      for (const [repo, bucket] of fleetFirstBucket) {
        if (!unionGot.has(repo)) {
          fleetLost[bucket]++;
        }
      }

      const banded = rows.filter(r => r.expected >= 10);
      // Baseline comparison bands: 0, (0, 0.5), [0.5, 0.9), [0.9, 1), == 1.
      const frac = (r: RegistryRow) => r.got / r.expected;
      const low = banded.filter(r => r.got > 0 && frac(r) < 0.5).length;
      const mid = banded.filter(r => frac(r) >= 0.5 && frac(r) < 0.9).length;
      const high = banded.filter(r => frac(r) >= 0.9 && frac(r) < 1).length;
      const perfect = banded.filter(r => r.got === r.expected).length;
      const zero = banded.filter(r => r.got === 0).length;
      const zeroGot = rows.filter(r => r.got === 0).length;

      const yieldPct = (100 * unionGot.size) / unionExpected.size;
      const worst = [...rows]
        .sort(
          (a, b) =>
            b.expected - b.got - (a.expected - a.got),
        )
        .slice(0, 15);

      console.log('=== YIELD REPORT ===');
      console.log(
        `registries: ${rows.length} (expected >= 10: ${banded.length})`,
      );
      console.log(
        `population yield: ${unionGot.size}/${unionExpected.size} = ${yieldPct.toFixed(1)}%`,
      );
      console.log(
        `bands (expected >= 10): zero=${zero} low=${low} mid=${mid} high=${high} perfect=${perfect} | registries with got=0: ${zeroGot}`,
      );
      console.log(
        `lost by bucket: ${LOSS_BUCKETS.map(b => `${b}=${fleetLost[b]}`).join(' ')}`,
      );
      for (const row of worst) {
        const dominant = LOSS_BUCKETS.reduce((best, b) =>
          row.lostByBucket[b] > row.lostByBucket[best] ? b : best,
        );
        console.log(
          `  ${row.slug}: ${row.got}/${row.expected} (${dominant} ${row.lostByBucket[dominant]})`,
        );
      }

      const reportPath = path.resolve(corpusDir!, '..', 'yield-report.json');
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            fleet: {
              registries: rows.length,
              expected: unionExpected.size,
              got: unionGot.size,
              yieldPct,
              lostByBucket: fleetLost,
            },
            registries: rows,
          },
          null,
          2,
        ),
      );
      console.log(`report: ${reportPath}`);

      expect(unionExpected.size).toBeGreaterThan(0);
      expect(yieldPct).toBeGreaterThan(0);
      expect(yieldPct).toBeLessThanOrEqual(100);
    },
    900_000,
  );
});
