import { describe, expect, it } from 'vitest';
import { digitalLines, orderInputSchema, shippableLines, validateOrder } from '../src';

const products = [
  { sku: 'A', name: 'Apron', kind: 'physical', weightKg: 0.5 },
  { sku: 'E', name: 'E-book', kind: 'digital' },
];

describe('accepting an order', () => {
  it('refuses no lines, an unknown SKU and an unknown customer', () => {
    expect(validateOrder({ lines: [] }, products, false)).toEqual({
      problem: 'Order has no lines',
    });
    expect(validateOrder({ lines: [{ sku: 'Z', qty: 1 }] }, products, false)).toEqual({
      problem: 'Unknown SKUs: Z',
    });
    expect(
      validateOrder({ lines: [{ sku: 'A', qty: 1 }], customerId: 'c1' }, products, false),
    ).toEqual({
      problem: 'Unknown customer c1',
    });
  });

  it('declines an order from a company that isn’t active, and a buyer who isn’t an active member', () => {
    const order = { lines: [{ sku: 'A', qty: 1 }], customerId: 'c1', meta: { buyerId: 'm1' } };
    const ok = {
      company: { status: 'active' as const },
      buyer: { companyId: 'c1', status: 'active' as const },
    };
    expect('lines' in validateOrder(order, products, true, ok)).toBe(true);
    expect(
      validateOrder(order, products, true, { ...ok, company: { status: 'suspended' } }),
    ).toEqual({
      problem: "Company c1 isn't active (suspended)",
    });
    expect(
      validateOrder(order, products, true, {
        ...ok,
        buyer: { companyId: 'c1', status: 'inactive' },
      }),
    ).toEqual({
      problem: "Buyer m1 isn't an active member of c1",
    });
    expect(validateOrder(order, products, true, { company: ok.company, buyer: undefined })).toEqual(
      {
        problem: "Buyer m1 isn't an active member of c1",
      },
    );
    // No account to hold it to (a consumer's order, or one placed before companies): accepted.
    expect('lines' in validateOrder({ ...order, meta: {} }, products, true)).toBe(true);
  });

  it('keeps whole quantities of at least one, named from the product', () => {
    expect(
      validateOrder(
        {
          lines: [
            { sku: 'A', qty: 0.2 },
            { sku: 'E', qty: 2.6, name: 'Mine' },
          ],
        },
        products,
        true,
      ),
    ).toEqual({
      lines: [
        { sku: 'A', qty: 1, name: 'Apron' },
        { sku: 'E', qty: 3, name: 'Mine' },
      ],
    });
  });
});

describe('what ships', () => {
  it('leaves out digital lines and carries the product weight', () => {
    expect(
      shippableLines(
        [
          { sku: 'A', qty: 2 },
          { sku: 'E', qty: 1 },
        ],
        products,
      ),
    ).toEqual([
      { qty: 2, weightKg: 0.5, lengthCm: undefined, widthCm: undefined, heightCm: undefined },
    ]);
  });
});

describe('what is delivered as a code', () => {
  it('keeps the digital lines with their place on the order, and nothing that ships', () => {
    expect(
      digitalLines(
        [
          { sku: 'A', qty: 2 },
          { sku: 'E', qty: 3 },
          { sku: 'Z', qty: 1 },
        ],
        products,
      ),
    ).toEqual([{ index: 1, sku: 'E', qty: 3 }]);
  });
});

describe('an order’s buyer', () => {
  const base = { model: 'b2b' as const, lines: [{ sku: 'A', qty: 1 }] };

  it('is a company member’s id in meta.buyerId, or nothing', () => {
    expect(orderInputSchema.safeParse({ ...base, meta: { buyerId: 'mem_1' } }).success).toBe(true);
    expect(orderInputSchema.safeParse({ ...base }).success).toBe(true);
    for (const buyerId of ['', 7, null])
      expect(orderInputSchema.safeParse({ ...base, meta: { buyerId } }).success).toBe(false);
  });
});
