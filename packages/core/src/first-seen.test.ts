import { describe, expect, it, vi } from 'vitest';

import type { JsonItem, JsonNode, JsonOutput } from './markdown.js';
import { enhance } from './orchestrator.js';

vi.mock('./github.js', async () => {
  const actual =
    await vi.importActual<typeof import('./github.js')>('./github.js');
  const { offlineGetRepoInfo: getRepoInfo, offlineMakeOctokit } = await import(
    './offline-github.js'
  );
  return { ...actual, makeOctokit: offlineMakeOctokit, getRepoInfo };
});

const RUN_1 = new Date('2026-08-01T00:00:00.000Z');
const RUN_2 = new Date('2026-08-20T00:00:00.000Z');

const CONTENT = `# Awesome Test

## Alpha

- [One](https://github.com/acme/one) - first entry
- [Two](https://github.com/acme/two) - second entry

### Nested

- [Three](https://github.com/acme/three) - nested entry

## Beta

- [Four](https://github.com/acme/four) - beta entry
- [Btwo](https://github.com/acme/btwo) - second beta entry
`;

async function runEnhance(
  content: string,
  now: Date,
  previousJson?: JsonOutput,
): Promise<JsonOutput> {
  const { jsonData } = await enhance({
    content,
    disableBranding: true,
    token: 'test-token',
    now,
    previousJson,
  });
  return jsonData;
}

function itemsOf(json: JsonOutput): JsonItem[] {
  const out: JsonItem[] = [];
  const walk = (nodes: JsonNode[]): void => {
    for (const node of nodes) {
      if (node.node_type === 'item') {
        out.push(node);
      }
      walk(node.children);
    }
  };
  for (const section of json.items) {
    walk(section.items);
  }
  return out;
}

function firstSeenByRepo(
  json: JsonOutput,
): Map<string, string | undefined> {
  return new Map(
    itemsOf(json).map(item => [item.repo_info.repo, item.first_seen]),
  );
}

// A pre-fix mirror's previous output: no first_seen anywhere.
function withoutFirstSeen(json: JsonOutput): JsonOutput {
  const clone = structuredClone(json);
  for (const node of itemsOf(clone)) {
    delete node.first_seen;
  }
  return clone;
}

