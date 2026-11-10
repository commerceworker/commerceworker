import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  CHECKOUT_CAPABILITY,
  DISCOUNT_CAPABILITY,
  digestMatches,
  FULFILLMENT_CAPABILITY,
  importVerifyKey,
  ORDER_CAPABILITY,
  type OrderState,
  type PlatformCaller,
  PRINCIPAL_HEADER,
  signPlatform,
  UCP_VERSION,
  verifyMessage,
} from '@commerceworker/core';
import { checkoutSessions, orders, promotionRedemptions, promotions } from '@commerceworker/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTemplates } from '../src/flows';
import worker from '../src/index';
import { eraseDataSubject, exportDataSubject } from '../src/subjects';
import { ucpProfile } from '../src/ucp/config';
import { signed } from './principal';
import {
  address,
  db,
  enableUcp,
  key,
  monitorCheckout,
  ORIGIN,
  pay,
  platform,
  platformKey,
  platformProfile,
  ucp,
  until,
} from './ucp-helpers';

// Order webhooks to the platform are caught here; everything else goes out as usual.
const hooks: { url: string; headers: Headers; body: string }[] = [];
const realFetch = globalThis.fetch;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

let alpha: PlatformCaller;
beforeAll(async () => {
  await ensureTemplates(env);
  await enableUcp();
  alpha = await platform('alpha');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url.startsWith('https://platform.example/')) {
      // Read here: the request belongs to the OrderAgent that sent it.
      hooks.push({ url: req.url, headers: new Headers(req.headers), body: await req.text() });
      return new Response(null, { status: 204 });
    }
    return realFetch(input as RequestInfo, init);
  });
});
afterAll(() => vi.restoreAllMocks());
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe('UCP discovery', () => {
  it('publishes the profile with the signing key and the test payment handler', async () => {
    const profile = (await ucpProfile(env, ORIGIN))!;
    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(profile.keys).toEqual([
      expect.objectContaining({ kid: 'test-ucp-2026', kty: 'EC', crv: 'P-256', alg: 'ES256' }),
    ]);
    expect(profile.keys[0]).not.toHaveProperty('d');
    expect(Object.keys(profile.ucp.payment_handlers)).toEqual(['com.commerceworker.test']);
  });
});

