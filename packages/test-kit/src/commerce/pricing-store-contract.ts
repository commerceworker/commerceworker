/**
 * The behaviour every `PricingStore` keeps, as one suite: the in-memory store runs it in node
 * (test-kit's own tests) and the D1 store in workerd (packages/db). A store that passes it can
 * stand in for the other in use-case tests.
 *
 * `make` seeds a fresh store from the fixture. Ids are distinctive so a backend holding other rows
 * (seed data, migrations' own price sources) can't satisfy an assertion by accident.
 */
import type { CustomerRecord, PricingStore, ProductRecord } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { PricingFixture } from './pricing-store';

const customer = (
  over: Partial<CustomerRecord> & { id: string; name: string },
): CustomerRecord => ({
  email: `${over.id}@example.com`,
  kind: 'business',
  tier: 'standard',
  creditLimit: 0,
  balance: 0,
  terms: 'net_30',
  stripeCustomerId: null,
  stripePaymentMethodId: null,
  ...over,
});

const product = (sku: string, price: number): ProductRecord => ({
  sku,
  name: `Product ${sku}`,
  price,
  cost: price / 2,
  stock: 10,
  reserved: 0,
  reorderPoint: 0,
  reorderQty: 0,
  supplier: '',
  sellerId: null,
  kind: 'physical',
  catalogAt: null,
  weightKg: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
});

/** The fixture the contract seeds every store with. */
export const PRICING_FIXTURE: PricingFixture = {
  customers: [
    customer({ id: 'pc_northwind', name: 'Pricing Contract Northwind, Ltd.', tier: 'gold' }),
    customer({ id: 'pc_twin_a', name: 'Pricing Contract Twin' }),
    customer({ id: 'pc_twin_b', name: 'pricing contract twin' }),
  ],
  products: [product('PC-SKU-1', 10), product('PC-SKU-2', 25)],
  promotions: [
    {
      id: 'pc_promo_last',
      code: 'PCLAST',
      name: 'Last one',
      kind: 'pct',
      value: 10,
      currency: null,
      minSubtotal: null,
      skus: ['PC-SKU-1'],
      customerId: null,
      validFrom: null,
      validTo: null,
      maxRedemptions: 1,
      perCustomerLimit: null,
      status: 'active',
      priority: 0,
      stacking: 'exclusive',
      maxDiscount: null,
      condition: null,
      conditionMessage: null,
      bxgy: null,
    },
    {
      id: 'pc_promo_paused',
      code: 'PCPAUSED',
      name: 'Paused',
      kind: 'amount',
      value: 5,
      currency: 'USD',
      minSubtotal: 20,
      skus: null,
      customerId: null,
      validFrom: null,
      validTo: null,
      maxRedemptions: null,
      perCustomerLimit: 1,
      status: 'paused',
      priority: 0,
      stacking: 'exclusive',
      maxDiscount: null,
      condition: null,
      conditionMessage: null,
      bxgy: null,
    },
    // Automatic promotions (no code): one live, and one each paused, not yet valid and ended.
    ...(
      [
        ['live', {}],
        ['paused', { status: 'paused' as const }],
        ['future', { validFrom: 5_000 }],
        ['ended', { validTo: 1_000 }],
      ] as const
    ).map(([name, over]) => ({
      id: `pc_promo_auto_${name}`,
      code: null,
      name: `Automatic ${name}`,
      kind: 'amount' as const,
      value: 3,
      currency: null,
      minSubtotal: null,
      skus: null,
      customerId: null,
      validFrom: null,
      validTo: null,
      maxRedemptions: null,
      perCustomerLimit: null,
      status: 'active' as const,
      priority: 7,
      stacking: 'stackable' as const,
      maxDiscount: 12,
      condition: null,
      conditionMessage: null,
      bxgy: null,
      ...over,
    })),
  ],
  fxRates: [{ currency: 'EUR', rate: 0.92 }],
  priceSources: [
    { id: 'quote', label: 'Quote', priority: 0, stopProcessing: true, active: true },
    { id: 'price_book', label: 'Price book', priority: 1, stopProcessing: true, active: true },
    { id: 'contract', label: 'Contract', priority: 2, stopProcessing: true, active: true },
    { id: 'volume', label: 'Volume', priority: 3, stopProcessing: false, active: false },
  ],
  priceRules: [
    {
      id: 'pc_rule_gold',
      source: 'price_book',
      name: 'Gold tier',
      sku: 'PC-SKU-1',
      customerId: null,
      customerTier: 'gold',
      minQty: null,
      price: 8,
      discountPct: null,
      startsAt: null,
      endsAt: null,
    },
  ],
  contractPrices: [
    { customerId: 'pc_northwind', sku: 'PC-SKU-2', price: 20 },
    { customerId: 'pc_twin_a', sku: 'PC-SKU-2', price: 21 },
  ],
};

