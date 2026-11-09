/**
 * Mock commerce connectors over the D1 back office and R2. Each is the seam where a real adapter
 * (a WMS, a carrier API, NetSuite) plugs in later; payments already have one (./payments, with
 * Stripe). Every write is keyed by the step that made it, so a retried step never double-books, and
 * every compensation is idempotent.
 *
 * Failure simulation for demos and tests: set `order.meta.simulate` to one of
 * "payment_decline", "charge_fail", "out_of_stock", "three_way_mismatch".
 */

import * as uc from '@commerceworker/application/commerce';
import { newId, type Order } from '@commerceworker/core';
import { paymentMode } from './payments';
import { commercePorts, invoiceStore, paymentLedger } from './wire';

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

/**
 * Undo everything compensable for an order (cancel path; Workflow rollback covers failures): the
 * `compensateOrder` use-case (@commerceworker/application/commerce) over this deployment's ports.
 */
export const compensateOrder = (env: Env, orderId: string) =>
  uc.compensateOrder(
    {
      ...commercePorts(env),
      ledger: paymentLedger(env),
      mode: paymentMode(env),
      invoices: invoiceStore(env),
    },
    orderId,
  );

export const idFor = newId;
