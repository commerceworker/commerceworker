/**
 * OrderAgent: one Agents SDK Durable Object per order. It holds the live run state that syncs to
 * every browser on the order page, records what the Workflow reports, owns the order's waits
 * (approvals and external events) and their delivery, and cancels with compensation. Questions
 * about an order go to the workspace assistant (./assistant), which reads and acts on it here.
 */

import type { ReturnRequest } from '@commerceworker/core';
import {
  aiGateFeedback,
  approvalWait,
  atLeast,
  decisionProblem,
  EMPTY_ORDER_STATE,
  eraseOrderState,
  eventDigest,
  eventProblem,
  eventWait,
  type FlowVersion,
  flowAwaits,
  foldReport,
  type HeldEvent,
  heldFor,
  holdProblem,
  type NodeRun,
  newId,
  type Order,
  type OrderEvent,
  type OrderReport,
  type OrderState,
  type OrderStatus,
  orderIndexRow,
  type PendingWait,
  type Principal,
  type ProxiedPrincipal,
  ROLE_LABELS,
  type Role,
  TERMINAL_ORDER_STATUSES,
  TIMELINE_BROADCAST,
  TIMELINE_CAP,
  type TimelineEntry,
} from '@commerceworker/core';
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from 'agents';
import { sendAiFeedback } from './ai';
import { recordAudit } from './audit';
import { compensateOrder } from './connectors';
import { a2aAgent } from './namespaces';
import { emit, orderSummary } from './outbox';
import { forwardedPrincipal, livePrincipal, SESSION_ENDED } from './principal';
import { separationRefusal } from './separation';
import { releaseHold } from './ucp/payments';
import { syncUcpOrder, ucpMetaOf } from './ucp/webhooks';
import { orderRecords } from './wire';
import { plural } from './words';

/** What the Workflow reports (`OrderReport` in core, where `foldReport` applies it). */
export type Report = OrderReport;

/**
 * The synced state: `flow` is always null and `timeline` holds the newest `TIMELINE_BROADCAST`
 * entries, so every broadcast stays small. The pinned flow and the whole timeline (up to
 * `TIMELINE_CAP`) live in this object's SQL; `snapshot()` and `getFlow()` read them.
 */
type State = OrderState & { seq: number };
/** Per-connection state: who opened the order page's socket. */
type ConnectionState = { principal: ProxiedPrincipal | null };

// Matches the Workflow's emit step: 5 retries with exponential backoff from 10 seconds.
const WEBHOOK_RETRIES = 5;
/** Statuses an order ends in without having been fulfilled. */
const UNFULFILLED: readonly OrderStatus[] = ['cancelled', 'declined', 'failed', 'rolled_back'];

/** What an A2A watcher cares about: the order's status and what it waits on. */
const watchKey = (s: State) => `${s.status}|${s.waits.map((w) => w.eventType).join(',')}`;

export class OrderAgent extends Agent<Env, State> {
  override initialState: State = { ...EMPTY_ORDER_STATE, seq: 0 };

  /** Browsers may read and call methods, never write state directly. */
  override validateStateChange(_next: State, source: Connection | 'server') {
    if (source !== 'server') throw new Error('Order state is read-only');
  }

  private patch(p: Partial<State>) {
    this.setState({ ...this.state, ...p, updatedAt: Date.now() });
  }

  /** Set once this instance has created its tables. */
  private tablesReady = false;

