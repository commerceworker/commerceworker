/**
 * Which order lines a restock covers. Pure: the engine passes what the node's `lines` expression
 * evaluated to (for a return, the lines in the `return.requested` payload) and the order's lines.
 */

import { companyOrderProblem, type OrderAccount } from './b2b/companies';
import type { Order, OrderLine } from './types';

export type StockLine = { sku: string; qty: number };

/**
 * No list means every ordered line. Otherwise each entry needs a SKU on the order and a positive
 * quantity; quantities are summed per SKU and capped at what was ordered, so a return can never
 * restock more than the order shipped. Anything else is ignored.
 */
export function stockLines(requested: unknown, ordered: OrderLine[]): StockLine[] {
  const limit = new Map<string, number>();
  for (const l of ordered) limit.set(l.sku, (limit.get(l.sku) ?? 0) + l.qty);
  if (requested === undefined || requested === null)
    return [...limit].map(([sku, qty]) => ({ sku, qty }));
  if (!Array.isArray(requested)) return [];

  const want = new Map<string, number>();
  for (const r of requested) {
    if (!r || typeof r !== 'object') continue;
    const { sku, qty } = r as { sku?: unknown; qty?: unknown };
    if (typeof sku !== 'string' || !limit.has(sku)) continue;
    const n = Number(qty);
    if (!(n > 0)) continue;
    want.set(sku, (want.get(sku) ?? 0) + n);
  }
  return [...want].map(([sku, qty]) => ({ sku, qty: Math.min(qty, limit.get(sku)!) }));
}

/**
 * An order's acceptance (`commerce.validate`): why it can't run at all (no lines, a SKU the
 * catalog doesn't sell, a customer that doesn't exist, a company that isn't active, a buyer who
 * isn't an active member of the customer: `companyOrderProblem`), or its lines as the order keeps them, each
 * quantity a whole number of at least one and each line named from its product when unnamed.
 */
export function validateOrder(
  order: Pick<Order, 'lines' | 'customerId'> & { meta?: Order['meta'] },
  products: readonly { sku: string; name: string }[],
  customerFound: boolean,
  account: OrderAccount = { company: undefined, buyer: undefined },
): { problem: string } | { lines: OrderLine[] } {
  const known = new Map(products.map((p) => [p.sku, p]));
  if (!order.lines.length) return { problem: 'Order has no lines' };
  const unknown = order.lines.map((l) => l.sku).filter((s) => !known.has(s));
  if (unknown.length) return { problem: `Unknown SKUs: ${unknown.join(', ')}` };
  if (order.customerId && !customerFound)
    return { problem: `Unknown customer ${order.customerId}` };
  const refused = companyOrderProblem(order, account);
  if (refused) return { problem: refused };
  return {
    lines: order.lines.map((l) => ({
      ...l,
      qty: Math.max(1, Math.round(l.qty)),
      name: l.name ?? known.get(l.sku)!.name,
    })),
  };
}
