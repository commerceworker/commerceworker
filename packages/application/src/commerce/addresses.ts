/**
 * The places a customer's orders ship to: an order's ship-to is kept when it starts, and the daily
 * sweep adds those of orders started before addresses were kept. Free text and unusable addresses
 * aren't kept (`rememberedAddress` in core).
 */
import { erasedCustomerEmail, type OrderState, rememberedAddress } from '@commerceworker/core';
import type { AddressBook, PricingStore } from '@commerceworker/ports/commerce';

const DAY = 86_400_000;
/** Marked orders one sweep reads; the rest wait for the next day's. */
export const ADDRESS_BACKFILL_MAX = 200;

/** Records the order's ship-to against its customer, when it has one and it is a real place. */
export async function rememberAddress(
  ports: { readonly addresses: AddressBook },
  order: { id: string; customerId?: string | null; shipTo: unknown; at: number },
) {
  if (!order.customerId) return;
  const remembered = rememberedAddress(order.shipTo);
  if (!remembered) return;
  await ports.addresses.remember({
    customerId: order.customerId,
    orderId: order.id,
    key: remembered.key,
    address: remembered.address,
    at: order.at,
  });
}

/**
 * Adds the ship-to of orders started before addresses were kept, read from each order's state
 * (`snapshot`), dated when the order started, then clears the mark. An erased order or customer
 * adds nothing, nor does an order older than the personal data retention (`retentionDays`), whose
 * address that sweep would delete again. One order that can't answer waits for the next sweep.
 * Returns how many orders it cleared.
 */
export async function backfillAddresses(
  ports: { readonly addresses: AddressBook; readonly pricing: Pick<PricingStore, 'customers'> },
  snapshot: (orderId: string) => Promise<OrderState>,
  now: number,
  retentionDays: number | null,
) {
  const due = await ports.addresses.pendingBackfill(ADDRESS_BACKFILL_MAX);
  if (!due.length) return 0;
  const ids = [...new Set(due.flatMap((o) => (o.customerId ? [o.customerId] : [])))];
  const live = new Set(
    (await ports.pricing.customers(ids))
      .filter((c) => c.email !== erasedCustomerEmail(c.id))
      .map((c) => c.id),
  );
  const cutoff = retentionDays === null ? -Infinity : now - retentionDays * DAY;
  let cleared = 0;
  for (const o of due) {
    try {
      if (o.customerId && live.has(o.customerId) && !o.erasedAt && o.createdAt >= cutoff) {
        const state = await snapshot(o.id);
        await rememberAddress(ports, {
          id: o.id,
          customerId: o.customerId,
          shipTo: state.order?.meta?.shipTo,
          at: o.createdAt,
        });
      }
      await ports.addresses.clearPending(o.id);
      cleared++;
    } catch (e) {
      console.error(
        JSON.stringify({ type: 'address_backfill_failed', id: o.id, error: String(e) }),
      );
    }
  }
  return cleared;
}
