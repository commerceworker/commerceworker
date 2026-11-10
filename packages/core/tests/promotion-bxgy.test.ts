import { describe, expect, it } from 'vitest';
import {
  applyPromotion,
  type BxgyRule,
  bxgyGroups,
  bxgyShapeProblem,
  choosePromotions,
  describeBxgy,
  type OrderLine,
  type Promotion,
  parseBxgyRule,
  promotionProblem,
} from '../src';

const rule = (r: Partial<BxgyRule> & Pick<BxgyRule, 'buy' | 'get'>): BxgyRule => ({
  repeat: null,
  ...r,
});
/** Buy `x` of `buy` (any when null), get `y` of `get` (the same when null) at `percent` off. */
const r = (
  x: number,
  y: number,
  o: { buy?: string[]; get?: string[]; percent?: number; repeat?: number } = {},
) =>
  rule({
    buy: { skus: o.buy ?? null, qty: x },
    get: { skus: o.get ?? null, qty: y, percent: o.percent ?? 100 },
    repeat: o.repeat ?? null,
  });

const promo = (b: BxgyRule, p: Partial<Promotion> = {}): Promotion => ({
  id: 'promo_bx',
  code: null,
  name: 'Buy and get',
  kind: 'bxgy',
  value: 0,
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
  bxgy: b,
  ...p,
});
const ctx = (lines: OrderLine[]) => ({
  now: 1_000,
  customerId: 'cus_1',
  currency: 'USD',
  fxRate: 1,
  channel: 'web',
  customer: undefined,
  meta: undefined,
  lines,
  redeemed: { total: 0, byCustomer: 0 },
});
const take = (b: BxgyRule, lines: OrderLine[], p: Partial<Promotion> = {}) =>
  applyPromotion(promo(b, p), { lines }, { fxRate: 1 });
const totals = (lines: OrderLine[]) =>
  Math.round(lines.reduce((s, l) => s + l.qty * (l.unitPrice ?? 0), 0) * 100) / 100;

