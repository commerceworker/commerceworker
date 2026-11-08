/**
 * Mock commerce connectors over the D1 back office and R2. Each is the seam where a real adapter
 * (a WMS, a carrier API, NetSuite) plugs in later; payments already have one (./payments, with
 * Stripe). Every write is keyed by the step that made it, so a retried step never double-books, and
 * every compensation is idempotent.
 *
 * Failure simulation for demos and tests: set `order.meta.simulate` to one of
 * "payment_decline", "charge_fail", "out_of_stock", "three_way_mismatch".
 */

import { voidOpenLabels } from '@commerceworker/application/commerce';
import { newId, type Order } from '@commerceworker/core';
import { voidInvoices } from './billing';
import { voidAuthorizations } from './payments';
import {
  balanceStore,
  commercePorts,
  fulfillmentStore,
  inventoryStore,
  marketplaceStore,
  shippingStore,
} from './wire';

export const simulate = (order: Order) => String(order.meta?.simulate ?? '');

// Customers, products, promotions, exchange rates and the price chain are read through the pricing
// port (@commerceworker/ports/commerce), bound in ./wire.ts: `pricingStore(env)`.

// ── Inventory ──────────────────────────────────────────────────────────────
// Holds, settlements and restocks go through the inventory port (@commerceworker/ports/commerce),
// bound in ./wire.ts: `inventoryStore(env)`.

// ── Fulfillment ────────────────────────────────────────────────────────────
// Routing is a use-case (`routeFulfillment`, @commerceworker/application/commerce); stores, pickups,
// hand-overs and digital codes go through the fulfillment port, bound in ./wire.ts.

// ── Addresses ──────────────────────────────────────────────────────────────
// `commerce.validate_address` checks a ship-to with core's `checkAddress`, or with the address
// provider plugin the node names (manifest `provides: ['address']`).

// ── Payments ───────────────────────────────────────────────────────────────

// The gateway (mock or Stripe) lives in ./payments; re-exported for existing callers.
export {
  authorizePayment,
  capturePayment,
  charge,
  paidAmount,
  paySupplier,
  refund,
  voidAuthorizations,
} from './payments';

// ── Shipping ───────────────────────────────────────────────────────────────
// Rates are quoted in ./shipping-rates.ts. Shipments and labels are booked, voided and cancelled by
// the shipping use-cases (@commerceworker/application/commerce) through the shipping port and the
// label service, bound in ./wire.ts.

// ── Documents (R2) and outbox ────────────────────────────────────────────────
// Documents are rendered by core (`renderDocument`) and filed through the documents port; messages
// go through the message port. Both are bound in ./wire.ts: `documentStore(env)`, `messageStore(env)`.

/** Undo everything compensable for an order (cancel path; Workflow rollback covers failures). */
export async function compensateOrder(env: Env, orderId: string) {
  // First, so a label a provider made is voided there before its shipment reads as cancelled.
  const labels = await voidOpenLabels(commercePorts(env), orderId);
  const [released, voided, cancelled, sellerOrdersCancelled, payoutsReversed, revoked, invoices] =
    await Promise.all([
      inventoryStore(env).release(orderId),
      voidAuthorizations(env, orderId),
      shippingStore(env).cancelOpen(orderId),
      marketplaceStore(env).cancel(orderId),
      marketplaceStore(env).reversePayouts(orderId),
      fulfillmentStore(env).revokeEntitlements(orderId),
      voidInvoices(env, orderId),
    ]);
  // After the void, so an invoice found paid in Stripe keeps its (settled) account charge.
  const unbilled = await balanceStore(env).reverse(orderId);
  // After the cancel above, so a shipment it cancelled no longer holds the stock.
  const restored = await inventoryStore(env).restoreShipped(orderId);
  return {
    released,
    voided,
    // Shipments voided at their provider were cancelled with the void.
    cancelled: cancelled + labels.voided,
    restored,
    sellerOrdersCancelled,
    payoutsReversed,
    revoked,
    unbilled,
    invoicesVoided: invoices.voided,
    invoicesPaid: invoices.paid,
    labelsNotVoided: labels.failed,
  };
}

export const idFor = newId;
