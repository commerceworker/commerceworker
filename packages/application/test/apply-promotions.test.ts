import type { Order, Promotion } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryCompanyDirectory,
  InMemoryPricingStore,
  PRICING_FIXTURE,
} from '@commerceworker/test-kit/commerce';
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
  condition: null,
  conditionMessage: null,
  bxgy: null,
  ...over,
});
const storeWith = (...promotions: Promotion[]) =>
  new InMemoryPricingStore({ ...PRICING_FIXTURE, promotions }, new FixedClock());
const order = (promoCodes: unknown, id = 'ord_promo', meta: object = {}): Order =>
  ({
    id,
    createdAt: now,
    channel: 'web',
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
    meta: { promoCodes, ...meta },
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

  it('gives a customer’s once-only code to one of two orders racing for it', async () => {
    const pricing = storeWith(promo({ id: 'p_once', code: 'ONCE', perCustomerLimit: 1 }));
    // Both read no redemptions yet and pass the check: the redeem decides, and declines the loser
    // with the per-customer reason, leaving its order undiscounted.
    const [a, b] = await Promise.all([
      applyPromotions({ pricing }, order(['ONCE'], 'ord_a'), opts),
      applyPromotions({ pricing }, order(['ONCE'], 'ord_b'), opts),
    ]);
    expect([a.applied.length, b.applied.length].sort()).toEqual([0, 1]);
    const lost = a.applied.length ? b : a;
    expect(lost.refused).toEqual([
      { code: 'ONCE', reason: 'ONCE has already been used by this customer.' },
    ]);
    expect(lost.order?.subtotal).toBe(45);
    expect(await pricing.redemptionsOf('p_once', 'ord_none', 'pc_northwind')).toEqual({
      total: 1,
      byCustomer: 1,
    });
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

  describe('with a condition', () => {
    const us = { '==': [{ var: 'order.meta.shipTo.country' }, 'US'] };
    const shipTo = (country: string) => ({
      shipTo: { line1: '1 Main St', city: 'Austin', postalCode: '78701', country },
    });

    it('refuses a code whose condition fails, in the merchant’s words or the default', async () => {
      const pricing = storeWith(
        promo({ id: 'a', code: 'USONLY', condition: us, conditionMessage: 'Only for US orders.' }),
        promo({ id: 'b', code: 'PLAIN', condition: us }),
      );
      const r = await applyPromotions(
        { pricing },
        order(['usonly', 'plain'], 'ord_promo', shipTo('DE')),
        opts,
      );
      expect(r.applied).toEqual([]);
      expect(r.refused).toEqual([
        { code: 'USONLY', reason: 'Only for US orders.' },
        { code: 'PLAIN', reason: "This order doesn't qualify for PLAIN." },
      ]);
      // Nothing was held for a refused code.
      expect(r.order?.subtotal).toBe(45);
    });

    it('applies the same codes once the order meets the condition', async () => {
      const pricing = storeWith(promo({ id: 'a', code: 'USONLY', condition: us }));
      const r = await applyPromotions(
        { pricing },
        order(['usonly'], 'ord_promo', shipTo('USA')),
        opts,
      );
      expect(r.applied.map((a) => a.code)).toEqual(['USONLY']);
      expect(r.refused).toEqual([]);
    });

    it('drops an automatic promotion whose condition fails, with nothing refused', async () => {
      const pricing = storeWith(promo({ id: 'auto', name: 'US sale', condition: us }));
      const dropped = await applyPromotions(
        { pricing },
        order(undefined, 'o1', shipTo('DE')),
        opts,
      );
      expect(dropped.applied).toEqual([]);
      expect(dropped.refused).toEqual([]);
      // No ship-to at all reads as null, not as a match.
      expect((await applyPromotions({ pricing }, order(undefined, 'o2'), opts)).applied).toEqual(
        [],
      );
      const met = await applyPromotions({ pricing }, order(undefined, 'o3', shipTo('US')), opts);
      expect(met.applied.map((a) => a.name)).toEqual(['US sale']);
    });

    it('asks about the buyer: their tier, and a guest has none', async () => {
      const gold = { '==': [{ var: 'customer.tier' }, 'gold'] };
      const pricing = storeWith(promo({ id: 'g', code: 'GOLD', condition: gold }));
      expect(
        (await applyPromotions({ pricing }, order(['gold']), opts)).applied.map((a) => a.code),
      ).toEqual(['GOLD']);
      const guest = { ...order(['gold'], 'ord_guest'), customerId: undefined } as Order;
      expect((await applyPromotions({ pricing }, guest, opts)).refused).toEqual([
        { code: 'GOLD', reason: "This order doesn't qualify for GOLD." },
      ]);
    });

    it('asks about the buyer’s company and the member who ordered', async () => {
      const companies = new InMemoryCompanyDirectory({
        customers: [{ ...PRICING_FIXTURE.customers![0]!, id: 'pc_northwind', tier: 'gold' }],
        companies: [
          {
            customerId: 'pc_northwind',
            status: 'active',
            legalName: 'Northwind',
            taxId: null,
            parentCompanyId: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        members: [
          {
            id: 'mem_ann',
            companyId: 'pc_northwind',
            name: 'Ann',
            email: 'ann@northwind.test',
            role: 'approver',
            teamId: 'team_ops',
            status: 'active',
            orderLimit: 1000,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      });
      const pricing = storeWith(
        promo({
          id: 'appr',
          code: 'APPROVER',
          condition: {
            and: [
              { '==': [{ var: 'company.status' }, 'active'] },
              { '==': [{ var: 'company.tier' }, 'gold'] },
              { '==': [{ var: 'buyer.role' }, 'approver'] },
              { '==': [{ var: 'buyer.team' }, 'team_ops'] },
              { '<=': [{ var: 'buyer.orderLimit' }, 1000] },
            ],
          },
        }),
      );
      const ports = { pricing, companies };
      const asAnn = order(['approver'], 'ord_ann', { buyerId: 'mem_ann' });
      expect((await applyPromotions(ports, asAnn, opts)).applied.map((a) => a.code)).toEqual([
        'APPROVER',
      ]);
      // No buyer named: `buyer.*` is null, and null is not 'approver'.
      expect((await applyPromotions(ports, order(['approver']), opts)).refused).toHaveLength(1);
      // Without the directory every `company.*` and `buyer.*` is null: fails closed.
      expect((await applyPromotions({ pricing }, asAnn, opts)).refused).toHaveLength(1);
    });

    it('lets a condition choose among stackable promotions by what is in the order', async () => {
      const pricing = storeWith(
        promo({
          id: 'sku2',
          name: 'Two or more of SKU 1',
          stacking: 'stackable',
          condition: {
            some: [
              { var: 'order.lines' },
              { and: [{ '==': [{ var: 'sku' }, 'PC-SKU-1'] }, { '>=': [{ var: 'qty' }, 2] }] },
            ],
          },
        }),
        promo({
          id: 'sku3',
          name: 'Three or more of SKU 1',
          stacking: 'stackable',
          condition: {
            some: [
              { var: 'order.lines' },
              { and: [{ '==': [{ var: 'sku' }, 'PC-SKU-1'] }, { '>=': [{ var: 'qty' }, 3] }] },
            ],
          },
        }),
      );
      const r = await applyPromotions({ pricing }, order(undefined), opts);
      expect(r.applied.map((a) => a.id)).toEqual(['sku2']);
    });
  });
});

describe('buy X, get Y on an order', () => {
  const bxgy = (over: Partial<Promotion> & { id: string }, rule: Promotion['bxgy']) =>
    promo({ kind: 'bxgy', value: 0, bxgy: rule, ...over });
  const twoGetOne = {
    buy: { skus: ['PC-SKU-1'], qty: 2 },
    get: { skus: ['PC-SKU-2'], qty: 1, percent: 100 },
    repeat: null,
  };

  it('puts the discount on the line that holds the units, and re-totals from it', async () => {
    const pricing = storeWith(bxgy({ id: 'bx', code: 'TWOFORONE' }, twoGetOne));
    const r = await applyPromotions({ pricing }, order(['twoforone']), opts);
    expect(r.applied).toEqual([
      { id: 'bx', code: 'TWOFORONE', name: '', kind: 'bxgy', amount: 25 },
    ]);
    expect(r.order?.lines).toEqual([
      { sku: 'PC-SKU-1', qty: 2, unitPrice: 10 },
      { sku: 'PC-SKU-2', qty: 1, unitPrice: 0 },
    ]);
    expect(r.order?.subtotal).toBe(20);
    expect(r.order?.total).toBe(25);
  });

  it('refuses a code the order is too small for, saying what it needs', async () => {
    const pricing = storeWith(
      bxgy({ id: 'bx', code: 'BIG' }, { ...twoGetOne, buy: { skus: ['PC-SKU-1'], qty: 3 } }),
    );
    const r = await applyPromotions({ pricing }, order(['big']), opts);
    expect(r.applied).toEqual([]);
    expect(r.refused).toEqual([
      { code: 'BIG', reason: 'BIG needs 3 PC-SKU-1 and 1 PC-SKU-2 in the order.' },
    ]);
    expect(r.order?.subtotal).toBe(45);
  });

  it('applies an automatic one only when the order fits, and nothing is refused', async () => {
    const pricing = storeWith(
      bxgy(
        { id: 'auto', name: 'Any three' },
        { buy: { skus: null, qty: 2 }, get: { skus: null, qty: 1, percent: 50 }, repeat: 1 },
      ),
    );
    // Three units: the cheapest, a SKU 1 at 10, half off.
    const fits = await applyPromotions({ pricing }, order(undefined), opts);
    expect(fits.applied.map((a) => [a.name, a.amount])).toEqual([['Any three', 5]]);
    expect(fits.order?.subtotal).toBe(40);
    const small = {
      ...order(undefined, 'o2'),
      lines: [{ sku: 'PC-SKU-2', qty: 2, unitPrice: 25 }],
    };
    const none = await applyPromotions({ pricing }, small as Order, opts);
    expect(none).toMatchObject({ applied: [], refused: [] });
  });

  it('holds its redemption once, like any promotion: a retry keeps it, a second order loses it', async () => {
    const pricing = storeWith(bxgy({ id: 'bx', code: 'ONCE', maxRedemptions: 1 }, twoGetOne));
    await applyPromotions({ pricing }, order(['once']), opts);
    expect((await applyPromotions({ pricing }, order(['once']), opts)).applied).toHaveLength(1);
    const other = await applyPromotions({ pricing }, order(['once'], 'ord_other'), opts);
    expect(other.applied).toEqual([]);
    expect(other.refused).toEqual([{ code: 'ONCE', reason: 'ONCE has been used up.' }]);
  });

  it('stacks on a percentage off that came before it', async () => {
    const pricing = storeWith(
      promo({ id: 'pct', code: 'TEN', value: 10, stacking: 'stackable', priority: 1 }),
      bxgy({ id: 'bx', code: 'FREE', stacking: 'stackable' }, twoGetOne),
    );
    const r = await applyPromotions({ pricing }, order(['ten', 'free']), opts);
    expect(r.applied.map((a) => a.code)).toEqual(['TEN', 'FREE']);
    // 10% off 45 is 4.50, then the SKU 2 unit, now 22.50, is free.
    expect(r.applied.map((a) => a.amount)).toEqual([4.5, 22.5]);
    expect(r.order?.subtotal).toBe(18);
  });

  it('judges its condition like any promotion’s, with its own message', async () => {
    const pricing = storeWith(
      bxgy(
        {
          id: 'bx',
          code: 'EUONLY',
          condition: { '==': [{ var: 'order.currency' }, 'EUR'] },
          conditionMessage: 'Euro orders only.',
        },
        twoGetOne,
      ),
    );
    const r = await applyPromotions({ pricing }, order(['euonly']), opts);
    expect(r.refused).toEqual([{ code: 'EUONLY', reason: 'Euro orders only.' }]);
  });
});
