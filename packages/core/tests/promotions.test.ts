import { describe, expect, it } from 'vitest';
import {
  applyPromotion,
  choosePromotions,
  type OrderLine,
  type Promotion,
  promoCodesOf,
  promotionLabel,
  promotionProblem,
  regionalTaxRate,
  unknownPromotion,
} from '../src';

const promo = (p: Partial<Promotion> = {}): Promotion => ({
  id: 'promo_1',
  code: 'SAVE10',
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
  condition: null,
  conditionMessage: null,
  bxgy: null,
  ...p,
});
const lines: OrderLine[] = [
  { sku: 'A', qty: 2, unitPrice: 50 },
  { sku: 'B', qty: 1, unitPrice: 100 },
];
const ctx = {
  now: 1_000,
  customerId: 'cus_1',
  currency: 'USD',
  fxRate: 1,
  channel: 'web',
  customer: undefined,
  meta: undefined,
  lines,
  redeemed: { total: 0, byCustomer: 0 },
};

describe('promotion codes', () => {
  it('reads an order’s codes normalised and once each', () => {
    expect(promoCodesOf({ promoCodes: [' save10 ', 'SAVE10', 'bad code', 3, 'x2'] })).toEqual([
      'SAVE10',
      'X2',
    ]);
    expect(promoCodesOf({})).toEqual([]);
    expect(promoCodesOf(undefined)).toEqual([]);
  });

  it('says why a promotion doesn’t apply', () => {
    expect(promotionProblem(promo(), ctx)).toBeNull();
    expect(promotionProblem(promo({ status: 'paused' }), ctx)).toMatch(/paused/);
    expect(promotionProblem(promo({ validFrom: 2_000 }), ctx)).toMatch(/isn't valid yet/);
    expect(promotionProblem(promo({ validTo: 1_000 }), ctx)).toMatch(/expired/);
    // Another customer's code reads exactly like one that doesn't exist, so codes can't be probed.
    expect(promotionProblem(promo({ customerId: 'cus_2' }), ctx)).toBe(unknownPromotion('SAVE10'));
    // Paused, upcoming or expired, it still reads as unknown: none of that may show it exists.
    for (const over of [
      { status: 'paused' as const },
      { validFrom: ctx.now + 1 },
      { validTo: ctx.now - 1 },
    ])
      expect(promotionProblem(promo({ customerId: 'cus_2', ...over }), ctx)).toBe(
        unknownPromotion('SAVE10'),
      );
    expect(promotionProblem(promo({ currency: 'EUR' }), ctx)).toMatch(/EUR orders/);
    expect(
      promotionProblem(promo({ maxRedemptions: 1 }), {
        ...ctx,
        redeemed: { total: 1, byCustomer: 0 },
      }),
    ).toMatch(/used up/);
    expect(
      promotionProblem(promo({ perCustomerLimit: 1 }), {
        ...ctx,
        redeemed: { total: 5, byCustomer: 1 },
      }),
    ).toMatch(/already been used/);
    expect(promotionProblem(promo({ skus: ['Z'] }), ctx)).toMatch(/doesn't cover/);
    expect(promotionProblem(promo({ minSubtotal: 201 }), ctx)).toMatch(/at least 201/);
    expect(promotionProblem(promo({ minSubtotal: 200 }), ctx)).toBeNull();
  });

  it('judges the condition after the typed fields, and answers a failure in the merchant’s words', () => {
    const channel = { '==': [{ var: 'order.channel' }, 'pos'] };
    expect(
      promotionProblem(promo({ condition: { '==': [{ var: 'order.channel' }, 'web'] } }), ctx),
    ).toBeNull();
    expect(promotionProblem(promo({ condition: channel }), ctx)).toBe(
      "This order doesn't qualify for SAVE10.",
    );
    expect(
      promotionProblem(promo({ condition: channel, conditionMessage: 'In store only.' }), ctx),
    ).toBe('In store only.');
    // A named automatic promotion reads as its name.
    expect(promotionProblem(promo({ code: null, name: 'Sale', condition: channel }), ctx)).toBe(
      "This order doesn't qualify for Sale.",
    );
    // A typed limit that fails says its own reason, not the condition's message.
    expect(
      promotionProblem(promo({ minSubtotal: 201, condition: channel, conditionMessage: 'x' }), ctx),
    ).toMatch(/at least 201/);
    // Another customer's code still reads as unknown, whatever its condition.
    expect(
      promotionProblem(
        promo({ customerId: 'cus_2', condition: channel, conditionMessage: 'x' }),
        ctx,
      ),
    ).toBe(unknownPromotion('SAVE10'));
    // A stored condition that isn't allowed never qualifies an order.
    expect(promotionProblem(promo({ condition: { exec: [] } }), ctx)).toMatch(/qualify/);
  });
});

describe('applying promotions', () => {
  it('takes a percentage off the covered lines’ prices', () => {
    const r = applyPromotion(promo({ value: 10 }), { lines }, { fxRate: 1 });
    expect(r.lines.map((l) => l.unitPrice)).toEqual([45, 90]);
    expect(r.amount).toBe(20);
    const onlyB = applyPromotion(promo({ value: 50, skus: ['B'] }), { lines }, { fxRate: 1 });
    expect(onlyB.lines.map((l) => l.unitPrice)).toEqual([50, 50]);
    expect(onlyB.amount).toBe(50);
  });

  it('spreads an amount over the covered lines, never past their total, in the order’s currency', () => {
    const r = applyPromotion(promo({ kind: 'amount', value: 30 }), { lines }, { fxRate: 1 });
    expect(r.amount).toBe(30);
    const capped = applyPromotion(
      promo({ kind: 'amount', value: 500, skus: ['A'] }),
      { lines },
      {
        fxRate: 1,
      },
    );
    expect(capped.amount).toBe(100);
    expect(capped.lines[0]!.unitPrice).toBe(0);
    // A base-currency amount converts at the order's rate.
    expect(
      applyPromotion(promo({ kind: 'amount', value: 10 }), { lines }, { fxRate: 0.9 }).amount,
    ).toBe(9);
  });

  it('takes shipping off for free shipping and leaves the lines alone', () => {
    const ship = promo({ kind: 'free_shipping' });
    expect(applyPromotion(ship, { lines, shipping: 30 }, { fxRate: 1 })).toEqual({
      lines,
      shipping: 0,
      amount: 30,
    });
    // No shipping charge yet (rated after the promotions): nothing to take off.
    expect(applyPromotion(ship, { lines }, { fxRate: 1 }).amount).toBe(0);
  });

  it('caps what a promotion takes off, in the base currency, after its own arithmetic', () => {
    // 10% of 200 is 20, capped at 12: the covered lines share the 12.
    const r = applyPromotion(promo({ value: 10, maxDiscount: 12 }), { lines }, { fxRate: 1 });
    expect(r.amount).toBe(12);
    expect(r.lines.map((l) => l.unitPrice)).toEqual([47.0, 94.0]);
    // Under the cap it changes nothing.
    expect(
      applyPromotion(promo({ value: 10, maxDiscount: 50 }), { lines }, { fxRate: 1 }).amount,
    ).toBe(20);
    // The cap is in the base currency: 10 base is 9 in an order at 0.9.
    expect(
      applyPromotion(
        promo({ kind: 'amount', value: 100, maxDiscount: 10 }),
        { lines },
        { fxRate: 0.9 },
      ).amount,
    ).toBe(9);
    // Free shipping takes off at most the cap.
    expect(
      applyPromotion(
        promo({ kind: 'free_shipping', maxDiscount: 8 }),
        { lines, shipping: 30 },
        { fxRate: 1 },
      ),
    ).toMatchObject({ shipping: 22, amount: 8 });
  });
});

describe('choosing promotions', () => {
  const order = { lines, shipping: 30 };
  const fx = { fxRate: 1 };
  const ten = promo({ id: 'ten', code: 'TEN', value: 10 });
  const ship = promo({ id: 'ship', code: 'SHIP', kind: 'free_shipping' });
  const fifty = promo({ id: 'fifty', code: 'FIFTY', kind: 'amount', value: 50 });
  const ids = (ps: Promotion[]) => ps.map((p) => p.id);

  it('applies the exclusive promotion worth the most, and says what it isn’t combined with', () => {
    const r = choosePromotions([ten, ship, fifty], order, fx);
    expect(ids(r.chosen)).toEqual(['fifty']);
    expect(r.left.map((l) => [l.promotion.id, l.reason])).toEqual([
      ['ship', "SHIP isn't combined with FIFTY."],
      ['ten', "TEN isn't combined with FIFTY."],
    ]);
    // Free shipping is worth the shipping charge.
    expect(ids(choosePromotions([ten, ship], order, fx).chosen)).toEqual(['ship']);
  });

  it('combines stackable promotions, highest priority first, each on the prices left', () => {
    const a = promo({ id: 'a', code: 'A', value: 10, stacking: 'stackable', priority: 1 });
    const b = promo({
      id: 'b',
      code: 'B',
      kind: 'amount',
      value: 20,
      stacking: 'stackable',
      priority: 5,
    });
    const r = choosePromotions([a, b], order, fx);
    expect(ids(r.chosen)).toEqual(['b', 'a']);
    expect(r.left).toEqual([]);
    // Equal priority: the larger discount is first.
    const c = promo({ id: 'c', code: 'C', value: 10, stacking: 'stackable' });
    const d = promo({ id: 'd', code: 'D', kind: 'amount', value: 30, stacking: 'stackable' });
    expect(ids(choosePromotions([c, d], order, fx).chosen)).toEqual(['d', 'c']);
  });

  it('lets an exclusive promotion displace the stackable set only when it alone beats it', () => {
    const s1 = promo({ id: 's1', code: 'S1', value: 10, stacking: 'stackable' });
    const s2 = promo({ id: 's2', code: 'S2', kind: 'free_shipping', stacking: 'stackable' });
    // Together the stackable pair takes off 20 + 30 = 50.
    const smaller = promo({ id: 'x', code: 'X', kind: 'amount', value: 49 });
    const r = choosePromotions([smaller, s1, s2], order, fx);
    // Free shipping (worth 30 alone) ranks before the 10% (worth 20).
    expect(ids(r.chosen)).toEqual(['s2', 's1']);
    expect(r.left).toEqual([{ promotion: smaller, reason: "X isn't combined with S2, S1." }]);
    // A bigger exclusive one wins alone, and the stackable ones are told which it is.
    const bigger = promo({ id: 'y', code: 'Y', kind: 'amount', value: 51 });
    const won = choosePromotions([bigger, s1, s2], order, fx);
    expect(ids(won.chosen)).toEqual(['y']);
    expect(won.left.map((l) => l.reason)).toEqual([
      "S2 isn't combined with Y.",
      "S1 isn't combined with Y.",
    ]);
    // Equal: the stackable set wins the tie.
    const equal = promo({ id: 'z', code: 'Z', kind: 'amount', value: 50 });
    expect(ids(choosePromotions([equal, s1, s2], order, fx).chosen)).toEqual(['s2', 's1']);
  });

  it('measures the stackable set with caps applied', () => {
    const capped = promo({
      id: 'c1',
      code: 'C1',
      value: 50,
      maxDiscount: 5,
      stacking: 'stackable',
    });
    const small = promo({ id: 'x', code: 'X', kind: 'amount', value: 6 });
    // Uncapped 50% would beat 6, but it takes off at most 5.
    expect(ids(choosePromotions([capped, small], order, fx).chosen)).toEqual(['x']);
  });

  it('breaks a tie between exclusive promotions by priority', () => {
    const a = promo({ id: 'a', code: 'A', kind: 'amount', value: 20, priority: 1 });
    const b = promo({ id: 'b', code: 'B', kind: 'amount', value: 20, priority: 9 });
    expect(ids(choosePromotions([a, b], order, fx).chosen)).toEqual(['b']);
  });

  it('names an automatic promotion by its name when it has no code', () => {
    const auto = promo({
      id: 'auto',
      code: null,
      name: 'Summer sale',
      value: 30,
      stacking: 'stackable',
    });
    const code = promo({ id: 'c', code: 'CODE', value: 5 });
    const r = choosePromotions([auto, code], order, fx);
    expect(ids(r.chosen)).toEqual(['auto']);
    expect(r.left[0]?.reason).toBe("CODE isn't combined with Summer sale.");
    expect(promotionLabel(auto)).toBe('Summer sale');
    expect(promotionProblem(auto, { ...ctx, now: 2_000 })).toBeNull();
    expect(promotionProblem({ ...auto, status: 'paused' }, ctx)).toBe('Summer sale is paused.');
  });

  it('chooses nothing from nothing', () => {
    expect(choosePromotions([], order, fx)).toEqual({ chosen: [], left: [] });
  });
});

describe('tax by region', () => {
  const regions = [
    { country: 'US', region: 'CA', rate: 0.0725 },
    { country: 'US', rate: 0.05 },
    { country: 'CA', rate: 0.13 },
  ];
  it('takes the most specific match, then the fallback', () => {
    expect(regionalTaxRate(regions, 'US', 'ca', 0.08)).toBe(0.0725);
    expect(regionalTaxRate(regions, 'US', 'NY', 0.08)).toBe(0.05);
    expect(regionalTaxRate(regions, 'CA', undefined, 0.08)).toBe(0.13);
    expect(regionalTaxRate(regions, 'DE', undefined, 0.08)).toBe(0.08);
    expect(regionalTaxRate(regions, undefined, undefined, 0.08)).toBe(0.08);
  });
});