describe('UCP checkout', () => {
  it('refuses a request without the signed platform header, and a principal header', async () => {
    expect((await ucp(null, 'GET', '/ucp/v1/checkout-sessions/x')).status).toBe(401);
    const person = await signed(
      { kind: 'user', id: 'usr_x', name: 'x', role: 'admin' },
      '/ucp/v1/checkout-sessions/x',
    );
    expect(
      (
        await ucp(null, 'GET', '/ucp/v1/checkout-sessions/x', undefined, {
          [PRINCIPAL_HEADER]: person,
        })
      ).status,
    ).toBe(401);
  });

  it("refuses a platform's header at the workspace's own MCP and A2A endpoints", async () => {
    for (const path of ['/mcp', '/a2a']) {
      const res = await worker.fetch(
        new Request(`https://engine${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            [PRINCIPAL_HEADER]: await signPlatform(platformKey, alpha, path),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
        env,
      );
      expect(res.status).toBe(401);
    }
  });

  it('prices a checkout with the storefront flow and makes it ready', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    expect(r.status).toBe(201);
    const c = r.body;
    expect(c.status).toBe('ready_for_complete');
    expect(c.ucp.capabilities).toEqual({
      [CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }],
      [FULFILLMENT_CAPABILITY]: [{ version: UCP_VERSION }],
    });
    expect(c.line_items[0].item).toEqual({ id: 'MON-27', title: '27" monitor', price: 34900 });
    const types = c.totals.map((t: { type: string }) => t.type);
    expect(types).toEqual(['subtotal', 'fulfillment', 'tax', 'total']);
    const total = c.totals.at(-1).amount;
    expect(total).toBe(
      c.totals.slice(0, -1).reduce((n: number, t: { amount: number }) => n + t.amount, 0),
    );
    const method = c.fulfillment.methods[0];
    expect(method.destinations[0]).toMatchObject({ id: 'dest_1', postal_code: '78701' });
    expect(method.groups[0].options.length).toBeGreaterThan(0);
    expect(method.groups[0].selected_option_id).toBeTruthy();
    expect(c.links).toEqual([{ type: 'terms_of_service', url: 'https://shop.example/terms' }]);
  });

  it('asks for what is missing, and reports the store policy', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', {
      line_items: [{ item: { id: 'MON-27' }, quantity: 11 }],
    });
    expect(r.body.status).toBe('incomplete');
    const codes = r.body.messages.map((m: { code: string }) => m.code);
    expect(codes).toEqual(expect.arrayContaining(['missing', 'policy']));
    expect(r.body.messages.find((m: { path?: string }) => m.path === '$.buyer.email')).toBeTruthy();
  });

  it('answers an error response when nothing in it is sold', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', {
      line_items: [{ item: { id: 'NOPE-1' }, quantity: 1 }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ucp: { status: 'error' },
      messages: [{ code: 'item_unavailable', severity: 'unrecoverable' }],
    });
    expect(r.body).not.toHaveProperty('id');
  });

  it("keeps one platform's checkouts from another", async () => {
    const created = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const beta = await platform('beta');
    const r = await ucp(beta, 'GET', `/ucp/v1/checkout-sessions/${created.body.id}`);
    expect(r.body).toMatchObject({ ucp: { status: 'error' }, messages: [{ code: 'not_found' }] });
  });

  it('updates by full replacement, keeping the ship-to named by id', async () => {
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const r = await ucp(alpha, 'PUT', `/ucp/v1/checkout-sessions/${c.id}`, {
      line_items: [{ id: c.line_items[0].id, item: { id: 'MON-27' }, quantity: 2 }],
      buyer: monitorCheckout.buyer,
      fulfillment: { methods: [{ id: 'fm_shipping', selected_destination_id: 'dest_1' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.line_items[0]).toMatchObject({ id: c.line_items[0].id, quantity: 2 });
    expect(r.body.fulfillment.methods[0].destinations[0].street_address).toBe('500 Congress Ave');
    expect(r.body.status).toBe('ready_for_complete');
  });

  it('needs an Idempotency-Key to complete, replays it, and refuses it for another body', async () => {
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const path = `/ucp/v1/checkout-sessions/${c.id}/complete`;
    expect((await ucp(alpha, 'POST', path, pay('tok_test_decline'))).status).toBe(400);
    const k = key();
    const first = await ucp(alpha, 'POST', path, pay('tok_test_decline'), { 'idempotency-key': k });
    expect(first.body.status).toBe('ready_for_complete');
    expect(first.body.messages).toEqual([
      expect.objectContaining({ code: 'payment_failed', severity: 'recoverable' }),
    ]);
    const again = await ucp(alpha, 'POST', path, pay('tok_test_decline'), { 'idempotency-key': k });
    expect(again).toEqual(first);
    const other = await ucp(alpha, 'POST', path, pay(), { 'idempotency-key': k });
    expect(other.status).toBe(409);
  });

  it('cancels an open checkout once', async () => {
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const path = `/ucp/v1/checkout-sessions/${c.id}/cancel`;
    const r = await ucp(alpha, 'POST', path, undefined, { 'idempotency-key': key() });
    expect(r.body.status).toBe('canceled');
    expect((await ucp(alpha, 'POST', path, undefined, { 'idempotency-key': key() })).status).toBe(
      409,
    );
  });

  it('refuses a platform on a newer UCP version', async () => {
    const future = await platform('future', platformProfile('2099-01-01'));
    const r = await ucp(future, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    expect(r).toMatchObject({ status: 422, body: { code: 'version_unsupported' } });
  });
});

describe('UCP completion and order events', () => {
  it('places the order, which adopts the payment, and tells the platform as it ships', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    hooks.length = 0;
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout);
    const done = await ucp(alpha, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    expect(done.body.status).toBe('completed');
    const orderId = done.body.order.id;
    expect(done.body.order.permalink_url).toBe(`https://shop.example/orders/${orderId}`);

    const row = await db().select().from(orders).where(eq(orders.id, orderId)).get();
    expect(row).toMatchObject({
      channel: 'agent',
      externalId: c.id,
      flowId: 'tpl-storefront-order',
    });
    const session = await db()
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, c.id))
      .get();
    expect(session).toMatchObject({ status: 'completed', orderId });

    // The order runs to its return window: authorized at the quoted total, shipped, captured.
    const state = await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return s.status === 'waiting' ? s : false;
    }, 'the return window');
    expect(state.nodes.authorize?.branches).toEqual(['ok']);
    expect(Math.round(state.order!.total * 100)).toBe(c.totals.at(-1).amount);

    // The platform hears about it: signed with the profile's key, the whole order each time.
    const shippedHook = await until(async () => {
      const h = hooks.find((x) => JSON.parse(x.body).fulfillment.events.length);
      return h ? { h, body: h.body } : false;
    }, 'a shipped order event');
    const { h, body } = shippedHook;
    expect(h.headers.get('ucp-agent')).toBe(`profile="${ORIGIN}/.well-known/ucp"`);
    expect(h.headers.get('webhook-id')).toBeTruthy();
    expect(await digestMatches(h.headers.get('content-digest'), body)).toBe(true);
    const profile = (await ucpProfile(env, ORIGIN))!;
    const pub = await importVerifyKey(profile.keys[0]!);
    const check = await verifyMessage(
      { method: 'POST', url: h.url, headers: h.headers },
      async (kid) => (kid === profile.keys[0]!.kid ? pub : null),
      ['@method', '@authority', '@path', 'content-digest', 'ucp-agent'],
    );
    expect(check).toMatchObject({ ok: true });
    const entity = JSON.parse(body);
    expect(entity).toMatchObject({
      id: orderId,
      checkout_id: c.id,
      ucp: { capabilities: { [ORDER_CAPABILITY]: [{ version: UCP_VERSION }] } },
    });
    expect(entity.fulfillment.events[0]).toMatchObject({
      type: 'shipped',
      line_items: [{ id: c.line_items[0].id, quantity: 1 }],
    });

    // Get Order returns the same snapshot.
    const got = await ucp(alpha, 'GET', `/ucp/v1/orders/${orderId}`);
    expect(got.body).toMatchObject({ id: orderId, line_items: [{ status: 'fulfilled' }] });
    // A completed checkout doesn't change, and completing it again places nothing new.
    const repeat = await ucp(alpha, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    expect(repeat.body.order.id).toBe(orderId);
  });
});

