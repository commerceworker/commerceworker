/**
 * Undoing everything compensable for an order: the cancel path (a person or the assistant cancels
 * it; a failing Workflow rolls back its own steps instead). Each part is idempotent, so a cancel
 * that runs twice, or after a partial one, undoes nothing more. The order of the steps matters,
 * as the comments say.
 *
 * A cancel refunds a card payment only when it is plain that the buyer paid for nothing: money the
 * card processor captured or charged, on an order nothing was ever fulfilled for (no shipment,
 * pickup, hand-over or digital code, cancelled since or not). A carrier shipment stays
 * `label_created` however far the parcel has travelled, a subscription's earlier boxes were
 * delivered, and a code may have been used, so once anything was fulfilled the payment is kept
 * and the caller is told how much (`paymentKept`, with `paymentKeptBecause`): a person refunds it
 * through a return. Payments taken elsewhere (another channel, cash, terms, a supplier payment)
 * are never refunded here, since no money would move. A paid invoice is left as it always was
 * (`invoicesPaid`).
 */

import { BASE_CURRENCY, isPaid, refundableTotal } from '@commerceworker/core';
import type {
  BalanceStore,
  BudgetStore,
  FulfillmentStore,
  InventoryStore,
  LabelService,
  MarketplaceStore,
  PricingStore,
  ShippingStore,
} from '@commerceworker/ports/commerce';
import { reverseBudgetSpend } from './budgets';
import { type InvoicePorts, voidInvoices } from './invoices';
import { refund, voidAuthorizations } from './payments';
import { voidOpenLabels } from './shipping-labels';

export type CompensationPorts = InvoicePorts & {
  readonly inventory: InventoryStore;
  readonly shipping: ShippingStore;
  readonly labels: LabelService;
  readonly marketplace: MarketplaceStore;
  readonly fulfillment: FulfillmentStore;
  readonly balances: BalanceStore;
  readonly budgets: BudgetStore;
  readonly pricing: Pick<PricingStore, 'releaseRedemptions'>;
};

/** What a cancel undid, counted. */
export type Undid = Awaited<ReturnType<typeof compensateOrder>>;

export async function compensateOrder(ports: CompensationPorts, orderId: string, now: number) {
  // First, so a label a provider made is voided there before its shipment reads as cancelled.
  const labels = await voidOpenLabels(ports, orderId);
  const [
    released,
    voided,
    cancelled,
    sellerOrdersCancelled,
    payoutsReversed,
    revoked,
    invoices,
    creditReleased,
    budgetSpendReversed,
    promotionsReleased,
  ] = await Promise.all([
    ports.inventory.release(orderId),
    voidAuthorizations(ports, orderId),
    ports.shipping.cancelOpen(orderId),
    ports.marketplace.cancel(orderId),
    ports.marketplace.reversePayouts(orderId),
    ports.fulfillment.revokeEntitlements(orderId),
    voidInvoices(ports, orderId),
    // Credit the order still holds goes back to the customer's limit; a charged hold stays charged.
    ports.balances.releaseHolds(orderId),
    // What the order spent of its company's budgets goes back to them.
    reverseBudgetSpend(ports, orderId, now),
    // A promotion's redemption counts toward its cap, so an order that never completes frees it.
    ports.pricing.releaseRedemptions(orderId),
  ]);
  // After the void, so an invoice found paid at the processor keeps its (settled) account charge.
  const unbilled = await ports.balances.reverse(orderId);
  // After the cancel above, so a shipment it cancelled no longer holds the stock.
  const restored = await ports.inventory.restoreShipped(orderId);
  // Last, and only for an order nothing was fulfilled for.
  const payment = await refundCaptured(ports, orderId);
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
    creditReleased,
    budgetSpendReversed,
    promotionsReleased,
    invoicesVoided: invoices.voided,
    invoicesPaid: invoices.paid,
    labelsNotVoided: labels.failed,
    ...payment,
  };
}

/** The step key a cancel's refund is recorded under: one per order, so a retry finds it made. */
const CANCEL_REFUND_STEP = 'cancel';

/** Why a cancel left money the order had taken: see the note at the top. */
export type PaymentKeptReason = 'fulfilled' | 'not_card' | 'refused';

async function refundCaptured(
  ports: Pick<CompensationPorts, 'ledger' | 'mode' | 'shipping' | 'fulfillment'>,
  orderId: string,
): Promise<{
  refunded: number;
  paymentKept: number;
  paymentKeptBecause: PaymentKeptReason | null;
  /** The currency of `refunded` and `paymentKept`, when there is either. */
  paymentCurrency: string | null;
}> {
  const none = { refunded: 0, paymentKept: 0, paymentKeptBecause: null, paymentCurrency: null };
  const rows = await ports.ledger.forOrder(orderId);
  // Captures and charges only: an order paid by invoice keeps its invoice (`invoicesPaid`).
  const paid = rows.filter(isPaid);
  const held = paid.length ? refundableTotal(rows) : 0;
  if (held <= 0) return none;
  const paymentCurrency = paid[0]?.currency ?? BASE_CURRENCY;
  const kept = (paymentKeptBecause: PaymentKeptReason) => ({
    refunded: 0,
    paymentKept: held,
    paymentKeptBecause,
    paymentCurrency,
  });
  // Only money the card processor holds: a refund row for any other would say money moved.
  if (!ports.mode.live() || paid.some((p) => p.provider !== ports.mode.processor().id))
    return kept('not_card');
  // Shipments booked with a carrier, then pickups and hand-overs, then codes: any, in any status.
  const [booked, handed, codes] = await Promise.all([
    ports.shipping.booked(orderId),
    ports.fulfillment.shipments(orderId),
    ports.fulfillment.entitlements(orderId),
  ]);
  if (booked.length || handed.length || codes.length) return kept('fulfilled');
  try {
    const r = await refund(ports, { id: orderId, currency: paymentCurrency }, CANCEL_REFUND_STEP);
    return r.status === 'succeeded'
      ? { ...none, refunded: r.amount, paymentCurrency }
      : kept('refused');
  } catch {
    // The rest of the cancel is done and must be recorded: the money is reported, not retried
    // (a disputed charge, or one refunded at the processor meanwhile, would fail every time).
    return kept('refused');
  }
}
