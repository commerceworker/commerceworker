/**
 * How the OrderAgent folds what the Workflow reports into the order's state, as one pure step.
 * Reports are either sequenced plan snapshots (non-durable: a stale one, from an earlier sequence
 * or generation, is dropped) or detail reports sent from inside steps (a status, a step's start or
 * end, a timeline line), which apply whenever they arrive. Folding is idempotent: a replayed
 * report changes nothing it already changed, and never counts a step's run twice. The agent keeps
 * the runtime: persisting the timeline, recording the finished run, syncing the index.
 */

import type { NodeRun, OrderState } from './api';
import type { EdgeState, PlanNode } from './graph';
import { orderReason } from './reasons';
import { type Order, type OrderStatus, TERMINAL_ORDER_STATUSES, type TimelineEntry } from './types';

/** What the Workflow reports to the order's agent. */
export type OrderReport = {
  /** Plan snapshots are sequenced per generation; stale ones are dropped. */
  seq?: number;
  generation?: number;
  status?: OrderStatus;
  reason?: string;
  plan?: { nodes: Record<string, PlanNode>; edges: Record<string, EdgeState> };
  order?: Order;
  vars?: Record<string, unknown>;
  node?: { id: string } & Partial<NodeRun>;
  log?: TimelineEntry;
};

/** The agent's state: the order's, with the last plan snapshot's sequence number. */
export type ReportedState = OrderState & { seq: number };

export type FoldedReport<S extends ReportedState> = {
  /** The next state, its timeline untouched: the agent appends `log` to it. */
  state: S;
  /** Timeline lines to append, in order (a keyed one replaces its earlier copy). */
  log: (Omit<TimelineEntry, 'at'> & { at?: number })[];
  /** A step whose run just ended for the first time: its run, to record once. */
  finished: { id: string; run: NodeRun } | null;
  statusChanged: boolean;
};

/** Folds one report into `s` at `now`. */
export function foldReport<S extends ReportedState>(
  s: S,
  r: OrderReport,
  now: number,
): FoldedReport<S> {
  let next: S = { ...s };
  const log: FoldedReport<S>['log'] = [];
  const gen = r.generation ?? s.generation;
  const sequenced = r.seq !== undefined;
  const fresh = !sequenced || gen > s.generation || (gen === s.generation && r.seq! > s.seq);

  if (sequenced && fresh) {
    next.seq = r.seq!;
    if (r.plan) {
      const nodes: Record<string, NodeRun> = { ...next.nodes };
      for (const [id, pn] of Object.entries(r.plan.nodes)) {
        const cur = nodes[id] ?? { status: 'pending', runs: 0 };
        // Rollback and failure come from their own reports; a later plan never clears them.
        const keep = cur.status === 'rolled_back' || cur.status === 'failed';
        nodes[id] = {
          ...cur,
          status: keep ? cur.status : pn.status,
          runs: pn.runs,
          branches: pn.branches,
        };
      }
      next.nodes = nodes;
      next.edges = r.plan.edges;
    }
    if (r.order) next.order = r.order;
    if (r.vars) next.vars = r.vars;
  }
  if (r.status && (fresh || !sequenced) && !TERMINAL_ORDER_STATUSES.includes(s.status)) {
    next.status = r.status;
    // Capped here too, whoever reported it: the order page, list and webhooks show it whole.
    if (r.reason !== undefined) next.reason = orderReason(r.reason);
    if (r.status !== s.status)
      log.push({
        kind: 'order',
        message: `Order ${r.status}${r.reason ? `: ${r.reason}` : ''}`,
        key: `status:${gen}:${r.status}`,
      });
  }
  let finished: FoldedReport<S>['finished'] = null;
  if (r.node) {
    const { id, ...detail } = r.node;
    const cur = next.nodes[id] ?? { status: 'pending', runs: 0 };
    const running = cur.startedAt !== undefined && cur.endedAt === undefined;
    if (detail.startedAt !== undefined) {
      // A retried attempt keeps the run's first start; a new run starts afresh.
      if (running) detail.startedAt = cur.startedAt;
      else detail.endedAt = undefined;
    }
    const merged = { ...cur, ...detail };
    next.nodes = { ...next.nodes, [id]: merged };
    // Only the first end of a running node counts, so replayed reports never add a row.
    if (running && detail.endedAt !== undefined && detail.endedAt >= cur.startedAt!)
      finished = { id, run: merged };
  }
  if (r.log) log.push(r.log);
  next = { ...next, updatedAt: now };
  return { state: next, log, finished, statusChanged: next.status !== s.status };
}