describe('first_seen: mirror history in the JSON contract', () => {
  it('stamps every item with the run time when no previous output exists', async () => {
    const json = await runEnhance(CONTENT, RUN_1);

    expect(json.metadata.last_updated).toBe(RUN_1.toISOString());
    const byRepo = firstSeenByRepo(json);
    expect(byRepo.get('one')).toBe(RUN_1.toISOString());
    expect(byRepo.get('two')).toBe(RUN_1.toISOString());
    expect(byRepo.get('three')).toBe(RUN_1.toISOString());
    expect(byRepo.get('four')).toBe(RUN_1.toISOString());
    expect(byRepo.get('btwo')).toBe(RUN_1.toISOString());
  });

  it('never stamps group nodes', async () => {
    const json = await runEnhance(CONTENT, RUN_1);

    const groups: JsonNode[] = [];
    const walk = (nodes: JsonNode[]): void => {
      for (const node of nodes) {
        if (node.node_type === 'group') {
          groups.push(node);
        }
        walk(node.children);
      }
    };
    for (const section of json.items) {
      walk(section.items);
    }
    expect(groups.map(group => group.title)).toContain('Nested');
    for (const group of groups) {
      expect('first_seen' in group).toBe(false);
    }
  });

  it('carries first_seen verbatim for already-listed repos and stamps only new ones', async () => {
    const run1 = await runEnhance(CONTENT, RUN_1);
    const withFive = CONTENT.replace(
      '- [Four](https://github.com/acme/four) - beta entry',
      '- [Four](https://github.com/acme/four) - beta entry\n- [Five](https://github.com/acme/five) - new entry',
    );

    const run2 = await runEnhance(withFive, RUN_2, run1);

    const byRepo = firstSeenByRepo(run2);
    expect(byRepo.get('one')).toBe(RUN_1.toISOString());
    expect(byRepo.get('two')).toBe(RUN_1.toISOString());
    expect(byRepo.get('three')).toBe(RUN_1.toISOString());
    expect(byRepo.get('four')).toBe(RUN_1.toISOString());
    expect(byRepo.get('btwo')).toBe(RUN_1.toISOString());
    expect(byRepo.get('five')).toBe(RUN_2.toISOString());
  });

  it('treats a repo dropped everywhere and re-added as new', async () => {
    const run1 = await runEnhance(CONTENT, RUN_1);
    // The intermediate run's output: Two was dropped everywhere.
    const withoutTwo = structuredClone(run1);
    const alpha = withoutTwo.items.find(section => section.title === 'Alpha');
    if (!alpha) {
      throw new Error('fixture output has no Alpha section');
    }
    alpha.items = alpha.items.filter(
      node => !(node.node_type === 'item' && node.repo_info.repo === 'two'),
    ) as JsonNode[];

    const run2 = await runEnhance(CONTENT, RUN_2, withoutTwo);

    const byRepo = firstSeenByRepo(run2);
    expect(byRepo.get('two')).toBe(RUN_2.toISOString());
    expect(byRepo.get('one')).toBe(RUN_1.toISOString());
  });

  it('keeps dates when sections are renamed or restructured', async () => {
    const run1 = await runEnhance(CONTENT, RUN_1);
    const restructured = CONTENT.replace('## Alpha', '## Gamma').replace(
      '### Nested',
      '### Reorganized',
    );

    const run2 = await runEnhance(restructured, RUN_2, run1);

    const byRepo = firstSeenByRepo(run2);
    expect(byRepo.get('one')).toBe(RUN_1.toISOString());
    expect(byRepo.get('three')).toBe(RUN_1.toISOString());
  });

  it('gives the same repo listed in two sections one carried date', async () => {
    const run1 = await runEnhance(CONTENT, RUN_1);
    const dup = CONTENT.replace(
      '- [Two](https://github.com/acme/two) - second entry',
      '- [Two](https://github.com/acme/two) - second entry\n- [Four too](https://github.com/acme/four) - cross-listed',
    );

    const run2 = await runEnhance(dup, RUN_2, run1);

    const fours = itemsOf(run2).filter(
      item => item.repo_info.repo === 'four',
    );
    expect(fours).toHaveLength(2);
    for (const four of fours) {
      expect(four.first_seen).toBe(RUN_1.toISOString());
    }
  });

  it('keeps dates when a listed repo is renamed or transferred', async () => {
    const run1 = await runEnhance(CONTENT, RUN_1);
    // The previous output has the pre-rename spelling; only the id survives.
    const renamed = structuredClone(run1);
    const alpha = renamed.items.find(section => section.title === 'Alpha');
    if (!alpha) {
      throw new Error('fixture output has no Alpha section');
    }
    const one = alpha.items.find(
      node => node.node_type === 'item' && node.repo_info.repo === 'one',
    );
    if (!one || one.node_type !== 'item') {
      throw new Error('fixture output has no item one');
    }
    one.repo_info = { ...one.repo_info, owner: 'acme-old' };

    const run2 = await runEnhance(CONTENT, RUN_2, renamed);

    expect(firstSeenByRepo(run2).get('one')).toBe(RUN_1.toISOString());
  });

  it('treats pre-fix previous output (no first_seen fields) as no history', async () => {
    const run1 = await runEnhance(CONTENT, RUN_1);

    const run2 = await runEnhance(CONTENT, RUN_2, withoutFirstSeen(run1));

    const byRepo = firstSeenByRepo(run2);
    expect(byRepo.get('one')).toBe(RUN_2.toISOString());
    expect(byRepo.get('four')).toBe(RUN_2.toISOString());
    expect(byRepo.get('btwo')).toBe(RUN_2.toISOString());
  });
});
