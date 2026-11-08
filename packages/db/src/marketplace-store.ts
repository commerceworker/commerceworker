/**
 * The marketplace port (`MarketplaceStore`, @commerceworker/ports/commerce) on D1. Moved here from
 * the engine's connectors. Parts are keyed by order and seller and payouts by order, step and
 * seller, each inserted only if absent; status changes are guarded by the status they leave. The
 * contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import type { MarketplaceStore } from '@commerceworker/ports/commerce';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb } from './index';
import { payouts, sellerOrders, sellers } from './schema';

/** D1 binds at most 100 parameters per statement. */
const IDS_PER_QUERY = 90;

export function d1MarketplaceStore(d1: D1Database, clock: Clock): MarketplaceStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();

  return {
    async sellers(ids) {
      const unique = [...new Set(ids)];
      const out = [];
      for (let i = 0; i < unique.length; i += IDS_PER_QUERY)
        out.push(
          ...(await d
            .select()
            .from(sellers)
            .where(inArray(sellers.id, unique.slice(i, i + IDS_PER_QUERY)))),
        );
      return out;
    },

    async openSellerOrders(orderId, drafts) {
      const at = now();
      const [first, ...rest] = drafts.map((p) =>
        d
          .insert(sellerOrders)
          .values({
            id: `so_${orderId}_${p.sellerId}`,
            orderId,
            sellerId: p.sellerId,
            status: p.status,
            lines: JSON.stringify(p.lines),
            subtotal: p.subtotal,
            createdAt: at,
            decidedAt: p.status === 'accepted' ? at : null,
          })
          .onConflictDoNothing(),
      );
      if (first) await d.batch([first, ...rest]);
    },

    async parts(orderId) {
      const rows = await d
        .select({
          sellerId: sellerOrders.sellerId,
          name: sellers.name,
          status: sellerOrders.status,
          subtotal: sellerOrders.subtotal,
          reason: sellerOrders.reason,
        })
        .from(sellerOrders)
        .leftJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
        .where(eq(sellerOrders.orderId, orderId))
        .orderBy(sellerOrders.sellerId);
      return rows.map((r) => ({ ...r, name: r.name ?? 'Marketplace' }));
    },

    async decide(orderId, sellerId, decision, reason) {
      await d
        .update(sellerOrders)
        .set({ status: decision, reason: reason ?? null, decidedAt: now() })
        .where(
          and(
            eq(sellerOrders.orderId, orderId),
            eq(sellerOrders.sellerId, sellerId),
            eq(sellerOrders.status, 'pending'),
          ),
        );
    },

    async expire(orderId, reason) {
      const res = await d
        .update(sellerOrders)
        .set({ status: 'rejected', reason, decidedAt: now() })
        .where(and(eq(sellerOrders.orderId, orderId), eq(sellerOrders.status, 'pending')))
        .returning({ id: sellerOrders.id });
      return res.length;
    },

    async cancel(orderId) {
      const res = await d
        .update(sellerOrders)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(sellerOrders.orderId, orderId),
            inArray(sellerOrders.status, ['pending', 'accepted']),
          ),
        )
        .returning({ id: sellerOrders.id });
      return res.length;
    },

    async contacts(orderId) {
      const rows = await d
        .select({ id: sellers.id, email: sellers.email, status: sellerOrders.status })
        .from(sellerOrders)
        .innerJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
        .where(eq(sellerOrders.orderId, orderId))
        .orderBy(sellers.id);
      const pending = rows.filter((r) => r.status === 'pending');
      return (pending.length ? pending : rows.filter((r) => r.status === 'accepted')).map(
        ({ id, email }) => ({ id, email }),
      );
    },

    async acceptedParts(orderId) {
      return d
        .select({
          sellerId: sellerOrders.sellerId,
          subtotal: sellerOrders.subtotal,
          commissionPct: sellers.commissionPct,
        })
        .from(sellerOrders)
        .innerJoin(sellers, eq(sellers.id, sellerOrders.sellerId))
        .where(and(eq(sellerOrders.orderId, orderId), eq(sellerOrders.status, 'accepted')))
        .orderBy(sellerOrders.sellerId);
    },

    async schedulePayouts(rows) {
      const at = now();
      const [first, ...rest] = rows.map((r) =>
        d
          .insert(payouts)
          .values({ ...r, createdAt: at })
          .onConflictDoNothing(),
      );
      if (first) await d.batch([first, ...rest]);
    },

    async reversePayouts(orderId) {
      const res = await d
        .update(payouts)
        .set({ status: 'reversed' })
        .where(and(eq(payouts.orderId, orderId), eq(payouts.status, 'scheduled')))
        .returning({ id: payouts.id });
      return res.length;
    },

    async payouts(orderId) {
      return d
        .select({
          id: payouts.id,
          orderId: payouts.orderId,
          sellerId: payouts.sellerId,
          gross: payouts.gross,
          commission: payouts.commission,
          refunded: payouts.refunded,
          net: payouts.net,
          status: payouts.status,
        })
        .from(payouts)
        .where(eq(payouts.orderId, orderId))
        .orderBy(payouts.id);
    },
  };
}
