import { describe, expect, it } from 'vitest';
import {
  buyerOrderView,
  confirmationEmail,
  escapeHtml,
  hashOrderViewToken,
  matchesOrderViewToken,
  newOrderViewToken,
  type Order,
  orderReceiptUrl,
  orderRef,
  shipToLines,
} from '../src';

const order = (over: Partial<Order> = {}): Order => ({
  id: 'ord_mv65gsxyqcs34m',
  model: 'b2c',
  channel: 'web',
  currency: 'USD',
  lines: [
    { sku: 'A', name: 'Alpha', qty: 3, unitPrice: 1.1, sellerId: 'sel_1', locationId: 'loc' },
  ],
  meta: {
    shipTo: { name: 'Ada', line1: '1 Main', city: 'Leeds', postalCode: 'LS1', country: 'GB' },
    internalNote: 'VIP, comp the shipping',
    buyerId: 'm_1',
  },
  createdAt: 5,
  subtotal: 3.3,
  shipping: 0,
  tax: 0,
  total: 3.3,
  contact: { email: 'ada@example.com' },
  documentText: 'raw po text',
  ...over,
});

describe('buyerOrderView', () => {
  it('carries the buyer-safe fields and nothing a flow or staff wrote', () => {
    const v = buyerOrderView({ orderId: 'ord_mv65gsxyqcs34m', status: 'running', order: order() }, [
      { carrier: 'UPS', tracking: '1Z9' },
    ]);
    expect(v).toMatchObject({
      ref: '#qcs34m',
      status: 'running',
      lines: [{ sku: 'A', name: 'Alpha', qty: 3, unitPrice: 1.1, lineTotal: 3.3 }],
      shipTo: ['Ada', '1 Main', 'Leeds, LS1', 'GB'],
      shipments: [{ carrier: 'UPS', tracking: '1Z9' }],
    });
    const json = JSON.stringify(v);
    for (const secret of ['VIP', 'internalNote', 'sel_1', 'ada@example.com', 'raw po text', 'm_1'])
      expect(json).not.toContain(secret);
  });

  it('is null for an order that has none', () => {
    expect(buyerOrderView({ orderId: null, status: 'queued', order: null })).toBeNull();
  });
});

describe('shipToLines', () => {
  it('prints a string as it is and an address object line by line', () => {
    expect(shipToLines('  12 Elm St, Leeds ')).toEqual(['12 Elm St, Leeds']);
    expect(shipToLines(undefined)).toEqual([]);
    expect(shipToLines({ line1: 'x' })).toEqual(['x']);
  });
});

describe('confirmationEmail', () => {
  it('escapes every value in the HTML part and none in the plain part', () => {
    const view = buyerOrderView(
      {
        orderId: 'o',
        status: 'completed',
        order: order({ lines: [{ sku: 'S', name: '<b>"x"</b>', qty: 1, unitPrice: 1 }] }),
      },
      [],
    )!;
    const m = confirmationEmail(view, 'https://s.example/orders/o?t=abc&x=1');
    expect(m.text).toContain('<b>"x"</b>');
    expect(m.html).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    expect(m.html).not.toContain('<b>');
    expect(m.html).toContain('href="https://s.example/orders/o?t=abc&amp;x=1"');
  });

  it('falls back to the plain number for a currency the runtime does not know', () => {
    const v = buyerOrderView({
      orderId: 'o',
      status: 'completed',
      order: order({ currency: 'ZZZ' }),
    })!;
    expect(confirmationEmail(v, 'https://s.example/o').text).toMatch(/Total: .*3\.3/);
  });
});

describe('the confirmation email’s wording', () => {
  it('never names the platform: it is the merchant’s mail, and the sender’s name is theirs to set', () => {
    const v = buyerOrderView(
      { orderId: 'ord_mv65gsxyqcs34m', status: 'running', order: order() },
      [],
    )!;
    const m = confirmationEmail(v, 'https://s.example/orders/o?t=abc');
    expect([m.subject, m.text, m.html].join('\n')).not.toMatch(/commerceworker/i);
  });
});

describe('order-view credentials', () => {
  it('are 64 hex characters, never repeated, and stored as a hash', async () => {
    const a = newOrderViewToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newOrderViewToken()).not.toBe(a);
    expect(await hashOrderViewToken(a)).not.toBe(a);
  });

  it('match only a live hash, whatever else is stored', async () => {
    const t = newOrderViewToken();
    const h = await hashOrderViewToken(t);
    expect(await matchesOrderViewToken(t, ['0'.repeat(64), h])).toBe(true);
    expect(await matchesOrderViewToken(t, ['0'.repeat(64)])).toBe(false);
    expect(await matchesOrderViewToken(t, [])).toBe(false);
    expect(await matchesOrderViewToken(h, [h])).toBe(false);
    expect(await matchesOrderViewToken(undefined, [h])).toBe(false);
    expect(await matchesOrderViewToken('x'.repeat(64), [h])).toBe(false);
  });
});

describe('small helpers', () => {
  it('names an order by its last six characters', () => {
    expect(orderRef('ord_mv65gsxyqcs34m')).toBe('#qcs34m');
  });
  it('escapes markup characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
  it('builds the receipt address, with or without a credential', () => {
    expect(orderReceiptUrl('https://s.example/', 'ord_1')).toBe('https://s.example/orders/ord_1');
    expect(orderReceiptUrl('https://s.example', 'ord_1', 'tok')).toBe(
      'https://s.example/orders/ord_1?t=tok',
    );
  });
});

describe('the hosted checkout’s idempotency key', () => {
  it('is reserved, so no REST caller can start an order under it', async () => {
    const { reservedOrderKey } = await import('../src');
    expect(reservedOrderKey('hosted:abc')).toBe(true);
    expect(reservedOrderKey('shop:abc')).toBe(false);
  });
});
