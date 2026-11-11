import {
  type EdgeState,
  type FlowGraph,
  isBackEdge,
  type NodeRun,
  type NodeStatus,
  SCENARIO_CUSTOMERS,
  SCENARIO_SKUS,
  TERMINAL_ORDER_STATUSES,
} from '@commerceworker/core';
import type {
  ApprovalCursor,
  ApprovalFilter,
  ApprovalScope,
  BoardFilter,
  Undone,
} from '@commerceworker/ports/commerce';
import { plural } from '@commerceworker/ui/lib/format';
import type { OrderCursor } from './cursor';
import { backOffice, flowStore, orderBoard, pricingStore } from './wire.server';

export type { ApprovalCursor, ApprovalFilter, ApprovalScope, Undone };

export type OrderFilters = {
  model?: string;
  channel?: string;
  status?: string;
  q?: string;
  /**
   * Newest first by default. "oldest" is created ascending, "updated" most recent first, "total"
   * largest first in the base currency, and "waiting" the longest-held first (orders not waiting
   * last).
   */
  sort?: 'created' | 'oldest' | 'updated' | 'total' | 'waiting';
  /** Only what needs a person: failed, rolled back, or waiting on a pending approval. */
  attention?: boolean;
  /** Only orders on this flow, any version. */
  flow?: string;
  /** Only this customer's orders. */
  customer?: string;
  /** Only orders waiting at, or stopped at, this step (by its label). */
  step?: string;
  /** Only orders updated within this window: for ended orders, ended within it. */
  within?: Within;
  /** Newest-first paging: only orders created before the previous page's last row. */
  after?: OrderCursor;
};

/*
 * An order the engine runs has its Workflow instance named in the index. A recorded order (one
 * `pnpm db:seed:volume` wrote straight into the index) has none, so nothing can resume it: the
 * board leaves it out of every live count, queue and open-status filter, and a list shows its open
 * status as "Recorded" (`liveStatus` in format.ts).
 */

