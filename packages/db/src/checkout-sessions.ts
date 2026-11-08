/**
 * The checkout sessions port (`CheckoutSessionStore`, @commerceworker/ports/commerce) on D1: the
 * `checkout_sessions` table, the session kept whole as JSON with the columns lists and sweeps read.
 * Moved here from the engine's UCP checkout. A write applies only over the version it read. The
 * contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import type { CheckoutSession } from '@commerceworker/core';
import type { CheckoutSessionStore } from '@commerceworker/ports/commerce';
import { and, eq } from 'drizzle-orm';
import { createDb } from './index';
import { checkoutSessions } from './schema';

export function d1CheckoutSessions(d1: D1Database): CheckoutSessionStore {
  const d = createDb(d1);
  return {
    async create(s) {
      await d.insert(checkoutSessions).values({
        id: s.id,
        ownerId: s.ownerId,
        status: s.status,
        data: JSON.stringify(s),
        orderId: s.orderId ?? null,
        version: s.version,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        expiresAt: s.expiresAt,
      });
    },

    async load(ownerId, id) {
      const row = await d
        .select({ data: checkoutSessions.data, ownerId: checkoutSessions.ownerId })
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, id))
        .get();
      return row && row.ownerId === ownerId ? (JSON.parse(row.data) as CheckoutSession) : null;
    },

    async save(next, readVersion) {
      const res = await d
        .update(checkoutSessions)
        .set({
          status: next.status,
          data: JSON.stringify(next),
          orderId: next.orderId,
          version: next.version,
          updatedAt: next.updatedAt,
          expiresAt: next.expiresAt,
        })
        .where(and(eq(checkoutSessions.id, next.id), eq(checkoutSessions.version, readVersion)))
        .returning({ id: checkoutSessions.id });
      return res.length > 0;
    },

    async forOrder(orderId) {
      const row = await d
        .select({ data: checkoutSessions.data })
        .from(checkoutSessions)
        .where(eq(checkoutSessions.orderId, orderId))
        .get();
      return row ? (JSON.parse(row.data) as CheckoutSession) : null;
    },
  };
}
