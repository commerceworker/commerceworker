/**
 * The behaviour every `RetentionStore` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Times are small (the 1970s), so rows the D1 migrations seed with
 * today's times are never past these retentions; ids start `rc_`.
 */
import { RETENTION } from '@commerceworker/core';
import type { PruneCounts, RetentionStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { RetentionFixture } from './retention-store';

const DAY = 86_400_000;
export const RETENTION_NOW = 400 * DAY;
const now = RETENTION_NOW;
const old = 0;

const tables: (keyof PruneCounts)[] = [
  'sessions',
  'webhookDeliveries',
  'nodeRuns',
  'inboundEmails',
  'webhookReceipts',
  'paymentEvents',
  'ucpIdempotency',
  'abandonedCheckouts',
  'orderViewTokens',
];

export const RETENTION_FIXTURE: RetentionFixture = {
  rows: [
    // One past its retention and one inside it, per table.
    ...tables.flatMap((table) => [
      { table, id: `rc_${table}_old`, at: old },
      {
        table,
        id: `rc_${table}_new`,
        at: table === 'sessions' || table === 'orderViewTokens' ? now + DAY : now,
      },
    ]),
    // Kept: a delivery still being retried, and a checkout that placed an order.
    { table: 'webhookDeliveries', id: 'rc_pending', at: old, pending: true },
    { table: 'abandonedCheckouts', id: 'rc_placed', at: old, orderId: 'rc_order_placed' },
  ],
  carts: [
    { id: 'rc_cart_old', status: 'submitted', updatedAt: 1, pluginId: null, buyerId: null },
    { id: 'rc_cart_older', status: 'canceled', updatedAt: 0, pluginId: null, buyerId: null },
    { id: 'rc_cart_new', status: 'submitted', updatedAt: now, pluginId: null, buyerId: null },
    { id: 'rc_cart_open', status: 'open', updatedAt: 0, pluginId: null, buyerId: null },
    {
      id: 'rc_cart_purged',
      status: 'returned',
      updatedAt: 0,
      pluginId: null,
      buyerId: null,
      purgedAt: 5,
    },
    { id: 'rc_cart_ext', status: 'open', updatedAt: now, pluginId: 'shop', buyerId: null },
    { id: 'rc_cart_ext_known', status: 'open', updatedAt: now, pluginId: 'shop', buyerId: 'ada@x' },
  ],
  orders: [
    { id: 'rc_order_done', title: 'Done', status: 'completed', updatedAt: 0 },
    { id: 'rc_order_erased', title: 'Erased', status: 'completed', updatedAt: 0, erasedAt: 1 },
    { id: 'rc_order_running', title: 'Running', status: 'running', updatedAt: 0 },
    { id: 'rc_order_recent', title: 'Recent', status: 'completed', updatedAt: now },
  ],
  addresses: [
    { id: 'rc_addr_old', customerId: 'rc_cus', lastUsedAt: 0 },
    { id: 'rc_addr_new', customerId: 'rc_cus', lastUsedAt: now },
  ],
  members: [
    { id: 'rc_mem_old', name: 'Old', email: 'old@x.test', status: 'removed', updatedAt: 0 },
    { id: 'rc_mem_new', name: 'New', email: 'new@x.test', status: 'removed', updatedAt: now },
    { id: 'rc_mem_live', name: 'Live', email: 'live@x.test', status: 'active', updatedAt: 0 },
  ],
  audit: [
    { id: 'rc_u_b', at: 1, seq: null },
    { id: 'rc_u_a', at: 1, seq: null },
    { id: 'rc_u_c', at: 2, seq: null },
    { id: 'rc_u_new', at: now, seq: null },
    { id: 'rc_c_1', at: 0, seq: 900_001 },
    { id: 'rc_c_2', at: 1, seq: 900_002 },
    { id: 'rc_c_3', at: now, seq: 900_003 },
  ],
};

export function describeRetentionStoreContract(
  name: string,
  make: (fixture: RetentionFixture) => Promise<RetentionStore>,
) {
  describe(`${name}: the retention store contract`, () => {
    const fresh = () => make(RETENTION_FIXTURE);

    it('prunes one row past its retention from each table, keeping the pending and the placed', async () => {
      const s = await fresh();
      const counts = await s.prune(now, RETENTION);
      expect(counts).toEqual(Object.fromEntries(tables.map((t) => [t, 1])));
      expect(Object.values(await s.prune(now, RETENTION))).toEqual(tables.map(() => 0));
    });

    it('lists ended carts past their retention, oldest first, and external ones with no buyer', async () => {
      const s = await fresh();
      expect(await s.endedCarts(now - RETENTION.endedCartsMs, 10)).toEqual([
        'rc_cart_older',
        'rc_cart_old',
      ]);
      expect(await s.endedCarts(now - RETENTION.endedCartsMs, 1)).toEqual(['rc_cart_older']);
      expect((await s.cartsWithoutBuyer(10)).filter((id) => id.startsWith('rc_'))).toEqual([
        'rc_cart_ext',
      ]);
      expect(await s.cartBuyer('rc_cart_ext_known')).toBe('ada@x');
      await s.markBuyerless('rc_cart_ext');
      expect(await s.cartBuyer('rc_cart_ext')).toBe('');
      expect((await s.cartsWithoutBuyer(10)).filter((id) => id.startsWith('rc_'))).toEqual([]);
    });

    it('lists ended orders not yet erased, and expires old addresses', async () => {
      const s = await fresh();
      expect(await s.ordersEndedBefore(now - DAY, 10)).toEqual([
        { id: 'rc_order_done', title: 'Done' },
      ]);
      expect(await s.expireAddresses(now - DAY)).toBe(1);
      expect(await s.expireAddresses(now - DAY)).toBe(0);
    });

    it('blanks the members removed long ago, once, and nobody else', async () => {
      const s = await fresh();
      expect(await s.expireMembers(now - DAY)).toBe(1);
      expect(await s.expireMembers(now - DAY)).toBe(0);
      expect(await s.expireMembers(now + DAY)).toBe(1);
    });

    it('reads and deletes audit events before the chain by time, then the chain in order', async () => {
      const s = await fresh();
      const unchained = await s.unchainedAudit(now, 2);
      expect(unchained.map((r) => r.id)).toEqual(['rc_u_a', 'rc_u_b']);
      await s.deleteUnchainedThrough(unchained.at(-1)!);
      expect((await s.unchainedAudit(now, 10)).map((r) => r.id)).toEqual(['rc_u_c']);
      const chained = (await s.chainedAudit(10_000)).filter((r) => r.id.startsWith('rc_'));
      expect(chained.map((r) => r.seq)).toEqual([900_001, 900_002, 900_003]);
      await s.deleteChainedThrough(900_002);
      expect(
        (await s.chainedAudit(10_000)).filter((r) => r.id.startsWith('rc_')).map((r) => r.id),
      ).toEqual(['rc_c_3']);
    });
  });
}
