import { env } from 'cloudflare:workers';
import {
  b2bOrderFlow,
  type Order,
  omnichannelOrderFlow,
  type RunContext,
  storefrontOrderFlow,
  withDefaults,
} from '@commerceworker/core';
import { createDb, promotionRedemptions, promotions } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXECUTORS, ROLLBACKS } from '../src/nodes';

const db = () => createDb(env.DB);
const now = Date.now();

const order = (o: Partial<Order> = {}): Order => ({
  id: `ord_promo_${crypto.randomUUID().slice(0, 8)}`,
  model: 'b2c',
  channel: 'web',
  currency: 'USD',
  customerId: 'cus_northwind',
  lines: [
    { sku: 'WID-100', qty: 2, unitPrice: 50 },
    { sku: 'GSK-010', qty: 1, unitPrice: 100 },
  ],
  meta: { promoCodes: ['save10'] },
  createdAt: now,
  subtotal: 200,
  shipping: 15,
  tax: 0,
  total: 215,
  fxRate: 1,
  ...o,
});

const node = {
  id: 'promo',
  type: 'commerce.discount',
  label: 'Promotions',
  config: {},
  position: { x: 0, y: 0 },
};
async function discount(o: Order, extra = {}) {
  const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now, ref: o.id };
  return EXECUTORS['commerce.discount']!({
    env,
    node,
    config: withDefaults('commerce.discount', {}),
    ctx,
    stepKey: 'promo#1',
    ...extra,
  });
}

async function addPromotion(
  p: Partial<typeof promotions.$inferInsert> & { code: string | null; name?: string },
) {
  await db()
    .insert(promotions)
    .values({
      id: `promo_${p.code ?? p.name}`,
      kind: 'pct',
      value: 10,
      createdAt: now,
      updatedAt: now,
      ...p,
    })
    .onConflictDoNothing();
}

const redemptions = (code: string) =>
  db()
    .select()
    .from(promotionRedemptions)
    .where(eq(promotionRedemptions.promotionId, `promo_${code}`))
    .all();

beforeEach(async () => {
  await db().delete(promotionRedemptions);
  await db().delete(promotions);
});

