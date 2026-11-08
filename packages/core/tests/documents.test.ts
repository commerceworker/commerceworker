import { describe, expect, it } from 'vitest';
import { renderDocument } from '../src';

const order = {
  id: 'ord_<1>',
  currency: 'USD',
  lines: [{ sku: 'TEE', name: 'Tee & co', qty: 2, unitPrice: 12.5 }],
  subtotal: 25,
  shipping: 5,
  tax: 2,
  total: 32,
};

describe('order documents', () => {
  it('renders lines, totals and extras, escaped, dated from the time given', () => {
    const at = Date.UTC(2026, 10, 8, 23, 0);
    const html = renderDocument('Invoice <x>', order, at, { Terms: 'net_30' });
    expect(html).toContain('<title>Invoice &lt;x&gt;</title>');
    expect(html).toContain('Order ord_&lt;1&gt; · 2026-11-08');
    expect(html).toContain('<td>Tee &amp; co</td><td>2</td><td>$12.50</td><td>$25.00</td>');
    expect(html).toContain('<p><b>Terms:</b> net_30</p>');
    expect(html).toContain('Shipping $5.00 · Tax $2.00 · <b>Total $32.00 USD</b>');
    expect(renderDocument('Invoice <x>', order, at, { Terms: 'net_30' })).toBe(html);
  });
});
