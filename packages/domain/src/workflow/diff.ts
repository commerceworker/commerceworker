/**
 * What changed between two workflow graphs, ignoring layout. The copilot returns it as
 * `changes`, and the editor's proposal banner shows `describeDiff` before anything is applied.
 */

import type { WorkflowGraph, WorkflowNode } from './graph-types';

/** Counted against the graph a proposal started from. */
export interface WorkflowGraphChanges {
  added: number;
  removed: number;
  edited: number;
  rewired: number;
}

/** What changed between two graphs, ignoring layout. */
export function graphDiff(before: WorkflowGraph, after: WorkflowGraph): WorkflowGraphChanges {
  const strip = (n: WorkflowNode) => JSON.stringify({ ...n, position: null });
  const b = new Map(before.nodes.map((n) => [n.id, strip(n)]));
  const a = new Map(after.nodes.map((n) => [n.id, strip(n)]));
  const eb = new Set(before.edges.map((e) => `${e.source}:${e.sourceHandle ?? ''}>${e.target}`));
  const ea = new Set(after.edges.map((e) => `${e.source}:${e.sourceHandle ?? ''}>${e.target}`));
  return {
    added: [...a.keys()].filter((id) => !b.has(id)).length,
    removed: [...b.keys()].filter((id) => !a.has(id)).length,
    edited: [...a].filter(([id, v]) => b.has(id) && b.get(id) !== v).length,
    rewired: [...ea].filter((k) => !eb.has(k)).length + [...eb].filter((k) => !ea.has(k)).length,
  };
}

/** "2 steps added, 1 edited", or null when nothing but layout changed. */
export function describeDiff(c: WorkflowGraphChanges): string | null {
  const parts = [
    c.added ? `${c.added} step${c.added === 1 ? '' : 's'} added` : '',
    c.removed ? `${c.removed} removed` : '',
    c.edited ? `${c.edited} edited` : '',
    c.rewired ? `${c.rewired} connection${c.rewired === 1 ? '' : 's'} changed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