export const WITHIN = { '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
export type Within = keyof typeof WITHIN;
export const isWithin = (v: string | null): v is Within => !!v && v in WITHIN;

/** The list's filters as the board takes them: a window becomes the time it starts. */
function board({ within, ...f }: OrderFilters, now = Date.now()): BoardFilter {
  return within ? { ...f, updatedSince: now - WITHIN[within] } : f;
}

export async function listOrders(f: OrderFilters = {}, limit = 200) {
  return orderBoard().list(board(f), limit);
}

/** The most orders `countOrders` counts; past it the list says "10,000+". */
export const COUNT_CAP = 10_000;

/**
 * How many orders a filter picks across every page, for the list's "Newest 200 of 960". It reads
 * at most `cap + 1` rows, so a large index costs the same as a capped one; `more` says there were
 * more than `cap`.
 */
export async function countOrders(f: OrderFilters = {}, cap = COUNT_CAP) {
  return orderBoard().count(board(f), cap);
}

/**
 * Everything the overview reads from D1, in one round trip: open orders by status, the most
 * recently updated orders, pending approvals, what ended in the last 24 hours, where open orders
 * wait (by flow and step) and what failed or rolled back this week (by flow and step).
 */
export async function overview(now = Date.now()) {
  return orderBoard().overview(now);
}

/** How many approvals the inbox shows at once; each costs one read of its order's live state. */
export const APPROVALS_PAGE = 50;

/**
 * One page of the approvals inbox, with how many rows match and how many came before this page.
 * Pending approvals read oldest request first (the longest wait is the most urgent); history reads
 * newest first. The queue reads the `live` scope, so every row on it can be decided; approvals on
 * recorded orders are a scope of their own that the inbox folds into one line
 * (`pendingApprovalCounts`).
 */
export async function listApprovals(
  status = 'pending',
  after: ApprovalCursor | null = null,
  limit = APPROVALS_PAGE,
  scope?: ApprovalScope,
  filter?: ApprovalFilter,
) {
  return orderBoard().approvals(status, after, limit, scope, filter);
}

/**
 * Pending approvals, split by whether a decision can resume their order: `live` is the queue the
 * nav badge and the overview count, `recorded` the ones on orders with no run.
 */
export async function pendingApprovalCounts() {
  return orderBoard().pendingApprovalCounts();
}

/** An order's D1 records, in one round trip. */
export async function orderRecords(orderId: string) {
  const board = orderBoard();
  const [records, votes, voters] = await Promise.all([
    board.records(orderId),
    board.votes(orderId),
    board.voters(orderId),
  ]);
  // The votes cast on its approvals, and the company members who may still vote.
  return { ...records, votes, voters };
}

/**
 * A recorded order's graph colours: each step's last recorded run, and the steps it is waiting at
 * (named in `waitingAt`) while it hasn't ended.
 */
export function recordedRuns(
  graph: FlowGraph | null,
  steps: { nodeId: string; status: string; run: number; startedAt: number; endedAt: number }[],
  order: { status: string; waitingAt: string | null; waitingSince: number | null },
): Record<string, NodeRun> {
  const runs: Record<string, NodeRun> = {};
  for (const r of steps)
    runs[r.nodeId] = {
      status: r.status as NodeStatus,
      runs: r.run,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    };
  if (TERMINAL_ORDER_STATUSES.includes(order.status as never)) return runs;
  const waitingAt = new Set(order.waitingAt?.split(' · ') ?? []);
  for (const n of graph?.nodes ?? [])
    if (waitingAt.has(n.label))
      runs[n.id] = { status: 'waiting', runs: 1, startedAt: order.waitingSince ?? undefined };
  return runs;
}

/**
 * The path a recorded order took, inked as the live view inks it. `node_runs` keeps no branches, so
 * an edge counts as taken when its source finished and its target ran. On an order that has ended,
 * every other edge was not taken; on an open one, an edge is untaken only when its source took
 * another branch, and the rest may still be taken.
 */
export function recordedEdges(
  graph: FlowGraph | null,
  runs: Record<string, NodeRun>,
  order: { status: string },
): Record<string, EdgeState> {
  const ended = TERMINAL_ORDER_STATUSES.includes(order.status as never);
  const finished = (id: string) => ['succeeded', 'rolled_back'].includes(runs[id]?.status ?? '');
  const ran = (id: string) => !!runs[id] && runs[id].status !== 'skipped';
  const taken = (e: FlowGraph['edges'][number]) =>
    finished(e.source) &&
    ran(e.target) &&
    // Going round a loop again means its target ran more than once.
    (!isBackEdge(e) || (runs[e.target]?.runs ?? 0) > 1);
  const edges = graph?.edges ?? [];
  const states: Record<string, EdgeState> = {};
  for (const e of edges) {
    if (taken(e)) states[e.id] = 'active';
    else if (ended) states[e.id] = 'inactive';
    else {
      const handle = e.sourceHandle || 'out';
      const otherBranch = edges.some(
        (o) => o.source === e.source && (o.sourceHandle || 'out') !== handle && taken(o),
      );
      states[e.id] = otherBranch || runs[e.source]?.status === 'skipped' ? 'inactive' : 'pending';
    }
  }
  return states;
}

/**
 * The step types whose compensation (the engine's `ROLLBACKS`) leaves a record behind, and how the
 * record reads. A step whose compensation leaves nothing countable (a promotion given back) isn't
 * here, so it is never shown as reversed on a guess.
 */
const REVERSALS: Record<string, { undone: keyof Undone; say: (n: number) => string }> = {
  'commerce.reserve_inventory': {
    undone: 'reservationsReleased',
    say: (n) => `Released ${plural(n, 'stock reservation')}`,
  },
  'commerce.authorize_payment': {
    undone: 'authorizationsVoided',
    say: (n) => `Voided ${plural(n, 'payment authorization')}`,
  },
  'commerce.split_by_seller': {
    undone: 'sellerOrdersCancelled',
    say: (n) => `Cancelled ${plural(n, 'seller order')}`,
  },
  'commerce.payout': { undone: 'payoutsReversed', say: (n) => `Reversed ${plural(n, 'payout')}` },
  'commerce.ship': {
    undone: 'shipmentsCancelled',
    say: (n) => `Cancelled ${plural(n, 'shipment')}`,
  },
  'commerce.pickup_ready': {
    undone: 'shipmentsCancelled',
    say: (n) => `Cancelled ${plural(n, 'pickup')}`,
  },
  'commerce.invoice': { undone: 'invoicesVoided', say: (n) => `Voided ${plural(n, 'invoice')}` },
  'commerce.deliver_digital': {
    undone: 'codesRevoked',
    say: (n) => `Revoked ${plural(n, 'digital code')}`,
  },
};

/**
 * What a rolled-back order's records show was undone, tied to the step that did it: the last step
 * of each reversible type whose last run succeeded, when its records were reversed. Records alone don't say
 * which of two steps of one type made them, so they go to the last one to run.
 */
export function recordedReversals(
  steps: { nodeId: string; type: string; status: string; startedAt: number }[],
  undone: Undone,
): { nodeId: string; text: string }[] {
  const lastRun = new Map<string, (typeof steps)[number]>();
  for (const st of [...steps].sort((a, b) => a.startedAt - b.startedAt)) lastRun.set(st.nodeId, st);
  const last = new Map<string, string>();
  for (const st of lastRun.values())
    if (st.status === 'succeeded' && REVERSALS[st.type]) last.set(st.type, st.nodeId);
  const claimed = new Set<keyof Undone>();
  const out: { nodeId: string; text: string }[] = [];
  for (const [type, nodeId] of last) {
    const r = REVERSALS[type]!;
    const n = undone[r.undone];
    if (!n || claimed.has(r.undone)) continue;
    claimed.add(r.undone);
    out.push({ nodeId, text: r.say(n) });
  }
  return out;
}

/**
 * An order the orders index has but the engine has no run for (one `pnpm db:seed:volume`
 * generated, say): what D1 recorded, for a read-only page. The flow is the version it ran on;
 * `runs` colours its graph by each step's last recorded run, and the steps it is waiting at, and
 * `edges` inks the path it took. A rolled-back order also says what its records show was undone,
 * and those steps read as rolled back.
 */
export async function recordedOrder(orderId: string) {
  const found = await orderBoard().recorded(orderId);
  if (!found) return null;
  const { order, runs: steps, approvals: asks, undone } = found;
  const version = await flowStore().version(order.flowId, order.flowVersion);
  const flow = version
    ? {
        name: version.name,
        version: version.version,
        graph: { nodes: version.nodes, edges: version.edges } as FlowGraph,
      }
    : null;
  const label = (id: string) => flow?.graph.nodes.find((n) => n.id === id)?.label ?? id;
  const runs = recordedRuns(flow?.graph ?? null, steps, order);
  const reversed = undone
    ? recordedReversals(
        steps.map((r) => ({ ...r, type: r.nodeType })),
        undone,
      ).map((r) => ({ ...r, label: label(r.nodeId) }))
    : [];
  const undoneIds = new Set(reversed.map((r) => r.nodeId));
  for (const id of undoneIds) if (runs[id]) runs[id] = { ...runs[id], status: 'rolled_back' };
  // Only a step's last run was reversed; an earlier run of it had already ended.
  const lastRun = new Map(steps.map((r) => [r.nodeId, r]));
  return {
    order,
    flow,
    runs,
    edges: recordedEdges(flow?.graph ?? null, runs, order),
    steps: steps.map((r) => ({
      nodeId: r.nodeId,
      label: label(r.nodeId),
      type: r.nodeType,
      status: undoneIds.has(r.nodeId) && lastRun.get(r.nodeId) === r ? 'rolled_back' : r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
    })),
    approvals: asks,
    /** Null unless the order rolled back; empty when its records show nothing undone. */
    reversed: order.status === 'rolled_back' ? reversed : null,
  };
}

/** Every record the new-order form and the carts choose from, in one round trip, and the rates. */
export async function commerceData() {
  const [all, rates] = await Promise.all([backOffice().everything(), currencies()]);
  return {
    customers: all.customers,
    sellers: all.sellers,
    stores: all.stores,
    products: all.products,
    pricing: { sources: all.sources, rules: all.rules, contracts: all.contracts, rates },
  };
}

/**
 * Orders with a run waiting on an outside event (the index's `waiting_for` names one), the `limit`
 * most recently updated, how many there are in all, and how many of those are past their step's
 * deadline (the index's `waiting_due`) at `now`.
 */
export async function waitingOnEvents(limit: number, now = Date.now()) {
  return orderBoard().waitingOnEvents(limit, now);
}

/** Every flow with a published version, by name, and the version orders start on. */
export async function publishedFlows() {
  return (await flowStore().list())
    .filter((f) => f.publishedVersion !== null)
    .map((f) => ({ id: f.id, name: f.name, model: f.model, version: f.publishedVersion }));
}

/** Orders still running (queued, running or waiting) per flow and version, for the flows list. */
export async function runningByFlow(): Promise<Record<string, Record<number, number>>> {
  const out: Record<string, Record<number, number>> = {};
  for (const r of await orderBoard().runningByFlow()) {
    out[r.flowId] ??= {};
    out[r.flowId]![r.version] = r.n;
  }
  return out;
}

/** Each published flow with the graph orders on it will run, for the new-order form. */
export async function publishedFlowGraphs() {
  const list = await publishedFlows();
  return Promise.all(
    list.map(async (f) => {
      const v = await flowStore().version(f.id, f.version ?? undefined);
      const graph = { nodes: v?.nodes ?? [], edges: v?.edges ?? [] } as FlowGraph;
      return { ...f, graph };
    }),
  );
}

/** Display names for the given customer ids, for lists that only carry the id. */
export async function customerNames(
  ids: (string | null | undefined)[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return {};
  const found = await pricingStore().customers(wanted);
  return Object.fromEntries(found.map((c) => [c.id, c.name]));
}

/**
 * Cancelled orders that were declined by policy (their approval was rejected or escalated) rather
 * than cancelled by a person. The index keeps one status; the approvals table says which.
 */
export async function declinedOrderIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set(await orderBoard().declinedOrderIds(ids));
}

/** The email intake log: every message the engine's email() entrypoint saw, newest first. */
export async function recentInboundEmails(limit = 20) {
  return orderBoard().inboundEmails(limit);
}

/** Currencies an order can be in: those with a rate, base first. */
export async function currencies() {
  return backOffice().currencies();
}

/** The customer a channel's buyer email belongs to, for orders that arrive without an id. */
export async function customerIdByEmail(email: string | null | undefined) {
  const wanted = email?.trim().toLowerCase();
  if (!wanted) return undefined;
  const domain = wanted.split('@').at(-1) ?? wanted;
  const found = await pricingStore().customersByEmail(wanted, domain);
  return found.find((c) => c.email.toLowerCase() === wanted)?.id;
}

let demo: { value: boolean; at: number } | null = null;

/**
 * Whether the demo data (`packages/db/seed`) is loaded: every customer and SKU the demo scenarios
 * use exists. Production has none of it, so the scenarios are hidden there. Remembered for a
 * minute per isolate.
 */
export async function demoAvailable(): Promise<boolean> {
  if (demo && Date.now() - demo.at < 60_000) return demo.value;
  const [c, p] = await Promise.all([
    pricingStore().customers(SCENARIO_CUSTOMERS),
    pricingStore().products(SCENARIO_SKUS),
  ]);
  const value = c.length === SCENARIO_CUSTOMERS.length && p.length === SCENARIO_SKUS.length;
  demo = { value, at: Date.now() };
  return value;
}
