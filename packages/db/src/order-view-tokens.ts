/**
 * The order-view credentials port (`OrderViewTokens`, @commerceworker/ports/commerce) on D1. A row is
 * a token's hash with its order and expiry; the token is never stored.
 */
import type { OrderViewTokens } from '@commerceworker/ports/commerce';
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { createDb } from './index';
import { orderViewTokens } from './schema';

/** Order ids per delete, under D1's 100 bound parameters. */
const CHUNK = 90;

export function d1OrderViewTokens(d1: D1Database): OrderViewTokens {
  const d = createDb(d1);
  return {
    async issue(orderId, tokenHash, now, expiresAt) {
      await d.batch([
        d.delete(orderViewTokens).where(lte(orderViewTokens.expiresAt, now)),
        d
          .insert(orderViewTokens)
          .values({ tokenHash, orderId, createdAt: now, expiresAt })
          .onConflictDoNothing(),
      ]);
    },

    async live(orderId, now) {
      const rows = await d
        .select({ hash: orderViewTokens.tokenHash })
        .from(orderViewTokens)
        .where(and(eq(orderViewTokens.orderId, orderId), gt(orderViewTokens.expiresAt, now)));
      return rows.map((r) => r.hash);
    },

    async revoke(orderIds) {
      let n = 0;
      for (let i = 0; i < orderIds.length; i += CHUNK)
        n += (
          await d
            .delete(orderViewTokens)
            .where(inArray(orderViewTokens.orderId, orderIds.slice(i, i + CHUNK)))
            .returning({ h: orderViewTokens.tokenHash })
        ).length;
      return n;
    },
  };
}
