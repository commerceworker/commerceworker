/**
 * The marketplace use-cases: split an order into one part per seller, record what the sellers
 * answer, and schedule what each accepted seller is paid. The split and the payout amounts are core rules (`groupBySeller`,
 * `payoutAmounts`); these gather what they need through the ports and record the result once.
 */
import {
  computeTotals,
  FIRST_PARTY,
  groupBySeller,
  linesSubtotal,
  type Order,
  payoutAmounts,
  sellerOfLine,
  sellerOutcome,
  sellerResponseOf,
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

export type SellerAnswers =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly outcome: 'pending' | 'rejected' | 'accepted' | 'partial';
      readonly parts: SellerPart[];
      /** On a partial accept: the order cut to the accepting sellers' lines, re-totalled. */
      readonly order?: Pick<Order, 'lines'> & ReturnType<typeof computeTotals>;
    };

/**
 * Records a seller's answer (a `seller.responded` event's data), or with `expire`, rejects every
 * part still pending, then says where the order stands (`sellerOutcome`). On a partial accept the
 * order keeps only the lines of sellers that accepted; shipping stays as charged and tax
 * re-applies at the rate the tax node used. Only a pending part changes, so a replay is a no-op.
 */
export async function answerSellerOrders(
  ports: { readonly pricing: PricingStore; readonly marketplace: MarketplaceStore },
  order: Order,
  answer: { readonly expire: string } | { readonly response: unknown },
): Promise<SellerAnswers> {
  if ('expire' in answer) await ports.marketplace.expire(order.id, answer.expire);
  else {
    const r = sellerResponseOf(answer.response);
    if (!r)
      return {
        ok: false,
        error: 'seller.responded needs { sellerId, decision: "accepted" | "rejected" }',
      };
    await ports.marketplace.decide(order.id, r.sellerId, r.decision, r.reason);
  }
  const parts = await ports.marketplace.parts(order.id);
  const outcome = sellerOutcome(parts);
  if (outcome !== 'partial') return { ok: true, outcome, parts };
  const keep = new Set(parts.filter((p) => p.status === 'accepted').map((p) => p.sellerId));
  const products = new Map(
    (await ports.pricing.products(order.lines.map((l) => l.sku))).map((p) => [p.sku, p]),
  );
  const lines = order.lines.filter((l) => keep.has(sellerOfLine(l, products.get(l.sku)?.sellerId)));
  return { ok: true, outcome, parts, order: { lines, ...computeTotals({ ...order, lines }) } };
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