describe('commerce.discount', () => {
  it('applies a code to the lines and records one redemption per order', async () => {
    await addPromotion({ code: 'SAVE10' });
    const o = order();
    const r = await discount(o);
    expect(r.order?.lines?.map((l) => l.unitPrice)).toEqual([45, 90]);
    expect(r.order).toMatchObject({ subtotal: 180, shipping: 15, total: 195 });
    expect(r.summary).toBe('SAVE10 · $20.00 off');
    // A retried step holds the same redemption.
    await discount(o);
    expect(await redemptions('SAVE10')).toEqual([
      expect.objectContaining({
        orderId: o.id,
        customerId: 'cus_northwind',
        amount: 20,
        stepKey: 'promo#1',
      }),
    ]);
  });

  it('never redeems when pricing a quote', async () => {
    await addPromotion({ code: 'SAVE10' });
    const r = await discount(order(), { dryRun: true });
    expect(r.order?.subtotal).toBe(180);
    expect(await redemptions('SAVE10')).toEqual([]);
  });

  // The refusals come in the order the codes were given, so their order shows nothing about which
  // codes exist.
  it('refuses a code that is unknown, expired or used up, and leaves the order as it was', async () => {
    await addPromotion({ code: 'OLD', validTo: now - 1 });
    await addPromotion({ code: 'ONCE', maxRedemptions: 1 });
    const first = await discount(order({ meta: { promoCodes: ['ONCE'] } }));
    expect(first.summary).toMatch(/ONCE/);
    const second = await discount(order({ meta: { promoCodes: ['ONCE', 'OLD', 'NOPE'] } }));
    expect(second.order?.subtotal).toBe(200);
    expect(
      (second.output as { refused: { reason: string }[] }).refused.map((r) => r.reason),
    ).toEqual(['ONCE has been used up.', 'OLD has expired.', "NOPE isn't a promotion."]);
    expect(await redemptions('ONCE')).toHaveLength(1);
  });

  it('applies only the best code unless the promotions stack themselves', async () => {
    await addPromotion({ code: 'SHIP', kind: 'free_shipping', value: 0 });
    await addPromotion({ code: 'SAVE10' });
    const codes = { meta: { promoCodes: ['SHIP', 'SAVE10'] } };
    // Exclusive by default: the code worth the most is applied, and the other is told why.
    const best = await discount(order(codes));
    const out = best.output as { applied: { code: string }[]; refused: unknown[] };
    expect(out.applied.map((a) => a.code)).toEqual(['SAVE10']);
    expect(out.refused).toEqual([{ code: 'SHIP', reason: "SHIP isn't combined with SAVE10." }]);

    await db().update(promotions).set({ stacking: 'stackable' });
    const both = await discount(order(codes));
    expect(both.order).toMatchObject({ subtotal: 180, shipping: 0, total: 180 });
  });

  it('applies an automatic promotion with no code, and an order carrying none', async () => {
    await addPromotion({ code: null, name: 'Spring sale', value: 10 });
    const r = await discount(order({ meta: {} }));
    expect(r.order).toMatchObject({ subtotal: 180, total: 195 });
    expect(r.summary).toBe('Spring sale · $20.00 off');
    expect((await redemptions('Spring sale'))[0]).toMatchObject({ amount: 20 });
    // Paused, it applies to nothing and nothing is said about it.
    await db().update(promotions).set({ status: 'paused' });
    const paused = await discount(order({ meta: {} }));
    expect(paused.order).toBeUndefined();
    expect(paused.summary).toBe('No promotions');
  });

  it('combines stackable promotions by priority and caps each', async () => {
    await addPromotion({
      code: null,
      name: 'Sitewide',
      value: 50,
      maxDiscount: 20,
      stacking: 'stackable',
      priority: 9,
    });
    await addPromotion({ code: 'SAVE10', stacking: 'stackable' });
    const r = await discount(order());
    const out = r.output as { applied: { name: string; code: string | null; amount: number }[] };
    // The 50% is capped at 20, then SAVE10 takes 10% of the 180 left.
    expect(out.applied.map((a) => [a.code, a.amount])).toEqual([
      [null, 20],
      ['SAVE10', 18],
    ]);
    expect(r.order?.subtotal).toBe(162);
  });

  it('lets an exclusive automatic promotion beat a code and names it in the refusal', async () => {
    await addPromotion({ code: null, name: 'Sitewide', value: 30 });
    await addPromotion({ code: 'SAVE10' });
    const r = await discount(order());
    expect((r.output as { refused: unknown[] }).refused).toEqual([
      { code: 'SAVE10', reason: "SAVE10 isn't combined with Sitewide." },
    ]);
    expect(await redemptions('SAVE10')).toEqual([]);
  });

  it('gives redemptions back when the order rolls back', async () => {
    await addPromotion({ code: 'SAVE10' });
    const o = order();
    await discount(o);
    expect(await ROLLBACKS['commerce.discount']!(env, o.id, undefined, 'promo#1')).toBe(
      'Gave back 1 promotion redemption',
    );
    expect(await ROLLBACKS['commerce.discount']!(env, o.id, undefined, 'promo#1')).toBe(
      'No promotions to give back',
    );
  });

  it('gives back an automatic promotion’s redemption too', async () => {
    await addPromotion({ code: null, name: 'Spring sale', maxRedemptions: 1 });
    const o = order({ meta: {} });
    await discount(o);
    // Used up for the next order until this one rolls back.
    expect((await discount(order({ meta: {} }))).order?.subtotal).toBe(200);
    await ROLLBACKS['commerce.discount']!(env, o.id, undefined, 'promo#1');
    expect((await discount(order({ meta: {} }))).order?.subtotal).toBe(180);
  });
});

describe('commerce.tax by region', () => {
  it('uses the ship-to region’s rate, else the node’s', async () => {
    const tax = async (shipTo: Record<string, string>) => {
      const o = order({ meta: { shipTo } });
      const ctx: RunContext = { order: o, nodes: {}, vars: {}, input: {}, now, ref: o.id };
      const r = await EXECUTORS['commerce.tax']!({
        env,
        node: {
          id: 'tax',
          type: 'commerce.tax',
          label: 'Tax',
          config: {},
          position: { x: 0, y: 0 },
        },
        config: withDefaults('commerce.tax', {
          rate: 0.1,
          includeShipping: false,
          regions: [
            { country: 'US', region: 'CA', rate: 0.05 },
            { country: 'US', rate: 0.07 },
          ],
        }),
        ctx,
        stepKey: 'tax#1',
      });
      return r.order?.tax;
    };
    const addr = { line1: '1 Main St', city: 'Town', postalCode: '94607' };
    expect(await tax({ ...addr, region: 'CA', country: 'US' })).toBe(10);
    expect(await tax({ ...addr, region: 'NY', country: 'US' })).toBe(14);
    expect(await tax({ ...addr, country: 'DE' })).toBe(20);
  });
});

// The built-in flows that take codes run it in their checkout quote, so a quote is discounted too.
it('is a pricing node the checkout quote runs', async () => {
  const { quoteNodes } = await import('@commerceworker/core');
  for (const flow of [b2bOrderFlow(), storefrontOrderFlow(), omnichannelOrderFlow()])
    expect([flow.id, quoteNodes(flow).map((n) => n.type)]).toEqual([
      flow.id,
      expect.arrayContaining(['commerce.discount']),
    ]);
});