describe('buy X, get Y', () => {
  it('takes the get units off the line that holds them, as a lower average unit price', () => {
    const out = take(r(2, 1), [{ sku: 'TEE', qty: 3, unitPrice: 10 }]);
    expect(out.amount).toBe(10);
    expect(out.lines).toEqual([{ sku: 'TEE', qty: 3, unitPrice: 6.6667 }]);
    expect(totals(out.lines)).toBe(20);
  });

  it('discounts the cheapest units first, across lines and the same SKUs on both sides', () => {
    // Six units, buy 2 get 1: two groups of three, so the two cheapest are free.
    const lines: OrderLine[] = [
      { sku: 'A', qty: 4, unitPrice: 10 },
      { sku: 'B', qty: 2, unitPrice: 4 },
    ];
    const out = take(r(2, 1), lines);
    expect(out.amount).toBe(8);
    expect(out.lines[1]).toMatchObject({ sku: 'B', unitPrice: 0 });
    expect(out.lines[0]).toMatchObject({ sku: 'A', unitPrice: 10 });
  });

  it('never counts a unit twice: a unit that bought is not also discounted', () => {
    const hats: OrderLine[] = [{ sku: 'HAT', qty: 2, unitPrice: 10 }];
    // Buy any 2, get 1: two units are only enough to buy.
    expect(bxgyGroups(r(2, 1), hats)).toBe(0);
    expect(bxgyGroups(r(2, 1), [{ sku: 'HAT', qty: 3, unitPrice: 10 }])).toBe(1);
    expect(bxgyGroups(r(2, 1), [{ sku: 'HAT', qty: 5, unitPrice: 10 }])).toBe(1);
    expect(bxgyGroups(r(2, 1), [{ sku: 'HAT', qty: 6, unitPrice: 10 }])).toBe(2);
  });

  it('buys from one SKU and gets another, once per group the buying earns', () => {
    const lines: OrderLine[] = [
      { sku: 'TEE', qty: 4, unitPrice: 20 },
      { sku: 'HAT', qty: 3, unitPrice: 15 },
    ];
    const b = r(2, 1, { buy: ['TEE'], get: ['HAT'] });
    // Unlimited: two groups of the four tees, two of the three hats.
    expect(take(b, lines).amount).toBe(30);
    // Repeat 1 holds it to one group.
    expect(take({ ...b, repeat: 1 }, lines).amount).toBe(15);
    // One tee is not a group.
    expect(bxgyGroups(b, [{ sku: 'TEE', qty: 1, unitPrice: 20 }, lines[1]!])).toBe(0);
  });

  it('is limited by the get units there are, not only the buy units', () => {
    const lines: OrderLine[] = [
      { sku: 'TEE', qty: 6, unitPrice: 20 },
      { sku: 'HAT', qty: 1, unitPrice: 15 },
    ];
    expect(take(r(2, 1, { buy: ['TEE'], get: ['HAT'] }), lines).amount).toBe(15);
  });

  it('gets several units a group, at a percentage off', () => {
    const lines: OrderLine[] = [
      { sku: 'TEE', qty: 2, unitPrice: 20 },
      { sku: 'SOCK', qty: 3, unitPrice: 6 },
      { sku: 'SOCK2', qty: 3, unitPrice: 8 },
    ];
    // One group: the two cheapest of the get set (SOCK at 6), each half off.
    const out = take(r(2, 2, { buy: ['TEE'], get: ['SOCK', 'SOCK2'], percent: 50 }), lines);
    expect(out.amount).toBe(6);
    expect(out.lines[1]).toMatchObject({ sku: 'SOCK', unitPrice: 4 });
  });

  it('with a source of either (buy and get overlapping), keeps enough units to buy with', () => {
    // Buy 1 TEE, get 1 of TEE or HAT: the cheap tee must stay the bought one.
    const out = take(r(1, 1, { buy: ['TEE'], get: ['TEE', 'HAT'] }), [
      { sku: 'TEE', qty: 1, unitPrice: 5 },
      { sku: 'HAT', qty: 1, unitPrice: 20 },
    ]);
    expect(out.amount).toBe(20);
    expect(out.lines[0]).toMatchObject({ sku: 'TEE', unitPrice: 5 });
    // With two tees the cheapest of the pool, a tee, is the free one.
    const two = take(r(1, 1, { buy: ['TEE'], get: ['TEE', 'HAT'] }), [
      { sku: 'TEE', qty: 2, unitPrice: 5 },
      { sku: 'HAT', qty: 1, unitPrice: 20 },
    ]);
    expect(two.amount).toBe(5);
  });

  it('counts whole units only, and none without a price or at a price of 0', () => {
    const b = r(2, 1);
    expect(bxgyGroups(b, [{ sku: 'A', qty: 2.9, unitPrice: 10 }])).toBe(0);
    expect(bxgyGroups(b, [{ sku: 'A', qty: 3.9, unitPrice: 10 }])).toBe(1);
    expect(bxgyGroups(b, [{ sku: 'A', qty: 3 }])).toBe(0);
    expect(bxgyGroups(b, [{ sku: 'A', qty: 3, unitPrice: 0 }])).toBe(0);
    // A gift among paid units is no unit to buy with or to take off.
    const lines: OrderLine[] = [
      { sku: 'A', qty: 2, unitPrice: 10 },
      { sku: 'GIFT', qty: 5, unitPrice: 0 },
    ];
    expect(bxgyGroups(b, lines)).toBe(0);
    // A fractional line still spreads its discount over its whole quantity.
    const out = take(r(1, 1), [{ sku: 'A', qty: 2.5, unitPrice: 10 }]);
    expect(out.amount).toBe(10);
    expect(out.lines[0]?.unitPrice).toBe(6);
  });

  it('rounds each line’s discount to the cent, and the order total follows', () => {
    // 7 units at 3.33: two free is 6.66; a third of 33% off a unit is not a cent.
    const out = take(r(1, 1, { percent: 33 }), [{ sku: 'A', qty: 7, unitPrice: 3.33 }]);
    // Three groups: 3 units at 33% off of 3.33 = 3.2967 -> 3.30.
    expect(out.amount).toBe(3.3);
    expect(totals(out.lines)).toBe(20.01);
  });

  it('caps what it takes off, scaled across the lines it touches', () => {
    const lines: OrderLine[] = [
      { sku: 'A', qty: 2, unitPrice: 10 },
      { sku: 'B', qty: 2, unitPrice: 30 },
    ];
    // Two groups of one: the two cheapest units of four are A's, 20 off before the cap.
    const wide = r(1, 1);
    expect(take(wide, lines).amount).toBe(20);
    expect(take(wide, lines, { maxDiscount: 15 }).amount).toBe(15);
    // The cap is in the base currency: at 2 per base unit, 5 allows 10.
    const out = applyPromotion(promo(wide, { maxDiscount: 5 }), { lines }, { fxRate: 2 });
    expect(out.amount).toBe(10);
  });

  it('takes the cap across lines in proportion', () => {
    const lines: OrderLine[] = [
      { sku: 'A', qty: 1, unitPrice: 10 },
      { sku: 'B', qty: 1, unitPrice: 30 },
    ];
    // The cheaper unit is free (10) but the cap is 4, all of it from line A.
    const out = take(r(1, 1, { buy: ['B'], get: ['A', 'B'] }), lines, { maxDiscount: 4 });
    expect(out.amount).toBe(4);
  });

  it('stacks on the prices an earlier stackable promotion left', () => {
    const lines: OrderLine[] = [{ sku: 'A', qty: 3, unitPrice: 10 }];
    const pct = promo(r(1, 1), {
      id: 'promo_pct',
      kind: 'pct',
      value: 10,
      bxgy: null,
      stacking: 'stackable',
      priority: 5,
    });
    const bx = promo(r(2, 1), { stacking: 'stackable' });
    const { chosen } = choosePromotions([bx, pct], { lines }, { fxRate: 1 });
    expect(chosen.map((p) => p.id)).toEqual(['promo_pct', 'promo_bx']);
    // 10% off first (9 a unit), then the cheapest of three free: 27 - 9.
    const first = applyPromotion(pct, { lines }, { fxRate: 1 });
    const both = applyPromotion(bx, first, { fxRate: 1 });
    expect(totals(both.lines)).toBe(18);
    expect(first.amount + both.amount).toBe(12);
  });

  it('is an exclusive choice that wins only when it alone beats the stackable ones', () => {
    const lines: OrderLine[] = [{ sku: 'A', qty: 3, unitPrice: 10 }];
    const pct = promo(r(1, 1), {
      id: 'promo_pct',
      name: 'Ten off',
      kind: 'pct',
      value: 10,
      bxgy: null,
      stacking: 'stackable',
    });
    const free = promo(r(2, 1));
    const out = choosePromotions([pct, free], { lines }, { fxRate: 1 });
    expect(out.chosen.map((p) => p.id)).toEqual(['promo_bx']);
    expect(out.left[0]?.reason).toBe("Ten off isn't combined with Buy and get.");
  });

  it('applies nothing for a rule that is missing or an order too small for it', () => {
    const lines: OrderLine[] = [{ sku: 'A', qty: 1, unitPrice: 10 }];
    expect(take(r(2, 1), lines)).toMatchObject({ amount: 0, lines });
    expect(applyPromotion(promo(r(2, 1), { bxgy: null }), { lines }, { fxRate: 1 }).amount).toBe(0);
  });
});

