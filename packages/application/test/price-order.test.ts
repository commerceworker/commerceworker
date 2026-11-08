import { FixedClock } from '@commerceworker/test-kit';
import { InMemoryPricingStore, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { MissingExchangeRateError, priceOrder } from '../src/commerce';

const pricing = new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock());
const now = Date.parse('2026-11-01T00:00:00Z');
const chain = { basis: 'auto', useContracts: true, usePriceRules: true, now } as const;
const lines = [
  { sku: 'PC-SKU-1', qty: 2 },
  { sku: 'PC-SKU-2', qty: 1 },
];
const order = (over: Partial<Parameters<typeof priceOrder>[1]> = {}) => ({
  lines,
  currency: 'USD',
  customerId: 'pc_northwind',
  model: 'b2b' as const,
  ...over,
});

describe('pricing an order', () => {
  it('runs the price chain for a sell-side order: tier price, contract price', async () => {
    const p = await priceOrder({ pricing }, order(), chain);
    expect(p.lines.map((l) => l.unitPrice)).toEqual([8, 20]);
    expect(p.priced.map((x) => x.by)).toEqual(['price_book', 'contract']);
    expect(p.totals.subtotal).toBe(36);
  });

  it('leaves out the sources a node turns off', async () => {
    const p = await priceOrder({ pricing }, order(), { ...chain, useContracts: false });
    expect(p.lines.map((l) => l.unitPrice)).toEqual([8, 25]);
    expect(p.priced[1]?.by).toBe('list');
  });

  it('prices a buy-side order at cost', async () => {
    const p = await priceOrder({ pricing }, order({ model: 'procurement' }), chain);
    expect(p.lines.map((l) => l.unitPrice)).toEqual([5, 12.5]);
    expect(p.priced).toEqual([]);
  });

  it('keeps a price given on the order', async () => {
    const given = [{ sku: 'PC-SKU-2', qty: 1, unitPrice: 19 }];
    const p = await priceOrder({ pricing }, order({ lines: given }), chain);
    expect(p.lines[0]?.unitPrice).toBe(19);
    expect(p.priced[0]).toMatchObject({ by: 'list', rule: 'Given on the order' });
  });

  it("converts base-currency prices at the order's rate", async () => {
    const p = await priceOrder({ pricing }, order({ currency: 'EUR' }), chain);
    expect(p.fxRate).toBe(0.92);
    expect(p.lines.map((l) => l.unitPrice)).toEqual([7.36, 18.4]);
  });

  it('refuses a currency with no exchange rate', async () => {
    await expect(priceOrder({ pricing }, order({ currency: 'XTS' }), chain)).rejects.toBeInstanceOf(
      MissingExchangeRateError,
    );
  });
});
