/**
 * The planner the workflow interpreter drives. `seedAt` serves the legacy transition shim.
 *
 * The planner is a pure state machine over node and edge states, so its semantics are unit tested
 * here and the interpreter only adds durability:
 * - A node is ready once every forward input edge is resolved and at least one is active
 *   (an AND-join that tolerates untaken branches). If every input is inactive the node is skipped,
 *   and skipping propagates downstream.
 * - Completing a node activates the out-edges for the branches it chose and deactivates the rest.
 * - Back-edges (targetHandle "next") point into a `control.loop` node. Activating one makes the loop
 *   pending again; continuing the loop resets its body region for the next iteration.
 *
 * The interpreter must never re-implement scheduling: this module is the only place it lives.
 */

import {
  cloneJson,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeStatus,
} from './graph-types';

export const LOOP_INPUT = 'next';
export const DEFAULT_OUTPUT = 'out';

export type EdgeState = 'pending' | 'active' | 'inactive';

export interface PlanNode {
  status: WorkflowNodeStatus;
  /** How many times the node has started; part of its durable step name. */
  runs: number;
  branches?: string[];
}

export interface PlanState {
  nodes: Record<string, PlanNode>;
  edges: Record<string, EdgeState>;
}

export const isBackEdge = (e: Pick<WorkflowEdge, 'targetHandle'>) => e.targetHandle === LOOP_INPUT;
export const edgeHandle = (e: Pick<WorkflowEdge, 'sourceHandle'>) =>
  e.sourceHandle || DEFAULT_OUTPUT;

export function isTrigger(n: Pick<WorkflowNode, 'type'>) {
  return n.type.startsWith('trigger.');
}

export function initPlan(graph: WorkflowGraph): PlanState {
  return {
    nodes: Object.fromEntries(
      graph.nodes.map((n) => [n.id, { status: 'pending', runs: 0 } as PlanNode]),
    ),
    edges: Object.fromEntries(graph.edges.map((e) => [e.id, 'pending' as EdgeState])),
  };
}

function index(graph: WorkflowGraph) {
  const inputs = new Map<string, WorkflowEdge[]>();
  const outputs = new Map<string, WorkflowEdge[]>();
  for (const n of graph.nodes) {
    inputs.set(n.id, []);
    outputs.set(n.id, []);
  }
  for (const e of graph.edges) {
    inputs.get(e.target)?.push(e);
    outputs.get(e.source)?.push(e);
  }
  return { inputs, outputs };
}

function planNode(state: PlanState, id: string): PlanNode {
  const ns = state.nodes[id];
  if (!ns) throw new Error(`Node “${id}” is not in the plan`);
  return ns;
}

/**
 * Resolve skips to a fixpoint and return the nodes that can start now, in graph order.
 * Mutates `state` (skipped nodes and their out-edges).
 */
export function readyNodes(
  graph: WorkflowGraph,
  state: PlanState,
): { ready: string[]; skipped: string[] } {
  const { inputs, outputs } = index(graph);
  const skipped: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of graph.nodes) {
      const ns = planNode(state, n.id);
      if (ns.status !== 'pending') continue;
      const ins = inputs.get(n.id) ?? [];
      const forward = ins.filter((e) => !isBackEdge(e));
      if (ins.some((e) => isBackEdge(e) && state.edges[e.id] === 'active')) continue;
      if (forward.length === 0) continue;
      const resolved = forward.every((e) => state.edges[e.id] !== 'pending');
      if (resolved && forward.every((e) => state.edges[e.id] === 'inactive')) {
        ns.status = 'skipped';
        skipped.push(n.id);
        for (const e of outputs.get(n.id) ?? []) state.edges[e.id] = 'inactive';
        changed = true;
      }
    }
  }

  const ready: string[] = [];
  for (const n of graph.nodes) {
    const ns = planNode(state, n.id);
    if (ns.status !== 'pending') continue;
    const ins = inputs.get(n.id) ?? [];
    const forward = ins.filter((e) => !isBackEdge(e));
    const reentered = ins.some((e) => isBackEdge(e) && state.edges[e.id] === 'active');
    if (reentered) ready.push(n.id);
    else if (forward.length === 0) {
      if (ns.runs === 0) ready.push(n.id);
    } else if (
      forward.every((e) => state.edges[e.id] !== 'pending') &&
      forward.some((e) => state.edges[e.id] === 'active')
    ) {
      ready.push(n.id);
    }
  }
  return { ready, skipped };
}

