import { describe, expect, it } from 'vitest';
import {
  maskPersonalText,
  modelContext,
  modelCustomer,
  modelOrder,
  personalDataMode,
  scrubPersonal,
} from '../src/redact';
import type { Order } from '../src/types';

const order: Order = {
  id: 'ord_1',
  createdAt: 0,
  model: 'b2c',
  channel: 'web',
  title: 'Order for jane@example.com',
  currency: 'USD',
  lines: [{ sku: 'MON-27', name: '27" monitor', qty: 2, unitPrice: 300 }],
  contact: { email: 'jane@example.com', name: 'Jane Doe', phone: '+1 555 010 0199' },
  fulfillment: { method: 'ship', locationId: 'loc_1' },
  payment: { provider: 'stripe', paymentMethodId: 'pm_123' },
  documentText: 'Please ship to 1 Main St. Call 555-010-0199.',
  meta: {
    shipTo: { name: 'Jane Doe', line1: '1 Main St', city: 'Springfield', country: 'US' },
    giftNote: 'Happy birthday! Text me at 555 010 0199',
    source: { email: 'jane@example.com', campaign: 'fall' },
  },
  subtotal: 600,
  shipping: 10,
  tax: 50,
  total: 660,
  baseTotal: 660,
};

const customer = {
  id: 'cus_1',
  name: 'Acme Corp',
  email: 'ap@acme.example',
  kind: 'business',
  tier: 'gold',
  creditLimit: 5000,
  balance: 100,
  terms: 'net_30',
  stripeCustomerId: 'cus_stripe',
};

describe('what a model sees of an order', () => {
  it('redacts by default: no contact, address, document, payment or personal text', () => {
    expect(personalDataMode(undefined)).toBe('redact');
    const seen = modelOrder(order, 'redact');
    const text = JSON.stringify(seen);
    for (const leak of [
      'jane@example.com',
      'Jane Doe',
      '1 Main St',
      'Springfield',
      '0199',
      'pm_123',
    ])
      expect(text).not.toContain(leak);
    expect(seen).toMatchObject({
      guest: true,
      shipToCountry: 'US',
      title: 'Order for [email]',
      fulfillment: { method: 'ship' },
      lines: [{ sku: 'MON-27', name: '27" monitor', qty: 2 }],
      meta: { giftNote: 'Happy birthday! Text me at [phone]', source: { campaign: 'fall' } },
      total: 660,
    });
    expect(text).not.toContain('documentText');
  });

  it('marks a guest checkout without saying who', () => {
    expect(modelOrder({ ...order, customerId: undefined }, 'redact')).toMatchObject({
      guest: true,
    });
    expect(modelOrder({ ...order, customerId: 'cus_1' }, 'redact')).toMatchObject({ guest: false });
  });

  it('sends contact and meta when the deployment says send, but never the document or payment ids', () => {
    expect(personalDataMode('send')).toBe('send');
    const seen = modelOrder(order, 'send');
    expect(seen).toMatchObject({ contact: order.contact, meta: order.meta });
    const text = JSON.stringify(seen);
    expect(text).not.toContain('pm_123');
    expect(text).not.toContain('documentText');
  });

  it("keeps a customer's account terms, and their name and email only with send", () => {
    expect(modelCustomer(customer, 'redact')).toEqual({
      id: 'cus_1',
      kind: 'business',
      tier: 'gold',
      creditLimit: 5000,
      balance: 100,
      terms: 'net_30',
    });
    expect(modelCustomer(customer, 'send')).toMatchObject({
      name: 'Acme Corp',
      email: 'ap@acme.example',
    });
    expect(JSON.stringify(modelCustomer(customer, 'send'))).not.toContain('cus_stripe');
  });

  it('scrubs vars and step outputs, and leaves out what was not asked for', () => {
    const c = modelContext('redact', {
      order,
      vars: { approver: 'boss@example.com', risk: 12 },
      completed: { validate: { output: { shipTo: { line1: '1 Main St' }, ok: true } } },
    });
    expect(c).toEqual({
      order: expect.any(Object),
      vars: { approver: '[email]', risk: 12 },
      completed: { validate: { output: { ok: true } } },
    });
    expect(modelContext('redact', { order })).not.toHaveProperty('customer');
  });
});

describe('masking personal text', () => {
  it('masks emails and phone numbers but not ordinary numbers', () => {
    expect(maskPersonalText('Mail a.b+c@mail.example.co or call +1 (555) 010-0199')).toBe(
      'Mail [email] or call [phone]',
    );
    expect(maskPersonalText('PO 4500123, qty 250, total 1,200.50, due 2026-10-15')).toBe(
      'PO 4500123, qty 250, total 1,200.50, due 2026-10-15',
    );
    expect(scrubPersonal({ Ship_To: { x: 1 }, keep: ['ok'] })).toEqual({ keep: ['ok'] });
  });
});

