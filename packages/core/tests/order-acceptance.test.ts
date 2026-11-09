import { describe, expect, it } from 'vitest';
import { shippableLines, validateOrder } from '../src';

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
