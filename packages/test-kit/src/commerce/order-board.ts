/**
 * The order board port in memory, over seeded rows shaped like the D1 tables. The contract in
 * ./order-board-contract.ts holds it to the same behaviour as the D1 store.
 */
import { TERMINAL_ORDER_STATUSES } from '@commerceworker/core';
import type {
  ApprovalCursor,
  ApprovalRecord,
  ApprovalRow,
  ApprovalScope,
  BoardFilter,
  InboundEmailRow,
  IndexedOrder,
  OrderBoard,
  OrderRecordsView,
  PaymentRecord,
  PerformanceFigures,
  RecentRecords,
  RecordedRun,
} from '@commerceworker/ports/commerce';

const DAY = 86_400_000;
const OPEN_STATUSES = ['queued', 'running', 'waiting'];

/** An order row: what a test names, the rest as the D1 schema defaults them. */
export type BoardOrder = Pick<IndexedOrder, 'id' | 'status' | 'createdAt'> & Partial<IndexedOrder>;

export interface OrderBoardFixture {
  orders?: BoardOrder[];
  approvals?: (Pick<ApprovalRecord, 'id' | 'orderId' | 'nodeId' | 'title' | 'requestedAt'> &
    Partial<ApprovalRecord>)[];
  customers?: { id: string; name: string }[];
  flows?: { id: string; name: string }[];
  /** Published versions' steps, for an approval's step label. */
  flowVersions?: { flowId: string; version: number; nodes: { id: string; label: string }[] }[];
  runs?: RecordedRun[];
  documents?: OrderRecordsView['documents'];
  messages?: OrderRecordsView['messages'];
  payments?: PaymentRecord[];
  shipments?: OrderRecordsView['shipments'];
  sellers?: { id: string; name: string }[];
  sellerOrders?: {
    id?: string;
    orderId: string;
    sellerId: string;
    status: string;
    subtotal: number;
    reason?: string | null;
    createdAt: number;
  }[];
  payouts?: {
    id?: string;
    orderId: string;
    sellerId: string;
    status: string;
    net: number;
    commission: number;
    /** Net plus commission when left out. */
    gross?: number;
    createdAt: number;
  }[];
  invoices?: (OrderRecordsView['invoices'][number] & {
    orderId: string;
    createdAt: number;
    provider?: string;
    terms?: string;
  })[];
  reservations?: {
    id?: string;
    orderId: string;
    status: string;
    sku?: string;
    qty?: number;
    locationId?: string | null;
    createdAt?: number;
  }[];
  locations?: { id: string; name: string }[];
  entitlements?: { orderId: string; status: string }[];
  inboundEmails?: InboundEmailRow[];
}

/** A row as D1 returns it, with the schema's defaults. */
export const indexedOrder = (o: BoardOrder): IndexedOrder => ({
  model: 'b2b',
  channel: 'api',
  externalId: null,
  contactEmail: null,
  title: '',
  flowId: 'ob_flow',
  flowVersion: 1,
  instanceId: `${o.id}-g1`,
  generation: 1,
  customerId: null,
  currency: 'USD',
  total: 0,
  waitingOn: null,
  waitingAt: null,
  waitingSince: null,
  waitingDue: null,
  waitingFor: null,
  stoppedAt: null,
  reason: null,
  updatedAt: o.createdAt,
  idempotencyKey: null,
  idempotencyFingerprint: null,
  fxRate: 1,
  startedBy: null,
  erasedAt: null,
  addressPending: null,
  ...o,
});

export const approvalRecord = (
  a: NonNullable<OrderBoardFixture['approvals']>[number],
): ApprovalRecord => ({
  eventType: `approval:${a.id}`,
  assignee: '',
  amount: null,
  status: 'pending',
  note: null,
  decidedAt: null,
  decidedBy: null,
  ...a,
});

/** SQLite's text order: by code unit, not locale. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** SQLite's LIKE: case-insensitive for ASCII. */
const has = (text: string | null | undefined, q: string) =>
  (text ?? '').toLowerCase().includes(q.toLowerCase());

