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
    },
  ],
  fxRates: [{ currency: 'EUR', rate: 0.92 }],
  priceSources: [
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
    });

    it('lets one order hold the last redemption, idempotently, until it gives it back', async () => {
      const s = await store();
      const promotion = { id: 'pc_promo_last', maxRedemptions: 1 };
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

    it('converts from the base currency, and knows no rate it was not given', async () => {
      const s = await store();
      expect(await s.fxRate('USD')).toBe(1);
      expect(await s.fxRate('EUR')).toBe(0.92);
      expect(await s.fxRate('XTS')).toBeNull();
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
        const together = await s.priceInputs(skus, currency, customerId, true);
        expect(byId(together.products)).toEqual(byId(await s.products(skus)));
        expect(together.fxRate).toBe(await s.fxRate(currency));
        expect(together.chain).toEqual(await s.pricingFor(customerId));
      }
      expect((await s.priceInputs(skus, 'USD', 'pc_northwind', false)).chain).toBeNull();
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
      };
      expect(await s.createPromotion(promo, 'usr_ada')).toBe(true);
      expect(await s.createPromotion({ ...promo, id: 'pc_promo_dup' }, 'usr_ada')).toBe(false);
      expect(await s.promotion('pc_promo_new')).toMatchObject({
        code: 'PC-NEW10',
        skus: ['PC-SKU-1'],
        status: 'active',
        maxRedemptions: 5,
      });
      expect(await s.promotion('pc_promo_dup')).toBeUndefined();
      const listed = (await s.listPromotions()).filter((p) => p.id.startsWith('pc_'));
      expect(listed[0]).toMatchObject({ id: 'pc_promo_new', redeemed: 0 });
      await s.setPromotionStatus('pc_promo_new', 'paused');
      expect((await s.promotionsByCode(['PC-NEW10']))[0]?.status).toBe('paused');
    });

    it("builds a customer's price chain: active sources, rules, their contract prices, their tier", async () => {
      const s = await store();
      const chain = await s.pricingFor('pc_northwind');
      expect(chain.sources.map((x) => x.id).sort()).toEqual(['contract', 'price_book']);
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

      const anonymous = await s.pricingFor(undefined);
      expect(anonymous.tier).toBeNull();
      expect(anonymous.rules.some((r) => r.source === 'contract')).toBe(false);
    });
  });
}