describe('through the assistant', () => {
  const ops = {
    kind: 'user' as const,
    id: 'usr_promo_ops',
    name: 'Ops',
    email: 'ops@example.com',
    role: 'operator' as const,
  };
  const viewer = { ...ops, id: 'usr_promo_viewer', role: 'viewer' as const };

  it('adds, pauses and resumes a code on cards that say what it does', async () => {
    await db().delete(promotions);
    const { TOOL_INPUTS } = await import('@commerceworker/core');
    const { previewAction, runAction } = await import('../src/assistant/data');
    // The code is read as a cart reads it.
    const input = TOOL_INPUTS.create_promotion.parse({
      code: ' spring10 ',
      kind: 'pct',
      value: 10,
    });
    expect(input.code).toBe('SPRING10');
    expect(() =>
      TOOL_INPUTS.create_promotion.parse({ code: 'no spaces', kind: 'pct', value: 1 }),
    ).toThrow();

    const many = TOOL_INPUTS.create_promotion.parse({
      code: 'WIDE',
      kind: 'pct',
      value: 5,
      skus: Array.from({ length: 10 }, (_, i) => `SKU-${i}`),
    });
    expect((await previewAction(env, ops, 'create_promotion', many)).consequences).toContain(
      'Only on 10 SKUs: “SKU-0”, “SKU-1”, “SKU-2”, “SKU-3”, “SKU-4”, “SKU-5” and 4 more',
    );
    const card = await previewAction(env, ops, 'create_promotion', input);
    expect(card.consequences).toEqual(
      expect.arrayContaining(['10% off', 'For any buyer', 'No end date']),
    );
    expect((await previewAction(env, viewer, 'create_promotion', input)).blocked).toBe(
      'This needs the Operator role.',
    );
    expect(
      (await previewAction(env, ops, 'create_promotion', { ...input, value: 150 })).blocked,
    ).toBe('A percentage is above 0 and at most 100.');
    const made = (await runAction(env, ops, 'create_promotion', input, 'assistant')) as {
      id: string;
    };
    expect((await previewAction(env, ops, 'create_promotion', input)).blocked).toBe(
      'SPRING10 already exists.',
    );

    const pause = { promotionId: made.id, status: 'paused' as const };
    expect((await previewAction(env, ops, 'set_promotion_status', pause)).title).toBe(
      'Pause SPRING10',
    );
    await runAction(env, ops, 'set_promotion_status', pause, 'assistant');
    const row = await db().select().from(promotions).where(eq(promotions.id, made.id)).get();
    expect(row?.status).toBe('paused');
    expect((await previewAction(env, ops, 'set_promotion_status', pause)).blocked).toBe(
      'SPRING10 is already paused.',
    );
  });

  it('adds an automatic promotion that needs a name, on a card that says how it combines', async () => {
    await db().delete(promotions);
    const { TOOL_INPUTS } = await import('@commerceworker/core');
    const { previewAction, runAction } = await import('../src/assistant/data');
    // Without a code it needs a name.
    expect(() => TOOL_INPUTS.create_promotion.parse({ kind: 'pct', value: 5 })).toThrow();
    const input = TOOL_INPUTS.create_promotion.parse({
      name: 'Spring sale',
      kind: 'pct',
      value: 15,
      priority: 5,
      stacking: 'stackable',
      maxDiscount: 40,
    });
    const card = await previewAction(env, ops, 'create_promotion', input);
    expect(card.title).toBe('Add the automatic promotion “Spring sale”');
    expect(card.consequences).toEqual(
      expect.arrayContaining([
        '15% off',
        'Takes off at most $40.00 from one order',
        'Combines with other stackable promotions · priority 5',
        'Active at once: it applies to every order it fits, with no code to enter',
      ]),
    );
    const made = (await runAction(env, ops, 'create_promotion', input, 'assistant')) as {
      id: string;
    };
    const row = await db().select().from(promotions).where(eq(promotions.id, made.id)).get();
    expect(row).toMatchObject({
      code: null,
      stacking: 'stackable',
      priority: 5,
      maxDiscount: 40,
    });
    // A second one is no clash: automatic promotions have no code to repeat.
    expect((await previewAction(env, ops, 'create_promotion', input)).blocked).toBeUndefined();
    const pause = { promotionId: made.id, status: 'paused' as const };
    expect((await previewAction(env, ops, 'set_promotion_status', pause)).title).toBe(
      'Pause Spring sale',
    );
  });
});
