/**
 * The HTML documents an order's nodes file (invoices, purchase orders): pure, dated from the time
 * the caller passes, so a retried step renders the same page. Stored through the documents port
 * (@commerceworker/ports/commerce).
 */
import { money } from './logic';
import type { Order } from './types';

function esc(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/** An order document: its lines and totals, and `extra` as labelled lines, dated `at` (ms). */
export function renderDocument(
  title: string,
  order: Pick<
    Order,
    'id' | 'currency' | 'lines' | 'subtotal' | 'shipping' | 'shippingOption' | 'tax' | 'total'
  >,
  at: number,
  extra: Record<string, string> = {},
) {
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: order.currency });
  const cash = (n: number) => esc(fmt.format(n));
  const rows = order.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.sku)}</td><td>${esc(l.name ?? '')}</td><td>${l.qty}</td><td>${cash(l.unitPrice ?? 0)}</td><td>${cash(money(l.qty * (l.unitPrice ?? 0)))}</td></tr>`,
    )
    .join('');
  const meta = Object.entries(extra)
    .map(([k, v]) => `<p><b>${esc(k)}:</b> ${esc(v)}</p>`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px system-ui;margin:40px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}</style>
<h1>${esc(title)}</h1><p>Order ${esc(order.id)} · ${new Date(at).toISOString().slice(0, 10)}</p>${meta}
<table><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Unit</th><th>Line</th></tr>${rows}</table>
<p>Subtotal ${cash(order.subtotal)}${order.shipping || order.shippingOption ? ` · Shipping ${cash(order.shipping ?? 0)}` : ''} · Tax ${cash(order.tax)} · <b>Total ${cash(order.total)} ${esc(order.currency)}</b></p>`;
}
