import { describe, expect, it } from 'vitest';
import {
  classTaxRate,
  computeTotals,
  regionalTaxRate,
  skuTaxRate,
  skuTaxRates,
  type TaxRegion,
  taxClassRatesSchema,
  taxesByClass,
  taxRegionsSchema,
} from '../src';

const regions: TaxRegion[] = [
  { country: 'GB', rate: 0.2 },
  { country: 'GB', class: 'reduced', rate: 0.05 },
  { country: 'US', region: 'CA', rate: 0.0725 },
  { country: 'US', region: 'CA', class: 'groceries', rate: 0 },
];

describe('tax classes', () => {
  it('keeps class entries out of the standard rate', () => {
    // Only a class entry for the place: the standard rate is still the fallback.
    expect(
      regionalTaxRate([{ country: 'FR', class: 'reduced', rate: 0.055 }], 'FR', undefined, 0.2),
    ).toBe(0.2);
    expect(regionalTaxRate(regions, 'GB', undefined, 0.08)).toBe(0.2);
    expect(regionalTaxRate(regions, 'US', 'ca', 0.08)).toBe(0.0725);
  });

  it('rates a class by region, then country, then its own default, then the standard rate', () => {
    const classes = { reduced: 0.1, 'gift-card': 0 };
    expect(classTaxRate('groceries', regions, classes, 'US', 'CA', 0.0725)).toBe(0);
    expect(classTaxRate('reduced', regions, classes, 'GB', 'ENG', 0.2)).toBe(0.05);
    expect(classTaxRate('reduced', regions, classes, 'DE', undefined, 0.19)).toBe(0.1);
    expect(classTaxRate('gift-card', regions, classes, undefined, undefined, 0.08)).toBe(0);
    // A class the node gives no rate is never taxed less than ordinary goods.
    expect(classTaxRate('unknown', regions, classes, 'GB', undefined, 0.2)).toBe(0.2);
    expect(classTaxRate(null, regions, classes, 'GB', undefined, 0.2)).toBe(0.2);
    expect(classTaxRate('standard', regions, { standard: 0 }, 'GB', undefined, 0.2)).toBe(0.2);
  });

  it('says whether settings rate any class', () => {
    expect(taxesByClass([{ country: 'GB', rate: 0.2 }], {})).toBe(false);
    expect(taxesByClass(regions, {})).toBe(true);
    expect(taxesByClass([], { reduced: 0.05 })).toBe(true);
  });

  it('validates class names and rates', () => {
    expect(taxClassRatesSchema.safeParse({ 'gift-card': 0, reduced: 0.05 }).success).toBe(true);
    expect(taxClassRatesSchema.safeParse({ 'Gift Card': 0 }).success).toBe(false);
    expect(taxClassRatesSchema.safeParse({ reduced: 0.6 }).success).toBe(false);
    expect(
      taxRegionsSchema.safeParse([{ country: 'GB', class: 'Reduced', rate: 0.05 }]).success,
    ).toBe(false);
  });

  it('refuses a rate for the standard class, which Rate and the regions set', () => {
    expect(taxClassRatesSchema.safeParse({ standard: 0 }).success).toBe(false);
  });

  it('keeps a rate by SKU only where it differs from the order rate', () => {
    const rates = new Map([
      ['A', 0.2],
      ['B', 0.05],
      ['C', 0],
    ]);
    const rateOf = (sku: string) => rates.get(sku) as number;
    expect(skuTaxRates(rates.keys(), 0.2, rateOf)).toEqual({ B: 0.05, C: 0 });
    expect(skuTaxRates(['A'], 0.2, rateOf)).toBeUndefined();
  });

  it('reads a SKU’s rate from the order, and nothing before a tax node ran', () => {
    const order = { taxRate: 0.2, taxRates: { B: 0.05, C: 0 } };
    expect(['A', 'B', 'C'].map((sku) => skuTaxRate(order, sku))).toEqual([0.2, 0.05, 0]);
    // A SKU named like a prototype key is an ordinary SKU.
    expect(skuTaxRate(order, 'constructor')).toBe(0.2);
    expect(skuTaxRate({ taxRates: { B: 0.05 } }, 'B')).toBe(0);
    expect(skuTaxRate({}, 'A')).toBe(0);
  });
});

describe('totals with tax rates by SKU', () => {
  const lines = [
    { sku: 'A', qty: 3, unitPrice: 19.99 },
    { sku: 'B', qty: 1, unitPrice: 9.99 },
    { sku: 'C', qty: 2, unitPrice: 25 },
  ];
  const taxRates = { B: 0.05, C: 0 };

  it('taxes each SKU at its own rate and shipping at the order rate, rounded once', () => {
    const t = computeTotals({ lines, shipping: 7.5, taxRate: 0.2, taxShipping: true, taxRates });
    // 59.97 × 0.2 + 9.99 × 0.05 + 0 + 7.5 × 0.2 = 11.994 + 0.4995 + 1.5 = 13.9935.
    expect(t).toMatchObject({ subtotal: 119.96, shipping: 7.5, tax: 13.99, total: 141.45 });
    expect(
      computeTotals({ lines, shipping: 7.5, taxRate: 0.2, taxShipping: false, taxRates }).tax,
    ).toBe(12.49);
  });

  it('charges nothing for rates by SKU before a tax node has run', () => {
    expect(computeTotals({ lines, taxRates: { A: 0.5 } }).tax).toBe(0);
  });

  it('keeps each SKU’s rate when lines are split, merged or dropped after tax', () => {
    // Buy-X-get-Y splits a line; a seller rejecting drops one.
    const split = [
      { sku: 'B', qty: 1, unitPrice: 9.99 },
      { sku: 'A', qty: 2, unitPrice: 19.99 },
      { sku: 'A', qty: 1, unitPrice: 0 },
    ];
    // 39.98 × 0.2 + 9.99 × 0.05 = 7.996 + 0.4995.
    expect(computeTotals({ lines: split, taxRate: 0.2, taxRates }).tax).toBe(8.5);
  });

  it('is unchanged for an order with one rate', () => {
    expect(computeTotals({ lines, shipping: 7.5, taxRate: 0.0825, taxShipping: true }).tax).toBe(
      Math.round((119.96 + 7.5) * 0.0825 * 100) / 100,
    );
  });
});
