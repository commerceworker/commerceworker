/**
 * The marketplace use-cases: split an order into one part per seller, and schedule what each
 * accepted seller is paid. The split and the payout amounts are core rules (`groupBySeller`,
 * `payoutAmounts`); these gather what they need through the ports and record the result once.
 */
import {
  FIRST_PARTY,
  groupBySeller,
  linesSubtotal,
  type Order,
  payoutAmounts,
} from '@commerceworker/core';
import {
  type MarketplaceStore,
  type PayoutRecord,
  type PricingStore,
  payoutId,
  type SellerPart,
} from '@commerceworker/ports/commerce';

export type SplitResult =
  | { readonly ok: true; readonly parts: SellerPart[] }
  | { readonly ok: false; readonly error: string };

/**
 * One part per seller on the order: a line's own seller, else its product's, else first party.
 * First-party lines and sellers that auto-accept start accepted. Every third-party seller must
 * exist and be active, or nothing is opened. Keyed by order and seller, so a retry opens nothing.
 */
export async function splitBySeller(
  ports: { readonly pricing: PricingStore; readonly marketplace: MarketplaceStore },
  order: Pick<Order, 'id' | 'lines'>,
): Promise<SplitResult> {
  const products = await ports.pricing.products(order.lines.map((l) => l.sku));
  const sellerOf = new Map(products.map((p) => [p.sku, p.sellerId]));
  const groups = groupBySeller(order.lines, (sku) => sellerOf.get(sku));
  const ids = [...groups.keys()].filter((id) => id !== FIRST_PARTY);
  const known = new Map((await ports.marketplace.sellers(ids)).map((s) => [s.id, s]));
  const missing = ids.filter((id) => !known.get(id)?.active);
  if (missing.length)
    return { ok: false, error: `Unknown or inactive seller: ${missing.join(', ')}` };
  await ports.marketplace.openSellerOrders(
    order.id,
    [...groups].map(([sellerId, lines]) => ({
      sellerId,
      status: sellerId === FIRST_PARTY || known.get(sellerId)?.autoAccept ? 'accepted' : 'pending',
      lines,
      subtotal: linesSubtotal(lines),
    })),
  );
  return { ok: true, parts: await ports.marketplace.parts(order.id) };
}

/**
 * One payout per accepted third-party seller, less their share of `refunds` (what the order has
 * refunded so far) and their commission. Keyed by step and seller: a retry schedules nothing more
 * and returns what the first scheduled.
 */
export async function schedulePayouts(
  ports: { readonly marketplace: MarketplaceStore },
  order: Pick<Order, 'id' | 'total'>,
  stepKey: string,
  refunds: number,
): Promise<PayoutRecord[]> {
  const parts = await ports.marketplace.acceptedParts(order.id);
  const rows = parts.map((p) => ({
    id: payoutId(order.id, stepKey, p.sellerId),
    orderId: order.id,
    sellerId: p.sellerId,
    ...payoutAmounts(p.subtotal, p.commissionPct, order.total, refunds),
    status: 'scheduled',
  }));
  await ports.marketplace.schedulePayouts(rows);
  return rows;
}
