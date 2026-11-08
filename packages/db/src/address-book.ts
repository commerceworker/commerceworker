/**
 * The address book port (`AddressBook`, @commerceworker/ports/commerce) on D1: the
 * `customer_addresses` table and orders' `address_pending` mark. Moved here from the engine. The
 * contract in @commerceworker/test-kit/commerce holds this and the in-memory store to the same
 * behaviour.
 */
import { newId } from '@commerceworker/core';
import type { AddressBook } from '@commerceworker/ports/commerce';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { createDb } from './index';
import { customerAddresses, orders } from './schema';

export function d1AddressBook(d1: D1Database): AddressBook {
  const d = createDb(d1);
  return {
    async remember({ customerId, orderId, key, address: a, at }) {
      await d
        .insert(customerAddresses)
        .values({
          id: newId('adr'),
          customerId,
          key,
          name: a.name ?? null,
          line1: a.line1,
          line2: a.line2 ?? null,
          city: a.city,
          region: a.region ?? null,
          postalCode: a.postalCode,
          country: a.country,
          firstUsedAt: at,
          lastUsedAt: at,
          lastOrderId: orderId,
        })
        .onConflictDoUpdate({
          target: [customerAddresses.customerId, customerAddresses.key],
          // By date, not by write: the backfill counts orders older than those already counted.
          set: {
            name: sql`CASE WHEN excluded.last_used_at >= ${customerAddresses.lastUsedAt} THEN excluded.name ELSE ${customerAddresses.name} END`,
            orders: sql`${customerAddresses.orders} + 1`,
            firstUsedAt: sql`min(${customerAddresses.firstUsedAt}, excluded.first_used_at)`,
            lastUsedAt: sql`max(${customerAddresses.lastUsedAt}, excluded.last_used_at)`,
            lastOrderId: sql`CASE WHEN excluded.last_used_at >= ${customerAddresses.lastUsedAt} THEN excluded.last_order_id ELSE ${customerAddresses.lastOrderId} END`,
          },
        });
    },

    addresses: (customerId, limit = -1) =>
      d
        .select({
          id: customerAddresses.id,
          key: customerAddresses.key,
          name: customerAddresses.name,
          line1: customerAddresses.line1,
          line2: customerAddresses.line2,
          region: customerAddresses.region,
          city: customerAddresses.city,
          postalCode: customerAddresses.postalCode,
          country: customerAddresses.country,
          orders: customerAddresses.orders,
          firstUsedAt: customerAddresses.firstUsedAt,
          lastUsedAt: customerAddresses.lastUsedAt,
          lastOrderId: customerAddresses.lastOrderId,
        })
        .from(customerAddresses)
        .where(eq(customerAddresses.customerId, customerId))
        .orderBy(desc(customerAddresses.lastUsedAt))
        .limit(limit),

    pendingBackfill: (limit) =>
      d
        .select({
          id: orders.id,
          customerId: orders.customerId,
          createdAt: orders.createdAt,
          erasedAt: orders.erasedAt,
        })
        .from(orders)
        .where(isNotNull(orders.addressPending))
        .limit(limit),

    async clearPending(orderId) {
      await d.update(orders).set({ addressPending: null }).where(eq(orders.id, orderId));
    },
  };
}