describe('UCP and data subject requests', () => {
  it("exports a buyer's checkouts and erases the ones that placed no order", async () => {
    const grace = { ...monitorCheckout, buyer: { email: 'Grace@Example.com' } };
    const { body: c } = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', grace);
    const exported = await exportDataSubject(env, 'grace@example.com');
    expect(exported.checkouts).toEqual([
      expect.objectContaining({ id: c.id, buyer: { email: 'Grace@Example.com' }, orderId: null }),
    ]);
    expect(await eraseDataSubject(env, 'grace@example.com')).toMatchObject({
      ok: true,
      done: true,
    });
    const left = await db().select().from(checkoutSessions).where(eq(checkoutSessions.id, c.id));
    expect(left).toEqual([]);
  });
});

describe('UCP over MCP', () => {
  let n = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await worker.fetch(
      new Request('https://engine/ucp/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signPlatform(platformKey, alpha, '/ucp/mcp'),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      }),
      env,
    );
    // biome-ignore lint/suspicious/noExplicitAny: a response body read as untyped JSON
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const meta = () => ({ 'ucp-agent': { profile: alpha.profileUrl } });

  it('lists the checkout and order tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    const r = await rpc('tools/list');
    expect(r.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'create_checkout',
      'get_checkout',
      'update_checkout',
      'complete_checkout',
      'cancel_checkout',
      'get_order',
    ]);
  });

  it('holds an MCP idempotency key to REST’s length, and refuses an oversized request', async () => {
    const created = await rpc('tools/call', {
      name: 'create_checkout',
      arguments: { meta: meta(), checkout: monitorCheckout },
    });
    const id = created.body.result.structuredContent.id as string;
    const short = await rpc('tools/call', {
      name: 'cancel_checkout',
      arguments: { meta: { ...meta(), 'idempotency-key': 'short' }, id },
    });
    expect(JSON.stringify(short.body)).toContain('invalid_idempotency_key');
    const big = await worker.fetch(
      new Request('https://engine/ucp/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signPlatform(platformKey, alpha, '/ucp/mcp'),
        },
        body: 'x'.repeat(257 * 1024),
      }),
      env,
    );
    expect(big.status).toBe(413);
  });

  it('creates and reads a checkout, the UCP body in structuredContent', async () => {
    const created = await rpc('tools/call', {
      name: 'create_checkout',
      arguments: { meta: meta(), checkout: monitorCheckout },
    });
    const c = created.body.result.structuredContent;
    expect(c.status).toBe('ready_for_complete');
    expect(JSON.parse(created.body.result.content[0].text)).toEqual(c);
    const got = await rpc('tools/call', {
      name: 'get_checkout',
      arguments: { meta: meta(), id: c.id },
    });
    expect(got.body.result.structuredContent.id).toBe(c.id);
  });

  it('refuses another profile in meta, and complete without an idempotency key', async () => {
    const wrong = await rpc('tools/call', {
      name: 'get_checkout',
      arguments: { meta: { 'ucp-agent': { profile: 'https://evil.example/p' } }, id: 'chk_x' },
    });
    expect(wrong.body.error).toMatchObject({ code: -32000, data: { code: 'forbidden' } });
    const noKey = await rpc('tools/call', {
      name: 'complete_checkout',
      arguments: { meta: meta(), id: 'chk_x', checkout: pay() },
    });
    expect(noKey.body.error).toMatchObject({
      code: -32000,
      data: { code: 'idempotency_key_required' },
    });
  });
});

