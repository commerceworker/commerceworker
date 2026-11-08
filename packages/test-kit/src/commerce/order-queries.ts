/**
 * The order queries port in memory, over a seeded orders index. The contract in
 * ./order-queries-contract.ts holds it to the same behaviour as the D1 store.
 */
import { money } from '@commerceworker/core';
import type { FoundOrder, OrderFilter, OrderQueries } from '@commerceworker/ports/commerce';

const DAY = 86_400_000;

export interface OrderQueriesFixture {
  customers?: { id: string; name: string }[];
  orders?: {
    id: string;
    title: string;
    status: string;
    model: string;
    channel: string;
    customerId: string | null;
    total: number;
    currency: string;
    fxRate: number;
    waitingOn: string | null;
    /** When the current wait opened; null for an order indexed before it was recorded. */
    waitingSince?: number | null;
    createdAt: number;
    updatedAt: number;
    idempotencyKey?: string | null;
    flowId?: string;
    flowVersion?: number;
  }[];
  /** Published flow versions, by flow and version. */
  flowVersions?: { flowId: string; version: number; flow: unknown }[];
  approvals?: {
    id: string;
    orderId: string;
    nodeId: string;
    title: string;
    amount: number | null;
    status: string;
    requestedAt: number;
  }[];
}

const has = (text: string | null | undefined, q: string) =>
  (text ?? '').toLowerCase().includes(q.toLowerCase());

export class InMemoryOrderQueries implements OrderQueries {
  constructor(private readonly f: OrderQueriesFixture = {}) {}

  private customerName(id: string | null) {
    return id ? (this.f.customers?.find((c) => c.id === id)?.name ?? null) : null;
  }

  async attention(now: number, cap: number) {
    const orders = this.f.orders ?? [];
    const pending = (this.f.approvals ?? [])
      .filter((a) => a.status === 'pending')
      .sort((a, b) => a.requestedAt - b.requestedAt);
    const failed = orders
      .filter((o) => ['failed', 'rolled_back'].includes(o.status) && o.updatedAt >= now - 3 * DAY)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    // Waiting too long counts from when the current wait opened, not the order's last change.
    const since = (o: (typeof orders)[number]) => o.waitingSince ?? o.updatedAt;
    const stalled = orders
      .filter((o) => o.status === 'waiting' && o.waitingOn !== null && since(o) <= now - DAY)
      .sort((a, b) => since(a) - since(b));
    return {
      approvals: pending
        .slice(0, cap)
        .map(({ id, orderId, nodeId, title, amount, requestedAt }) => ({
          id,
          orderId,
          nodeId,
          title,
          amount,
          requestedAt,
        })),
      failed: failed
        .slice(0, cap)
        .map(({ id, title, status, updatedAt }) => ({ id, title, status, updatedAt })),
      stalled: stalled.slice(0, cap).map(({ id, title, waitingOn, waitingSince, updatedAt }) => ({
        id,
        title,
        waitingOn,
        waitingSince: waitingSince ?? null,
        updatedAt,
      })),
      counts: { approvals: pending.length, failed: failed.length, stalled: stalled.length },
    };
  }

  async find(f: OrderFilter, now: number) {
    const base = (o: { total: number; fxRate: number }) => o.total / o.fxRate;
    const matched = (this.f.orders ?? []).filter((o) => {
      const name = this.customerName(o.customerId);
      return (
        (!f.status || o.status === f.status) &&
        (!f.model || o.model === f.model) &&
        (!f.channel || o.channel === f.channel) &&
        (!f.customer || has(name, f.customer) || o.customerId === f.customer) &&
        (!f.q || has(o.id, f.q) || has(o.title, f.q) || has(name, f.q)) &&
        (f.minTotal === undefined || base(o) >= f.minTotal) &&
        (f.maxTotal === undefined || base(o) <= f.maxTotal) &&
        (!f.sinceDays || o.createdAt >= now - f.sinceDays * DAY)
      );
    });
    const key = (o: (typeof matched)[number]) =>
      f.sort === 'largest' ? base(o) : f.sort === 'updated' ? o.updatedAt : o.createdAt;
    const sorted = [...matched].sort((a, b) => key(b) - key(a));
    const orders: FoundOrder[] = sorted.slice(0, f.limit).map((o) => ({
      id: o.id,
      title: o.title,
      model: o.model,
      channel: o.channel,
      status: o.status,
      customer: this.customerName(o.customerId),
      total: o.total,
      currency: o.currency,
      waitingOn: o.waitingOn,
      waitingAt: null,
      stoppedAt: null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));
    return {
      orders,
      count: matched.length,
      total: money(matched.reduce((s, o) => s + base(o), 0)),
    };
  }

  async startedWithKey(key: string) {
    const o = (this.f.orders ?? []).find((x) => x.idempotencyKey === key);
    return o ? { id: o.id, status: o.status } : undefined;
  }

  async unfinished(ended: readonly string[]) {
    return (this.f.orders ?? []).flatMap((o) => {
      if (ended.includes(o.status)) return [];
      const v = (this.f.flowVersions ?? []).find(
        (x) => x.flowId === o.flowId && x.version === o.flowVersion,
      );
      return v ? [{ id: o.id, flowId: v.flowId, version: v.version, flow: v.flow }] : [];
    });
  }

  async resolveId(ref: string) {
    const ids = (this.f.orders ?? []).map((o) => o.id);
    if (ids.includes(ref)) return ref;
    const tail = ids.filter((id) => id.toLowerCase().endsWith(ref.toLowerCase()));
    return tail.length === 1 ? tail[0]! : null;
  }
}
