/**
 * Undoing everything compensable for an order: the cancel path (a person or the assistant cancels
 * it; a failing Workflow rolls back its own steps instead). Each part is idempotent, so a cancel
 * that runs twice, or after a partial one, undoes nothing more. The order of the steps matters,
 * as the comments say.
 */
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
import { voidAuthorizations } from './payments';
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
  };
}