export function describePricingStoreContract(
  name: string,
  make: (fixture: PricingFixture) => Promise<PricingStore>,
) {
  describe(`${name}: the pricing store contract`, () => {
    const store = () => make(PRICING_FIXTURE);

    it('reads a customer by id, and none for an unknown or missing id', async () => {
      const s = await store();
      expect((await s.customer('pc_northwind'))?.tier).toBe('gold');
      expect(await s.customer('pc_nobody')).toBeUndefined();
      expect(
        (await s.customers(['pc_northwind', 'pc_nobody', 'pc_northwind'])).map((c) => c.id),
      ).toEqual(['pc_northwind']);
      const ada = (await s.customer('pc_northwind'))!;
      const [, domain] = ada.email.split('@') as [string, string];
      expect(
        (await s.customersByEmail('nobody@nowhere.example', domain.toUpperCase())).map((c) => c.id),
      ).toContain('pc_northwind');
      expect(await s.customersByEmail('nobody@nowhere.example', 'nowhere.example')).toEqual([]);
      expect(await s.customer(undefined)).toBeUndefined();
    });

    it('matches a customer by name only when exactly one matches', async () => {
      const s = await store();
      expect((await s.customerByName('pricing contract northwind ltd'))?.id).toBe('pc_northwind');
      expect(await s.customerByName('Pricing Contract Twin')).toBeUndefined();
      expect(await s.customerByName('Pricing Contract North')).toBeUndefined();
    });

    it('reads products by SKU, or all of them', async () => {
      const s = await store();
      expect((await s.products(['PC-SKU-2'])).map((p) => p.price)).toEqual([25]);
      expect(await s.products(['PC-NONE'])).toEqual([]);
      const all = (await s.products()).map((p) => p.sku);
      expect(all).toEqual(expect.arrayContaining(['PC-SKU-1', 'PC-SKU-2']));
    });

    it('reads more SKUs than one D1 statement can bind, each once', async () => {
      const s = await store();
      const many = Array.from({ length: 150 }, (_, i) => `PC-NONE-${i}`);
      const skus = [...many, 'PC-SKU-1', 'PC-SKU-2', 'PC-SKU-1'];
      expect((await s.products(skus)).map((p) => p.sku).sort()).toEqual(['PC-SKU-1', 'PC-SKU-2']);
    });

    it('reads promotions by code, as the discount node reads them', async () => {
      const s = await store();
      expect(await s.promotionsByCode([])).toEqual([]);
      const [last] = await s.promotionsByCode(['PCLAST']);
      expect(last).toMatchObject({ id: 'pc_promo_last', skus: ['PC-SKU-1'], maxRedemptions: 1 });
      const [paused] = await s.promotionsByCode(['PCPAUSED']);
      expect(paused).toMatchObject({ status: 'paused', skus: null, perCustomerLimit: 1 });
      // The rules every promotion carries: older ones are exclusive, uncapped, priority 0.
      expect(last).toMatchObject({ priority: 0, stacking: 'exclusive', maxDiscount: null });
      expect(last).toMatchObject({ condition: null, conditionMessage: null });
    });

    it('reads automatic promotions live at a time, and never by code', async () => {
      const s = await store();
      const ids = async (at: number) =>
        (await s.automaticPromotions(at))
          .filter((p) => p.id.startsWith('pc_'))
          .map((p) => p.id)
          .sort();
      // Inside its dates, not paused: the live one; the future one from its start, never the ended
      // one after its end (a promotion ends at validTo, as the node judges it).
      expect(await ids(500)).toEqual(['pc_promo_auto_ended', 'pc_promo_auto_live']);
      expect(await ids(2_000)).toEqual(['pc_promo_auto_live']);
      expect(await ids(5_000)).toEqual(['pc_promo_auto_future', 'pc_promo_auto_live']);
      const [live] = await s.automaticPromotions(2_000);
      expect(live).toMatchObject({
        code: null,
        priority: 7,
        stacking: 'stackable',
        maxDiscount: 12,
      });
      // A codeless promotion has nothing to look up.
      expect((await s.promotionsByCode(['PCLAST'])).every((p) => p.code !== null)).toBe(true);
    });

    it('lets one order hold the last redemption, idempotently, until it gives it back', async () => {
      const s = await store();
      const promotion = { id: 'pc_promo_last', maxRedemptions: 1, perCustomerLimit: null };
      const redeem = (orderId: string, customerId?: string) =>
        s.redeem({ promotion, orderId, customerId, amount: 1, stepKey: `${orderId}:discount#0` });

      expect(await redeem('pc_order_1', 'pc_northwind')).toBe(true);
      expect(await redeem('pc_order_1', 'pc_northwind')).toBe(true);
      expect(await redeem('pc_order_2', 'pc_twin_a')).toBe(false);
      expect(await s.redemptionsOf('pc_promo_last', 'pc_order_2', 'pc_northwind')).toEqual({
        total: 1,
        byCustomer: 1,
      });
      expect(await s.redemptionsOf('pc_promo_last', 'pc_order_1', 'pc_northwind')).toEqual({
        total: 0,
        byCustomer: 0,
      });

      // A guest order (no customer) has no redemptions of its own to count.
      expect(await s.redemptionsOf('pc_promo_last', 'pc_order_2', undefined)).toEqual({
        total: 1,
        byCustomer: 0,
      });

      expect(await s.releaseRedemptions('pc_order_1')).toBe(1);
      expect(await s.releaseRedemptions('pc_order_1')).toBe(0);
      expect(await redeem('pc_order_2', 'pc_twin_a')).toBe(true);
    });

    it('lets a customer hold a once-per-customer promotion for only one of two racing orders', async () => {
      const s = await store();
      const promotion = { id: 'pc_promo_once_each', maxRedemptions: null, perCustomerLimit: 1 };
      const redeem = (orderId: string, customerId?: string) =>
        s.redeem({ promotion, orderId, customerId, amount: 1, stepKey: `${orderId}:discount#0` });

      const raced = await Promise.all([
        redeem('pc_race_1', 'pc_northwind'),
        redeem('pc_race_2', 'pc_northwind'),
      ]);
      expect(raced.filter(Boolean)).toHaveLength(1);
      // Exactly one row is left, and a retry of the winner still holds it.
      expect(await s.redemptionsOf('pc_promo_once_each', 'pc_none', 'pc_northwind')).toEqual({
        total: 1,
        byCustomer: 1,
      });
      const winner = raced[0] ? 'pc_race_1' : 'pc_race_2';
      expect(await redeem(winner, 'pc_northwind')).toBe(true);
      // Another customer, and a guest, are not held to it.
      expect(await redeem('pc_race_3', 'pc_twin_a')).toBe(true);
      expect(await redeem('pc_race_4')).toBe(true);
      // Giving the winner's back lets the customer have it again.
      await s.releaseRedemptions(winner);
      expect(await redeem(winner === 'pc_race_1' ? 'pc_race_2' : 'pc_race_1', 'pc_northwind')).toBe(
        true,
      );
    });

    it('converts from the base currency, and knows no rate it was not given', async () => {
      const s = await store();
      expect(await s.fxRate('USD')).toBe(1);
      expect(await s.fxRate('EUR')).toBe(0.92);
      expect(await s.fxRate('XTS')).toBeNull();
    });

    it('sets and adds rates, never the base currency, and prices with them at once', async () => {
      const s = await store();
      expect(
        await s.setFxRates(
          [
            { currency: 'EUR', rate: 0.9312 },
            { currency: 'GBP', rate: 0.781 },
            { currency: 'USD', rate: 2 },
            { currency: 'XTS', rate: 0 },
          ],
          1_000,
          'ecb',
        ),
      ).toBe(2);
      expect(await s.fxRate('EUR')).toBe(0.9312);
      expect(await s.fxRate('GBP')).toBe(0.781);
      expect(await s.fxRate('USD')).toBe(1);
      expect(await s.fxRate('XTS')).toBeNull();
      expect((await s.priceInputs([], 'GBP', undefined, false, 0)).fxRate).toBe(0.781);
      expect(await s.setFxRates([], 2_000, 'ecb')).toBe(0);
      expect(
        await s.setFxRates([{ currency: 'CHF', rate: Number.POSITIVE_INFINITY }], 2_000, 'ecb'),
      ).toBe(0);
      expect(await s.fxRate('CHF')).toBeNull();
    });

    it('records who set each rate and when, the base currency never among them', async () => {
      const s = await store();
      await s.setFxRates([{ currency: 'EUR', rate: 0.9 }], 4_000, 'ecb');
      await s.setFxRates([{ currency: 'GBP', rate: 0.8 }], 5_000, 'person', 'ada@example.com');
      const rows = await s.fxRateRows();
      expect(rows.map((r) => r.currency)).not.toContain('USD');
      expect(rows.find((r) => r.currency === 'EUR')).toEqual({
        currency: 'EUR',
        rate: 0.9,
        updatedAt: 4_000,
        source: 'ecb',
        updatedBy: null,
      });
      expect(rows.find((r) => r.currency === 'GBP')).toEqual({
        currency: 'GBP',
        rate: 0.8,
        updatedAt: 5_000,
        source: 'person',
        updatedBy: 'ada@example.com',
      });
      // A later write by the feed takes the person's name off the rate.
      await s.setFxRates([{ currency: 'GBP', rate: 0.79 }], 6_000, 'ecb');
      expect((await s.fxRateRows()).find((r) => r.currency === 'GBP')).toMatchObject({
        rate: 0.79,
        source: 'ecb',
        updatedBy: null,
      });
    });

    it('writes more rates than one statement can bind, all together', async () => {
      const s = await store();
      // 40 currencies at three parameters each is past D1's 100 bound parameters a statement.
      const many = Array.from({ length: 40 }, (_, i) => ({
        currency: `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
        rate: i + 1,
      }));
      expect(await s.setFxRates(many, 3_000, 'ecb')).toBe(40);
      expect(await s.fxRate('QAA')).toBe(1);
      expect(await s.fxRate('QBN')).toBe(40);
    });

    it('reads what pricing an order needs together, as the separate reads answer', async () => {
      const s = await store();
      const skus = ['PC-SKU-1', 'PC-SKU-2', 'PC-NONE', 'PC-SKU-1'];
      const byId = (xs: { sku: string }[]) => [...xs].sort((a, b) => a.sku.localeCompare(b.sku));
      for (const [currency, customerId] of [
        ['EUR', 'pc_northwind'],
        ['USD', undefined],
        ['XTS', 'pc_northwind'],
      ] as const) {
        const together = await s.priceInputs(skus, currency, customerId, true, 0);
        expect(byId(together.products)).toEqual(byId(await s.products(skus)));
        expect(together.fxRate).toBe(await s.fxRate(currency));
        expect(together.chain).toEqual(await s.pricingFor(customerId, 0, skus));
      }
      expect((await s.priceInputs(skus, 'USD', 'pc_northwind', false, 0)).chain).toBeNull();
    });

    it('adds a promotion once per code, active, and pauses and reactivates it', async () => {
      const s = await store();
      const promo = {
        id: 'pc_promo_new',
        code: 'PC-NEW10',
        name: 'Ten off',
        kind: 'pct' as const,
        value: 10,
        minSubtotal: null,
        skus: ['PC-SKU-1'],
        customerId: null,
        validTo: null,
        maxRedemptions: 5,
        perCustomerLimit: null,
        priority: 3,
        stacking: 'stackable' as const,
        maxDiscount: 25,
        condition: null,
        conditionMessage: null,
        bxgy: null,
      };
      expect(await s.createPromotion(promo, 'usr_ada')).toBe(true);
      expect(await s.createPromotion({ ...promo, id: 'pc_promo_dup' }, 'usr_ada')).toBe(false);
      expect(await s.promotion('pc_promo_new')).toMatchObject({
        code: 'PC-NEW10',
        skus: ['PC-SKU-1'],
        status: 'active',
        maxRedemptions: 5,
        priority: 3,
        stacking: 'stackable',
        maxDiscount: 25,
      });
      expect(await s.promotion('pc_promo_dup')).toBeUndefined();
      const listed = (await s.listPromotions()).filter((p) => p.id.startsWith('pc_'));
      expect(listed[0]).toMatchObject({ id: 'pc_promo_new', redeemed: 0 });
      await s.setPromotionStatus('pc_promo_new', 'paused');
      expect((await s.promotionsByCode(['PC-NEW10']))[0]?.status).toBe('paused');
    });

    it('keeps a promotion’s condition and its message, as written', async () => {
      const s = await store();
      const condition = {
        and: [
          { '==': [{ var: 'order.meta.shipTo.country' }, 'US'] },
          { some: [{ var: 'order.lines' }, { '>=': [{ var: 'qty' }, 3] }] },
        ],
      };
      const promo = {
        id: 'pc_promo_cond',
        code: 'PC-COND',
        name: 'US bulk',
        kind: 'pct' as const,
        value: 5,
        minSubtotal: null,
        skus: null,
        customerId: null,
        validTo: null,
        maxRedemptions: null,
        perCustomerLimit: null,
        priority: 0,
        stacking: 'exclusive' as const,
        maxDiscount: null,
        condition,
        conditionMessage: 'US orders with 3 or more of a SKU only.',
        bxgy: null,
      };
      expect(await s.createPromotion(promo, 'usr_ada')).toBe(true);
      const expected = { condition, conditionMessage: promo.conditionMessage };
      expect(await s.promotion('pc_promo_cond')).toMatchObject(expected);
      expect((await s.promotionsByCode(['PC-COND']))[0]).toMatchObject(expected);
      expect((await s.listPromotions()).find((p) => p.id === 'pc_promo_cond')).toMatchObject(
        expected,
      );
      // Without one, both read back null, not an empty expression.
      expect(await s.promotion('pc_promo_last')).toMatchObject({
        condition: null,
        conditionMessage: null,
        bxgy: null,
      });
    });

    it('keeps a buy X, get Y rule whole, with every default it was given', async () => {
      const s = await store();
      const rule = {
        buy: { skus: ['PC-SKU-1'], qty: 2 },
        get: { skus: null, qty: 1, percent: 100 },
        repeat: null,
      };
      const promo = {
        id: 'pc_promo_bxgy',
        code: null,
        name: 'Buy 2, get 1',
        kind: 'bxgy' as const,
        value: 0,
        minSubtotal: null,
        skus: null,
        customerId: null,
        validTo: null,
        maxRedemptions: null,
        perCustomerLimit: null,
        priority: 0,
        stacking: 'stackable' as const,
        maxDiscount: 10,
        condition: null,
        conditionMessage: null,
        bxgy: rule,
      };
      expect(await s.createPromotion(promo, 'usr_ada')).toBe(true);
      expect(await s.promotion('pc_promo_bxgy')).toMatchObject({ kind: 'bxgy', bxgy: rule });
      expect((await s.listPromotions()).find((p) => p.id === 'pc_promo_bxgy')?.bxgy).toEqual(rule);
      // Automatic, so the discount node reads it with the others.
      expect(
        (await s.automaticPromotions(2_000)).find((p) => p.id === 'pc_promo_bxgy')?.bxgy,
      ).toEqual(rule);
    });

    it('adds any number of automatic promotions, which have no code to clash', async () => {
      const s = await store();
      const auto = {
        id: 'pc_promo_auto_a',
        code: null,
        name: 'Ten off orders',
        kind: 'pct' as const,
        value: 10,
        minSubtotal: null,
        skus: null,
        customerId: null,
        validTo: null,
        maxRedemptions: 100,
        perCustomerLimit: null,
        priority: 0,
        stacking: 'exclusive' as const,
        maxDiscount: null,
        condition: null,
        conditionMessage: null,
        bxgy: null,
      };
      expect(await s.createPromotion(auto, 'usr_ada')).toBe(true);
      expect(await s.createPromotion({ ...auto, id: 'pc_promo_auto_b' }, 'usr_ada')).toBe(true);
      // The same id is still a clash.
      expect(await s.createPromotion(auto, 'usr_ada')).toBe(false);
      const ours = (await s.automaticPromotions(2_000)).filter((p) => /_auto_[ab]$/.test(p.id));
      expect(ours.map((p) => p.id).sort()).toEqual(['pc_promo_auto_a', 'pc_promo_auto_b']);
      expect(ours[0]).toMatchObject({ code: null, maxRedemptions: 100 });
    });

    it("builds a customer's price chain: active sources, rules, their contract prices, their tier", async () => {
      const s = await store();
      const chain = await s.pricingFor('pc_northwind', 0);
      expect(chain.sources.map((x) => x.id).sort()).toEqual(['contract', 'price_book', 'quote']);
      expect(chain.tier).toBe('gold');
      const mine = chain.rules.filter(
        (r) => r.id.startsWith('pc_') || r.id.startsWith('contract_pc_'),
      );
      expect(mine.map((r) => r.id).sort()).toEqual([
        'contract_pc_northwind_PC-SKU-2',
        'pc_rule_gold',
      ]);
      expect(mine.find((r) => r.source === 'contract')).toMatchObject({
        sku: 'PC-SKU-2',
        price: 20,
      });

      const anonymous = await s.pricingFor(undefined, 0);
      expect(anonymous.tier).toBeNull();
      expect(anonymous.rules.some((r) => r.source === 'contract')).toBe(false);
    });
  });
}
