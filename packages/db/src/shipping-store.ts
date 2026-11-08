/**
 * The shipping port (`ShippingStore`, @commerceworker/ports/commerce) on D1. Moved here from the
 * engine's connectors. A booking inserts only if absent, so a retried step books nothing more; a
 * label's outcome is an upsert of its status. The contract in @commerceworker/test-kit/commerce
 * holds this and the in-memory store to the same behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import { OPEN_SHIPMENT, type ShippingStore } from '@commerceworker/ports/commerce';
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { createDb } from './index';
import { shipments } from './schema';

/** D1 binds at most 100 parameters per statement. */
const IDS_PER_QUERY = 90;

const columns = {
  id: shipments.id,
  orderId: shipments.orderId,
  carrier: shipments.carrier,
  tracking: shipments.tracking,
  status: shipments.status,
  provider: shipments.provider,
  externalId: shipments.externalId,
};

export function d1ShippingStore(d1: D1Database, clock: Clock): ShippingStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();
  const labelled = and(isNotNull(shipments.provider), isNotNull(shipments.externalId));

  return {
    async book(rows) {
      const at = now();
      const [first, ...rest] = rows.map((r) =>
        d
          .insert(shipments)
          .values({ ...r, createdAt: at })
          .onConflictDoNothing(),
      );
      if (first) await d.batch([first, ...rest]);
    },

    async settleLabels(rows, status) {
      const at = now();
      const [first, ...rest] = rows.map((r) =>
        d
          .insert(shipments)
          .values({ ...r, status, createdAt: at })
          .onConflictDoUpdate({ target: shipments.id, set: { status } }),
      );
      if (first) await d.batch([first, ...rest]);
    },

    async labelled(where) {
      if ('ids' in where) {
        const ids = [...new Set(where.ids)];
        const out = [];
        for (let i = 0; i < ids.length; i += IDS_PER_QUERY)
          out.push(
            ...(await d
              .select(columns)
              .from(shipments)
              .where(
                and(
                  inArray(shipments.id, ids.slice(i, i + IDS_PER_QUERY)),
                  labelled,
                  ne(shipments.status, 'cancelled'),
                ),
              )
              .orderBy(asc(shipments.id))),
          );
        return out;
      }
      return d
        .select(columns)
        .from(shipments)
        .where(
          and(
            eq(shipments.orderId, where.orderId),
            inArray(shipments.status, [...where.statuses]),
            labelled,
            ne(shipments.status, 'cancelled'),
          ),
        )
        .orderBy(asc(shipments.id));
    },

    async voidFailed(limit, provider) {
      return d
        .select(columns)
        .from(shipments)
        .where(
          and(
            eq(shipments.status, 'void_failed'),
            provider ? eq(shipments.provider, provider) : undefined,
          ),
        )
        .orderBy(asc(shipments.createdAt), asc(shipments.id))
        .limit(limit);
    },

    async cancel(shipmentId) {
      await d.update(shipments).set({ status: 'cancelled' }).where(eq(shipments.id, shipmentId));
    },

    async cancelOpen(orderId) {
      const res = await d
        .update(shipments)
        .set({ status: 'cancelled' })
        .where(and(eq(shipments.orderId, orderId), inArray(shipments.status, [...OPEN_SHIPMENT])))
        .returning({ id: shipments.id });
      return res.length;
    },

    async booked(orderId) {
      return d
        .select({ ...columns, createdAt: shipments.createdAt })
        .from(shipments)
        .where(eq(shipments.orderId, orderId))
        .orderBy(asc(shipments.id));
    },
  };
}