describe('promotionProblem for buy X, get Y', () => {
  const lines: OrderLine[] = [
    { sku: 'TEE', qty: 2, unitPrice: 20 },
    { sku: 'HAT', qty: 1, unitPrice: 15 },
  ];

  it('is met once the order holds what the rule needs', () => {
    expect(promotionProblem(promo(r(2, 1, { buy: ['TEE'], get: ['HAT'] })), ctx(lines))).toBeNull();
    expect(promotionProblem(promo(r(2, 1)), ctx(lines))).toBeNull();
  });

  it('says what the order lacks, in the rule’s own words', () => {
    const own = promo(r(2, 1, { buy: ['TEE'] }), { code: 'TEEDEAL' });
    expect(promotionProblem(own, ctx([{ sku: 'TEE', qty: 2, unitPrice: 20 }]))).toBe(
      'TEEDEAL needs at least 3 TEE in the order.',
    );
    const cross = promo(r(2, 1, { buy: ['TEE'], get: ['HAT'] }), { code: 'HATDEAL' });
    expect(promotionProblem(cross, ctx([lines[0]!]))).toBe(
      'HATDEAL needs 2 TEE and 1 HAT in the order.',
    );
    expect(promotionProblem(promo(r(2, 1), { code: 'ANY' }), ctx([lines[1]!]))).toBe(
      'ANY needs at least 3 items in the order.',
    );
  });

  it('is judged with the typed fields and the condition, as any promotion is', () => {
    const b = r(2, 1, { buy: ['TEE'], get: ['HAT'] });
    expect(promotionProblem(promo(b, { minSubtotal: 100, code: 'BIG' }), ctx(lines))).toBe(
      'BIG needs a subtotal of at least 100.',
    );
    const us = { '==': [{ var: 'order.currency' }, 'EUR'] };
    expect(
      promotionProblem(
        promo(b, { condition: us, conditionMessage: 'Euro orders only.' }),
        ctx(lines),
      ),
    ).toBe('Euro orders only.');
    expect(promotionProblem(promo(b, { status: 'paused', code: 'OFF' }), ctx(lines))).toBe(
      'OFF is paused.',
    );
  });

  it('refuses a promotion of this kind that has no readable rule', () => {
    expect(promotionProblem(promo(r(1, 1), { bxgy: null, code: 'BAD' }), ctx(lines))).toBe(
      'BAD has no buy X, get Y rule.',
    );
  });
});