const byKey =
  <T>(...keys: ((x: T) => number | string)[]) =>
  (a: T, b: T) => {
    for (const k of keys) {
      const x = k(a);
      const y = k(b);
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
const neg =
  <T>(k: (x: T) => number) =>
  (x: T) =>
    -k(x);
/** Descending on a string: compare reversed. */
const descStr =
  <T>(k: (x: T) => string) =>
  (a: T, b: T) =>
    cmp(k(b), k(a));

export class InMemoryOrderBoard implements OrderBoard {
  private readonly orders: IndexedOrder[];
  private readonly asks: ApprovalRecord[];

  constructor(private readonly f: OrderBoardFixture = {}) {
    this.orders = (f.orders ?? []).map(indexedOrder);
    this.asks = (f.approvals ?? []).map(approvalRecord);
  }

  private order(id: string) {
    return this.orders.find((o) => o.id === id);
  }
  private customerName(id: string | null) {
    return id ? (this.f.customers?.find((c) => c.id === id)?.name ?? null) : null;
  }
  private declined(o: IndexedOrder) {
    return (
      o.status === 'cancelled' &&
      this.asks.some((a) => a.orderId === o.id && ['escalated', 'rejected'].includes(a.status))
    );
  }

  private picks(f: BoardFilter) {
    const q = f.q?.trim().replace(/^#/, '');
    return (o: IndexedOrder) => {
      if (
        f.after &&
        !(
          o.createdAt < f.after.createdAt ||
          (o.createdAt === f.after.createdAt && o.id < f.after.id)
        )
      )
        return false;
      if (f.model && o.model !== f.model) return false;
      if (f.channel && o.channel !== f.channel) return false;
      if (f.flow && o.flowId !== f.flow) return false;
      if (f.customer && o.customerId !== f.customer) return false;
      if (f.step && !has(o.waitingAt, f.step) && !has(o.stoppedAt, f.step)) return false;
      if (f.updatedSince !== undefined && o.updatedAt < f.updatedSince) return false;
      if (f.status === 'declined') {
        if (o.status !== 'declined' && !this.declined(o)) return false;
      } else if (f.status) {
        if (o.status !== f.status) return false;
        if (OPEN_STATUSES.includes(f.status) && !o.instanceId) return false;
      }
      if (
        f.attention &&
        !['failed', 'rolled_back'].includes(o.status) &&
        !(o.instanceId && this.asks.some((a) => a.orderId === o.id && a.status === 'pending'))
      )
        return false;
      if (
        q &&
        ![
          o.id,
          o.title,
          o.customerId,
          this.customerName(o.customerId),
          o.contactEmail,
          o.externalId,
        ].some((t) => has(t, q))
      )
        return false;
      return true;
    };
  }

  private sorted(f: BoardFilter) {
    const id = (o: IndexedOrder) => o.id;
    const sort =
      f.sort === 'oldest'
        ? byKey<IndexedOrder>((o) => o.createdAt, id)
        : f.sort === 'total'
          ? (a: IndexedOrder, b: IndexedOrder) =>
              b.total / b.fxRate - a.total / a.fxRate || cmp(b.id, a.id)
          : f.sort === 'updated'
            ? (a: IndexedOrder, b: IndexedOrder) => b.updatedAt - a.updatedAt || cmp(b.id, a.id)
            : f.sort === 'waiting'
              ? (a: IndexedOrder, b: IndexedOrder) =>
                  Number(a.waitingSince === null) - Number(b.waitingSince === null) ||
                  (a.waitingSince ?? 0) - (b.waitingSince ?? 0) ||
                  cmp(b.id, a.id)
              : (a: IndexedOrder, b: IndexedOrder) => b.createdAt - a.createdAt || cmp(b.id, a.id);
    return this.orders.filter(this.picks(f)).sort(sort);
  }

  async list(f: BoardFilter, limit: number) {
    return this.sorted(f).slice(0, limit);
  }

  async count(f: BoardFilter, cap: number) {
    const { after: _, ...filters } = f;
    const n = this.orders.filter(this.picks(filters)).length;
    return { n: Math.min(n, cap), more: n > cap };
  }

  private inScope(scope?: ApprovalScope) {
    return (a: ApprovalRecord) => {
      if (!scope) return true;
      const run = !!this.order(a.orderId)?.instanceId;
      return scope === 'live' ? run : !run;
    };
  }

  private row(a: ApprovalRecord, total: number): ApprovalRow {
    const o = this.order(a.orderId);
    const label = o
      ? (this.f.flowVersions
          ?.find((v) => v.flowId === o.flowId && v.version === o.flowVersion)
          ?.nodes.find((n) => n.id === a.nodeId)?.label ?? null)
      : null;
    const { eventType: _e, ...approval } = a;
    return {
      ...approval,
      orderModel: o?.model ?? null,
      orderTitle: o?.title ?? null,
      stepLabel: label,
      flowId: o?.flowId ?? null,
      flowName: o ? (this.f.flows?.find((x) => x.id === o.flowId)?.name ?? null) : null,
      currency: o?.currency ?? null,
      customerId: o?.customerId ?? null,
      customerName: this.customerName(o?.customerId ?? null),
      fxRate: o?.fxRate ?? null,
      startedBy: o?.startedBy ?? null,
      total,
    };
  }

  async approvals(
    status: string,
    after: ApprovalCursor | null,
    limit: number,
    scope?: ApprovalScope,
  ) {
    const pending = status === 'pending';
    const all = this.asks
      .filter((a) => status === 'all' || a.status === status)
      .filter(this.inScope(scope))
      .sort(
        pending
          ? byKey<ApprovalRecord>(
              (a) => a.requestedAt,
              (a) => a.id,
            )
          : (a, b) => b.requestedAt - a.requestedAt || descStr<ApprovalRecord>((x) => x.id)(a, b),
      );
    const beyond = (a: ApprovalRecord) =>
      !after ||
      (pending
        ? a.requestedAt > after.requestedAt ||
          (a.requestedAt === after.requestedAt && a.id > after.id)
        : a.requestedAt < after.requestedAt ||
          (a.requestedAt === after.requestedAt && a.id < after.id));
    const rest = all.filter(beyond);
    const from = all.length - rest.length;
    const shown = rest.slice(0, limit).map((a) => this.row(a, all.length));
    const last = shown.at(-1);
    return {
      rows: shown,
      from,
      total: shown.length ? all.length : from,
      next: rest.length > limit && last ? { requestedAt: last.requestedAt, id: last.id } : null,
    };
  }

  async pendingApprovalCounts() {
    const pending = this.asks.filter((a) => a.status === 'pending');
    const live = pending.filter(this.inScope('live')).length;
    return { live, recorded: pending.length - live };
  }

  async overview(now: number) {
    const dayAgo = now - DAY;
    const weekAgo = now - 7 * DAY;
    const groups = <K extends string, T>(xs: T[], key: (x: T) => K) => {
      const m = new Map<K, T[]>();
      for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
      return [...m.values()];
    };
    const open = groups(
      this.orders.filter((o) => OPEN_STATUSES.includes(o.status) && o.instanceId),
      (o) => o.status,
    ).map((g) => ({ status: g[0]!.status, n: g.length }));
    const ended = groups(
      this.orders.filter(
        (o) => TERMINAL_ORDER_STATUSES.includes(o.status as never) && o.updatedAt >= dayAgo,
      ),
      (o) => o.status,
    ).map((g) => ({
      status: g[0]!.status,
      n: g.length,
      total: g.reduce((s, o) => s + o.total / o.fxRate, 0),
    }));
    const waiting = this.orders.filter((o) => o.status === 'waiting' && o.instanceId);
    const waitsByFlow = groups(waiting, (o) => `${o.flowId}\0${o.waitingAt}\0${o.waitingFor}`).map(
      (g) => {
        const since = g.map((o) => o.waitingSince).filter((x): x is number => x !== null);
        return {
          flowId: g[0]!.flowId,
          at: g[0]!.waitingAt,
          for: g[0]!.waitingFor,
          n: g.length,
          oldest: since.length ? Math.min(...since) : null,
          overdue: g.filter((o) => o.waitingDue !== null && o.waitingDue <= now).length,
        };
      },
    );
    const stoppedWeek = groups(
      this.orders.filter(
        (o) => ['failed', 'rolled_back'].includes(o.status) && o.updatedAt >= weekAgo,
      ),
      (o) => `${o.flowId}\0${o.stoppedAt ?? ''}`,
    )
      .map((g) => {
        const newest = [...g].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
        return {
          flowId: g[0]!.flowId,
          at: g[0]!.stoppedAt,
          n: g.length,
          rolledBack: g.filter((o) => o.status === 'rolled_back').length,
          latest: newest.updatedAt,
          reason: newest.reason,
        };
      })
      .sort((a, b) => b.n - a.n);
    const queue = await this.approvals('pending', null, 5, 'live');
    return {
      open,
      recent: this.sorted({ sort: 'updated' }).slice(0, 8),
      approvals: queue.rows,
      pendingApprovals: queue.rows[0]?.total ?? 0,
      ended24h: ended,
      declined24h: this.orders.filter((o) => this.declined(o) && o.updatedAt >= dayAgo).length,
      waitsByFlow,
      stoppedWeek,
    };
  }

  async records(orderId: string): Promise<OrderRecordsView> {
    const mine = <T extends { orderId: string; createdAt: number }>(xs: T[] | undefined) =>
      (xs ?? []).filter((x) => x.orderId === orderId).sort((a, b) => b.createdAt - a.createdAt);
    const seller = (id: string) => this.f.sellers?.find((s) => s.id === id)?.name ?? null;
    const bySeller = <T extends { sellerId: string }>(xs: T[]) =>
      [...xs].sort((a, b) => cmp(a.sellerId, b.sellerId));
    return {
      documents: mine(this.f.documents),
      messages: mine(this.f.messages),
      payments: mine(this.f.payments),
      shipments: mine(this.f.shipments),
      sellers: bySeller(mine(this.f.sellerOrders)).map((p) => ({
        sellerId: p.sellerId,
        name: seller(p.sellerId) ?? 'Marketplace',
        status: p.status,
        subtotal: p.subtotal,
        reason: p.reason ?? null,
      })),
      payouts: bySeller(mine(this.f.payouts)).map((p) => ({
        sellerId: p.sellerId,
        name: seller(p.sellerId),
        status: p.status,
        net: p.net,
        commission: p.commission,
      })),
      invoices: mine(this.f.invoices).map(({ orderId: _o, createdAt: _c, ...i }) => i),
    };
  }

  async recorded(orderId: string) {
    const order = this.order(orderId);
    if (!order) return undefined;
    const count = (xs: { orderId: string; status: string }[] | undefined, status: string) =>
      (xs ?? []).filter((x) => x.orderId === orderId && x.status === status).length;
    return {
      order,
      runs: (this.f.runs ?? [])
        .filter((r) => r.orderId === orderId && r.generation === order.generation)
        .sort((a, b) => a.startedAt - b.startedAt),
      approvals: this.asks
        .filter((a) => a.orderId === orderId)
        .sort((a, b) => a.requestedAt - b.requestedAt),
      undone:
        order.status === 'rolled_back'
          ? {
              reservationsReleased: count(this.f.reservations, 'released'),
              authorizationsVoided: count(this.f.payments, 'voided'),
              sellerOrdersCancelled: count(this.f.sellerOrders, 'cancelled'),
              payoutsReversed: count(this.f.payouts, 'reversed'),
              shipmentsCancelled: count(this.f.shipments, 'cancelled'),
              invoicesVoided: count(this.f.invoices, 'void'),
              codesRevoked: count(this.f.entitlements, 'revoked'),
            }
          : null,
    };
  }

  async performance(since: number): Promise<PerformanceFigures> {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const ended = this.orders.filter(
      (o) => TERMINAL_ORDER_STATUSES.includes(o.status as never) && o.updatedAt >= since,
    );
    const group = <T, K extends string>(xs: T[], key: (x: T) => K) => {
      const m = new Map<K, T[]>();
      for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
      return [...m];
    };
    const completion = group(ended, (o) => o.model)
      .map(([model, os]) => ({
        model,
        finished: os.length,
        completed: os.filter((o) => o.status === 'completed').length,
      }))
      .sort((a, b) => b.finished - a.finished);
    const nodes = group(
      (this.f.runs ?? []).filter((r) => r.endedAt >= since),
      (r) => r.nodeType,
    )
      .map(([type, rs]) => {
        const ms = rs.map((r) => r.durationMs).sort((a, b) => a - b);
        const at = (p: number) => ms[Math.ceil((ms.length * p) / 100) - 1]!;
        return { type, n: ms.length, p50: at(50), p95: at(95) };
      })
      .sort((a, b) => b.p95 - a.p95);
    const revenue = group(
      this.orders.filter((o) => o.status === 'completed' && o.updatedAt >= since),
      (o) => day(o.updatedAt),
    ).map(([d, os]) => ({ day: d, total: os.reduce((t, o) => t + o.total / o.fxRate, 0) }));
    const rate = (orderId: string) => this.order(orderId)?.fxRate ?? 1;
    const money = group(
      (this.f.payments ?? []).filter((p) => p.status === 'succeeded' && p.createdAt >= since),
      (p) => day(p.createdAt),
    ).map(([d, ps]) => ({
      day: d,
      collected: ps
        .filter((p) => p.kind === 'capture' || p.kind === 'charge')
        .reduce((t, p) => t + p.amount / rate(p.orderId), 0),
      refunded: ps
        .filter((p) => p.kind === 'refund')
        .reduce((t, p) => t + p.amount / rate(p.orderId), 0),
    }));
    const endings = group(ended, (o) => `${day(o.updatedAt)}|${o.status}`).map(([, os]) => ({
      day: day(os[0]!.updatedAt),
      status: os[0]!.status,
      n: os.length,
    }));
    return { completion, nodes, revenue, money, endings };
  }

  async recentRecords(rawQ: string, perKind: number): Promise<RecentRecords> {
    const term = rawQ.trim().replace(/^#/, '');
    const seller = (id: string) => this.f.sellers?.find((x) => x.id === id)?.name ?? null;
    const location = (id: string | null | undefined) =>
      (id && this.f.locations?.find((l) => l.id === id)?.name) || null;
    /** Each record with its order (left out when that is gone), matched and newest first. */
    const of = <T extends { orderId: string; createdAt: number }>(
      xs: T[],
      own: (x: T) => (string | null | undefined)[],
    ) =>
      xs
        .flatMap((x) => {
          const o = this.order(x.orderId);
          if (!o) return [];
          const context = {
            orderId: o.id,
            orderTitle: o.title,
            customerName: this.customerName(o.customerId),
            contactEmail: o.contactEmail,
          };
          const texts = [o.id, o.title, o.contactEmail, context.customerName, ...own(x)];
          return !term || texts.some((t) => has(t, term)) ? [{ ...x, ...context }] : [];
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, perKind);
    return {
      payments: of(this.f.payments ?? [], (p) => [p.ref, p.externalId]),
      invoices: of(
        (this.f.invoices ?? []).map((i) => ({
          id: i.id,
          orderId: i.orderId,
          number: i.number,
          provider: i.provider ?? 'mock',
          terms: i.terms ?? 'net_30',
          amount: i.amount,
          currency: i.currency,
          status: i.status,
          createdAt: i.createdAt,
        })),
        (i) => [i.number],
      ),
      payouts: of(
        (this.f.payouts ?? []).map((p, i) => ({
          id: p.id ?? `ob_po_${i}`,
          orderId: p.orderId,
          sellerId: p.sellerId,
          seller: seller(p.sellerId),
          gross: p.gross ?? p.net + p.commission,
          commission: p.commission,
          net: p.net,
          status: p.status,
          createdAt: p.createdAt,
        })),
        (p) => [p.seller],
      ),
      shipments: of(
        (this.f.shipments ?? []).map(({ id, orderId, carrier, tracking, status, createdAt }) => ({
          id,
          orderId,
          carrier,
          tracking,
          status,
          createdAt,
        })),
        (x) => [x.tracking, x.carrier],
      ),
      holds: of(
        (this.f.reservations ?? []).map((r, i) => ({
          id: r.id ?? `ob_res_${i}`,
          orderId: r.orderId,
          sku: r.sku ?? 'OB-SKU',
          qty: r.qty ?? 1,
          location: location(r.locationId),
          status: r.status,
          createdAt: r.createdAt ?? 1,
        })),
        (h) => [h.sku],
      ),
      sellerOrders: of(
        (this.f.sellerOrders ?? []).map((p, i) => ({
          id: p.id ?? `ob_so_${i}`,
          orderId: p.orderId,
          sellerId: p.sellerId,
          seller: seller(p.sellerId),
          subtotal: p.subtotal,
          reason: p.reason ?? null,
          status: p.status,
          createdAt: p.createdAt,
        })),
        (p) => [p.seller],
      ),
      messages: of(
        (this.f.messages ?? []).map(({ id, orderId, recipient, subject, createdAt }) => ({
          id,
          orderId,
          recipient,
          subject,
          createdAt,
        })),
        (m) => [m.recipient, m.subject],
      ),
      documents: of(
        (this.f.documents ?? []).map(({ id, orderId, kind, contentType, createdAt }) => ({
          id,
          orderId,
          kind,
          contentType,
          createdAt,
        })),
        (d) => [d.kind],
      ),
    };
  }

  async waitingOnEvents(limit: number, now: number) {
    const all = this.orders
      .filter(
        (o) =>
          ['waiting', 'running'].includes(o.status) && o.instanceId && has(o.waitingFor, 'event:'),
      )
      .sort(neg((o) => o.updatedAt));
    return {
      orders: all.slice(0, limit),
      total: all.length,
      overdue: all.filter((o) => o.waitingDue !== null && o.waitingDue <= now).length,
    };
  }

  async runningByFlow() {
    const out = new Map<string, { flowId: string; version: number; n: number }>();
    for (const o of this.orders)
      if (OPEN_STATUSES.includes(o.status) && o.instanceId) {
        const k = `${o.flowId}\0${o.flowVersion}`;
        const had = out.get(k) ?? { flowId: o.flowId, version: o.flowVersion, n: 0 };
        out.set(k, { ...had, n: had.n + 1 });
      }
    return [...out.values()];
  }

  async declinedOrderIds(ids: readonly string[]) {
    const wanted = new Set(ids);
    return this.orders.filter((o) => wanted.has(o.id) && this.declined(o)).map((o) => o.id);
  }

  async inboundEmails(limit: number) {
    return [...(this.f.inboundEmails ?? [])]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit);
  }
}