// The regexes maskPersonalText used before it became a linear scanner. They backtrack
// polynomially on hostile text, so they only run here, on short inputs, as the oracle the
// scanner has to agree with.
const OLD_EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const OLD_PHONE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const oldMask = (text: string) =>
  text
    .replace(OLD_EMAIL, '[email]')
    .replace(OLD_PHONE, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m));

const MASK_TABLE: [string, string][] = [
  ['', ''],
  ['no personal data here', 'no personal data here'],
  ['jane@example.com', '[email]'],
  ['a.b+c@mail.example.co', '[email]'],
  ['x_y%z-1@sub-domain.example.museum.', '[email].'],
  ['mail jane@example.com, or bob@example.org.', 'mail [email], or [email].'],
  ['José@exämple.cöm', '[email]'],
  ['用户@例子.广告', '[email]'],
  ['a@b.c', 'a@b.c'],
  ['a@b', 'a@b'],
  ['@example.com', '@example.com'],
  ['a@@b.com', 'a@@b.com'],
  ['a@b@c.com', 'a@[email]'],
  ['a@b.c1', 'a@b.c1'],
  ['a@b.𝐀𝐀', '[email]'],
  ['a@b.𝐀', 'a@b.𝐀'],
  ['a@b.co1', '[email]1'],
  ['a@b.com.', '[email].'],
  ['a@b-c.d.ef9', '[email]9'],
  ['a@1.23.ab', '[email]'],
  ['a@b..com', '[email]'],
  ['..@x.yz', '[email]'],
  ['+1 (555) 010-0199', '[phone]'],
  ['+15550100199', '[phone]'],
  ['(555) 010-0199', '[phone]'],
  ['+(555) 010-0199 ok', '[phone] ok'],
  ['call 555 010 0199.', 'call [phone].'],
  ['555.010.0199 or 555-010-0198', '[phone] or [phone]'],
  ['12345678', '12345678'],
  ['123456789', '[phone]'],
  ['1 2 3 4 5 6 7 8 9', '[phone]'],
  ['1234567', '1234567'],
  ['12 3456', '12 3456'],
  [
    'PO 4500123, qty 250, total 1,200.50, due 2026-10-15',
    'PO 4500123, qty 250, total 1,200.50, due 2026-10-15',
  ],
  ['2026-10-15 2026-10-15', '[phone]'],
  ['order 12345678-9 shipped', 'order [phone] shipped'],
  ['(((1234567890', '(([phone]'],
  ['++1234567890', '+[phone]'],
  ['1234567890   ', '[phone]   '],
  ['tel: 1234567 8', 'tel: 1234567 8'],
  ['x@y.zz then 555-010-0199', '[email] then [phone]'],
  [' 1234567890 ', ' [phone] '],
  ['\n555\n010\n0199\n', '\n[phone]\n'],
];

describe('masking personal text, pinned', () => {
  it.each(MASK_TABLE)('%j', (input, expected) => {
    expect(oldMask(input)).toBe(expected);
    expect(maskPersonalText(input)).toBe(expected);
  });

  it('agrees with the old patterns on random short text', () => {
    const alphabet = [
      'a',
      'Z',
      'é',
      '用',
      '1',
      '9',
      '0',
      '.',
      '-',
      '_',
      '%',
      '+',
      '@',
      '(',
      ')',
      ' ',
      '\n',
      ' ',
      '€',
      '𝐀',
      '\ud835',
    ];
    let seed = 20261113;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 20000; i++) {
      const len = next() % 24;
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
      expect(maskPersonalText(s), JSON.stringify(s)).toBe(oldMask(s));
    }
  });

  it('finishes hostile 100k inputs in well under a second', () => {
    const n = 100_000;
    const hostile = [
      'a'.repeat(n),
      `${'a.'.repeat(n / 2)}`,
      `${'a'.repeat(n)}@`,
      `${'a'.repeat(n / 2)}@${'b'.repeat(n / 2)}`,
      `${'a@'.repeat(n / 2)}`,
      `${'a@b.'.repeat(n / 4)}`,
      `a@${'b.'.repeat(n / 2)}c`,
      '1'.repeat(n),
      `${'1 '.repeat(n / 2)}`,
      `${'1-'.repeat(n / 2)}x`,
      `${'(1'.repeat(n / 2)}`,
      ` ${' '.repeat(n)}1`,
      `${'+'.repeat(n)}`,
      `${'1234567 '.repeat(n / 8)}`,
    ];
    for (const text of hostile) {
      const t0 = performance.now();
      maskPersonalText(text);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });

  it('masks a very long local part in full', () => {
    const local = 'a'.repeat(100_000);
    expect(maskPersonalText(`${local}@example.com`)).toBe('[email]');
    expect(maskPersonalText(`x ${local}.b+c@example.com y`)).toBe('x [email] y');
  });
});
