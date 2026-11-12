/**
 * The behaviour every `OrderQueries` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Ids start `oq_`; times are around `ORDER_QUERIES_NOW`.
 */
import type { OrderQueries } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { OrderQueriesFixture } from './order-queries';

const DAY = 86_400_000;
export const ORDER_QUERIES_NOW = Date.UTC(2026, 10, 8);
const now = ORDER_QUERIES_NOW;

const order = (
  id: string,
  over: Partial<NonNullable<OrderQueriesFixture['orders']>[number]> = {},
) => ({
  id,
  title: id,
  status: 'completed',
  model: 'b2b',
  channel: 'api',
  customerId: null,
  total: 100,
  currency: 'USD',
  fxRate: 1,
  waitingOn: null,
  createdAt: now - DAY,
  updatedAt: now - DAY,
  ...over,
});

export const ORDER_QUERIES_FIXTURE: OrderQueriesFixture = {
  customers: [{ id: 'oq_cus', name: 'Northwind Traders' }],
  orders: [
    order('oq_failed', { status: 'failed', updatedAt: now - DAY }),
    order('oq_old_fail', { status: 'rolled_back', updatedAt: now - 5 * DAY }),
    order('oq_stalled', { status: 'waiting', waitingOn: 'Payment', updatedAt: now - 2 * DAY }),
    order('oq_waiting_new', { status: 'waiting', waitingOn: 'Payment', updatedAt: now }),
    order('oq_eur_big', {
      customerId: 'oq_cus',
      total: 920,
      currency: 'EUR',
      fxRate: 0.92,
      createdAt: now - 10 * DAY,
    }),
    order('oq_tail_abc123', {
      status: 'running',
      idempotencyKey: 'plugin:shop:k1',
      flowId: 'oq_flow',
      flowVersion: 2,
    }),
  ],
  flowVersions: [{ flowId: 'oq_flow', version: 2, flow: { id: 'oq_flow', nodes: [] } }],
  approvals: [
    {
      id: 'oq_apr_2',
      orderId: 'oq_stalled',
      nodeId: 'approve',
      title: 'Second',
      amount: 5,
      status: 'pending',
      requestedAt: 2,
    },
    {
      id: 'oq_apr_1',
      orderId: 'oq_failed',
      nodeId: 'approve',
      title: 'First',
      amount: null,
      status: 'pending',
      requestedAt: 1,
    },
    {
      id: 'oq_apr_done',
      orderId: 'oq_failed',
      nodeId: 'approve',
      title: 'Done',
      amount: null,
      status: 'approved',
      requestedAt: 0,
    },
  ],
};

/** Waits measured from when they opened (`waitingSince`), against the order's last change. */
const WAITS_FIXTURE: OrderQueriesFixture = {
  orders: [
    // Indexed before `waiting_since` was recorded: measured from its last change.
    order('oq_wait_legacy', { status: 'waiting', waitingOn: 'Payment', updatedAt: now - 2 * DAY }),
    // Touched an hour ago (an indexed field changed) but waiting on the same event for three days.
    order('oq_wait_long', {
      status: 'waiting',
      waitingOn: 'Goods received',
      waitingSince: now - 3 * DAY,
      updatedAt: now - 3_600_000,
    }),
    // Untouched for a week, but its current wait opened an hour ago.
    order('oq_wait_reopened', {
      status: 'waiting',
      waitingOn: 'Supplier ack',
      waitingSince: now - 3_600_000,
      updatedAt: now - 7 * DAY,
    }),
  ],
};

/** Orders placed under two addresses, one with its case changed and one erased. */
const CONTACT_FIXTURE: OrderQueriesFixture = {
  orders: [
    order('oq_c_old', { contactEmail: 'Shopper@Example.com', createdAt: now - 3 * DAY, total: 10 }),
    order('oq_c_b', { contactEmail: 'shopper@example.com', createdAt: now - 2 * DAY, total: 20 }),
    // The same moment as the one above: the id breaks the tie.
    order('oq_c_a', { contactEmail: 'shopper@example.com', createdAt: now - 2 * DAY, total: 30 }),
    order('oq_c_new', {
      contactEmail: 'shopper@example.com',
      createdAt: now - DAY,
      status: 'running',
      currency: 'EUR',
      total: 40,
    }),
    order('oq_c_erased', {
      contactEmail: 'shopper@example.com',
      createdAt: now,
      erasedAt: now,
    }),
    order('oq_c_other', { contactEmail: 'someone@example.com', createdAt: now - DAY }),
    order('oq_c_none', { createdAt: now - DAY }),
  ],
};

