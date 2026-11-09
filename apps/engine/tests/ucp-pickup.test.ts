import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { type OrderState, type PlatformCaller, UCP_SETTINGS_KEY } from '@commerceworker/core';
import { locationStock, products, workspaceSettings } from '@commerceworker/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureTemplates } from '../src/flows';
import { db, key, pay, platform, ucp, until } from './ucp-helpers';

// Pickup needs a checkout flow with a pickup path: the omnichannel template, not the storefront's.
let alpha: PlatformCaller;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeAll(async () => {
  await ensureTemplates(env);
  await db()
    .insert(workspaceSettings)
    .values({
      key: UCP_SETTINGS_KEY,
      value: JSON.stringify({ checkoutFlowId: 'tpl-omnichannel-order', links: [], orderUrl: null }),
      updatedAt: Date.now(),
      updatedBy: 'test',
    })
    .onConflictDoNothing();
  alpha = await platform('pickup_alpha');
});
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

const buyer = { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' };
const checkout = (quantity: number, storeId?: string) => ({
  line_items: [{ item: { id: 'MON-27' }, quantity }],
  buyer,
  fulfillment: {
    methods: [{ type: 'pickup', ...(storeId ? { selected_destination_id: storeId } : {}) }],
  },
});
type Method = {
  type: string;
  destinations: { id: string }[];
  selected_destination_id: string | null;
};
// biome-ignore lint/suspicious/noExplicitAny: a checkout body read as untyped JSON
const pickupOf = (c: Record<string, any>) =>
  (c.fulfillment.methods as Method[]).find((m) => m.type === 'pickup');

describe('UCP pickup', () => {
  it('offers the pickup stores that hold every item, without asking for an address', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', checkout(1));
    expect(r.status).toBe(201);
    const pickup = pickupOf(r.body)!;
    expect(pickup.destinations.map((d) => d.id)).toEqual(['loc_mission', 'loc_soho']);
    expect(pickup.destinations[1]).toMatchObject({ type: 'business_location', name: 'SoHo store' });
    expect(pickup.selected_destination_id).toBeNull();
    // Four monitors: the Mission store has three, so only SoHo can supply them.
    const four = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', checkout(4));
    expect(pickupOf(four.body)!.destinations.map((d) => d.id)).toEqual(['loc_soho']);
    // No store chosen and no address: still a shipping checkout, asking for what it needs.
    expect(r.body.status).toBe('incomplete');
  });

  it('prices a chosen store through the flow with free shipping, and holds the quoted total', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { body: c, status } = await ucp(
      alpha,
      'POST',
      '/ucp/v1/checkout-sessions',
      checkout(1, 'loc_soho'),
    );
    expect(status).toBe(201);
    expect(c.status).toBe('ready_for_complete');
    expect(pickupOf(c)!.selected_destination_id).toBe('loc_soho');
    expect(c.messages ?? []).toEqual([]);
    expect(c.totals.find((t: { type: string }) => t.type === 'fulfillment').amount).toBe(0);

    const done = await ucp(alpha, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    expect(done.body.status).toBe('completed');
    const orderId = done.body.order.id;
    // The order runs its pickup path: held at the store, ready, waiting for the buyer.
    const state = await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return s.status === 'waiting' ? s : false;
    }, 'the order waiting for collection');
    expect(state.order!.fulfillment).toMatchObject({ method: 'pickup', locationId: 'loc_soho' });
    expect(state.nodes.route?.branches).toEqual(['pickup']);
    expect(state.nodes.reserve_pickup?.branches).toEqual(['ok']);
    expect(state.nodes.authorize?.branches).toEqual(['ok']);
    expect(Math.round(state.order!.total * 100)).toBe(
      c.totals.find((t: { type: string }) => t.type === 'total').amount,
    );
  });

  it('refuses a store that cannot hold every item, and an update back to shipping clears the choice', async () => {
    // The SoHo store holds 6 monitors; 7 is more than any store has.
    const big = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', checkout(7, 'loc_soho'));
    expect(big.body.status).toBe('incomplete');
    expect(big.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'pickup_unavailable', path: '$.fulfillment' }),
      ]),
    );
    // No store qualifies, but the one chosen stays on the checkout.
    expect(pickupOf(big.body)).toMatchObject({
      destinations: [],
      selected_destination_id: 'loc_soho',
    });

    const { body: c } = await ucp(
      alpha,
      'POST',
      '/ucp/v1/checkout-sessions',
      checkout(1, 'loc_soho'),
    );
    const back = await ucp(alpha, 'PUT', `/ucp/v1/checkout-sessions/${c.id}`, {
      line_items: [{ id: c.line_items[0].id, item: { id: 'MON-27' }, quantity: 1 }],
      buyer,
    });
    expect(back.body.status).toBe('incomplete');
    expect(pickupOf(back.body)!.selected_destination_id).toBeNull();
  });

  // Stock the tests change, put back after each.
  const setStore = (id: string, stock: number) =>
    db()
      .update(locationStock)
      .set({ stock })
      .where(and(eq(locationStock.locationId, id), eq(locationStock.sku, 'MON-27')));
  const setWarehouse = (stock: number) =>
    db().update(products).set({ stock }).where(eq(products.sku, 'MON-27'));
  afterEach(async () => {
    await setStore('loc_soho', 6);
    await setStore('loc_mission', 3);
    await setWarehouse(40);
  });

  it('checks a pickup against the store, not the warehouse, in both directions', async () => {
    await setWarehouse(0);
    const ok = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', checkout(1, 'loc_soho'));
    expect(ok.body.status).toBe('ready_for_complete');
    expect(ok.body.messages ?? []).toEqual([]);

    await setWarehouse(40);
    await setStore('loc_soho', 0);
    const short = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', checkout(1, 'loc_soho'));
    expect(short.body.status).toBe('incomplete');
    const codes = short.body.messages.map((m: { code: string }) => m.code);
    expect(codes).toContain('pickup_unavailable');
    expect(codes).not.toContain('out_of_stock');
  });

  it('adds up two lines of one SKU against the store', async () => {
    await setStore('loc_soho', 4);
    const lines = [
      { item: { id: 'MON-27' }, quantity: 3 },
      { item: { id: 'MON-27' }, quantity: 3 },
    ];
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', {
      ...checkout(1, 'loc_soho'),
      line_items: lines,
    });
    expect(r.body.status).toBe('incomplete');
    expect(r.body.messages).toEqual([
      expect.objectContaining({
        code: 'pickup_unavailable',
        content: expect.stringContaining('SoHo store does not have enough MON-27'),
      }),
    ]);
    expect(pickupOf(r.body)!.destinations).toEqual([]);
  });

  it('says so when the id is not a store', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', checkout(1, 'loc_nowhere'));
    expect(r.body.messages).toEqual([
      expect.objectContaining({
        code: 'pickup_unavailable',
        content: 'loc_nowhere is not a store.',
      }),
    ]);
  });

  it('reads a store chosen by method id on update, and refuses a method that leaves out a line', async () => {
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', checkout(1));
    const lineId = c.line_items[0].id;
    const chosen = await ucp(alpha, 'PUT', `/ucp/v1/checkout-sessions/${c.id}`, {
      line_items: [{ id: lineId, item: { id: 'MON-27' }, quantity: 1 }],
      buyer,
      fulfillment: { methods: [{ id: 'fm_pickup', selected_destination_id: 'loc_soho' }] },
    });
    expect(chosen.body.status).toBe('ready_for_complete');
    expect(pickupOf(chosen.body)!.selected_destination_id).toBe('loc_soho');
    const partial = await ucp(alpha, 'PUT', `/ucp/v1/checkout-sessions/${c.id}`, {
      line_items: [{ id: lineId, item: { id: 'MON-27' }, quantity: 1 }],
      buyer,
      fulfillment: {
        methods: [
          {
            id: 'fm_pickup',
            line_item_ids: ['li_99'],
            selected_destination_id: 'loc_soho',
          },
        ],
      },
    });
    expect(partial.body.status).toBe('incomplete');
    expect(partial.body.messages).toEqual([
      expect.objectContaining({ code: 'pickup_unavailable', path: '$.fulfillment' }),
    ]);
  });
});
