/**
 * Graph validation the editor, the API and the copilot all share, over a domain
 * {@link NodeRegistry}. Plugin node types are deferred, but the registry seam is kept so they can
 * be added without touching the validator.
 */

import { type NodeSpec, specDefaults, specOutputs, validateFields } from './catalog';
import type { WorkflowGraph, WorkflowNode } from './graph-types';
import { NODE_SPECS } from './nodes';
import { edgeHandle, isBackEdge, isTrigger, loopRegion } from './planner';

export interface NodeRegistry {
  spec(type: string): NodeSpec | undefined;
  outputs(type: string, config?: Record<string, unknown>): string[];
  withDefaults(type: string, config?: Record<string, unknown>): Record<string, unknown>;
  validate(type: string, config: Record<string, unknown>): string[];
}

/** A registry over the built-in catalog plus `extra` specs (which may not shadow built-ins). */
export function createNodeRegistry(extra: readonly NodeSpec[] = []): NodeRegistry {
  const byType = new Map<string, NodeSpec>(NODE_SPECS.map((s) => [s.type, s]));
  for (const s of extra) {
    if (byType.has(s.type)) throw new Error(`Node type “${s.type}” is already defined`);
    byType.set(s.type, s);
  }
  return {
    spec: (type) => byType.get(type),
    outputs: (type, config = {}) => {
      const s = byType.get(type);
      return s ? specOutputs(s, config) : [];
    },
    withDefaults: (type, config = {}) => specDefaults(byType.get(type), config),
    validate: (type, config) => {
      const s = byType.get(type);
      if (!s) return [`Unknown node type “${type}”`];
      return validateFields(s, specDefaults(s, config));
    },
  };
}

export const builtinNodeRegistry: NodeRegistry = createNodeRegistry();

export interface GraphIssue {
  nodeId?: string;
  edgeId?: string;
  message: string;
}

export function validateGraph(
  graph: WorkflowGraph,
  registry: NodeRegistry = builtinNodeRegistry,
): { errors: GraphIssue[]; warnings: GraphIssue[] } {
  const { spec, outputs } = registry;
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const ids = new Set<string>();
  const byId = new Map<string, WorkflowNode>();

  for (const n of graph.nodes) {
    if (ids.has(n.id)) errors.push({ nodeId: n.id, message: `Duplicate node id “${n.id}”` });
    ids.add(n.id);
    byId.set(n.id, n);
    if (!spec(n.type)) {
      errors.push({ nodeId: n.id, message: `Unknown node type “${n.type}”` });
      continue;
    }
    for (const m of registry.validate(n.type, n.config)) {
      errors.push({ nodeId: n.id, message: `${n.label}: ${m}` });
    }
  }

  const triggers = graph.nodes.filter(isTrigger);
  if (triggers.length !== 1) {
    errors.push({ message: `A workflow needs exactly one trigger (found ${triggers.length})` });
  }

  const edgeKeys = new Set<string>();
  for (const e of graph.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) {
      errors.push({ edgeId: e.id, message: 'Edge points at a missing node' });
      continue;
    }
    const key = `${e.source}:${edgeHandle(e)}→${e.target}:${e.targetHandle ?? ''}`;
    if (edgeKeys.has(key)) warnings.push({ edgeId: e.id, message: 'Duplicate edge' });
    edgeKeys.add(key);
    if (spec(s.type) && !outputs(s.type, s.config).includes(edgeHandle(e))) {
      errors.push({
        edgeId: e.id,
        nodeId: s.id,
        message: `${s.label} has no “${edgeHandle(e)}” output`,
      });
    }
    if (isBackEdge(e) && !spec(t.type)?.loop) {
      errors.push({ edgeId: e.id, message: 'Only a Loop node accepts a “next” edge' });
    }
    if (isTrigger(t)) errors.push({ edgeId: e.id, message: 'Triggers cannot have inputs' });
  }

  // Forward edges must form a DAG.
  const forward = graph.edges.filter(
    (e) => !isBackEdge(e) && ids.has(e.source) && ids.has(e.target),
  );
  const indeg = new Map([...ids].map((id) => [id, 0]));
  for (const e of forward) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift() as string;
    seen++;
    for (const e of forward) {
      if (e.source !== id) continue;
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (seen < ids.size) {
    errors.push({
      message: 'The workflow has a cycle. Use a Loop node with a “next” edge to repeat steps.',
    });
  }

  for (const n of graph.nodes) {
    if (isTrigger(n)) continue;
    if (!forward.some((e) => e.target === n.id)) {
      errors.push({ nodeId: n.id, message: `${n.label} is not connected to anything upstream` });
    }
    const outs = spec(n.type) ? outputs(n.type, n.config) : [];
    if (outs.length && !graph.edges.some((e) => e.source === n.id)) {
      warnings.push({
        nodeId: n.id,
        message: `${n.label} has no outgoing edge; the run ends there`,
      });
    }
  }

  for (const e of graph.edges.filter(isBackEdge)) {
    if (byId.get(e.target) && !loopRegion(graph, e.target).has(e.source)) {
      errors.push({
        edgeId: e.id,
        message: 'A “next” edge must come from inside that loop’s body',
      });
    }
  }

  warnings.push(...unguardedRouterBypasses(graph, byId, forward));

  return { errors, warnings };
}

/** Node types that put content in front of readers. */
const PUBLISHING_TYPES = new Set([
  'content.publish',
  'content.publish_release',
  'content.schedule',
]);

/**
 * An `ai.router` route the model alone decides (no deterministic `guards` entry) that reaches a
 * publishing node without passing an approval, while another route of the same router does pass
 * one: the model could pick its way around the review. Warned, not refused.
 */
function unguardedRouterBypasses(
  graph: WorkflowGraph,
  byId: Map<string, WorkflowNode>,
  forward: WorkflowGraph['edges'],
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  /** Does a path from `start` reach a publishing node without an approval on the way? */
  const reaches = (start: string) => {
    const seen = new Set<string>();
    const stack = [start];
    let publishes = false;
    let approves = false;
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (!n) continue;
      if (n.type === 'control.approval') {
        approves = true;
        continue;
      }
      if (PUBLISHING_TYPES.has(n.type)) publishes = true;
      for (const e of forward) if (e.source === id) stack.push(e.target);
    }
    return { publishes, approves };
  };
  for (const r of graph.nodes.filter((n) => n.type === 'ai.router')) {
    const guards =
      r.config.guards && typeof r.config.guards === 'object' && !Array.isArray(r.config.guards)
        ? (r.config.guards as Record<string, unknown>)
        : {};
    const byRoute = new Map<string, { publishes: boolean; approves: boolean }>();
    for (const e of forward) {
      if (e.source !== r.id) continue;
      const route = edgeHandle(e);
      const prev = byRoute.get(route) ?? { publishes: false, approves: false };
      const next = reaches(e.target);
      byRoute.set(route, {
        publishes: prev.publishes || next.publishes,
        approves: prev.approves || next.approves,
      });
    }
    if (![...byRoute.values()].some((v) => v.approves)) continue;
    for (const [route, v] of byRoute) {
      if (v.publishes && guards[route] === undefined) {
        issues.push({
          nodeId: r.id,
          message: `${r.label}: route “${route}” publishes without the approval another route requires; add a guard for it`,
        });
      }
    }
  }
  return issues;
}