describe('UCP discounts', () => {
  const SAVE = 'UCPSAVE10';
  let disc: PlatformCaller;
  beforeAll(async () => {
    disc = await platform('disc', platformProfile(UCP_VERSION, true, true));
    const now = Date.now();
    await db()
      .insert(promotions)
      .values({
        id: `promo_${SAVE}`,
        code: SAVE,
        name: 'Ten percent off',
        kind: 'pct',
        value: 10,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });

  const withCodes = (codes?: string[]) => ({
    ...monitorCheckout,
    ...(codes ? { discounts: { codes } } : {}),
  });
  type Total = { type: string; amount: number };
  // biome-ignore lint/suspicious/noExplicitAny: a checkout body read as untyped JSON
  type Priced = Record<string, any>;
  const totalsOf = (c: Priced) => c.totals as Total[];
  const amountOf = (c: Priced, type: string) =>
    totalsOf(c).find((t) => t.type === type)?.amount ?? 0;
  const sums = (c: Priced) =>
    totalsOf(c)
      .filter((t) => t.type !== 'total')
      .reduce((n, t) => n + t.amount, 0);

  it('applies a code over REST, prices it through the flow and reports what was applied', async () => {
    const plain = (await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', withCodes())).body;
    const r = await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', withCodes(['ucpSave10']));
    expect(r.status).toBe(201);
    const c = r.body;
    expect(c.ucp.capabilities[DISCOUNT_CAPABILITY]).toEqual([{ version: UCP_VERSION }]);
    // 10% of the monitor's 349.00, taken from the same quote the flow would charge.
    expect(c.discounts).toEqual({
      codes: ['ucpSave10'],
      applied: [
        {
          code: SAVE,
          title: 'Ten percent off',
          amount: 3490,
          method: 'each',
          allocations: [{ path: '$.line_items[0]', amount: 3490 }],
        },
      ],
    });
    expect(amountOf(c, 'subtotal')).toBe(34900);
    expect(amountOf(c, 'discount')).toBe(-3490);
    expect(c.line_items[0].item.price).toBe(34900);
    expect(sums(c)).toBe(amountOf(c, 'total'));
    expect(amountOf(c, 'total')).toBeLessThan(amountOf(plain, 'total'));
    expect(c.messages ?? []).toEqual([]);
    expect(c.status).toBe('ready_for_complete');

    // An update replaces the codes: one the step refuses is reported at its place and still
    // listed, and an empty list clears them.
    const bad = await ucp(disc, 'PUT', `/ucp/v1/checkout-sessions/${c.id}`, {
      ...withCodes([SAVE, 'NOPE']),
      line_items: [{ id: c.line_items[0].id, item: { id: 'MON-27' }, quantity: 1 }],
      fulfillment: { methods: [{ id: 'fm_shipping', selected_destination_id: 'dest_1' }] },
    });
    expect(bad.body.discounts.codes).toEqual([SAVE, 'NOPE']);
    expect(bad.body.discounts.applied.map((a: { code: string }) => a.code)).toEqual([SAVE]);
    expect(bad.body.messages).toEqual([
      {
        type: 'warning',
        code: 'promotion',
        content: "NOPE isn't a promotion.",
        path: '$.discounts.codes[1]',
      },
    ]);
    expect(bad.body.status).toBe('ready_for_complete');
    const cleared = await ucp(disc, 'PUT', `/ucp/v1/checkout-sessions/${c.id}`, {
      ...withCodes([]),
      line_items: [{ id: c.line_items[0].id, item: { id: 'MON-27' }, quantity: 1 }],
      fulfillment: { methods: [{ id: 'fm_shipping', selected_destination_id: 'dest_1' }] },
    });
    expect(cleared.body.discounts).toEqual({ codes: [], applied: [] });
    expect(cleared.body.totals).toEqual(plain.totals);
  });

  it('refuses an unknown code without failing the checkout', async () => {
    const r = await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', withCodes(['NOPE']));
    expect(r.body.status).toBe('ready_for_complete');
    expect(r.body.discounts).toEqual({ codes: ['NOPE'], applied: [] });
    expect(r.body.messages).toEqual([
      expect.objectContaining({ code: 'promotion', path: '$.discounts.codes[0]' }),
    ]);
    expect(r.body.totals.map((t: Total) => t.type)).toEqual([
      'subtotal',
      'fulfillment',
      'tax',
      'total',
    ]);
  });

  it('ignores codes, and serves no discounts, when the extension was not negotiated', async () => {
    const plain = (await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', withCodes())).body;
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', withCodes([SAVE]));
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('discounts');
    expect(r.body).not.toHaveProperty('messages');
    expect(r.body.ucp.capabilities).not.toHaveProperty(DISCOUNT_CAPABILITY);
    expect(r.body.totals).toEqual(plain.totals);
    expect(r.body.line_items[0].item.price).toBe(34900);
  });

  it('applies and refuses codes over MCP as over REST', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await worker.fetch(
        new Request('https://engine/ucp/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [PRINCIPAL_HEADER]: await signPlatform(platformKey, disc, '/ucp/mcp'),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name,
              arguments: { meta: { 'ucp-agent': { profile: disc.profileUrl } }, ...args },
            },
          }),
        }),
        env,
      );
      // biome-ignore lint/suspicious/noExplicitAny: a response body read as untyped JSON
      return ((await res.json()) as Record<string, any>).result.structuredContent;
    };
    const c = await call('create_checkout', { checkout: withCodes([SAVE, 'NOPE']) });
    expect(c.discounts.applied).toEqual([expect.objectContaining({ code: SAVE, amount: 3490 })]);
    expect(c.messages).toEqual([expect.objectContaining({ path: '$.discounts.codes[1]' })]);
    expect(sums(c)).toBe(amountOf(c, 'total'));
    // Not negotiated: the same call from a platform without the extension carries no discounts.
    const res = await worker.fetch(
      new Request('https://engine/ucp/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINCIPAL_HEADER]: await signPlatform(platformKey, alpha, '/ucp/mcp'),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'create_checkout',
            arguments: {
              meta: { 'ucp-agent': { profile: alpha.profileUrl } },
              checkout: withCodes([SAVE]),
            },
          },
        }),
      }),
      env,
    );
    // biome-ignore lint/suspicious/noExplicitAny: a response body read as untyped JSON
    const plain = ((await res.json()) as Record<string, any>).result.structuredContent;
    expect(plain).not.toHaveProperty('discounts');
  });

  it('holds and authorizes the discounted total, and redeems the code once for the order', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const { body: c } = await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', withCodes([SAVE]));
    const done = await ucp(disc, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    expect(done.body.status).toBe('completed');
    const orderId = done.body.order.id;
    const state = await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return s.status === 'waiting' ? s : false;
    }, 'the return window');
    // The flow's own discount step took the code off again: its total is the one quoted.
    expect(state.nodes.authorize?.branches).toEqual(['ok']);
    expect(Math.round(state.order!.total * 100)).toBe(amountOf(c, 'total'));
    const redeemed = await db()
      .select()
      .from(promotionRedemptions)
      .where(eq(promotionRedemptions.orderId, orderId));
    expect(redeemed).toHaveLength(1);
  });

  it('hands the order only the codes the quote applied', async () => {
    introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    const now = Date.now();
    await db()
      .insert(promotions)
      .values({
        id: 'promo_UCPLATER',
        code: 'UCPLATER',
        name: 'Later',
        kind: 'pct',
        value: 50,
        validFrom: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const { body: c } = await ucp(
      disc,
      'POST',
      '/ucp/v1/checkout-sessions',
      withCodes([SAVE, 'UCPLATER']),
    );
    expect(c.messages).toEqual([
      expect.objectContaining({
        path: '$.discounts.codes[1]',
        content: "UCPLATER isn't valid yet.",
      }),
    ]);
    const done = await ucp(disc, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
      'idempotency-key': key(),
    });
    const orderId = done.body.order.id;
    const state = await until(async () => {
      const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
      return s.status === 'waiting' ? s : false;
    }, 'the return window');
    expect(state.order!.meta?.promoCodes).toEqual([SAVE]);
    expect(Math.round(state.order!.total * 100)).toBe(amountOf(c, 'total'));
  });

  describe('with buy X, get Y', () => {
    const at = Date.now();
    const row = {
      id: 'promo_UCPBXGY',
      code: 'UCPBXGY',
      name: 'Buy 2, get 1',
      kind: 'bxgy',
      value: 0,
      bxgy: JSON.stringify({
        buy: { skus: ['MON-27'], qty: 2 },
        get: { skus: null, qty: 1, percent: 100 },
        repeat: null,
      }),
      createdAt: at,
      updatedAt: at,
    };
    beforeAll(async () => {
      await db().insert(promotions).values(row).onConflictDoNothing();
      await db().update(promotions).set({ status: 'paused' }).where(eq(promotions.code, SAVE));
    });
    afterAll(async () => {
      await db().delete(promotions).where(eq(promotions.id, row.id));
      await db().update(promotions).set({ status: 'active' }).where(eq(promotions.code, SAVE));
    });
    const three = (codes?: string[]) => ({
      ...withCodes(codes),
      line_items: [{ item: { id: 'MON-27' }, quantity: 3 }],
    });

    it('shows the free unit as the line’s own discount, and the totals agree', async () => {
      const plain = (await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', three())).body;
      const { body: c } = await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', three(['ucpbxgy']));
      // Three monitors at 349.00: the third is free.
      expect(c.discounts.applied).toEqual([
        {
          code: 'UCPBXGY',
          title: 'Buy 2, get 1',
          amount: 34900,
          method: 'across',
          allocations: [{ path: '$.line_items[0]', amount: 34900 }],
        },
      ]);
      expect(c.line_items[0]).toMatchObject({ quantity: 3, item: { price: 34900 } });
      expect(c.line_items[0].totals).toEqual([
        { type: 'subtotal', amount: 104700 },
        { type: 'discount', display_text: 'Discount', amount: -34900 },
        { type: 'total', amount: 69800 },
      ]);
      expect(amountOf(c, 'discount')).toBe(-34900);
      expect(sums(c)).toBe(amountOf(c, 'total'));
      // Tax follows the discounted prices, so the total falls by more than the free unit.
      expect(amountOf(c, 'total')).toBeLessThan(amountOf(plain, 'total') - 34900 + 1);
    });

    it('refuses the code on a checkout too small for it, without failing the checkout', async () => {
      const { body: c } = await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', {
        ...withCodes(['UCPBXGY']),
        line_items: [{ item: { id: 'MON-27' }, quantity: 2 }],
      });
      expect(c.discounts.applied).toEqual([]);
      expect(c.messages).toEqual([
        expect.objectContaining({
          code: 'promotion',
          path: '$.discounts.codes[0]',
          content: 'UCPBXGY needs at least 3 MON-27 in the order.',
        }),
      ]);
    });
  });

  describe('with promotion conditions', () => {
    const at = Date.now();
    const rows = [
      // Met: a checkout started by an agent.
      {
        id: 'promo_UCPAGENT',
        code: 'UCPAGENT',
        name: 'Agents',
        kind: 'amount',
        value: 10,
        condition: JSON.stringify({ '==': [{ var: 'order.channel' }, 'agent'] }),
      },
      // Not met: no checkout here is that large, and the merchant says why.
      {
        id: 'promo_UCPBIG',
        code: 'UCPBIG',
        name: 'Big baskets',
        kind: 'amount',
        value: 10,
        condition: JSON.stringify({ '>=': [{ var: 'order.baseSubtotal' }, 1_000_000] }),
        conditionMessage: 'Needs a basket of $1,000,000.',
      },
    ].map((r) => ({ ...r, createdAt: at, updatedAt: at }));
    beforeAll(async () => {
      await db().insert(promotions).values(rows).onConflictDoNothing();
    });
    afterAll(async () => {
      await db().delete(promotions).where(eq(promotions.id, 'promo_UCPAGENT'));
      await db().delete(promotions).where(eq(promotions.id, 'promo_UCPBIG'));
    });

    it('prices a code whose condition holds, and tells the agent why another does not', async () => {
      const { body: c } = await ucp(
        disc,
        'POST',
        '/ucp/v1/checkout-sessions',
        withCodes(['ucpagent', 'ucpbig']),
      );
      expect(c.status).toBe('ready_for_complete');
      expect(c.discounts.applied).toEqual([
        expect.objectContaining({ code: 'UCPAGENT', amount: 1000 }),
      ]);
      expect(c.messages).toEqual([
        expect.objectContaining({
          path: '$.discounts.codes[1]',
          content: 'Needs a basket of $1,000,000.',
        }),
      ]);
      expect(sums(c)).toBe(amountOf(c, 'total'));
    });
  });

  describe('with promotions that combine', () => {
    const at = Date.now();
    const rows = [
      // 5% off every order, with no code; it combines with the code below.
      {
        id: 'promo_UCPAUTO',
        code: null,
        name: 'Sitewide',
        kind: 'pct',
        value: 5,
        stacking: 'stackable',
        priority: 9,
      },
      {
        id: 'promo_UCPSTACK',
        code: 'UCPSTACK',
        name: 'Ten off',
        kind: 'amount',
        value: 10,
        stacking: 'stackable',
      },
      // Never combined, and worth less than the two together.
      { id: 'promo_UCPALONE', code: 'UCPALONE', name: 'Alone', kind: 'amount', value: 12 },
    ].map((r) => ({ ...r, createdAt: at, updatedAt: at }));
    beforeAll(async () => {
      await db().insert(promotions).values(rows).onConflictDoNothing();
      // SAVE would be exclusive and worth more than the pair; take it out of play.
      await db().update(promotions).set({ status: 'paused' }).where(eq(promotions.code, SAVE));
    });
    afterAll(async () => {
      await db().delete(promotions).where(eq(promotions.id, 'promo_UCPAUTO'));
      await db().delete(promotions).where(eq(promotions.id, 'promo_UCPSTACK'));
      await db().delete(promotions).where(eq(promotions.id, 'promo_UCPALONE'));
      await db().update(promotions).set({ status: 'active' }).where(eq(promotions.code, SAVE));
    });

    it('applies several codes and an automatic promotion, and names what a code is not combined with', async () => {
      const { body: c } = await ucp(
        disc,
        'POST',
        '/ucp/v1/checkout-sessions',
        withCodes(['ucpstack', 'ucpalone']),
      );
      // The automatic 5% (349.00 -> 17.45) is first by priority, then 10 off the rest.
      expect(c.discounts.applied).toEqual([
        expect.objectContaining({ title: 'Sitewide', automatic: true, amount: 1745 }),
        expect.objectContaining({ code: 'UCPSTACK', title: 'Ten off', amount: 1000 }),
      ]);
      expect(c.discounts.applied[0]).not.toHaveProperty('code');
      expect(amountOf(c, 'discount')).toBe(-2745);
      expect(sums(c)).toBe(amountOf(c, 'total'));
      expect(c.messages).toEqual([
        expect.objectContaining({
          path: '$.discounts.codes[1]',
          content: "UCPALONE isn't combined with Sitewide, UCPSTACK.",
        }),
      ]);
    });

    it('prices an automatic promotion with no codes sent, and the order charges the quoted total', async () => {
      introspector = await introspectWorkflow(env.ORDER_WORKFLOW);
      await introspector.modifyAll(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
      });
      const { body: c } = await ucp(disc, 'POST', '/ucp/v1/checkout-sessions', withCodes());
      expect(c.discounts.applied).toEqual([
        expect.objectContaining({ title: 'Sitewide', automatic: true, amount: 1745 }),
      ]);
      const done = await ucp(disc, 'POST', `/ucp/v1/checkout-sessions/${c.id}/complete`, pay(), {
        'idempotency-key': key(),
      });
      const orderId = done.body.order.id;
      const state = await until(async () => {
        const s = (await env.ORDER_AGENT.getByName(orderId).snapshot()) as OrderState;
        return s.status === 'waiting' ? s : false;
      }, 'the return window');
      // No code was handed on; the flow's discount step applied the promotion itself.
      expect(state.order!.meta?.promoCodes).toBeUndefined();
      expect(Math.round(state.order!.total * 100)).toBe(amountOf(c, 'total'));
      const redeemed = await db()
        .select()
        .from(promotionRedemptions)
        .where(eq(promotionRedemptions.orderId, orderId));
      expect(redeemed.map((r) => r.promotionId)).toEqual(['promo_UCPAUTO']);
    });
  });
});

describe('UCP pickup on a flow without a pickup path', () => {
  it('offers no pickup, and refuses a store the platform names', async () => {
    const r = await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', {
      ...monitorCheckout,
      fulfillment: {
        methods: [
          { type: 'shipping', destinations: [address] },
          { type: 'pickup', selected_destination_id: 'loc_soho' },
        ],
      },
    });
    // No store is offered; the one named stays on the checkout beside the error.
    const pickup = r.body.fulfillment.methods.find((m: { type: string }) => m.type === 'pickup');
    expect(pickup).toMatchObject({ destinations: [], selected_destination_id: 'loc_soho' });
    const plain = (await ucp(alpha, 'POST', '/ucp/v1/checkout-sessions', monitorCheckout)).body;
    expect(plain.fulfillment.methods.map((m: { type: string }) => m.type)).toEqual(['shipping']);
    expect(plain.fulfillment.available_methods).toEqual([
      { type: 'shipping', line_item_ids: [plain.line_items[0].id] },
    ]);
    expect(r.body.messages).toEqual([
      expect.objectContaining({ code: 'pickup_unavailable', path: '$.fulfillment' }),
    ]);
  });
});
