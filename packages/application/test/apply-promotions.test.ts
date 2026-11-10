import type { Order, Promotion } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import { InMemoryPricingStore, PRICING_FIXTURE } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { applyPromotions } from '../src/commerce';

const now = Date.parse('2026-11-01T00:00:00Z');
const opts = { now, stepKey: 'discount#1', dryRun: false };

/** The contract fixture's coded promotions only: its automatic ones would apply to every order. */
const coded = { ...PRICING_FIXTURE, promotions: PRICING_FIXTURE.promotions!.filter((p) => p.code) };
const promo = (over: Partial<Promotion> & { id: string }): Promotion => ({
  code: null,
  name: '',
  kind: 'pct',
  value: 10,
  currency: null,
  minSubtotal: null,
  skus: null,
  customerId: null,
  validFrom: null,
  validTo: null,
  maxRedemptions: null,
  perCustomerLimit: null,
  status: 'active',
  priority: 0,
  stacking: 'exclusive',
  maxDiscount: null,
  ...over,
});
const storeWith = (...promotions: Promotion[]) =>
  new InMemoryPricingStore({ ...PRICING_FIXTURE, promotions }, new FixedClock());
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
  it('does nothing for an order with no codes and no automatic promotion', async () => {
    const pricing = new InMemoryPricingStore(coded, new FixedClock());
    expect(await applyPromotions({ pricing }, order(undefined), opts)).toEqual({
      applied: [],
      refused: [],
    });
  });

  it('applies a usable code, refuses the rest in the order given, and re-totals', async () => {
    const pricing = new InMemoryPricingStore(coded, new FixedClock());
    const r = await applyPromotions({ pricing }, order(['nope', 'pcpaused', 'pclast']), opts);
    expect(r.applied).toEqual([
      { id: 'pc_promo_last', code: 'PCLAST', name: 'Last one', kind: 'pct', amount: 2 },
    ]);
    expect(r.refused.map((x) => x.code)).toEqual(['NOPE', 'PCPAUSED']);
    expect(r.order?.subtotal).toBe(43);
    expect(r.order?.total).toBe(48);
  });

  it('holds the redemption once: a second order finds the code used up', async () => {
    const pricing = new InMemoryPricingStore(coded, new FixedClock());
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
    const pricing = new InMemoryPricingStore(coded, new FixedClock());
    await applyPromotions({ pricing }, order(['PCLAST']), { ...opts, dryRun: true });
    const r = await applyPromotions({ pricing }, order(['PCLAST'], 'ord_other'), opts);
    expect(r.applied.map((a) => a.code)).toEqual(['PCLAST']);
  });

  it('refuses a code by name when an exclusive promotion wins, and says which', async () => {
    const pricing = storeWith(
      promo({ id: 'a', code: 'BIG', value: 20 }),
      promo({ id: 'b', code: 'SMALL', value: 5 }),
    );
    const r = await applyPromotions({ pricing }, order(['small', 'big']), opts);
    expect(r.applied.map((a) => a.code)).toEqual(['BIG']);
    expect(r.refused).toEqual([{ code: 'SMALL', reason: "SMALL isn't combined with BIG." }]);
  });

  it('applies several stackable codes, each to the prices the one before left', async () => {
    const pricing = storeWith(
      promo({ id: 'a', code: 'TEN', value: 10, stacking: 'stackable' }),
      promo({ id: 'b', code: 'FIVE', kind: 'amount', value: 5, stacking: 'stackable' }),
    );
    const r = await applyPromotions({ pricing }, order(['ten', 'five', 'nope']), opts);
    // Subtotal 45: FIVE is worth more alone (5 against 4.50), so it goes first; TEN then takes
    // 10% of the 40 left.
    expect(r.applied.map((a) => [a.code, a.amount])).toEqual([
      ['FIVE', 5],
      ['TEN', 4],
    ]);
    expect(r.order?.subtotal).toBe(36);
    expect(r.refused.map((x) => x.code)).toEqual(['NOPE']);
  });

  it('applies an automatic promotion with no code, and keeps it beside a stackable code', async () => {
    const pricing = storeWith(
      promo({ id: 'auto', name: 'Summer sale', value: 10, stacking: 'stackable', priority: 5 }),
      promo({ id: 'b', code: 'FIVE', kind: 'amount', value: 5, stacking: 'stackable' }),
    );
    const none = await applyPromotions({ pricing }, order(undefined), opts);
    expect(none.applied).toEqual([
      { id: 'auto', code: null, name: 'Summer sale', kind: 'pct', amount: 4.5 },
    ]);
    expect(none.order?.subtotal).toBe(40.5);
    const both = await applyPromotions({ pricing }, order(['five'], 'ord_two'), opts);
    expect(both.applied.map((a) => a.code)).toEqual([null, 'FIVE']);
  });

  it('leaves out an automatic promotion that does not fit, without a refusal', async () => {
    const pricing = storeWith(
      promo({ id: 'mine', name: 'Only for another', customerId: 'someone_else' }),
      promo({ id: 'min', name: 'Big orders', minSubtotal: 1_000 }),
      promo({ id: 'paused', name: 'Paused', status: 'paused' }),
    );
    const r = await applyPromotions({ pricing }, order(undefined), opts);
    expect(r.applied).toEqual([]);
    expect(r.refused).toEqual([]);
    expect(r.order?.subtotal).toBe(45);
  });

  it('lets an exclusive automatic promotion beat a code, and says so by name', async () => {
    const pricing = storeWith(
      promo({ id: 'auto', name: 'Sitewide', value: 20 }),
      promo({ id: 'b', code: 'FIVE', kind: 'amount', value: 5, stacking: 'stackable' }),
    );
    const r = await applyPromotions({ pricing }, order(['five']), opts);
    expect(r.applied.map((a) => a.name)).toEqual(['Sitewide']);
    expect(r.refused).toEqual([{ code: 'FIVE', reason: "FIVE isn't combined with Sitewide." }]);
  });

  it('caps what each promotion takes off before the next one applies', async () => {
    const pricing = storeWith(
      promo({ id: 'a', code: 'HALF', value: 50, maxDiscount: 10, stacking: 'stackable' }),
      promo({ id: 'b', code: 'TEN', value: 10, stacking: 'stackable' }),
    );
    const r = await applyPromotions({ pricing }, order(['half', 'ten']), opts);
    expect(r.applied.map((a) => [a.code, a.amount])).toEqual([
      ['HALF', 10],
      ['TEN', 3.5],
    ]);
    expect(r.order?.subtotal).toBe(31.5);
  });

  it('redeems an automatic promotion like a code: held once per order, used up at its limit', async () => {
    const pricing = storeWith(promo({ id: 'auto', name: 'First order', maxRedemptions: 1 }));
    const first = await applyPromotions({ pricing }, order(undefined), opts);
    expect(first.applied).toHaveLength(1);
    // A retried step holds the same redemption again.
    expect((await applyPromotions({ pricing }, order(undefined), opts)).applied).toHaveLength(1);
    // The limit is reached: another order simply doesn't get it, with nothing refused.
    const other = await applyPromotions({ pricing }, order(undefined, 'ord_other'), opts);
    expect(other.applied).toEqual([]);
    expect(other.refused).toEqual([]);
    // Giving back the first order's redemption frees it.
    await pricing.releaseRedemptions('ord_promo');
    expect(
      (await applyPromotions({ pricing }, order(undefined, 'ord_other'), opts)).applied,
    ).toHaveLength(1);
  });

  it('holds no redemption of an automatic promotion on a dry run', async () => {
    const pricing = storeWith(promo({ id: 'auto', name: 'First order', maxRedemptions: 1 }));
    await applyPromotions({ pricing }, order(undefined), { ...opts, dryRun: true });
    expect(
      (await applyPromotions({ pricing }, order(undefined, 'ord_other'), opts)).applied,
    ).toHaveLength(1);
  });
});