  /** Creates this object's SQL tables, once per instance. */
  private tables() {
    if (this.tablesReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS order_flow (id INTEGER PRIMARY KEY, flow TEXT NOT NULL)`;
    this
      .sql`CREATE TABLE IF NOT EXISTS order_timeline (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, entry TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS a2a_watchers (name TEXT PRIMARY KEY)`;
    this.sql`CREATE TABLE IF NOT EXISTS a2a_watch_state (id INTEGER PRIMARY KEY, key TEXT)`;
    this
      .sql`CREATE TABLE IF NOT EXISTS ucp_sync (id INTEGER PRIMARY KEY, digest TEXT, pending INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0)`;
    // Events that arrived before a step waited for them (`holdProblem` in core).
    this
      .sql`CREATE TABLE IF NOT EXISTS order_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, taken_by TEXT)`;
    // What the order's waits were given (`eventDigest`), so a resend isn't held for a later pass.
    this.sql`CREATE TABLE IF NOT EXISTS order_delivered (digest TEXT PRIMARY KEY)`;
    this.tablesReady = true;
    // An order begun while the flow and the whole timeline were kept in state: move them out.
    const s = this.state;
    if (s.flow) {
      this.sql`INSERT OR IGNORE INTO order_flow (id, flow) VALUES (1, ${JSON.stringify(s.flow)})`;
      if (!this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM order_timeline`[0]?.n)
        for (const e of s.timeline) this.appendTimeline(e);
      this.setState({ ...s, flow: null, timeline: s.timeline.slice(-TIMELINE_BROADCAST) });
    }
  }

  private appendTimeline(e: TimelineEntry) {
    // A keyed entry replaces its earlier row and moves to the end, as the broadcast tail does.
    this
      .sql`INSERT OR REPLACE INTO order_timeline (key, entry) VALUES (${e.key ?? null}, ${JSON.stringify(e)})`;
  }

  /** The order's whole timeline, oldest first. */
  private fullTimeline(): TimelineEntry[] {
    this.tables();
    return this.sql<{ entry: string }>`SELECT entry FROM order_timeline ORDER BY seq`.map(
      (r) => JSON.parse(r.entry) as TimelineEntry,
    );
  }

  /** The events this order holds, oldest first. */
  private inbox(): HeldEvent[] {
    this.tables();
    return this.sql<{
      id: number;
      event: string;
      payload: string;
      at: number;
      taken_by: string | null;
    }>`SELECT id, event, payload, at, taken_by FROM order_inbox ORDER BY at, id`.map((r) => ({
      id: r.id,
      event: r.event,
      at: r.at,
      takenBy: r.taken_by,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  /** What this order's waits have been given, by `eventDigest`. */
  private delivered(): Set<string> {
    this.tables();
    return new Set(
      this.sql<{ digest: string }>`SELECT digest FROM order_delivered`.map((r) => r.digest),
    );
  }

  private rememberDelivered(event: string, payload: Record<string, unknown>) {
    this
      .sql`INSERT OR IGNORE INTO order_delivered (digest) VALUES (${eventDigest(event, payload)})`;
  }

  /** Empties the inbox and what it remembers: the order takes no more events. */
  private forgetEvents() {
    this.tables();
    this.sql`DELETE FROM order_inbox`;
    this.sql`DELETE FROM order_delivered`;
  }

  /**
   * Gives a wait that just opened the event held for it, if any. The Workflow keeps an event sent
   * before its `waitForEvent` and hands it over there. The row is marked as this wait's before the
   * send (synchronously, so no other delivery can slip in), and goes when the wait closes: a
   * retried open resends the same event, never the next one, and a send that failed is tried
   * again by the step's retry.
   */
  private async deliverHeld(w: PendingWait) {
    if (w.kind !== 'event' || !this.state.instanceId) return;
    const held = heldFor(this.inbox(), w);
    if (!held) return;
    this.sql`UPDATE order_inbox SET taken_by = ${w.eventType} WHERE id = ${held.id}`;
    const instance = await this.env.ORDER_WORKFLOW.get(this.state.instanceId);
    await instance.sendEvent({
      type: w.eventType,
      payload: { ...held.payload, event: held.event, at: held.at },
    });
    this.rememberDelivered(held.event, held.payload);
    this.patch({
      timeline: this.log({
        nodeId: w.nodeId,
        kind: 'event',
        message: `${this.stepLabel(w.nodeId)}: took ${held.event}, held since ${new Date(held.at).toISOString()}`,
        key: `held:${held.id}`,
      }),
    });
  }

  private flowCache: FlowVersion | null | undefined;

  /** The flow version this order runs on (it never changes once pinned). */
  private pinnedFlow(): FlowVersion | null {
    if (this.flowCache !== undefined) return this.flowCache;
    this.tables();
    const row = this.sql<{ flow: string }>`SELECT flow FROM order_flow WHERE id = 1`[0];
    this.flowCache = row ? (JSON.parse(row.flow) as FlowVersion) : null;
    return this.flowCache;
  }

  /** A step's label in the pinned flow, or its id when the flow doesn't name it. */
  private stepLabel(nodeId: string): string {
    return this.pinnedFlow()?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  }

  /**
   * Records a timeline entry (a keyed one replaces its earlier copy) and returns the broadcast
   * tail with it: `base` is the tail it builds on, never the whole timeline.
   */
  private log(entry: Omit<TimelineEntry, 'at'> & { at?: number }, base = this.state.timeline) {
    const e: TimelineEntry = { at: Date.now(), ...entry };
    this.tables();
    this.appendTimeline(e);
    this
      .sql`DELETE FROM order_timeline WHERE seq <= (SELECT seq FROM order_timeline ORDER BY seq DESC LIMIT 1 OFFSET ${TIMELINE_CAP})`;
    const kept = e.key ? base.filter((t) => t.key !== e.key) : base;
    return [...kept.slice(-(TIMELINE_BROADCAST - 1)), e];
  }

  /** The order's projections in D1: its index row, step timings and approvals. */
  private records() {
    return orderRecords(this.env);
  }

  /** What the D1 index row last got from this object, so an unchanged report writes nothing. */
  private indexed: string | null = null;

  private async syncIndex() {
    const s = this.state;
    if (!s.orderId || !s.order) return;
    const row = orderIndexRow({ ...s, order: s.order }, this.pinnedFlow());
    const key = JSON.stringify(row);
    if (key === this.indexed) return;
    await this.records().index(s.orderId, row);
    this.indexed = key;
  }

  // ── Called by EngineApi and the Workflow ───────────────────────────────────

  /** The whole state: the synced state with the pinned flow and the full timeline. */
  async snapshot(): Promise<OrderState> {
    return this.fullState();
  }

  private fullState(): State {
    const flow = this.pinnedFlow();
    return { ...this.state, flow, timeline: this.fullTimeline() };
  }

  /**
   * Removes a data subject from this order (`eraseOrderState` in core) once it has finished, and
   * returns its erased title (`held` false when this object never held the order). Null while it
   * still runs: its steps may yet need the buyer's details.
   */
  async erasePersonalData(terms: string[]): Promise<{ held: boolean; title: string } | null> {
    if (!this.state.orderId) return { held: false, title: '' };
    if (!TERMINAL_ORDER_STATUSES.includes(this.state.status)) return null;
    const erased = eraseOrderState(this.fullState(), terms);
    this.sql`DELETE FROM order_timeline`;
    // Held events carry what their senders sent; a finished order has none left, but make sure.
    this.forgetEvents();
    for (const e of erased.timeline) this.appendTimeline(e);
    this.setState({
      ...erased,
      flow: null,
      timeline: erased.timeline.slice(-TIMELINE_BROADCAST),
      updatedAt: Date.now(),
    });
    await this.syncIndex();
    return { held: true, title: this.state.order?.title ?? '' };
  }

  async init(order: Order, flow: FlowVersion, instanceId: string) {
    // A replayed start may call this again; never reset a run that has begun.
    if (this.state.instanceId === instanceId) return;
    this.tables();
    this.sql`INSERT OR REPLACE INTO order_flow (id, flow) VALUES (1, ${JSON.stringify(flow)})`;
    this.flowCache = flow;
    this.sql`DELETE FROM order_timeline`;
    const timeline = this.log(
      { kind: 'order', message: `Order created on ${flow.name} v${flow.version}` },
      [],
    );
    this.setState({
      ...EMPTY_ORDER_STATE,
      seq: 0,
      orderId: order.id,
      order,
      flow: null,
      instanceId,
      generation: 1,
      status: 'queued',
      nodes: Object.fromEntries(flow.nodes.map((n) => [n.id, { status: 'pending', runs: 0 }])),
      edges: Object.fromEntries(flow.edges.map((e) => [e.id, 'pending'])),
      timeline,
      updatedAt: Date.now(),
    });
  }

  async report(r: Report) {
    this.tables();
    const s = this.state;
    const folded = foldReport(s, r, Date.now());
    let timeline = s.timeline;
    for (const entry of folded.log) timeline = this.log(entry, timeline);
    const next = { ...folded.state, timeline };
    this.setState(next);

    if (folded.finished) await this.recordRun(folded.finished.id, folded.finished.run);

    if (folded.statusChanged || r.order) await this.syncIndex();
    // A finished order takes no more events: what it held goes.
    if (folded.statusChanged && TERMINAL_ORDER_STATUSES.includes(next.status)) this.forgetEvents();
    // A failed order rolls back inside the Workflow; poll it until it settles to record the outcome.
    if (folded.statusChanged && next.status === 'failed')
      await this.schedule(5, 'checkInstance', { attempt: 0 });
  }

  /** Writes one finished node run for the dashboard's timing; a repeat is a no-op. */
  private async recordRun(nodeId: string, run: NodeRun) {
    const s = this.state;
    const type = this.pinnedFlow()?.nodes.find((n) => n.id === nodeId)?.type;
    if (!s.orderId || !s.order || !type || run.startedAt === undefined || run.endedAt === undefined)
      return;
    await this.records().recordRun({
      orderId: s.orderId,
      generation: s.generation,
      nodeId,
      run: Math.max(1, run.runs),
      nodeType: type,
      model: s.order.model,
      status: run.status === 'failed' ? 'failed' : 'succeeded',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    });
  }

  async openWait(w: PendingWait) {
    if (this.state.waits.some((x) => x.eventType === w.eventType)) return this.deliverHeld(w);
    if (w.kind === 'approval' && this.state.orderId) {
      await this.records().openApproval({
        id: newId('apr'),
        orderId: this.state.orderId,
        nodeId: w.nodeId,
        eventType: w.eventType,
        title: w.title,
        assignee: w.assignee ?? '',
        amount: w.amount ?? null,
      });
    }
    const node = this.state.nodes[w.nodeId] ?? { status: 'pending' as const, runs: 0 };
    this.patch({
      // A wait's run starts when it opens; this runs in the Workflow's memoized `:open` step.
      nodes: {
        ...this.state.nodes,
        [w.nodeId]: { ...node, startedAt: w.since, endedAt: undefined },
      },
      waits: [...this.state.waits, w],
      timeline: this.log({
        nodeId: w.nodeId,
        kind: w.kind === 'approval' ? 'approval' : 'event',
        // An event wait reads by its step, as a step's own lines do; the key stays on the wait.
        message:
          w.kind === 'approval'
            ? `Awaiting approval: ${w.title} (${w.assignee})`
            : `${this.stepLabel(w.nodeId)}: waiting`,
        key: `open:${w.eventType}`,
      }),
    });
    await this.syncIndex();
    await this.deliverHeld(w);
  }

  async closeWait(eventType: string, outcome: string, payload: Record<string, unknown>) {
    const w = this.state.waits.find((x) => x.eventType === eventType);
    // A held event this wait took is spent once it closes.
    this.tables();
    this.sql`DELETE FROM order_inbox WHERE taken_by = ${eventType}`;
    if (w?.kind === 'approval' && this.state.orderId) {
      await this.records().decideApproval(this.state.orderId, eventType, {
        status: outcome,
        decidedBy:
          typeof payload.by === 'string' ? payload.by : outcome === 'escalated' ? 'timeout' : null,
        note: typeof payload.note === 'string' ? payload.note : null,
      });
    }
    this.patch({
      waits: this.state.waits.filter((x) => x.eventType !== eventType),
      timeline: this.log({
        nodeId: w?.nodeId,
        kind: w?.kind === 'approval' ? 'approval' : 'event',
        message: w
          ? `${w.kind === 'approval' ? w.title : this.stepLabel(w.nodeId)}: ${outcome === 'escalated' || outcome === 'timeout' ? 'timed out' : outcome}${payload.by ? ` by ${String(payload.by)}` : ''}${payload.note ? ` — “${String(payload.note)}”` : ''}`
          : outcome,
        key: `close:${eventType}`,
      }),
    });
    await this.syncIndex();
  }

  async continuedAs(instanceId: string, generation: number) {
    if (generation <= this.state.generation) return;
    this.patch({
      instanceId,
      generation,
      seq: 0,
      timeline: this.log({
        kind: 'order',
        message: `Continued as run ${generation}`,
        key: `gen:${generation}`,
      }),
    });
    await this.syncIndex();
  }

  async checkInstance(payload: { attempt: number }) {
    if (!this.state.instanceId) return;
    // `rollback` is newer than the installed workers-types.
    const st = (await (
      await this.env.ORDER_WORKFLOW.get(this.state.instanceId)
    ).status()) as InstanceStatus & {
      rollback?: { outcome: 'complete' | 'failed'; error: { message: string } | null } | null;
    };
    const settled = ['errored', 'terminated', 'complete'].includes(st.status);
    if (!settled) {
      if (payload.attempt < 60)
        await this.schedule(10, 'checkInstance', { attempt: payload.attempt + 1 });
      return;
    }
    // Older runtimes (and local dev) omit `rollback`; fall back to the rollback reports we received.
    const rolledBack = Object.values(this.state.nodes).some((n) => n.status === 'rolled_back');
    const rb =
      st.rollback ??
      (st.status === 'errored' && rolledBack
        ? { outcome: 'complete' as const, error: null }
        : null);
    if (!rb) return;
    this.patch({
      rollback: { outcome: rb.outcome, error: rb.error?.message ?? null },
      status: rb.outcome === 'complete' ? 'rolled_back' : 'failed',
      timeline: this.log({
        kind: 'rollback',
        message:
          rb.outcome === 'complete' ? 'Rollback complete' : `Rollback failed: ${rb.error?.message}`,
        key: 'rollback:done',
      }),
    });
    await this.syncIndex();
  }

  // ── Callable from the order page ──
  //
  // The web app proxies the page's WebSocket here with the signed-in principal in a header it signs
  // (PRINCIPAL_HEADER); `onConnect` keeps it on the connection. Each socket call re-reads a
  // person's session and user from D1, so signing out, a password reset, being disabled or a role
  // change applies to a page that is already open. The same methods called over RPC (EngineApi,
  // from the web app's own authorized routes) or by the Workflow have no connection and are trusted.

  override async onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext) {
    const principal = await forwardedPrincipal(this.env, ctx.request);
    // The gate (agent-routes.ts) refuses this before it gets here; this close is a backstop, and
    // comes after the SDK's own first frames.
    if (!principal) {
      connection.close(4401, 'Session ended');
      return;
    }
    connection.setState({ principal });
    if (!this.getSchedules().some((s) => s.callback === 'recheckConnections'))
      await this.schedule(OrderAgent.RECHECK_S, 'recheckConnections');
  }

  /** No child agents: a `/sub/` path inside this one is refused (agent-routes.ts refuses it first). */
  override async onBeforeSubAgent(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  }

  /** How often open sockets are checked against live sign-ins. */
  private static RECHECK_S = 30;

  /**
   * Closes every socket whose person can no longer read the order (signed out, disabled, a revoked
   * token, a role below viewer): state broadcasts reach a socket without it calling anything, so a
   * call's own check isn't enough. Runs on a schedule while anyone has the order open.
   */
  async recheckConnections() {
    let open = 0;
    for (const c of this.getConnections<ConnectionState>()) {
      const stored = c.state?.principal ?? null;
      // A check no one made: it doesn't keep the session from going idle.
      const p = stored ? await livePrincipal(this.env, stored, { touch: false }) : null;
      if (!p || !atLeast(p.role, 'viewer')) c.close(4401, 'Session ended');
      else open++;
    }
    // Counted afresh: a socket that opened while this ran found this job still queued and
    // scheduled none of its own.
    if (open || [...this.getConnections()].length)
      await this.schedule(OrderAgent.RECHECK_S, 'recheckConnections');
  }

  /**
   * For a socket call, the caller as they are now if they hold at least `min`, else throws. For an
   * RPC call, null. A socket without a principal (which only a misconfigured proxy could open), or
   * whose session has ended, is refused and closed.
   */
  private async authorize(min: Role): Promise<Principal | null> {
    const { connection } = getCurrentAgent();
    if (!connection) return null;
    const stored = (connection.state as ConnectionState | null)?.principal ?? null;
    const p = stored ? await livePrincipal(this.env, stored) : null;
    if (!p) {
      // Close once the refusal has gone out, so the page can show why.
      setTimeout(() => connection.close(4401, 'Session ended'), 100);
      throw new Error(SESSION_ENDED);
    }
    if (!atLeast(p.role, min)) throw new Error(`This needs the ${ROLE_LABELS[min]} role.`);
    return p;
  }

  /** The flow version the order runs on; the synced state leaves it out, since it never changes. */
  @callable()
  async getFlow() {
    await this.authorize('viewer');
    return this.pinnedFlow();
  }

  /** The caller as this agent sees them now: their current role, or a refusal if signed out. */
  @callable()
  async whoami() {
    const p = await this.authorize('viewer');
    return p ? { name: p.name, role: p.role } : null;
  }

  /**
   * Approve or reject the approval a node is waiting on. `deciderId` is the principal deciding,
   * from an RPC caller; on a socket it is the signed-in caller, whatever the page sent.
   */
  @callable()
  async decide(
    nodeId: string,
    decision: 'approved' | 'rejected',
    by = 'operator',
    note?: string,
    deciderId?: string,
  ) {
    const caller = await this.authorize('approver');
    const invalid = decisionProblem(decision, note);
    if (invalid) throw new Error(invalid);
    // On a socket the audit trail names the signed-in person, never what the page sent.
    if (caller) by = caller.email ?? caller.name;
    by = String(by).slice(0, 200);
    if (caller) deciderId = caller.id;
    const own = this.state.orderId
      ? await separationRefusal(this.env, this.state.orderId, deciderId)
      : null;
    if (own) throw new Error(own);
    const w = approvalWait(this.state.waits, nodeId);
    if (!w || !this.state.instanceId) throw new Error('That node is not waiting for an approval');
    const instance = await this.env.ORDER_WORKFLOW.get(this.state.instanceId);
    await instance.sendEvent({ type: w.eventType, payload: { decision, by, note: note ?? null } });
    // The AI gate that sent the order here learns whether the review was needed.
    const feedback = aiGateFeedback(this.state, nodeId, decision);
    if (feedback && this.state.orderId)
      this.ctx.waitUntil(sendAiFeedback(this.env, this.state.orderId, feedback));
    // On the order page's socket; an RPC caller (the web app, the assistant) records its own.
    if (caller)
      await recordAudit(this.env, 'approval.decided', {
        actor: caller,
        target: this.state.orderId,
        detail: { nodeId, decision, ...(note ? { note } : {}), via: 'app' },
      });
    return { ok: true };
  }

  /**
   * Deliver a business event (e.g. "payment.received") to whichever node waits for it. Every outside
   * route comes through here, so `goodsBack` goes: only `recordReturn` may say nothing is coming
   * back, since that sends a flow straight to its refund.
   */
  @callable()
  async deliver(
    event: string,
    payload: Record<string, unknown> = {},
    options: { hold?: boolean } = {},
  ) {
    const hold = options?.hold === true;
    if (payload && typeof payload === 'object' && 'goodsBack' in payload) {
      const { goodsBack: _dropped, ...rest } = payload;
      return this.deliverEvent(event, rest, hold);
    }
    return this.deliverEvent(event, payload, hold);
  }

  /**
   * A return or claim a person confirmed on the assistant's card. Not `@callable`: only the engine
   * reaches it, after `returnRequest` has checked it against the order.
   */
  async recordReturn(request: ReturnRequest, meta: { source: string; by: string }) {
    return this.deliverEvent('return.requested', { ...request, ...meta });
  }

  /**
   * With `hold`, an event no step waits for yet is held on the order (see `holdProblem`) and given
   * to the step that waits for it when it opens: `{ delivered: false, held: true }`.
   */
  private async deliverEvent(event: string, payload: Record<string, unknown>, hold = false) {
    const caller = await this.authorize('operator');
    // The payload lands in the order's variables, every broadcast and the next generation.
    const invalid = eventProblem(event, payload);
    if (invalid) throw new Error(invalid);
    const inbox = this.inbox();
    const open = eventWait(this.state.waits, event);
    // A wait being given a held event is spoken for: another event for it is held, not sent.
    const w = open && !inbox.some((h) => h.takenBy === open.eventType) ? open : undefined;
    if (!w || !this.state.instanceId) {
      if (!hold || !this.state.instanceId) return { delivered: false };
      const refused = holdProblem(
        inbox,
        {
          running: !TERMINAL_ORDER_STATUSES.includes(this.state.status),
          flowAwaits: flowAwaits(this.pinnedFlow(), event),
          delivered: this.delivered(),
        },
        event,
        payload,
      );
      if (refused === 'already held') return { delivered: false, held: true };
      // A resend of one a wait already took: taken, so the sender stops.
      if (refused === 'already delivered') return { delivered: true, duplicate: true };
      if (refused) return { delivered: false };
      const at = Date.now();
      this
        .sql`INSERT INTO order_inbox (event, payload, at) VALUES (${event}, ${JSON.stringify(payload)}, ${at})`;
      this.patch({
        timeline: this.log({
          kind: 'event',
          message: `${event} held until a step waits for it`,
          key: `hold:${event}:${at}`,
        }),
      });
      if (caller)
        await recordAudit(this.env, 'order.event_delivered', {
          actor: caller,
          target: this.state.orderId,
          detail: { event, held: true, via: 'app' },
        });
      return { delivered: false, held: true };
    }
    const instance = await this.env.ORDER_WORKFLOW.get(this.state.instanceId);
    await instance.sendEvent({ type: w.eventType, payload: { ...payload, event, at: Date.now() } });
    this.rememberDelivered(event, payload);
    if (caller)
      await recordAudit(this.env, 'order.event_delivered', {
        actor: caller,
        target: this.state.orderId,
        detail: { event, nodeId: w.nodeId, via: 'app' },
      });
    return { delivered: true, nodeId: w.nodeId };
  }

  /** Set while a cancel runs, so a second cancel arriving during its awaits does nothing. */
  private cancelling = false;

  @callable()
  async cancel(reason = 'Cancelled by operator') {
    const caller = await this.authorize('operator');
    reason = String(reason).slice(0, 500);
    if (this.cancelling || TERMINAL_ORDER_STATUSES.includes(this.state.status))
      return { ok: false };
    this.cancelling = true;
    try {
      const done = await this.cancelOrder(reason);
      if (caller)
        await recordAudit(this.env, 'order.cancelled', {
          actor: caller,
          target: this.state.orderId,
          detail: { reason, via: 'app' },
        });
      return done;
    } finally {
      this.cancelling = false;
    }
  }

  private async cancelOrder(reason: string) {
    if (this.state.instanceId) {
      try {
        await (await this.env.ORDER_WORKFLOW.get(this.state.instanceId)).terminate();
      } catch (err) {
        console.warn('terminate', err);
      }
    }
    const undone = this.state.orderId ? await compensateOrder(this.env, this.state.orderId) : null;
    if (this.state.orderId) {
      await this.records().cancelApprovals(this.state.orderId);
    }
    // A cancelled order takes no more events: what it held goes.
    this.forgetEvents();
    this.patch({
      status: 'cancelled',
      reason,
      waits: [],
      timeline: this.log({
        kind: 'order',
        message: `Cancelled: ${reason}${undone ? ` (${undoneText(undone)})` : ''}`,
      }),
    });
    await this.syncIndex();
    // Cancelling terminates the Workflow, so no End node announces it; the agent does.
    await this.schedule(0, 'emitWebhook', {
      key: 'cancel',
      event: 'order.cancelled',
      data: {
        order: this.state.order ? orderSummary(this.state.order) : null,
        outcome: 'cancelled',
        reason,
      },
      attempt: 0,
    });
    return { ok: true };
  }

  // ── A2A watchers ──
  // An A2A task that follows this order (apps/engine/src/a2a/) registers its caller's A2AAgent
  // here, and is told whenever the order's status or waits change, so the task can push the update
  // after the request that started it has ended.

  private watchers(): string[] {
    this.tables();
    return this.sql<{ name: string }>`SELECT name FROM a2a_watchers`.map((r) => r.name);
  }

  /** Registers an A2AAgent (by name) to hear about this order. Repeats are harmless. */
  async watch(name: string) {
    this.watchers();
    this.sql`INSERT OR IGNORE INTO a2a_watchers (name) VALUES (${name})`;
  }

  override onStateChanged(state: State | undefined) {
    if (!state?.orderId) return;
    if (ucpMetaOf(state.order?.meta)) this.queueUcpSync();
    if (!this.watchers().length) return;
    const key = watchKey(state);
    const last = this.sql<{ key: string }>`SELECT key FROM a2a_watch_state WHERE id = 1`[0]?.key;
    if (key === last) return;
    this.sql`INSERT OR REPLACE INTO a2a_watch_state (id, key) VALUES (1, ${key})`;
    this.ctx.waitUntil(this.schedule(0, 'notifyWatchers', { names: this.watchers(), attempt: 0 }));
  }

  /**
   * Tells each watcher the order moved. A watcher that can't be reached is retried with the
   * webhooks' backoff; once the order has finished and everyone has heard, the list is cleared.
   */
  async notifyWatchers(p: { names: string[]; attempt: number }) {
    const orderId = this.state.orderId;
    if (!orderId) return;
    const missed: string[] = [];
    for (const name of p.names) {
      try {
        await a2aAgent(this.env, name).orderChanged(orderId);
      } catch (err) {
        console.warn('a2a watcher', name, err);
        missed.push(name);
      }
    }
    if (missed.length && p.attempt < WEBHOOK_RETRIES)
      await this.schedule(10 * 2 ** p.attempt, 'notifyWatchers', {
        names: missed,
        attempt: p.attempt + 1,
      });
    else if (TERMINAL_ORDER_STATUSES.includes(this.state.status))
      this.sql`DELETE FROM a2a_watchers`;
  }

  // ── UCP order events ──
  // An order a UCP checkout placed tells the platform about every change: a sync a moment after
  // the state settles sends the whole order entity, unless it is the same as the last one sent.

  private ucpSyncRow() {
    this.tables();
    return this.sql<{
      digest: string | null;
      pending: number;
      released: number;
    }>`SELECT digest, pending, released FROM ucp_sync WHERE id = 1`[0];
  }

  private queueUcpSync() {
    if (this.ucpSyncRow()?.pending) return;
    this
      .sql`INSERT INTO ucp_sync (id, pending) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET pending = 1`;
    this.ctx.waitUntil(this.schedule(2, 'ucpSync', { attempt: 0 }));
  }

  /** Sends the platform the order as it is now; retried with the webhooks' backoff. */
  async ucpSync(p: { attempt: number }) {
    const orderId = this.state.orderId;
    const u = ucpMetaOf(this.state.order?.meta);
    if (!orderId || !u) return;
    this.sql`UPDATE ucp_sync SET pending = 0 WHERE id = 1`;
    const row = this.ucpSyncRow();
    // A hold the checkout placed that no step took is released once the order ends without it.
    const intent = this.state.order?.payment?.intentId;
    if (intent && !row?.released && UNFULFILLED.includes(this.state.status)) {
      try {
        await releaseHold(this.env, intent);
        this.sql`UPDATE ucp_sync SET released = 1 WHERE id = 1`;
      } catch (err) {
        console.warn('ucp release hold', orderId, err);
      }
    }
    let out: Awaited<ReturnType<typeof syncUcpOrder>>;
    try {
      out = await syncUcpOrder(this.env, orderId, u, row?.digest ?? null);
    } catch (err) {
      out = { sent: false, retry: true, reason: String(err) };
    }
    if (out.sent) this.sql`UPDATE ucp_sync SET digest = ${out.digest} WHERE id = 1`;
    else if (out.retry && p.attempt < WEBHOOK_RETRIES)
      await this.schedule(10 * 2 ** p.attempt, 'ucpSync', { attempt: p.attempt + 1 });
    else if (out.retry) console.warn('ucp order event gave up', orderId, out.reason);
  }

  /**
   * Delivers an outbound webhook from the agent, for endings the Workflow doesn't see. Retries on
   * the agent's own schedule with the same backoff as `emitStep`, then leaves the row `failed`.
   */
  async emitWebhook(p: {
    key: string;
    event: OrderEvent;
    data: Record<string, unknown>;
    attempt: number;
  }) {
    if (!this.state.orderId) return;
    let pending = 1;
    try {
      ({ pending } = await emit(this.env, p.key, this.state.orderId, p.event, p.data));
    } catch (err) {
      console.warn('webhook emit', p.event, err);
    }
    if (pending && p.attempt < WEBHOOK_RETRIES)
      await this.schedule(10 * 2 ** p.attempt, 'emitWebhook', { ...p, attempt: p.attempt + 1 });
  }
}

/** What cancelling undid, for the timeline: "released 2 reservations, voided 1 authorization, …". */
function undoneText(u: Awaited<ReturnType<typeof compensateOrder>>) {
  const parts = [
    `released ${plural(u.released, 'reservation')}`,
    `voided ${plural(u.voided, 'authorization')}`,
    `cancelled ${plural(u.cancelled, 'shipment')}`,
  ];
  if (u.restored) parts.push(`restocked ${plural(u.restored, 'line')}`);
  if (u.invoicesVoided) parts.push(`voided ${plural(u.invoicesVoided, 'invoice')}`);
  if (u.invoicesPaid.length) parts.push(`left paid invoices ${u.invoicesPaid.join(', ')}`);
  if (u.unbilled) parts.push(`reversed ${plural(u.unbilled, 'account charge')}`);
  if (u.creditReleased) parts.push(`released ${plural(u.creditReleased, 'credit hold')}`);
  if (u.budgetSpendReversed)
    parts.push(`gave back ${plural(u.budgetSpendReversed, 'budget spend')}`);
  if (u.sellerOrdersCancelled) parts.push(plural(u.sellerOrdersCancelled, 'seller order'));
  if (u.payoutsReversed) parts.push(`reversed ${plural(u.payoutsReversed, 'payout')}`);
  if (u.revoked) parts.push(`revoked ${plural(u.revoked, 'code')}`);
  const text = parts.join(', ');
  return u.labelsNotVoided
    ? `${text}; ${plural(u.labelsNotVoided, 'label')} could not be voided with the label provider`
    : text;
}