export function describeOrderQueriesContract(
  name: string,
  make: (fixture: OrderQueriesFixture) => Promise<OrderQueries>,
) {
  describe(`${name}: the order queries contract`, () => {
    const fresh = () => make(ORDER_QUERIES_FIXTURE);

    it('lists pending approvals, recent failures and long waits, capped, with full counts', async () => {
      const q = await fresh();
      const a = await q.attention(now, 1);
      expect(a.approvals.map((x) => x.id)).toEqual(['oq_apr_1']);
      expect(a.failed.map((x) => x.id)).toEqual(['oq_failed']);
      expect(a.stalled.map((x) => x.id)).toEqual(['oq_stalled']);
      expect(a.counts).toEqual({ approvals: 2, failed: 1, stalled: 1 });
    });

    it('counts a wait as stalled from when it opened, not from the order last changing', async () => {
      const q = await make(WAITS_FIXTURE);
      const a = await q.attention(now, 10);
      expect(a.stalled.map((x) => [x.id, x.waitingSince])).toEqual([
        ['oq_wait_long', now - 3 * DAY],
        ['oq_wait_legacy', null],
      ]);
      expect(a.counts.stalled).toBe(2);
    });

    it('finds orders by filter, with the count and the base-currency total', async () => {
      const q = await fresh();
      const all = await q.find({ limit: 50 }, now);
      expect(all.count).toBe(6);
      const big = await q.find({ minTotal: 500, limit: 50 }, now);
      expect(big.orders.map((o) => [o.id, o.customer])).toEqual([
        ['oq_eur_big', 'Northwind Traders'],
      ]);
      expect(big.total).toBe(1000);
      expect((await q.find({ customer: 'northwind', limit: 50 }, now)).count).toBe(1);
      expect((await q.find({ q: 'stalled', limit: 50 }, now)).orders.map((o) => o.id)).toEqual([
        'oq_stalled',
      ]);
      expect((await q.find({ sinceDays: 3, limit: 50 }, now)).count).toBe(5);
      expect((await q.find({ sort: 'largest', limit: 1 }, now)).orders[0]?.id).toBe('oq_eur_big');
      expect(await q.find({ status: 'waiting', limit: 1 }, now)).toMatchObject({ count: 2 });
    });

    it('finds the order started under a key, and unfinished orders with their flow', async () => {
      const q = await fresh();
      expect(await q.startedWithKey('plugin:shop:k1')).toEqual({
        id: 'oq_tail_abc123',
        status: 'running',
      });
      expect(await q.startedWithKey('plugin:shop:none')).toBeUndefined();
      const live = (
        await q.unfinished(['completed', 'cancelled', 'failed', 'rolled_back', 'declined'])
      ).filter((o) => o.id.startsWith('oq_'));
      expect(live).toEqual([
        { id: 'oq_tail_abc123', flowId: 'oq_flow', version: 2, flow: { id: 'oq_flow', nodes: [] } },
      ]);
    });

    it('resolves an order from its id or a unique ending', async () => {
      const q = await fresh();
      expect(await q.resolveId('oq_failed')).toBe('oq_failed');
      expect(await q.resolveId('abc123')).toBe('oq_tail_abc123');
      expect(await q.resolveId('led')).toBeNull();
      expect(await q.resolveId('zzz')).toBeNull();
    });

    it('lists the orders placed under an address, newest first, in pages by keyset', async () => {
      const q = await make(CONTACT_FIXTURE);
      const first = await q.forContact('Shopper@example.com', { limit: 2 });
      expect(first.map((o) => o.id)).toEqual(['oq_c_new', 'oq_c_b']);
      expect(first[0]).toEqual({
        id: 'oq_c_new',
        status: 'running',
        currency: 'EUR',
        total: 40,
        createdAt: now - DAY,
      });
      const last = first[1]!;
      const second = await q.forContact('shopper@example.com', {
        before: { createdAt: last.createdAt, id: last.id },
        limit: 2,
      });
      expect(second.map((o) => o.id)).toEqual(['oq_c_a', 'oq_c_old']);
      const end = second[1]!;
      expect(
        await q.forContact('shopper@example.com', {
          before: { createdAt: end.createdAt, id: end.id },
          limit: 2,
        }),
      ).toEqual([]);
    });

    it('lists nothing for an address no order was placed under, nor an erased order', async () => {
      const q = await make(CONTACT_FIXTURE);
      expect(await q.forContact('nobody@example.com', { limit: 10 })).toEqual([]);
      const all = await q.forContact('shopper@example.com', { limit: 50 });
      expect(all.map((o) => o.id)).not.toContain('oq_c_erased');
      expect(all).toHaveLength(4);
    });

    it('says whether an order was placed under an address, never for an erased one', async () => {
      const q = await make(CONTACT_FIXTURE);
      expect(await q.placedUnder('SHOPPER@example.com', 'oq_c_a')).toBe(true);
      expect(await q.placedUnder('shopper@example.com', 'oq_c_other')).toBe(false);
      expect(await q.placedUnder('someone@example.com', 'oq_c_a')).toBe(false);
      expect(await q.placedUnder('shopper@example.com', 'oq_c_erased')).toBe(false);
      expect(await q.placedUnder('shopper@example.com', 'oq_c_none')).toBe(false);
      expect(await q.placedUnder('shopper@example.com', 'oq_nothing')).toBe(false);
    });
  });
}
