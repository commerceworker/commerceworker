/**
 * The retention port in memory, seeded with the rows each table holds, reduced to what retention
 * reads (when, and whether a delivery is pending or a checkout placed an order). The contract in
 * ./retention-store-contract.ts holds it to the same behaviour as the D1 store.
 */
import {
  ERASED,
  FINAL_CART_STATUSES,
  type RetentionPolicy,
  TERMINAL_ORDER_STATUSES,
} from '@commerceworker/core';
import type { AuditRow, PruneCounts, RetentionStore } from '@commerceworker/ports/commerce';

export interface RetentionFixture {
  /**
   * Prunable rows. `at` is what each table's retention reads: a session's or order-view token's expiry, a delivery's
   * creation, a run's end, a receipt's arrival, a checkout's expiry.
   */
  rows?: {
    table: keyof PruneCounts;
    id: string;
    at: number;
    pending?: boolean;
    orderId?: string | null;
  }[];
  carts?: {
    id: string;
    status: string;
    updatedAt: number;
    pluginId: string | null;
    buyerId: string | null;
    purgedAt?: number | null;
  }[];
  orders?: {
    id: string;
    title: string;
    status: string;
    updatedAt: number;
    erasedAt?: number | null;
  }[];
  addresses?: { id: string; customerId: string; lastUsedAt: number }[];
  members?: { id: string; name: string; email: string; status: string; updatedAt: number }[];
  audit?: { id: string; at: number; seq: number | null }[];
}

type Fixture = Required<RetentionFixture>;

export class InMemoryRetentionStore implements RetentionStore {
  private readonly f: Fixture;

  constructor(fixture: RetentionFixture = {}) {
    this.f = structuredClone({
      rows: fixture.rows ?? [],
      carts: fixture.carts ?? [],
      orders: fixture.orders ?? [],
      addresses: fixture.addresses ?? [],
      members: fixture.members ?? [],
      audit: fixture.audit ?? [],
    });
  }

  async prune(now: number, policy: RetentionPolicy): Promise<PruneCounts> {
    const due = (r: Fixture['rows'][number]) => {
      switch (r.table) {
        case 'sessions':
        case 'orderViewTokens':
          return r.at < now;
        case 'webhookDeliveries':
          return r.at < now - policy.webhookDeliveriesMs && !r.pending;
        case 'nodeRuns':
          return r.at < now - policy.nodeRunsMs;
        case 'inboundEmails':
          return r.at < now - policy.inboundEmailsMs;
        case 'webhookReceipts':
          return r.at < now - policy.webhookReceiptsMs;
        case 'paymentEvents':
          return r.at < now - policy.paymentEventsMs;
        case 'ucpIdempotency':
          return r.at < now - policy.ucpIdempotencyMs;
        case 'abandonedCheckouts':
          return !r.orderId && r.at < now - policy.abandonedCheckoutsMs;
      }
    };
    const counts: Record<keyof PruneCounts, number> = {
      sessions: 0,
      webhookDeliveries: 0,
      nodeRuns: 0,
      inboundEmails: 0,
      webhookReceipts: 0,
      paymentEvents: 0,
      ucpIdempotency: 0,
      abandonedCheckouts: 0,
      orderViewTokens: 0,
    };
    this.f.rows = this.f.rows.filter((r) => {
      if (!due(r)) return true;
      counts[r.table]++;
      return false;
    });
    return counts;
  }

  async endedCarts(before: number, limit: number) {
    return this.f.carts
      .filter(
        (c) =>
          !c.purgedAt &&
          (FINAL_CART_STATUSES as readonly string[]).includes(c.status) &&
          c.updatedAt < before,
      )
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit)
      .map((c) => c.id);
  }

  async cartsWithoutBuyer(limit: number) {
    return this.f.carts
      .filter((c) => c.pluginId && c.buyerId === null)
      .slice(0, limit)
      .map((c) => c.id);
  }

  async cartBuyer(id: string) {
    return this.f.carts.find((c) => c.id === id)?.buyerId ?? null;
  }

  async markBuyerless(id: string) {
    const c = this.f.carts.find((x) => x.id === id);
    if (c && c.buyerId === null) c.buyerId = '';
  }

  async ordersEndedBefore(before: number, limit: number) {
    return this.f.orders
      .filter(
        (o) =>
          !o.erasedAt &&
          (TERMINAL_ORDER_STATUSES as readonly string[]).includes(o.status) &&
          o.updatedAt < before,
      )
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit)
      .map(({ id, title }) => ({ id, title }));
  }

  async expireAddresses(before: number) {
    const n = this.f.addresses.length;
    this.f.addresses = this.f.addresses.filter((a) => a.lastUsedAt >= before);
    return n - this.f.addresses.length;
  }

  async expireMembers(before: number) {
    const due = this.f.members.filter(
      (m) => m.status === 'removed' && m.updatedAt < before && m.name !== ERASED,
    );
    for (const m of due) Object.assign(m, { name: ERASED, email: ERASED });
    return due.length;
  }

  async unchainedAudit(before: number, limit: number): Promise<AuditRow[]> {
    return this.f.audit
      .filter((a) => a.seq === null && a.at < before)
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  async deleteUnchainedThrough(last: { at: number; id: string }) {
    this.f.audit = this.f.audit.filter(
      (a) => a.seq !== null || a.at > last.at || (a.at === last.at && a.id > last.id),
    );
  }

  async chainedAudit(limit: number): Promise<AuditRow[]> {
    return this.f.audit
      .filter((a) => a.seq !== null)
      .sort((a, b) => a.seq! - b.seq!)
      .slice(0, limit);
  }

  async deleteChainedThrough(seq: number) {
    this.f.audit = this.f.audit.filter((a) => a.seq === null || a.seq > seq);
  }
}
