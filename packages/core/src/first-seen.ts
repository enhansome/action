import type { JsonNode, JsonOutput } from './markdown.js';

export type FirstSeen = (repoId: number) => string;

export function firstSeenFor(
  previous: JsonOutput | undefined,
  now: Date,
): FirstSeen {
  const index = new Map<number, string>();
  if (previous) {
    for (const section of previous.items) {
      collect(section.items, index);
    }
  }
  return repoId => index.get(repoId) ?? now.toISOString();
}

function collect(nodes: JsonNode[], index: Map<number, string>): void {
  for (const node of nodes) {
    if (node.node_type === 'item' && node.first_seen) {
      const existing = index.get(node.repo_info.id);
      if (existing === undefined || node.first_seen < existing) {
        index.set(node.repo_info.id, node.first_seen);
      }
    }
    collect(node.children, index);
  }
}
