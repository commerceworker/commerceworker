/**
 * The cart records port (`CartRecords`, @commerceworker/ports/commerce) on D1: the `carts` table.
 * Moved here from the CartAgent and the carts module. A cart's row is an upsert keyed by its id;
 * `(plugin_id, session_ref)` is unique, so two opens of one plugin session make one cart. The
 * contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import type { CartRecords } from '@commerceworker/ports/commerce';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { createDb } from './index';
import { carts, customers } from './schema';

const record = {
  id: carts.id,
  status: carts.status,
  pluginId: carts.pluginId,
  expiresAt: carts.expiresAt,
  purgedAt: carts.purgedAt,
};

export function d1CartRecords(d1: D1Database, clock: Clock): CartRecords {
  const d = createDb(d1);
  return {
    async index(row) {
      const set = {
        title: row.title,
        status: row.status,
        customerId: row.customerId,
        orderId: row.orderId,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
        buyerId: row.buyerId,
      };
      await d.insert(carts).values(row).onConflictDoUpdate({ target: carts.id, set });
    },

    async extendExpiry(id, until) {
      await d
        .update(carts)
        .set({ expiresAt: until })
        .where(and(eq(carts.id, id), inArray(carts.status, ['open', 'locked'])));
    },

    async markPurged(id) {
      await d.update(carts).set({ purgedAt: clock.now().getTime() }).where(eq(carts.id, id));
    },

    find: (id) => d.select(record).from(carts).where(eq(carts.id, id)).get(),

    async list(f) {
      const rows = await d
        .select()
        .from(carts)
        .where(
          and(
            f.status ? eq(carts.status, f.status) : undefined,
            f.external ? undefined : isNull(carts.pluginId),
          ),
        )
        .orderBy(desc(carts.updatedAt))
        .limit(f.limit);
      return rows.map(({ purgedAt: _p, ...r }) => r);
    },

    staffCarts: (f) =>
      d
        .select({
          id: carts.id,
          title: carts.title,
          status: carts.status,
          customerId: carts.customerId,
          customer: customers.name,
          flowId: carts.flowId,
          orderId: carts.orderId,
          updatedAt: carts.updatedAt,
        })
        .from(carts)
        .leftJoin(customers, eq(customers.id, carts.customerId))
        .where(and(isNull(carts.pluginId), f.status ? eq(carts.status, f.status) : undefined))
        .orderBy(desc(carts.updatedAt))
        .limit(f.limit),

    forSession: (pluginId, sessionRef) =>
      d
        .select(record)
        .from(carts)
        .where(and(eq(carts.pluginId, pluginId), eq(carts.sessionRef, sessionRef)))
        .get(),
  };
}
