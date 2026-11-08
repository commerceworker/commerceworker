/**
 * Invoice rules with no storage: payment terms, when an invoice falls due, and the items it bills.
 * The engine issues invoices through the invoices port and the card processor
 * (@commerceworker/ports/commerce).
 */
import { toMinor } from './money';
import type { Order } from './types';

export type InvoiceTerms = 'due_on_receipt' | 'net_15' | 'net_30' | 'net_60';

/** Days until an invoice on these terms is due; unknown terms are net 30. */
export const TERM_DAYS: Record<string, number> = {
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_60: 60,
};

const DAY = 86_400_000;

export const termDays = (terms: string) => TERM_DAYS[terms] ?? 30;

/** When an invoice issued at `at` on these terms is due: never sooner than a day out. */
export const invoiceDueAt = (terms: string, at: number) => at + Math.max(termDays(terms), 1) * DAY;

/**
 * How the processor is told the due date. Net terms are a number of days. "Due on receipt" asks
 * for a date a day out (`dueAt`, in ms): processors document days-until-due only as a number of
 * days, so rather than rely on 0 being accepted, the invoice is due the next day.
 */
export function invoiceDue(
  terms: string,
  dueAt: number,
): { daysUntilDue: number } | { dueDate: number } {
  const days = termDays(terms);
  return days > 0 ? { daysUntilDue: days } : { dueDate: Math.floor(dueAt / 1000) };
}

/** The invoice's items in minor units: each line, shipping, tax, and whatever rounding is left. */
export function invoiceItems(
  order: Pick<Order, 'lines' | 'shipping' | 'shippingOption' | 'tax' | 'total' | 'currency'>,
) {
  const items: { description: string; amount: number }[] = [];
  for (const l of order.lines) {
    const amount = toMinor(l.qty * (l.unitPrice ?? 0), order.currency);
    if (amount) items.push({ description: `${l.name ?? l.sku} × ${l.qty}`, amount });
  }
  const shipping = toMinor(order.shipping ?? 0, order.currency);
  if (shipping)
    items.push({
      description: order.shippingOption ? `Shipping (${order.shippingOption})` : 'Shipping',
      amount: shipping,
    });
  const tax = toMinor(order.tax, order.currency);
  if (tax) items.push({ description: 'Tax', amount: tax });
  const rest = toMinor(order.total, order.currency) - items.reduce((s, i) => s + i.amount, 0);
  if (rest) items.push({ description: 'Adjustments', amount: rest });
  return items;
}