/** Mark a node started; returns its deterministic step key for this run. */
export function beginNode(state: PlanState, nodeId: string): string {
  const ns = planNode(state, nodeId);
  ns.runs += 1;
  ns.status = 'running';
  return `${nodeId}#${ns.runs}`;
}

/** Complete a node with the branches it chose ("out" for single-output nodes). */
export function completeNode(
  graph: WorkflowGraph,
  state: PlanState,
  nodeId: string,
  branches: string[] = [DEFAULT_OUTPUT],
): void {
  const ns = planNode(state, nodeId);
  ns.status = 'succeeded';
  ns.branches = branches;
  // Consumed: a loop's back-edges reset once the loop has run.
  for (const e of graph.edges) {
    if (e.target === nodeId && isBackEdge(e)) state.edges[e.id] = 'pending';
  }
  for (const e of graph.edges) {
    if (e.source !== nodeId) continue;
    const active = branches.includes(edgeHandle(e));
    state.edges[e.id] = active ? 'active' : 'inactive';
    if (active && isBackEdge(e)) planNode(state, e.target).status = 'pending';
  }
}

/** Nodes reachable from a loop's "body" output without passing back through the loop. */
export function loopRegion(graph: WorkflowGraph, loopId: string): Set<string> {
  const { outputs } = index(graph);
  const region = new Set<string>();
  const stack = (outputs.get(loopId) ?? [])
    .filter((e) => edgeHandle(e) === 'body')
    .map((e) => e.target);
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === loopId || region.has(id)) continue;
    region.add(id);
    for (const e of outputs.get(id) ?? []) if (!isBackEdge(e)) stack.push(e.target);
  }
  return region;
}

/**
 * Complete a loop node. Continuing resets the body region (statuses and edges) so it runs again;
 * run counts are kept so the next iteration's step names are new.
 */
export function completeLoop(
  graph: WorkflowGraph,
  state: PlanState,
  loopId: string,
  next: boolean,
): void {
  if (next) {
    const region = loopRegion(graph, loopId);
    for (const id of region) planNode(state, id).status = 'pending';
    for (const e of graph.edges) {
      if (region.has(e.source)) state.edges[e.id] = 'pending';
    }
  }
  completeNode(graph, state, loopId, [next ? 'body' : 'done']);
  // Iterating doesn't decide the exit yet: leave "done" pending so what follows the loop isn't
  // skipped before the final iteration.
  if (next) {
    for (const e of graph.edges) {
      if (e.source === loopId && edgeHandle(e) === 'done') state.edges[e.id] = 'pending';
    }
  }
}

export function isSettled(graph: WorkflowGraph, state: PlanState): boolean {
  if (Object.values(state.nodes).some((n) => n.status === 'running' || n.status === 'waiting')) {
    return false;
  }
  return readyNodes(graph, cloneJson(state)).ready.length === 0;
}

/**
 * Seed a fresh plan so a run starts at `nodeId` instead of the trigger. It backs
 * the legacy "move an entry to any stage" transition API.
 *
 * Every node not forward-reachable from `nodeId` is marked skipped and its out-edges inactive,
 * except the forward edges into `nodeId` itself, which are activated so `nodeId` is the one ready
 * node. Downstream joins see the skipped side as an untaken branch, as usual. Mutates `state`
 * (which should come from {@link initPlan}).
 */
export function seedAt(graph: WorkflowGraph, state: PlanState, nodeId: string): void {
  if (!graph.nodes.some((n) => n.id === nodeId)) {
    throw new Error(`Node “${nodeId}” is not in the graph`);
  }
  const { outputs } = index(graph);
  const reachable = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of outputs.get(id) ?? []) if (!isBackEdge(e)) stack.push(e.target);
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.id)) planNode(state, n.id).status = 'skipped';
  }
  for (const e of graph.edges) {
    if (reachable.has(e.source)) continue;
    state.edges[e.id] = e.target === nodeId && !isBackEdge(e) ? 'active' : 'inactive';
  }
}

/** A key that changes only when topology changes (used to decide when to re-layout). */
export function topologyKey(graph: WorkflowGraph): string {
  return [
    graph.nodes
      .map((n) => n.id)
      .sort()
      .join(','),
    graph.edges
      .map((e) => `${e.source}>${e.target}`)
      .sort()
      .join(','),
  ].join('|');
}
