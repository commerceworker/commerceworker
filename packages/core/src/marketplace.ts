/**
 * Marketplace rules with no storage: which seller fulfils a line, how an order splits into one
 * part per seller, and what a seller is paid. The engine records parts and payouts through the
 * marketplace port (@commerceworker/ports/commerce).
 */
import { money } from './logic';
import type { OrderLine } from './types';

/** The seller id for lines the marketplace operator sells itself. */
export const FIRST_PARTY = 'first_party';

/** A line's seller: its own `sellerId`, else its product's seller, else first party. */
export const sellerOfLine = (line: OrderLine, productSeller?: string | null) =>
  line.sellerId ?? productSeller ?? FIRST_PARTY;

/** The order's lines grouped by seller, in the order sellers first appear. */
export function groupBySeller(
  lines: readonly OrderLine[],
  productSeller: (sku: string) => string | null | undefined,
): Map<string, OrderLine[]> {
  const groups = new Map<string, OrderLine[]>();
  for (const l of lines) {
    const seller = sellerOfLine(l, productSeller(l.sku));
    groups.set(seller, [...(groups.get(seller) ?? []), l]);
  }
  return groups;
}

/** What a seller's lines come to, before refunds and commission. */
export const linesSubtotal = (lines: readonly OrderLine[]) =>
  money(lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0));

export interface PayoutAmounts {
  readonly gross: number;
  readonly refunded: number;
  readonly commission: number;
  readonly net: number;
}

/**
 * A seller's payout: their lines, less their share of refunds so far (pro rata to the order total,
 * never more than their lines) and the commission on what is left.
 */
export function payoutAmounts(
  gross: number,
  commissionPct: number,
  orderTotal: number,
  refunds: number,
): PayoutAmounts {
  const refunded = orderTotal > 0 ? money(Math.min(gross, (refunds * gross) / orderTotal)) : 0;
  const commission = money((gross - refunded) * commissionPct);
  return { gross, refunded, commission, net: money(gross - refunded - commission) };
}
