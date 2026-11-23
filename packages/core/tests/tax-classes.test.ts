import { describe, expect, it } from 'vitest';
import {
  classTaxRate,
  computeTotals,
  regionalTaxRate,
  type TaxRegion,
  taxClassRatesSchema,
  taxesByClass,
  taxRegionsSchema,
  withLineTaxRates,
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

  it('sets a line rate only where it differs from the order rate, and clears old ones', () => {
    const lines = [
      { sku: 'A', qty: 1, taxRate: 0.3 },
      { sku: 'B', qty: 1 },
      { sku: 'C', qty: 1 },
    ];
    const rates = new Map([
      ['A', 0.2],
      ['B', 0.05],
      ['C', 0],
    ]);
    expect(withLineTaxRates(lines, 0.2, (sku) => rates.get(sku) as number)).toEqual([
      { sku: 'A', qty: 1 },
      { sku: 'B', qty: 1, taxRate: 0.05 },
      { sku: 'C', qty: 1, taxRate: 0 },
    ]);
    expect(withLineTaxRates(lines, 0.2)).toEqual([
      { sku: 'A', qty: 1 },
      { sku: 'B', qty: 1 },
      { sku: 'C', qty: 1 },
    ]);
  });
});

describe('totals with line tax rates', () => {
  const lines = [
    { sku: 'A', qty: 3, unitPrice: 19.99 },
    { sku: 'B', qty: 1, unitPrice: 9.99, taxRate: 0.05 },
    { sku: 'C', qty: 2, unitPrice: 25, taxRate: 0 },
  ];

  it('taxes each line at its own rate and shipping at the order rate, rounded once', () => {
    const t = computeTotals({ lines, shipping: 7.5, taxRate: 0.2, taxShipping: true });
    // 59.97 × 0.2 + 9.99 × 0.05 + 0 + 7.5 × 0.2 = 11.994 + 0.4995 + 1.5 = 13.9935.
    expect(t).toMatchObject({ subtotal: 119.96, shipping: 7.5, tax: 13.99, total: 141.45 });
    expect(computeTotals({ lines, shipping: 7.5, taxRate: 0.2, taxShipping: false }).tax).toBe(
      12.49,
    );
  });

  it('charges nothing for line rates before a tax node has run', () => {
    expect(computeTotals({ lines: [{ sku: 'A', qty: 1, unitPrice: 100, taxRate: 0.5 }] }).tax).toBe(
      0,
    );
  });

  it('is unchanged for an order with one rate', () => {
    const plain = lines.map(({ taxRate: _r, ...l }) => l);
    expect(
      computeTotals({ lines: plain, shipping: 7.5, taxRate: 0.0825, taxShipping: true }).tax,
    ).toBe(Math.round((119.96 + 7.5) * 0.0825 * 100) / 100);
  });
});