describe('the rule', () => {
  it('fills in what a writer leaves out', () => {
    expect(parseBxgyRule({ buy: { qty: 2 }, get: { qty: 1 } })).toEqual({
      rule: {
        buy: { skus: null, qty: 2 },
        get: { skus: null, qty: 1, percent: 100 },
        repeat: null,
      },
    });
  });

  it('refuses a rule that can never apply, or never means what it says', () => {
    const bad = (x: unknown) => {
      const p = parseBxgyRule(x);
      return 'error' in p ? p.error : 'accepted';
    };
    const ok = { buy: { qty: 2 }, get: { qty: 1 } };
    expect(bad({ ...ok, get: { qty: 0 } })).toMatch(/at least 1/);
    expect(bad({ ...ok, buy: { qty: 0 } })).toMatch(/at least 1/);
    expect(bad({ ...ok, get: { qty: 1.5 } })).toBe('A quantity is a whole number');
    expect(bad({ ...ok, get: { qty: 1, percent: 0 } })).toBe('A percentage is above 0');
    expect(bad({ ...ok, get: { qty: 1, percent: 120 } })).toMatch(/100/);
    expect(bad({ ...ok, repeat: 0 })).toMatch(/at least 1/);
    // A set that is present but empty can never match a line.
    expect(bad({ ...ok, get: { qty: 1, skus: [] } })).toMatch(/at least one/);
    expect(bad({ ...ok, buy: { qty: 1, skus: ['A', 'A'] } })).toBe('A SKU is listed once');
    expect(bad({ ...ok, extra: 1 })).not.toBe('accepted');
    expect(bad({ buy: { qty: 2 } })).not.toBe('accepted');
    expect(bad(null)).not.toBe('accepted');
  });

  it('is one kind’s alone, and that kind names its SKUs inside it', () => {
    const ok = { buy: { qty: 2 }, get: { qty: 1 } };
    expect(bxgyShapeProblem('bxgy', ok, null)).toBeNull();
    expect(bxgyShapeProblem('bxgy', undefined, null)).toBe(
      'A buy X, get Y promotion needs its rule.',
    );
    expect(bxgyShapeProblem('bxgy', ok, ['A'])).toBe(
      'A buy X, get Y promotion lists its SKUs inside its rule.',
    );
    expect(bxgyShapeProblem('pct', ok, null)).toBe('Only a buy X, get Y promotion takes a rule.');
    expect(bxgyShapeProblem('pct', undefined, ['A'])).toBeNull();
    expect(bxgyShapeProblem('bxgy', { buy: { qty: 0 }, get: { qty: 1 } }, null)).toMatch(
      /at least 1/,
    );
  });

  it('reads aloud as a merchant would say it', () => {
    expect(describeBxgy(r(2, 1, { buy: ['TEE'] }))).toBe('Buy 2 TEE, get 1 free');
    expect(describeBxgy(r(1, 1))).toBe('Buy 1 items, get 1 free');
    expect(describeBxgy(r(3, 2, { buy: ['A', 'B'], get: ['HAT'], percent: 50, repeat: 2 }))).toBe(
      'Buy 3 A or B, get 2 HAT 50% off, up to 2 times per order',
    );
    expect(describeBxgy(r(1, 1, { repeat: 1 }))).toBe(
      'Buy 1 items, get 1 free, up to 1 time per order',
    );
  });
});
