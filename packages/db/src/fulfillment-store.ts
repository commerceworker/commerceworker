/**
 * The fulfillment port (`FulfillmentStore`, @commerceworker/ports/commerce) on D1. Moved here from
 * the engine's connectors; held to the same contract as the in-memory store.
 */
import { entitlementCode, pickupCode } from '@commerceworker/core';
import type { Clock } from '@commerceworker/ports';
import type { FulfillmentStore } from '@commerceworker/ports/commerce';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb } from './index';
import { entitlements, locations, shipments } from './schema';

/** Rows per multi-row insert: D1 binds at most 100 values per statement (6 per entitlement). */
const ENTITLEMENTS_PER_INSERT = 16;

const keyed = (s: string) => s.replace(/[^\w-]/g, '_');

export function d1FulfillmentStore(d1: D1Database, clock: Clock): FulfillmentStore {
  const d = createDb(d1);
  const now = () => clock.now().getTime();
  return {
    async locations() {
      return d.select().from(locations).orderBy(locations.id);
    },

    async stagePickup(orderId, stepKey) {
      const id = keyed(`pkp_${orderId}_${stepKey}`);
      const code = pickupCode(id);
      await d
        .insert(shipments)
        .values({
          id,
          orderId,
          carrier: 'pickup',
          tracking: code,
          status: 'ready_for_pickup',
          createdAt: now(),
        })
        .onConflictDoNothing();
      return { shipmentId: id, pickupCode: code };
    },

    async handOver(order, stepKey) {
      const staged = await d
        .select()
        .from(shipments)
        .where(and(eq(shipments.orderId, order.id), eq(shipments.status, 'ready_for_pickup')));
      if (staged.length) {
        await d
          .update(shipments)
          .set({ status: 'collected' })
          .where(
            inArray(
              shipments.id,
              staged.map((s) => s.id),
            ),
          );
        return { collected: 'pickup' };
      }
      // A retried hand-over finds the pickup it already collected.
      const collected = await d
        .select({ carrier: shipments.carrier })
        .from(shipments)
        .where(and(eq(shipments.orderId, order.id), eq(shipments.status, 'collected')));
      if (collected.some((s) => s.carrier === 'pickup')) return { collected: 'pickup' };
      await d
        .insert(shipments)
        .values({
          id: keyed(`hnd_${order.id}_${stepKey}`),
          orderId: order.id,
          carrier: 'carry_out',
          tracking: order.fulfillment?.locationId ?? 'store',
          status: 'collected',
          createdAt: now(),
        })
        .onConflictDoNothing();
      return { collected: 'carry_out' };
    },

    async takeBack(orderId) {
      const res = await d
        .update(shipments)
        .set({ status: 'returned' })
        .where(and(eq(shipments.orderId, orderId), eq(shipments.status, 'collected')))
        .returning({ id: shipments.id });
      return res.length;
    },

    async issueEntitlements(orderId, stepKey, lines) {
      const at = now();
      const rows = lines.flatMap((l) =>
        Array.from({ length: l.qty }, (_, n) => {
          const id = keyed(`ent_${orderId}_${stepKey}_${l.index}_${n}`);
          return {
            id,
            orderId,
            sku: l.sku,
            code: entitlementCode(l.sku, id),
            status: 'issued',
            createdAt: at,
          };
        }),
      );
      const inserts = [];
      for (let i = 0; i < rows.length; i += ENTITLEMENTS_PER_INSERT)
        inserts.push(
          d
            .insert(entitlements)
            .values(rows.slice(i, i + ENTITLEMENTS_PER_INSERT))
            .onConflictDoNothing(),
        );
      if (inserts.length) await d.batch([inserts[0]!, ...inserts.slice(1)]);
      return rows.map((r) => ({ sku: r.sku, code: r.code }));
    },

    async revokeEntitlements(orderId) {
      const res = await d
        .update(entitlements)
        .set({ status: 'revoked' })
        .where(and(eq(entitlements.orderId, orderId), eq(entitlements.status, 'issued')))
        .returning();
      return res.length;
    },

    async shipments(orderId) {
      return d.select().from(shipments).where(eq(shipments.orderId, orderId)).orderBy(shipments.id);
    },

    async entitlements(orderId) {
      return d
        .select()
        .from(entitlements)
        .where(eq(entitlements.orderId, orderId))
        .orderBy(entitlements.id);
    },
  };
}
