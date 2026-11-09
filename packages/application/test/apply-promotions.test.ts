import type { Order } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import { InMemoryPricingStore, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { applyPromotions } from '../src/commerce';

const now = Date.parse('2026-11-01T00:00:00Z');
const opts = { now, stack: false, stepKey: 'discount#1', dryRun: false };
const order = (promoCodes: unknown, id = 'ord_promo'): Order =>
  ({
    id,
    createdAt: now,
    customerId: 'pc_northwind',
    currency: 'USD',
    lines: [
      { sku: 'PC-SKU-1', qty: 2, unitPrice: 10 },
      { sku: 'PC-SKU-2', qty: 1, unitPrice: 25 },
    ],
    subtotal: 45,
    shipping: 5,
    tax: 0,
    total: 50,
    meta: { promoCodes },
  }) as unknown as Order;

describe('applying promotion codes to an order', () => {
  it('does nothing for an order with no codes', async () => {
    const pricing = new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock());
    expect(await applyPromotions({ pricing }, order(undefined), opts)).toEqual({
      applied: [],
      refused: [],
    });
  });

  it('applies a usable code, refuses the rest in the order given, and re-totals', async () => {
    const pricing = new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock());
    const r = await applyPromotions({ pricing }, order(['nope', 'pcpaused', 'pclast']), opts);
    expect(r.applied).toEqual([
      { id: 'pc_promo_last', code: 'PCLAST', name: 'Last one', kind: 'pct', amount: 2 },
    ]);
    expect(r.refused.map((x) => x.code)).toEqual(['NOPE', 'PCPAUSED']);
    expect(r.order?.subtotal).toBe(43);
    expect(r.order?.total).toBe(48);
  });

  it('holds the redemption once: a second order finds the code used up', async () => {
    const pricing = new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock());
    await applyPromotions({ pricing }, order(['PCLAST']), opts);
    // A retried step holds the same redemption again.
    const retried = await applyPromotions({ pricing }, order(['PCLAST']), opts);
    expect(retried.applied.map((a) => a.code)).toEqual(['PCLAST']);
    const other = await applyPromotions({ pricing }, order(['PCLAST'], 'ord_other'), opts);
    expect(other.applied).toEqual([]);
    expect(other.refused).toHaveLength(1);
    expect(other.order?.subtotal).toBe(45);
  });

  it('holds nothing on a dry run', async () => {
    const pricing = new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock());
    await applyPromotions({ pricing }, order(['PCLAST']), { ...opts, dryRun: true });
    const r = await applyPromotions({ pricing }, order(['PCLAST'], 'ord_other'), opts);
    expect(r.applied.map((a) => a.code)).toEqual(['PCLAST']);
  });
});
