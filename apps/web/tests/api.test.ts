import type { Cart, Principal } from '@commerceworker/core';
import { DEV_PRINCIPAL_KEY, operationCall, verifyRpcActor } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = {
  decide: vi.fn(),
  cancel: vi.fn(),
  sendEvent: vi.fn(),
  exportDataSubject: vi.fn(),
  eraseDataSubject: vi.fn(),
  pluginCatalog: vi.fn(async () => [
    {
      id: 'example',
      runtime: 'worker',
      source: 'deployment',
      healthy: true,
      manifest: {
        id: 'example',
        name: 'Example',
        version: '1',
        nodes: [{ type: 'example.stamp' }],
        events: ['order.completed'],
      },
    },
    {
      id: 'broken',
      runtime: 'sandboxed',
      source: 'installed',
      healthy: false,
      manifest: null,
      error: 'apiVersion must be 1',
    },
  ]),
  pluginUsage: vi.fn(async () => ({ flows: [{ id: 'f1', version: 2 }], orders: [], labels: [] })),
  uploadPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  approvePlugin: vi.fn(),
  createCart: vi.fn(),
  cartSnapshot: vi.fn(),
  changeCart: vi.fn(),
  submitCart: vi.fn(),
  cancelCart: vi.fn(),
  runOperation: vi.fn(),
};

/** The signed webhooks already taken, in memory: claimed on delivery, given back on failure. */
const { InMemoryWebhookReceipts } = await import('@commerceworker/test-kit/commerce');
let receipts = new InMemoryWebhookReceipts();
vi.mock('~/lib/wire.server', () => ({ webhookReceipts: () => receipts }));
const env: Record<string, unknown> = {};
/** The actor a binding call carries, as the engine reads it (local dev's key in tests). */
const actorOf = (signed: string, call: string) => verifyRpcActor([DEV_PRINCIPAL_KEY], signed, call);

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => engine }));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
vi.mock('~/lib/orders.server', () => ({ currencies: async () => [], listOrders: async () => [] }));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({
  actor: () => 'ops@example.com',
  forbidden: () => 'Forbidden',
  stepUp: async () => 'step-up needed',
}));
const listCarts = vi.fn(async (_f: unknown, _limit: number) => [] as Record<string, unknown>[]);
vi.mock('~/lib/carts.server', () => ({
  listCarts,
  isCartStatus: (v: unknown) =>
    ['open', 'locked', 'submitted', 'returned', 'canceled'].includes(v as string),
}));
const webhooks = { rotateSubscription: vi.fn(), deleteSubscription: vi.fn() };
vi.mock('~/lib/webhooks.server', () => webhooks);

const scope = { events: ['payment.received'], startOrders: false, flows: [], channel: null };
const keys: Record<string, Record<string, unknown>> = {
  int_pay: {
    id: 'int_pay',
    name: 'Payments',
    secret: 'whsec_test',
    previousSecret: null,
    previousExpiresAt: null,
    ...scope,
  },
  int_web: {
    id: 'int_web',
    name: 'Storefront',
    secret: 'whsec_web',
    previousSecret: null,
    previousExpiresAt: null,
    ...scope,
    events: ['*'],
    channel: 'web',
  },
};
const channels: Record<string, string> = { ord_x: 'web', ord_pos: 'pos' };
const integrations = {
  findIntegration: async (id: string) => keys[id] ?? null,
  touchIntegration: async () => {},
  orderChannel: async (id: string) => channels[id] ?? null,
  createIntegration: vi.fn(),
  rotateIntegration: vi.fn(),
  revokeIntegration: vi.fn(),
  listIntegrations: vi.fn(),
};
vi.mock('~/lib/integrations.server', () => integrations);

const ucp = {
  ucpAdmin: vi.fn(),
  setUcpSettings: vi.fn(),
  revokePlatform: vi.fn(),
  addPlatform: vi.fn(),
};
vi.mock('~/lib/ucp.server', () => ucp);

const storefront = { storefrontAdmin: vi.fn(), setStorefrontSettings: vi.fn() };
vi.mock('~/lib/storefront.server', () => storefront);

const { handleApi, handleSignedEvent } = await import('~/lib/api.server');
const { signWebhook } = await import('@commerceworker/core');

const operator: Principal = { kind: 'token', id: 'tok_1', name: 'ci', role: 'operator' };
const admin: Principal = { ...operator, id: 'tok_2', role: 'admin' };
const post = (path: string, body: unknown, as = operator) =>
  handleApi(
    new Request(`https://app.test/api/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    as,
  );

describe('starting orders over REST', () => {
  it('refuses an Idempotency-Key in a namespace the core starts orders under', async () => {
    for (const key of [
      'cart:cart_1',
      'ucp:chk_1',
      'plugin:punchout:po-1',
      'email:<m@x>',
      'a2a:1',
      // A submitted purchase order's own start.
      'po:x',
      // A quote's own start.
      'quote:x',
      // A hosted checkout's own start: a REST caller must not pre-empt its order.
      'hosted:abc',
    ]) {
      const res = await handleApi(
        new Request('https://app.test/api/v1/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ flowId: 'tpl-b2b-order', input: { model: 'b2b' } }),
        }),
        operator,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /^Idempotency-Key may not start with cart:, ucp:/,
      );
    }
  });
});

describe('order actions over REST', () => {
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
  });

  it('answers 404 for an unknown order, 409 for a step not waiting or an order with no run', async () => {
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'approved' })).status).toBe(404);
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'not_waiting' });
    const busy = await post('orders/ord_x/approvals/mgr', { decision: 'approved' });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'mgr is not waiting for an approval' });
    engine.decide.mockResolvedValueOnce({ ok: false, reason: 'no_run' });
    const recorded = await post('orders/ord_x/approvals/mgr', { decision: 'approved' });
    expect(recorded.status).toBe(409);
    expect(await recorded.json()).toEqual({
      error: 'The order has no live run, so its approvals can’t be decided',
    });
    engine.decide.mockResolvedValueOnce({ ok: true });
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'approved' })).status).toBe(200);
  });

  it('answers 409 when cancelling an order that already finished', async () => {
    engine.cancel.mockResolvedValueOnce({ ok: false, reason: 'finished' });
    const res = await post('orders/ord_x/cancel', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The order has already finished' });
    engine.cancel.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await post('orders/ord_x/cancel', {})).status).toBe(404);
    engine.cancel.mockResolvedValueOnce({ ok: true });
    expect((await post('orders/ord_x/cancel', {})).status).toBe(200);
  });

  it('passes the caller as the decider, and answers 403 when they started the order', async () => {
    engine.decide.mockResolvedValueOnce({
      ok: false,
      reason: 'own_order',
      error: 'You started this order, so someone else must decide its approvals.',
    });
    const res = await post('orders/ord_1/approvals/mgr', { decision: 'approved' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'You started this order, so someone else must decide its approvals.',
    });
    expect(engine.decide).toHaveBeenCalledWith(
      'ord_1',
      'mgr',
      'approved',
      expect.any(String),
      undefined,
      undefined,
    );
    // Who decides travels signed for this one call: the engine believes nothing else.
    expect(await actorOf(engine.decide.mock.calls.at(-1)![3], 'decide:ord_1')).toEqual({
      kind: 'staff',
      id: 'tok_1',
      name: 'ops@example.com',
      role: 'operator',
    });
  });

  it('casts a vote for a company member, audits who it was for and where the vote stands, and says why a vote is refused', async () => {
    audit.mockReset();
    engine.decide.mockResolvedValueOnce({ ok: true, outcome: 'recorded', tally: '1 of 2' });
    const voted = await post('orders/ord_1/approvals/appr', {
      decision: 'approved',
      note: 'Fine',
      onBehalfOf: 'mem_ann',
    });
    expect(voted.status).toBe(200);
    expect(await voted.json()).toEqual({ ok: true, outcome: 'recorded', tally: '1 of 2' });
    expect(engine.decide).toHaveBeenLastCalledWith(
      'ord_1',
      'appr',
      'approved',
      expect.any(String),
      'Fine',
      'mem_ann',
    );
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'approval.decided', {
      actor: operator,
      target: 'ord_1',
      detail: {
        nodeId: 'appr',
        decision: 'approved',
        note: 'Fine',
        onBehalfOf: 'mem_ann',
        outcome: 'recorded',
        tally: '1 of 2',
        via: 'api',
      },
    });

    // One approver's decision audits as it always did, with no tally.
    audit.mockClear();
    engine.decide.mockResolvedValueOnce({ ok: true, outcome: 'approved', tally: '1 of 1' });
    await post('orders/ord_1/approvals/mgr', { decision: 'approved' });
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'approval.decided', {
      actor: operator,
      target: 'ord_1',
      detail: { nodeId: 'mgr', decision: 'approved', via: 'api' },
    });

    // A vote that can't be taken is a 409 with the reason, and nothing is audited.
    audit.mockClear();
    engine.decide.mockResolvedValueOnce({
      ok: false,
      reason: 'refused',
      error: 'This person has already voted.',
    });
    const again = await post('orders/ord_1/approvals/appr', {
      decision: 'approved',
      onBehalfOf: 'mem_ann',
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'This person has already voted.' });
    expect(audit).not.toHaveBeenCalled();
    // `onBehalfOf` is a member id: a number or an empty one is a 400.
    expect(
      (await post('orders/ord_1/approvals/appr', { decision: 'approved', onBehalfOf: '' })).status,
    ).toBe(400);
  });

  it('stamps who delivered an event, and refuses a payload naming its source or a return', async () => {
    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    await post('orders/ord_x/events', { event: 'payment.received', payload: { amount: 5 } });
    expect(engine.sendEvent).toHaveBeenLastCalledWith('ord_x', 'payment.received', {
      amount: 5,
      source: 'api',
      by: operator.name,
    });
    engine.sendEvent.mockClear();
    const forged = await post('orders/ord_x/events', {
      event: 'payment.received',
      payload: { provider: 'stripe', paymentIntentId: 'pi_1' },
    });
    expect(forged.status).toBe(422);
    expect(((await forged.json()) as { error: string }).error).toContain(
      'provider, paymentIntentId',
    );
    expect((await post('orders/ord_x/events', { event: 'return.requested' })).status).toBe(422);
    expect(engine.sendEvent).not.toHaveBeenCalled();
  });

  it('answers 404 for an event to an unknown order', async () => {
    engine.sendEvent.mockResolvedValueOnce({ delivered: false, notFound: true });
    expect((await post('orders/ord_x/events', { event: 'payment.received' })).status).toBe(404);
    engine.sendEvent.mockResolvedValueOnce({ delivered: false });
    const early = await post('orders/ord_x/events', { event: 'payment.received' });
    expect(early.status).toBe(200);
    expect(await early.json()).toEqual({ delivered: false });
    engine.sendEvent.mockResolvedValueOnce({ delivered: false, held: true });
    const held = await post('orders/ord_x/events', { event: 'goods.received' });
    expect(await held.json()).toEqual({ delivered: false, held: true });
  });
});

describe('carts over REST', () => {
  const viewer: Principal = { ...operator, id: 'tok_3', role: 'viewer' };
  const get = (path: string, as = operator) =>
    handleApi(new Request(`https://app.test/api/v1/${path}`), as);
  const cart = (patch: Partial<Cart> = {}): Cart => ({
    id: 'cart_1',
    title: 'Q4 restock',
    status: 'open',
    customerId: 'cus_northwind',
    flowId: 'tpl-b2b-order',
    external: null,
    lines: [{ id: 'l1', sku: 'WID-100', qty: 2 }],
    promoCodes: [],
    shipTo: null,
    shippingOption: null,
    quote: null,
    quotedVersion: 2,
    issues: [],
    orderId: null,
    createdBy: 'tok_1',
    createdAt: 1,
    updatedAt: 2,
    version: 2,
    ...patch,
  });
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
    audit.mockReset();
  });

  it('lets a viewer list and read, without the chat or an external cart', async () => {
    listCarts.mockResolvedValueOnce([
      { ...cart(), pluginId: null, sessionRef: null, buyerId: null, lines: undefined },
    ]);
    const listed = await get('carts?status=open&limit=5', viewer);
    expect(listed.status).toBe(200);
    expect(listCarts).toHaveBeenLastCalledWith({ status: 'open' }, 5);
    const [row] = ((await listed.json()) as { carts: Record<string, unknown>[] }).carts;
    expect(row).toMatchObject({ id: 'cart_1', status: 'open' });
    expect(row).not.toHaveProperty('buyerId');
    expect((await get('carts?status=lost', viewer)).status).toBe(400);

    engine.cartSnapshot.mockResolvedValueOnce({
      cart: cart(),
      members: [],
      chat: [{ body: 'chat-only-words' }],
    });
    const read = await get('carts/cart_1', viewer);
    const body = (await read.json()) as { cart: Record<string, unknown> };
    expect(body.cart).toMatchObject({
      id: 'cart_1',
      quoteCurrent: false,
      notReady: 'The cart could not be priced.',
    });
    expect(JSON.stringify(body)).not.toContain('chat-only-words');
    engine.cartSnapshot.mockResolvedValueOnce({ cart: cart({ external: {} as Cart['external'] }) });
    expect((await get('carts/cart_1', viewer)).status).toBe(404);
    engine.cartSnapshot.mockResolvedValueOnce(null);
    expect((await get('carts/cart_x', viewer)).status).toBe(404);
  });

  it('refuses a viewer every change before it reaches the engine', async () => {
    for (const [path, b] of [
      ['carts', { title: 'x', flowId: 'tpl-b2b-order' }],
      ['carts/cart_1/ops', { op: 'clear' }],
      ['carts/cart_1/submit', {}],
      ['carts/cart_1/cancel', {}],
    ] as const)
      expect((await post(path, b, viewer)).status, path).toBe(403);
    expect(engine.createCart).not.toHaveBeenCalled();
    expect(engine.changeCart).not.toHaveBeenCalled();
    expect(engine.submitCart).not.toHaveBeenCalled();
  });

  it('opens a cart as the caller, whatever the body says, and audits it', async () => {
    expect((await post('carts', { flowId: 'tpl-b2b-order' })).status).toBe(400);
    engine.createCart.mockResolvedValueOnce({ ok: false, error: 'No such customer.' });
    const refused = await post('carts', {
      title: 'x',
      flowId: 'tpl-b2b-order',
      customerId: 'cus_x',
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'No such customer.' });

    engine.createCart.mockResolvedValueOnce({ ok: true, id: 'cart_1' });
    engine.cartSnapshot.mockResolvedValueOnce({ cart: cart() });
    const made = await post('carts', {
      title: ' Q4 ',
      flowId: 'tpl-b2b-order',
      createdBy: 'usr_ceo',
    });
    expect(made.status).toBe(201);
    expect(engine.createCart).toHaveBeenLastCalledWith({
      title: 'Q4',
      flowId: 'tpl-b2b-order',
      createdBy: 'tok_1',
    });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'cart.created', {
      actor: operator,
      target: 'cart_1',
      detail: { flowId: 'tpl-b2b-order', via: 'api' },
    });
  });

  it('applies a validated op as the caller, and shapes refusals', async () => {
    expect((await post('carts/cart_1/ops', { op: 'add', sku: 'WID-100', qty: 0 })).status).toBe(
      400,
    );
    expect((await post('carts/cart_1/ops', { op: 'explode' })).status).toBe(400);
    expect(engine.changeCart).not.toHaveBeenCalled();

    engine.changeCart.mockResolvedValueOnce({ ok: true, cart: { id: 'cart_1' } });
    const ok = await post('carts/cart_1/ops', { op: 'add', sku: ' WID-100 ', qty: 3 });
    expect(ok.status).toBe(200);
    expect(engine.changeCart).toHaveBeenLastCalledWith(
      'cart_1',
      { op: 'add', sku: 'WID-100', qty: 3 },
      expect.any(String),
    );
    expect(await actorOf(engine.changeCart.mock.calls.at(-1)![2], 'cart:cart_1')).toEqual({
      kind: 'staff',
      id: 'tok_1',
      name: 'ci',
      role: 'operator',
    });
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'cart.changed', {
      actor: operator,
      target: 'cart_1',
      detail: { op: 'add', via: 'api' },
    });
    audit.mockClear();
    engine.changeCart.mockResolvedValueOnce({ ok: false, error: 'The cart is locked.' });
    const locked = await post('carts/cart_1/ops', { op: 'clear' });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ error: 'The cart is locked.' });
    engine.changeCart.mockResolvedValueOnce({ ok: false, error: 'No such cart.', notFound: true });
    expect((await post('carts/cart_x/ops', { op: 'clear' })).status).toBe(404);
    // Only a change that went in is recorded.
    expect(audit).not.toHaveBeenCalled();

    // A ship-to reaches the engine bounded and trimmed, without fields it doesn't know.
    expect(
      (await post('carts/cart_1/ops', { op: 'set_ship_to', address: { line1: 'x'.repeat(201) } }))
        .status,
    ).toBe(400);
    expect((await post('carts/cart_1/ops', { op: 'set_shipping_option', option: '' })).status).toBe(
      400,
    );
    engine.changeCart.mockResolvedValueOnce({ ok: true, cart: { id: 'cart_1' } });
    const shipped = await post('carts/cart_1/ops', {
      op: 'set_ship_to',
      address: { line1: ' 1 Main St ', city: 'Austin', postalCode: '78701', country: 'US', x: 1 },
    });
    expect(shipped.status).toBe(200);
    expect(engine.changeCart).toHaveBeenLastCalledWith(
      'cart_1',
      {
        op: 'set_ship_to',
        address: { line1: '1 Main St', city: 'Austin', postalCode: '78701', country: 'US' },
      },
      expect.any(String),
    );
    // The audit names the op, never the address.
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'cart.changed', {
      actor: operator,
      target: 'cart_1',
      detail: { op: 'set_ship_to', via: 'api' },
    });

    // Several quantities go as one op, bounded before they reach the engine.
    engine.changeCart.mockClear();
    for (const lines of [[], [{ lineId: 'li_1', qty: -1 }], [{ lineId: 'li_1' }]])
      expect((await post('carts/cart_1/ops', { op: 'set_qtys', lines })).status).toBe(400);
    expect(engine.changeCart).not.toHaveBeenCalled();
    engine.changeCart.mockResolvedValueOnce({ ok: true, cart: { id: 'cart_1' } });
    const set = await post('carts/cart_1/ops', {
      op: 'set_qtys',
      lines: [
        { lineId: 'li_1', qty: 4, unitPrice: 0 },
        { lineId: 'li_2', qty: 0 },
      ],
    });
    expect(set.status).toBe(200);
    expect(engine.changeCart).toHaveBeenCalledTimes(1);
    expect(engine.changeCart).toHaveBeenLastCalledWith(
      'cart_1',
      {
        op: 'set_qtys',
        lines: [
          { lineId: 'li_1', qty: 4 },
          { lineId: 'li_2', qty: 0 },
        ],
      },
      expect.any(String),
    );
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'cart.changed', {
      actor: operator,
      target: 'cart_1',
      detail: { op: 'set_qtys', via: 'api' },
    });
  });

  it('holds a submit to the version the caller read, by ETag or body', async () => {
    engine.cartSnapshot.mockResolvedValueOnce({ cart: cart({ version: 7 }) });
    const read = await get('carts/cart_1');
    expect(read.headers.get('etag')).toBe('"7"');
    const submit = (headers: Record<string, string>, b: unknown = {}) =>
      handleApi(
        new Request('https://app.test/api/v1/carts/cart_1/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(b),
        }),
        operator,
      );
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_1' });
    expect((await submit({ 'if-match': '"7"' })).status).toBe(201);
    expect(engine.submitCart).toHaveBeenLastCalledWith('cart_1', expect.anything(), 7);
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_2' });
    await submit({}, { version: 8 });
    expect(engine.submitCart).toHaveBeenLastCalledWith('cart_1', expect.anything(), 8);
    // Optional: without either, the engine isn't asked to hold it.
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_3' });
    await submit({});
    expect(engine.submitCart).toHaveBeenLastCalledWith('cart_1', expect.anything(), undefined);

    engine.submitCart.mockResolvedValueOnce({
      ok: false,
      error: 'The cart changed since you confirmed; preview it again.',
    });
    const moved = await submit({ 'if-match': 'W/"7"' });
    expect(moved.status).toBe(412);
    expect(await moved.json()).toEqual({
      error: 'The cart has changed since version 7; read it again',
    });
    engine.submitCart.mockClear();
    expect((await submit({ 'if-match': '"seven"' })).status).toBe(400);
    expect((await submit({ 'if-match': '"7"' }, { version: 8 })).status).toBe(400);
    expect((await submit({}, { version: 0 })).status).toBe(400);
    expect(engine.submitCart).not.toHaveBeenCalled();
  });

  it('submits once, recording the order it started, and cancels', async () => {
    engine.submitCart.mockResolvedValueOnce({ ok: false, error: 'Add at least one line.' });
    expect((await post('carts/cart_1/submit', {})).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_9' });
    const done = await post('carts/cart_1/submit', {});
    expect(done.status).toBe(201);
    expect(await done.json()).toEqual({ orderId: 'ord_9', cartId: 'cart_1' });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'order.started', {
      actor: operator,
      target: 'ord_9',
      detail: { cartId: 'cart_1', via: 'api' },
    });

    engine.cancelCart.mockResolvedValueOnce({ ok: false, error: 'The cart is submitted.' });
    expect((await post('carts/cart_1/cancel', {})).status).toBe(409);
    engine.cancelCart.mockResolvedValueOnce({
      ok: true,
      cart: { id: 'cart_2', status: 'canceled' },
    });
    expect((await post('carts/cart_2/cancel', {})).status).toBe(200);
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'cart.canceled', {
      actor: operator,
      target: 'cart_2',
      detail: { via: 'api' },
    });
  });
});

describe('request validation', () => {
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset();
  });

  it('refuses malformed and oversized bodies before reaching the engine', async () => {
    expect((await post('orders/ord_x/approvals/mgr', { decision: 'maybe' })).status).toBe(400);
    expect((await post('orders/ord_x/events', { event: 42 })).status).toBe(400);
    expect(
      (await post('orders/ord_x/events', { event: 'x', payload: { blob: 'a'.repeat(40_000) } }))
        .status,
    ).toBe(400);
    expect((await post('orders/ord_x/cancel', { reason: 'r'.repeat(501) })).status).toBe(400);
    const huge = await post('orders/ord_x/cancel', { reason: 'r'.repeat(2 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(engine.decide).not.toHaveBeenCalled();
    expect(engine.sendEvent).not.toHaveBeenCalled();
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it('answers an engine failure without its internals', async () => {
    engine.cancel.mockRejectedValueOnce(new Error('D1_ERROR: no such table: orders'));
    const res = await post('orders/ord_x/cancel', {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
  });
});

describe('signed events', () => {
  const send = async (raw: string, signature: string) =>
    handleSignedEvent(
      new Request('https://app.test/api/v1/webhooks/events', {
        method: 'POST',
        headers: { 'x-commerceworker-signature': signature },
        body: raw,
      }),
    );

  beforeEach(() => {
    receipts = new InMemoryWebhookReceipts();
    engine.sendEvent.mockReset();
  });

  const sign = (raw: string, keyId = 'int_pay', secret = 'whsec_test') =>
    signWebhook(secret, raw, undefined, keyId);

  it('delivers a signed event once, and lets a sender retry one nothing was waiting for', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    const signature = await sign(raw);
    engine.sendEvent.mockResolvedValueOnce({ delivered: false });
    expect((await send(raw, signature)).status).toBe(409);
    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    expect((await send(raw, signature)).status).toBe(200);
    const replay = await send(raw, signature);
    expect(await replay.json()).toEqual({ delivered: true, duplicate: true });
    expect(engine.sendEvent).toHaveBeenCalledTimes(2);
  });

  it('answers 202 for an event the order holds, and takes a resend as the same delivery', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    const signature = await sign(raw);
    engine.sendEvent.mockResolvedValueOnce({ delivered: false, held: true });
    const held = await send(raw, signature);
    expect(held.status).toBe(202);
    expect(await held.json()).toEqual({ delivered: false, held: true });
    // Held counts as taken: the sender's resend isn't delivered or held a second time.
    expect(await (await send(raw, signature)).json()).toEqual({ delivered: true, duplicate: true });
    expect(engine.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('stamps the integration on a signed event, and refuses one naming its source', async () => {
    const raw = JSON.stringify({
      orderId: 'ord_x',
      event: 'payment.received',
      payload: { amount: 5 },
    });
    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    expect((await send(raw, await sign(raw))).status).toBe(200);
    expect(engine.sendEvent.mock.calls.at(-1)![2]).toMatchObject({ amount: 5, source: 'webhook' });
    expect(String(engine.sendEvent.mock.calls.at(-1)![2].by)).toMatch(/^integration:/);
    const forged = JSON.stringify({
      orderId: 'ord_x',
      event: 'payment.received',
      payload: { source: 'stripe' },
    });
    expect((await send(forged, await sign(forged))).status).toBe(422);
    expect(engine.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('treats a respelled copy of a delivered event as the same delivery', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    const signature = await sign(raw);
    engine.sendEvent.mockResolvedValue({ delivered: true, nodeId: 'pay' });
    expect((await send(raw, signature)).status).toBe(200);
    // The same signature with its hex upper-cased, or with another v1 in front, still verifies:
    // it must still be the same receipt.
    const hex = /v1=([0-9a-f]+)/.exec(signature)![1]!;
    for (const copy of [
      signature.replace(hex, hex.toUpperCase()),
      signature.replace(`v1=${hex}`, `v1=00,v1=${hex}`),
    ])
      expect(await (await send(raw, copy)).json()).toEqual({ delivered: true, duplicate: true });
    expect(engine.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('treats a copy signed with only the old secret, during a rotation, as the same delivery', async () => {
    keys.int_pay!.previousSecret = 'whsec_old';
    keys.int_pay!.previousExpiresAt = Date.now() + 86_400_000;
    try {
      const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
      const t = Math.floor(Date.now() / 1000);
      engine.sendEvent.mockResolvedValue({ delivered: true, nodeId: 'pay' });
      // Signed under both secrets, as a sender does while it rolls them.
      const both = await signWebhook(['whsec_test', 'whsec_old'], raw, t, 'int_pay');
      expect((await send(raw, both)).status).toBe(200);
      const oldOnly = await signWebhook('whsec_old', raw, t, 'int_pay');
      expect(await (await send(raw, oldOnly)).json()).toEqual({ delivered: true, duplicate: true });
      expect(engine.sendEvent).toHaveBeenCalledTimes(1);
    } finally {
      keys.int_pay!.previousSecret = null;
      keys.int_pay!.previousExpiresAt = null;
    }
  });

  it('refuses a key that names no integration, an unknown one, or the wrong secret', async () => {
    const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    expect((await send(raw, await signWebhook('whsec_test', raw))).status).toBe(401);
    expect((await send(raw, await sign(raw, 'int_nope'))).status).toBe(401);
    expect((await send(raw, await sign(raw, 'int_pay', 'whsec_other'))).status).toBe(401);
    expect(engine.sendEvent).not.toHaveBeenCalled();
  });

  it("keeps an integration to its events and its channel's orders", async () => {
    const ship = JSON.stringify({ orderId: 'ord_x', event: 'shipment.delivered' });
    const refused = await send(ship, await sign(ship));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'This integration may not deliver shipment.delivered',
    });

    const pos = JSON.stringify({ orderId: 'ord_pos', event: 'payment.received' });
    expect((await send(pos, await sign(pos, 'int_web', 'whsec_web'))).status).toBe(403);
    const missing = JSON.stringify({ orderId: 'ord_missing', event: 'payment.received' });
    expect((await send(missing, await sign(missing, 'int_web', 'whsec_web'))).status).toBe(404);

    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    const web = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
    expect((await send(web, await sign(web, 'int_web', 'whsec_web'))).status).toBe(200);
    expect(engine.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("spends only a verified integration's budget, and answers 429 once it runs out", async () => {
    const spent: string[] = [];
    env.WEBHOOK_LIMIT = {
      limit: async ({ key }: { key: string }) => {
        spent.push(key);
        return { success: spent.length < 2 };
      },
    };
    try {
      const raw = JSON.stringify({ orderId: 'ord_x', event: 'payment.received' });
      // A forged signature is refused before it can use up the real sender's budget.
      expect((await send(raw, await sign(raw, 'int_pay', 'whsec_other'))).status).toBe(401);
      expect(spent).toEqual([]);
      engine.sendEvent.mockResolvedValue({ delivered: true, nodeId: 'pay' });
      expect((await send(raw, await sign(raw))).status).toBe(200);
      const limited = await send(raw, await sign(raw));
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(spent).toEqual(['int_pay', 'int_pay']);
      expect(engine.sendEvent).toHaveBeenCalledTimes(1);
    } finally {
      delete env.WEBHOOK_LIMIT;
    }
  });
});

describe('integrations over REST', () => {
  beforeEach(() => audit.mockReset());

  it('creates a key, shows its secret once, and records who did', async () => {
    integrations.createIntegration.mockResolvedValueOnce({
      integration: { id: 'int_new', name: 'Stripe' },
      secret: 'whsec_abc',
    });
    const res = await post('integrations', { name: 'Stripe', events: ['payment.received'] }, admin);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ secret: 'whsec_abc' });
    expect(integrations.createIntegration).toHaveBeenCalledWith(
      { name: 'Stripe', events: ['payment.received'], startOrders: false, flows: [] },
      'ops@example.com',
    );
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'integration.created', {
      actor: admin,
      target: 'Stripe',
      detail: { id: 'int_new' },
    });
  });

  it('rotates and revokes, 404 for an unknown key, and needs an admin', async () => {
    integrations.rotateIntegration.mockResolvedValueOnce({
      integration: { name: 'Stripe' },
      secret: 'whsec_2',
    });
    expect((await post('integrations/int_new/rotate', {}, admin)).status).toBe(200);
    integrations.rotateIntegration.mockResolvedValueOnce(null);
    expect((await post('integrations/int_nope/rotate', {}, admin)).status).toBe(404);
    integrations.revokeIntegration.mockResolvedValueOnce({
      ok: true,
      integration: { name: 'Stripe' },
      audit: { action: 'integration.revoked', target: 'Stripe', detail: { id: 'int_new' } },
    });
    const del = await handleApi(
      new Request('https://app.test/api/v1/integrations/int_new', { method: 'DELETE' }),
      admin,
    );
    expect(del.status).toBe(200);
    expect(audit.mock.calls.map((c) => c[1])).toEqual([
      'integration.rotated',
      'integration.revoked',
    ]);
    // Operators run orders and flows; keys, webhooks and the audit log are an admin's.
    for (const path of [
      'integrations',
      'webhook-subscriptions',
      'audit-events',
      'audit-events/verify',
    ])
      expect(
        (await handleApi(new Request(`https://app.test/api/v1/${path}`), operator)).status,
      ).toBe(403);
  });
});

describe('webhook subscriptions over REST', () => {
  beforeEach(() => audit.mockReset());

  it('rotates a signing secret, shows it once and records who did; 404 for an unknown one', async () => {
    webhooks.rotateSubscription.mockResolvedValueOnce({
      subscription: { id: 'whs_1', url: 'https://hooks.example/a' },
      secret: 'whsec_next',
    });
    const res = await post('webhook-subscriptions/whs_1/rotate', {}, admin);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ secret: 'whsec_next' });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'webhook.rotated', {
      actor: admin,
      target: 'https://hooks.example/a',
      detail: { id: 'whs_1', via: 'api' },
    });
    webhooks.rotateSubscription.mockResolvedValueOnce(null);
    expect((await post('webhook-subscriptions/whs_nope/rotate', {}, admin)).status).toBe(404);
    expect((await post('webhook-subscriptions/whs_1/rotate', {}, operator)).status).toBe(403);
  });
});

describe('removing a webhook subscription over REST', () => {
  beforeEach(() => audit.mockReset());
  const del = (path: string, as = admin) =>
    handleApi(new Request(`https://app.test/api/v1/${path}`, { method: 'DELETE' }), as);

  it('records what the use-case asks, via the API; 404 when nothing was removed', async () => {
    webhooks.deleteSubscription.mockResolvedValueOnce({
      ok: true,
      audit: { action: 'webhook.unsubscribed', target: 'whs_1', detail: {} },
    });
    expect((await del('webhook-subscriptions/whs_1')).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'webhook.unsubscribed', {
      actor: admin,
      target: 'whs_1',
      detail: { via: 'api' },
    });
    webhooks.deleteSubscription.mockResolvedValueOnce({ ok: false, error: 'No such one.' });
    expect((await del('webhook-subscriptions/whs_nope')).status).toBe(404);
    expect((await del('webhook-subscriptions/whs_1', operator)).status).toBe(403);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

describe('hosted checkout’s settings over REST', () => {
  beforeEach(() => audit.mockReset());
  const settings = {
    storeName: 'Acme Supply',
    checkout: { enabled: true, checkoutFlowId: 'tpl-checkout', editLines: false },
  };

  it('shows the settings, to an admin only', async () => {
    storefront.storefrontAdmin.mockResolvedValueOnce(settings);
    const res = await handleApi(new Request('https://app.test/api/v1/storefront'), admin);
    expect(await res.json()).toEqual({ settings });
    expect(
      (await handleApi(new Request('https://app.test/api/v1/storefront'), operator)).status,
    ).toBe(403);
  });

  it('saves them and audits what changed, or refuses with 422 and audits nothing', async () => {
    storefront.setStorefrontSettings.mockResolvedValueOnce({
      ok: true,
      settings,
      audit: { action: 'checkout.settings', detail: { enabled: true } },
    });
    const ok = await post('storefront/settings', settings, admin);
    expect(await ok.json()).toEqual({ settings });
    expect(storefront.setStorefrontSettings).toHaveBeenCalledWith(settings, expect.any(String));
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'checkout.settings', {
      actor: admin,
      detail: { enabled: true },
    });
    storefront.setStorefrontSettings.mockResolvedValueOnce({ ok: false, error: 'Needs a card.' });
    const refused = await post('storefront/settings', settings, admin);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'Needs a card.' });
    expect(
      (await post('storefront/settings', { checkout: { enabled: 'yes' } }, admin)).status,
    ).toBe(400);
    expect((await post('storefront/settings', settings, operator)).status).toBe(403);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('refuses a store name that is blank, too long, or has a control character, saving nothing', async () => {
    storefront.setStorefrontSettings.mockClear();
    for (const storeName of ['', '   ', 'x'.repeat(61), 'Acme\nSupply', 'Acme\u0000', 7]) {
      const res = await post('storefront/settings', { ...settings, storeName }, admin);
      expect(res.status, JSON.stringify(storeName)).toBe(400);
    }
    expect(storefront.setStorefrontSettings).not.toHaveBeenCalled();
    // Trimmed on the way in; markup is just text and is kept as typed (the pages render text only).
    storefront.setStorefrontSettings.mockResolvedValueOnce({
      ok: true,
      settings,
      audit: { action: 'checkout.settings', detail: {} },
    });
    await post('storefront/settings', { ...settings, storeName: '  <b>Acme</b>  ' }, admin);
    expect(storefront.setStorefrontSettings).toHaveBeenCalledWith(
      { ...settings, storeName: '<b>Acme</b>' },
      expect.any(String),
    );
  });

  it('passes a left-out name on as left out (kept), and null as null (cleared)', async () => {
    const result = {
      ok: true,
      settings,
      audit: { action: 'checkout.settings', detail: {} },
    };
    storefront.setStorefrontSettings.mockResolvedValue(result);
    const { storeName: _name, ...without } = settings;
    expect((await post('storefront/settings', without, admin)).status).toBe(200);
    expect(storefront.setStorefrontSettings).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ storeName: expect.anything() }),
      expect.any(String),
    );
    expect(
      (storefront.setStorefrontSettings.mock.lastCall![0] as Record<string, unknown>).storeName,
    ).toBeUndefined();
    await post('storefront/settings', { ...settings, storeName: null }, admin);
    expect(storefront.setStorefrontSettings).toHaveBeenLastCalledWith(
      { ...settings, storeName: null },
      expect.any(String),
    );
  });
});

describe('agentic checkout over REST', () => {
  beforeEach(() => audit.mockReset());
  const settings = { checkoutFlowId: 'tpl-checkout', links: [], orderUrl: null, productUrl: null };

  it('shows the settings and platforms, and is an admin’s', async () => {
    ucp.ucpAdmin.mockResolvedValueOnce({ settings, platforms: [] });
    const res = await handleApi(new Request('https://app.test/api/v1/ucp'), admin);
    expect(await res.json()).toEqual({ settings, platforms: [] });
    expect((await handleApi(new Request('https://app.test/api/v1/ucp'), operator)).status).toBe(
      403,
    );
  });

  it('saves settings and records the flow they switch, or refuses with 422 and records nothing', async () => {
    ucp.setUcpSettings.mockResolvedValueOnce({
      ok: true,
      settings,
      audit: { action: 'ucp.settings', detail: { from: null, to: 'tpl-checkout' } },
    });
    const ok = await post('ucp/settings', settings, admin);
    expect(await ok.json()).toEqual({ settings });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'ucp.settings', {
      actor: admin,
      detail: { from: null, to: 'tpl-checkout' },
    });
    ucp.setUcpSettings.mockResolvedValueOnce({ ok: false, error: 'Needs a card.' });
    const refused = await post('ucp/settings', settings, admin);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'Needs a card.' });
    expect((await post('ucp/settings', { checkoutFlowId: 7 }, admin)).status).toBe(400);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('takes only exact https return addresses with a platform, and records them', async () => {
    const platform = {
      id: 'ucp_1',
      name: 'Agent',
      profileUrl: 'https://agent.example/p',
      redirectUris: ['https://agent.example/cb'],
    };
    ucp.addPlatform.mockResolvedValueOnce({ platform, key: 'cmw_ucp_x' });
    const ok = await post(
      'ucp/platforms',
      {
        name: 'Agent',
        profileUrl: 'https://agent.example/p',
        redirectUris: ['https://agent.example/cb'],
      },
      admin,
    );
    expect(ok.status).toBe(201);
    expect(ucp.addPlatform.mock.calls[0]![0]).toMatchObject({
      redirectUris: ['https://agent.example/cb'],
    });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'ucp.platform_added', {
      actor: admin,
      target: 'Agent',
      detail: expect.objectContaining({ redirectUris: ['https://agent.example/cb'] }),
    });
    for (const bad of [
      ['http://agent.example/cb'],
      ['https://agent.example/cb#x'],
      ['https://u:p@agent.example/cb'],
      ['agent://cb'],
      ['https://agent.example/cb', 'https://agent.example/cb'],
      Array.from({ length: 11 }, (_, i) => `https://agent.example/cb${i}`),
    ]) {
      const res = await post(
        'ucp/platforms',
        { name: 'Agent', profileUrl: 'https://agent.example/p', redirectUris: bad },
        admin,
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(ucp.addPlatform).toHaveBeenCalledTimes(1);
  });

  it('revokes a platform and names it in the audit log; 404 when it is unknown or already revoked', async () => {
    const revoke = () =>
      handleApi(
        new Request('https://app.test/api/v1/ucp/platforms/ucp_1', { method: 'DELETE' }),
        admin,
      );
    ucp.revokePlatform.mockResolvedValueOnce({
      ok: true,
      audit: { action: 'ucp.platform_revoked', target: 'Agent', detail: { id: 'ucp_1' } },
    });
    expect((await revoke()).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'ucp.platform_revoked', {
      actor: admin,
      target: 'Agent',
      detail: { id: 'ucp_1' },
    });
    ucp.revokePlatform.mockResolvedValueOnce({ ok: false, error: 'Already.' });
    expect((await revoke()).status).toBe(404);
  });
});

describe('order list paging', () => {
  it('round-trips a cursor and refuses one it did not issue', async () => {
    const { decodeCursor, encodeCursor } = await import('~/lib/cursor');
    const c = { createdAt: 1_790_000_000_000, id: 'ord_abc:1' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not-base64!')).toBeNull();
    expect(decodeCursor(btoa('later:ord_1'))).toBeNull();
    const res = await handleApi(
      new Request('https://app.test/api/v1/orders?cursor=bogus'),
      operator,
    );
    expect(res.status).toBe(400);
  });
});

describe('data subject requests over REST', () => {
  beforeEach(() => audit.mockReset());

  it("are an admin's, and the audit log names the person only by a hash", async () => {
    expect((await post('data-subjects/erase', { email: 'jane@example.com' })).status).toBe(403);
    expect((await post('data-subjects/erase', { email: 'not an email' }, admin)).status).toBe(400);

    engine.eraseDataSubject.mockResolvedValueOnce({
      ok: true,
      done: true,
      orders: 2,
      customers: 1,
      documents: 3,
      messages: 1,
      inboundEmails: 0,
      teamMember: false,
    });
    const res = await post('data-subjects/erase', { email: 'Jane@Example.com' }, admin);
    expect(res.status).toBe(200);
    expect(engine.eraseDataSubject).toHaveBeenCalledWith('Jane@Example.com');
    const [, action, event] = audit.mock.calls[0]!;
    expect(action).toBe('personal_data.erased');
    expect(event.target).toMatch(/^subject:[0-9a-f]{16}$/);
    expect(JSON.stringify(event)).not.toMatch(/jane/i);

    // The same person hashes the same, whatever the case.
    engine.exportDataSubject.mockResolvedValueOnce({ orders: [], customers: [] });
    const exported = await post('data-subjects/export', { email: ' jane@example.com' }, admin);
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    expect(audit.mock.calls[1]![2].target).toBe(event.target);
  });

  it('answers 409 while their orders still run', async () => {
    engine.eraseDataSubject.mockResolvedValueOnce({
      ok: false,
      reason: 'active_orders',
      orders: ['ord_1'],
    });
    const res = await post('data-subjects/erase', { email: 'jane@example.com' }, admin);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ orders: ['ord_1'] });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('plugins over REST', () => {
  const get = (path: string, as = admin) =>
    handleApi(new Request(`https://app.test/api/v1/${path}`), as);

  it('lists the installed plugins and what uses one, for an admin', async () => {
    expect((await get('plugins', operator)).status).toBe(403);
    expect(await (await get('plugins')).json()).toEqual({
      plugins: [
        {
          id: 'example',
          runtime: 'worker',
          source: 'deployment',
          name: 'Example',
          version: '1',
          nodes: ['example.stamp'],
          events: ['order.completed'],
          provides: [],
          healthy: true,
        },
        {
          id: 'broken',
          runtime: 'sandboxed',
          source: 'installed',
          name: null,
          version: null,
          nodes: [],
          events: [],
          provides: [],
          healthy: false,
          error: 'apiVersion must be 1',
        },
      ],
    });
    expect(await (await get('plugins/example/usage')).json()).toEqual({
      flows: [{ id: 'f1', version: 2 }],
      orders: [],
      labels: [],
    });
    expect(engine.pluginUsage).toHaveBeenCalledWith('example');
    expect((await get('plugins/Not_An_Id/usage')).status).toBe(404);
  });
});

describe('installing plugins over REST', () => {
  const review = { id: 'acme-carrier', sha: 'a'.repeat(64), version: '2', publisher: 'acme' };
  const upload = (text: string, as = admin) =>
    handleApi(new Request('https://app.test/api/v1/plugins', { method: 'POST', body: text }), as);

  beforeEach(() => {
    audit.mockReset();
    engine.uploadPlugin.mockReset();
    engine.setPluginEnabled.mockReset();
  });

  it('uploads a signed file for review, and audits it', async () => {
    engine.uploadPlugin.mockResolvedValueOnce({
      ok: true,
      value: { ...review, status: 'pending' },
    });
    expect((await upload('{}', operator)).status).toBe(403);
    const res = await upload('{"format":1}');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'acme-carrier', status: 'pending' });
    expect(engine.uploadPlugin).toHaveBeenCalledWith('{"format":1}', admin.id);
    expect(audit.mock.calls[0]?.[1]).toBe('plugin.uploaded');
    expect(audit.mock.calls[0]?.[2]).toMatchObject({
      target: 'acme-carrier',
      detail: { version: '2', publisher: 'acme', sha: 'a'.repeat(12) },
    });
  });

  it('answers a refusal with its reason, audited, and never approves', async () => {
    engine.uploadPlugin.mockResolvedValueOnce({
      ok: false,
      error: '“nobody” is not a publisher this deployment trusts',
    });
    const res = await upload('{}');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: '“nobody” is not a publisher this deployment trusts',
    });
    expect(audit.mock.calls[0]?.[1]).toBe('plugin.refused');
    expect(engine.approvePlugin).not.toHaveBeenCalled();
    expect((await post('plugins/acme-carrier/approve', {}, admin)).status).toBe(404);
  });

  it('refuses a file larger than a plugin may be, before the engine sees it', async () => {
    const res = await upload('x'.repeat(5 * 1024 * 1024 + 2));
    expect(res.status).toBe(413);
    expect(engine.uploadPlugin).not.toHaveBeenCalled();
  });

  it('turns a plugin off', async () => {
    engine.setPluginEnabled.mockResolvedValueOnce({ ok: true, value: { id: 'acme-carrier' } });
    const res = await post('plugins/acme-carrier/disable', {}, admin);
    expect(await res.json()).toEqual({ id: 'acme-carrier', status: 'disabled' });
    expect(engine.setPluginEnabled).toHaveBeenCalledWith('acme-carrier', false);
    expect(audit.mock.calls[0]?.[1]).toBe('plugin.disabled');
    expect((await post('plugins/acme-carrier/disable', {}, operator)).status).toBe(403);
    engine.setPluginEnabled.mockResolvedValueOnce({
      ok: false,
      error: 'example is not installed at runtime',
    });
    const registry = await post('plugins/example/disable', {}, admin);
    expect(registry.status).toBe(400);
    expect(await registry.json()).toEqual({ error: 'example is not installed at runtime' });
  });
});

describe('operations REST runs as MCP does', () => {
  const viewer: Principal = { ...operator, id: 'tok_v', role: 'viewer' };
  const person: Principal = {
    kind: 'user',
    id: 'usr_1',
    name: 'ann@example.com',
    role: 'operator',
  };
  const run = engine.runOperation;

  beforeEach(() => run.mockReset());

  it("runs the route's tool with the path's fields over the body's, signed for that operation", async () => {
    run.mockResolvedValueOnce({ ok: true, value: { done: 'Restarted the order' } });
    const res = await post('orders/ord_1/restart', { orderId: 'ord_other' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: 'Restarted the order' });
    const [tool, input, signed, key] = run.mock.calls.at(-1)!;
    expect([tool, input, key]).toEqual(['restart_order', { orderId: 'ord_1' }, undefined]);
    expect(
      await actorOf(signed, await operationCall('restart_order', { orderId: 'ord_1' })),
    ).toEqual({
      kind: 'staff',
      id: 'tok_1',
      name: 'ops@example.com',
      role: 'operator',
    });
  });

  it('says a person is acting only for a signed-in person, and passes the Idempotency-Key', async () => {
    run.mockResolvedValue({ ok: true, value: {} });
    await handleApi(
      new Request('https://app.test/api/v1/customers/cus_1/tax-certificates/txc_1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
        body: '{}',
      }),
      person,
    );
    const [tool, input, signed, key] = run.mock.calls.at(-1)!;
    expect([tool, input, key]).toEqual([
      'verify_tax_certificate',
      { customerId: 'cus_1', certificateId: 'txc_1' },
      'k-1',
    ]);
    expect(
      await actorOf(
        signed,
        await operationCall('verify_tax_certificate', {
          customerId: 'cus_1',
          certificateId: 'txc_1',
        }),
      ),
    ).toMatchObject({
      id: 'usr_1',
      person: true,
    });
  });

  it("reads a GET's query as the tool's types, and leaves out what the tool doesn't take", async () => {
    run.mockResolvedValueOnce({ ok: true, value: { products: [] } });
    const res = await handleApi(
      new Request('https://app.test/api/v1/stock?q=123&belowReorder=true&nope=1'),
      viewer,
    );
    expect(res.status).toBe(200);
    const [tool, input] = run.mock.calls.at(-1)!;
    expect([tool, input]).toEqual(['find_products', { q: '123', belowReorder: true }]);
  });

  it('lists exchange rates for an operator and sets one for an admin, the path naming the currency', async () => {
    const admin: Principal = { ...person, role: 'admin' };
    run.mockResolvedValueOnce({ ok: true, value: { base: 'USD', rates: [] } });
    const listed = await handleApi(new Request('https://app.test/api/v1/fx-rates'), operator);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ base: 'USD', rates: [] });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual(['list_fx_rates', {}]);
    expect((await handleApi(new Request('https://app.test/api/v1/fx-rates'), viewer)).status).toBe(
      403,
    );

    run.mockResolvedValueOnce({ ok: true, value: { done: 'Set the EUR rate to 0.95 per USD' } });
    const set = await handleApi(
      new Request('https://app.test/api/v1/fx-rates/EUR', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rate: 0.95, currency: 'GBP' }),
      }),
      admin,
    );
    expect(set.status).toBe(200);
    const [tool, input, signed] = run.mock.calls.at(-1)!;
    expect([tool, input]).toEqual(['set_fx_rate', { currency: 'EUR', rate: 0.95 }]);
    expect(
      await actorOf(signed, await operationCall('set_fx_rate', { currency: 'EUR', rate: 0.95 })),
    ).toMatchObject({ id: 'usr_1', person: true, role: 'admin' });

    // An operator can't set one; the engine refuses an API token, and a rate it won't take.
    const before = run.mock.calls.length;
    expect((await post('fx-rates/EUR', { rate: 0.95 })).status).toBe(403);
    expect(run).toHaveBeenCalledTimes(before);
    run.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'A person signed in as themselves does this',
    });
    expect(
      (await post('fx-rates/EUR', { rate: 0.95 }, { ...operator, role: 'admin' })).status,
    ).toBe(403);
    run.mockResolvedValueOnce({ ok: false, status: 400, error: 'rate: Invalid input' });
    expect(
      (
        await handleApi(
          new Request('https://app.test/api/v1/fx-rates/EUR', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rate: 'high' }),
          }),
          admin,
        )
      ).status,
    ).toBe(400);
  });

  it('reads and writes companies as the tools do, the path naming the company, the member and the customer', async () => {
    run.mockResolvedValueOnce({ ok: true, value: { companies: [], total: 0, cursor: null } });
    const listed = await handleApi(
      new Request('https://app.test/api/v1/companies?status=active&limit=5&search=acme&nope=1'),
      operator,
    );
    expect(listed.status).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'list_companies',
      { status: 'active', limit: 5, search: 'acme' },
    ]);
    run.mockResolvedValueOnce({ ok: true, value: { members: [], total: 0, cursor: null } });
    await handleApi(
      new Request('https://app.test/api/v1/companies/cus_1/members?role=buyer&companyId=cus_2'),
      operator,
    );
    // The path names the company: a query can't name another.
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'list_company_members',
      { companyId: 'cus_1', role: 'buyer' },
    ]);
    // Reads and writes are an operator's: a viewer reads nothing.
    const before = run.mock.calls.length;
    expect((await handleApi(new Request('https://app.test/api/v1/companies'), viewer)).status).toBe(
      403,
    );
    expect((await post('customers', { name: 'Acme', email: 'a@acme.test' }, viewer)).status).toBe(
      403,
    );
    expect(run).toHaveBeenCalledTimes(before);

    run.mockResolvedValue({ ok: true, value: { done: 'ok' } });
    const members = [{ email: 'a@acme.test', name: 'Ann' }];
    await post('companies/cus_1/members', { members, companyId: 'cus_2' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'put_company_members',
      { companyId: 'cus_1', members },
    ]);
    await post('companies/cus_1/members/mem_1/remove', {});
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'remove_company_member',
      { companyId: 'cus_1', memberId: 'mem_1' },
    ]);
    await post('companies/cus_1/status', { status: 'suspended' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'set_company_status',
      { companyId: 'cus_1', status: 'suspended' },
    ]);
    await post('companies/cus_1/teams', { name: 'Ops' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'put_company_team',
      { companyId: 'cus_1', name: 'Ops' },
    ]);
    await post('customers/cus_1/update', { tier: 'gold', customerId: 'cus_2' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'update_customer',
      { customerId: 'cus_1', tier: 'gold' },
    ]);
    await post('customers', { name: 'Acme', email: 'a@acme.test', company: { taxId: 'GB1' } });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'create_customer',
      { name: 'Acme', email: 'a@acme.test', company: { taxId: 'GB1' } },
    ]);
    run.mockReset();
  });

  it("reads a customer's credit account for a viewer, and lets an admin person set the limit and adjust the balance", async () => {
    const admin: Principal = { ...person, role: 'admin' };
    run.mockResolvedValueOnce({ ok: true, value: { limit: 1_000, entries: [], next: null } });
    const read = await handleApi(
      new Request('https://app.test/api/v1/customers/cus_1/credit?after=5%3Aabc&limit=10'),
      viewer,
    );
    expect(read.status).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'get_credit_account',
      { customerId: 'cus_1', after: '5:abc', limit: 10 },
    ]);

    run.mockResolvedValueOnce({ ok: true, value: { done: 'Set cus_1’s credit limit' } });
    const limit = await handleApi(
      new Request('https://app.test/api/v1/customers/cus_1/credit/limit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 2_500, customerId: 'cus_other' }),
      }),
      admin,
    );
    expect(limit.status).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'set_credit_limit',
      { customerId: 'cus_1', limit: 2_500 },
    ]);

    run.mockResolvedValueOnce({ ok: true, value: { done: 'Lowered cus_1’s balance' } });
    const adjusted = await handleApi(
      new Request('https://app.test/api/v1/customers/cus_1/credit/adjustments', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'adj-1' },
        body: JSON.stringify({ amount: -250, reason: 'Credit memo 41' }),
      }),
      admin,
    );
    expect(adjusted.status).toBe(200);
    const [tool, input, signed, key] = run.mock.calls.at(-1)!;
    expect([tool, input, key]).toEqual([
      'adjust_credit',
      { customerId: 'cus_1', amount: -250, reason: 'Credit memo 41' },
      'adj-1',
    ]);
    expect(await actorOf(signed, await operationCall('adjust_credit', input))).toMatchObject({
      person: true,
      role: 'admin',
    });

    // Changing what a customer owes is an admin's; an operator is refused before the engine.
    const calls = run.mock.calls.length;
    expect((await post('customers/cus_1/credit/limit', { limit: 1 })).status).toBe(403);
    expect(
      (await post('customers/cus_1/credit/adjustments', { amount: -1, reason: 'x' })).status,
    ).toBe(403);
    expect(run).toHaveBeenCalledTimes(calls);
    // The engine refuses a token, which never changes what a customer owes.
    run.mockResolvedValueOnce({ ok: false, status: 403, error: 'A person does this' });
    expect(
      (await post('customers/cus_1/credit/limit', { limit: 1 }, { ...operator, role: 'admin' }))
        .status,
    ).toBe(403);
  });

  it('reads price books as a viewer, with the book from the path and the query typed as the tool takes it', async () => {
    run.mockResolvedValueOnce({ ok: true, value: { books: [], total: 0, next: null } });
    const listed = await handleApi(
      new Request('https://app.test/api/v1/price-books?status=active&limit=5&after=spring'),
      viewer,
    );
    expect(listed.status).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'list_price_books',
      { status: 'active', limit: 5, after: 'spring' },
    ]);
    run.mockResolvedValueOnce({ ok: true, value: { entries: [] } });
    await handleApi(new Request('https://app.test/api/v1/price-books/pb_1?limit=10'), viewer);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'get_price_book',
      { bookId: 'pb_1', limit: 10 },
    ]);
    run.mockResolvedValueOnce({ ok: true, value: { lines: [] } });
    expect(
      (await post('price-preview', { lines: [{ sku: 'WID-100', qty: 3 }] }, viewer)).status,
    ).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'preview_price',
      { lines: [{ sku: 'WID-100', qty: 3 }] },
    ]);
  });

  it('writes price books and contract prices only for an operator, naming the book or customer in the path', async () => {
    const before = run.mock.calls.length;
    for (const [path, body] of [
      ['price-books', { code: 'spring', name: 'Spring' }],
      ['price-books/pb_1/status', { status: 'active' }],
      ['price-books/pb_1/entries', { entries: [{ sku: 'A', price: 1 }] }],
      ['price-books/pb_1/assignments', { tier: 'gold' }],
      ['customers/cus_1/contract-prices', { prices: [{ sku: 'A', price: 1 }] }],
    ] as const)
      expect((await post(path, body, viewer)).status, path).toBe(403);
    expect(run).toHaveBeenCalledTimes(before);

    run.mockResolvedValueOnce({ ok: true, value: { done: 'Added', href: '/price-books/pb_1' } });
    expect(
      (await post('price-books', { code: 'spring', name: 'Spring', priority: 5 })).status,
    ).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'create_price_book',
      { code: 'spring', name: 'Spring', priority: 5 },
    ]);
    run.mockResolvedValueOnce({ ok: true, value: {} });
    await post('price-books/pb_1/status', { status: 'archived', bookId: 'pb_other' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'set_price_book_status',
      { bookId: 'pb_1', status: 'archived' },
    ]);
    run.mockResolvedValueOnce({ ok: true, value: {} });
    await post('customers/cus_1/contract-prices', { prices: [{ sku: 'A', price: null }] });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'put_contract_prices',
      { customerId: 'cus_1', prices: [{ sku: 'A', price: null }] },
    ]);

    // The engine refuses an API token: these change what buyers pay.
    run.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'A person signed in as themselves does this',
    });
    expect((await post('price-books/pb_1/assignments', { tier: 'gold' })).status).toBe(403);
    // A body the tool won't take is a 400.
    run.mockResolvedValueOnce({ ok: false, status: 400, error: 'status: Invalid option' });
    expect((await post('price-books/pb_1/status', { status: 'draft' })).status).toBe(400);
  });

  it('reads and writes a company’s budgets as the tools do, the path naming the company and the budget', async () => {
    run.mockResolvedValueOnce({ ok: true, value: { budgets: [], total: 0, cursor: null } });
    const listed = await handleApi(
      new Request(
        'https://app.test/api/v1/companies/cus_1/budgets?status=active&teamId=team_1&limit=5&companyId=cus_2&nope=1',
      ),
      viewer,
    );
    expect(listed.status).toBe(200);
    // The path names the company: a query can't name another.
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'list_budgets',
      { companyId: 'cus_1', status: 'active', teamId: 'team_1', limit: 5 },
    ]);
    // The ledger is read the same way: the path names the company and the budget.
    run.mockResolvedValueOnce({ ok: true, value: { entries: [], total: 0, cursor: null } });
    expect(
      (
        await handleApi(
          new Request(
            'https://app.test/api/v1/companies/cus_1/budgets/bud_1/spend?limit=5&budgetId=bud_2',
          ),
          viewer,
        )
      ).status,
    ).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'list_budget_spend',
      { companyId: 'cus_1', budgetId: 'bud_1', limit: 5 },
    ]);
    // Reading is a viewer's; changing is an operator's.
    const before = run.mock.calls.length;
    expect(
      (
        await post(
          'companies/cus_1/budgets',
          { name: 'Office', amount: 5, period: 'monthly' },
          viewer,
        )
      ).status,
    ).toBe(403);
    expect(
      (await post('companies/cus_1/budgets/bud_1/status', { status: 'paused' }, viewer)).status,
    ).toBe(403);
    expect(run).toHaveBeenCalledTimes(before);

    run.mockResolvedValue({ ok: true, value: { done: 'ok' } });
    await post('companies/cus_1/budgets', {
      name: 'Office',
      amount: 500,
      period: 'monthly',
      enforcement: 'strict',
      companyId: 'cus_2',
    });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'put_budget',
      { companyId: 'cus_1', name: 'Office', amount: 500, period: 'monthly', enforcement: 'strict' },
    ]);
    await post('companies/cus_1/budgets/bud_1/status', {
      status: 'archived',
      budgetId: 'bud_2',
      companyId: 'cus_2',
    });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'set_budget_status',
      { companyId: 'cus_1', budgetId: 'bud_1', status: 'archived' },
    ]);
    run.mockReset();
  });

  it('runs the purchase order tools: reads are a viewer’s, drafts and submitting an operator’s, the path naming the PO', async () => {
    run.mockResolvedValueOnce({ ok: true, value: { purchaseOrders: [], total: 0, cursor: null } });
    const listed = await handleApi(
      new Request(
        'https://app.test/api/v1/purchase-orders?companyId=cus_1&status=submitted&buyerId=mem_1&search=PO-&from=2026-11-01&to=2026-11-30&limit=5&nope=1',
      ),
      viewer,
    );
    expect(listed.status).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'list_purchase_orders',
      {
        companyId: 'cus_1',
        status: 'submitted',
        buyerId: 'mem_1',
        search: 'PO-',
        from: '2026-11-01',
        to: '2026-11-30',
        limit: 5,
      },
    ]);
    run.mockResolvedValueOnce({ ok: true, value: { purchaseOrder: { id: 'po_1' } } });
    expect(
      (await handleApi(new Request('https://app.test/api/v1/purchase-orders/po_1'), viewer)).status,
    ).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual(['get_purchase_order', { poId: 'po_1' }]);

    // Drafting, editing, submitting and cancelling are an operator's.
    const before = run.mock.calls.length;
    for (const [path, body] of [
      ['purchase-orders', { companyId: 'cus_1', poNumber: 'PO-1', lines: [{ sku: 'A', qty: 1 }] }],
      ['purchase-orders/po_1/update', { notes: 'x' }],
      ['purchase-orders/po_1/submit', {}],
      ['purchase-orders/po_1/cancel', {}],
    ] as const)
      expect((await post(path, body, viewer)).status, path).toBe(403);
    expect(run).toHaveBeenCalledTimes(before);

    run.mockResolvedValue({ ok: true, value: { done: 'ok' } });
    await post('purchase-orders', {
      companyId: 'cus_1',
      poNumber: 'PO-1',
      lines: [{ sku: 'A', qty: 1 }],
    });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'create_po_draft',
      { companyId: 'cus_1', poNumber: 'PO-1', lines: [{ sku: 'A', qty: 1 }] },
    ]);
    // The path names the PO: a body can't name another.
    await post('purchase-orders/po_1/update', { notes: 'Rush', poId: 'po_2' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'update_po_draft',
      { poId: 'po_1', notes: 'Rush' },
    ]);
    await post('purchase-orders/po_1/submit', { poId: 'po_2' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual(['submit_po', { poId: 'po_1' }]);
    await post('purchase-orders/po_1/cancel', { reason: 'Duplicate' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'cancel_po',
      { poId: 'po_1', reason: 'Duplicate' },
    ]);
    // A PO the engine refuses (not a draft any more) is a 409, as the other refusals are.
    run.mockResolvedValueOnce({
      ok: false,
      error: 'PO-1 is submitted: only a draft can be changed.',
    });
    expect((await post('purchase-orders/po_1/update', { notes: 'x' })).status).toBe(409);
    run.mockReset();
  });

  it('runs the quote tools: reads are a viewer’s, every move an operator’s, the path naming the quote', async () => {
    run.mockResolvedValueOnce({ ok: true, value: { quotes: [], total: 0, cursor: null } });
    const listed = await handleApi(
      new Request(
        'https://app.test/api/v1/quotes?companyId=cus_1&status=sent&rootId=qt_1&search=Spring&limit=5&nope=1',
      ),
      viewer,
    );
    expect(listed.status).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'list_quotes',
      { companyId: 'cus_1', status: 'sent', rootId: 'qt_1', search: 'Spring', limit: 5 },
    ]);
    run.mockResolvedValueOnce({ ok: true, value: { quote: { id: 'qt_1' } } });
    expect(
      (await handleApi(new Request('https://app.test/api/v1/quotes/qt_1'), viewer)).status,
    ).toBe(200);
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual(['get_quote', { quoteId: 'qt_1' }]);

    // Drafting, editing, and every move after are an operator's.
    const before = run.mock.calls.length;
    for (const [path, body] of [
      [
        'quotes',
        {
          companyId: 'cus_1',
          name: 'Spring',
          lines: [{ sku: 'A', qty: 1, unitPrice: 2 }],
        },
      ],
      ['quotes/qt_1/update', { notes: 'x' }],
      ['quotes/qt_1/send', {}],
      ['quotes/qt_1/accept', {}],
      ['quotes/qt_1/decline', {}],
      ['quotes/qt_1/revise', {}],
      ['quotes/qt_1/expire', {}],
      ['quotes/qt_1/convert', {}],
    ] as const)
      expect((await post(path, body, viewer)).status, path).toBe(403);
    expect(run).toHaveBeenCalledTimes(before);

    run.mockResolvedValue({ ok: true, value: { done: 'ok' } });
    await post('quotes', {
      companyId: 'cus_1',
      name: 'Spring',
      expiresOn: '2026-12-01',
      lines: [{ sku: 'A', qty: 1, unitPrice: 2 }],
    });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'create_quote',
      {
        companyId: 'cus_1',
        name: 'Spring',
        expiresOn: '2026-12-01',
        lines: [{ sku: 'A', qty: 1, unitPrice: 2 }],
      },
    ]);
    // The path names the quote: a body can't name another.
    await post('quotes/qt_1/update', { notes: 'Net 30', quoteId: 'qt_2' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'update_quote',
      { quoteId: 'qt_1', notes: 'Net 30' },
    ]);
    for (const [move, tool] of [
      ['send', 'send_quote'],
      ['decline', 'decline_quote'],
      ['revise', 'revise_quote'],
      ['expire', 'expire_quote'],
    ] as const) {
      await post(`quotes/qt_1/${move}`, { quoteId: 'qt_2' });
      expect(run.mock.calls.at(-1)!.slice(0, 2), tool).toEqual([tool, { quoteId: 'qt_1' }]);
    }
    await post('quotes/qt_1/accept', { note: 'By phone' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'accept_quote',
      { quoteId: 'qt_1', note: 'By phone' },
    ]);
    await post('quotes/qt_1/convert', { to: 'po', poNumber: 'PO-9' });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'convert_quote',
      { quoteId: 'qt_1', to: 'po', poNumber: 'PO-9' },
    ]);
    // A quote the engine refuses (not a draft any more) is a 409, as the other refusals are.
    run.mockResolvedValueOnce({
      ok: false,
      error: 'Spring is sent: only a draft can be changed; revise it for a new version.',
    });
    expect((await post('quotes/qt_1/update', { notes: 'x' })).status).toBe(409);
    run.mockReset();
  });

  it("answers the engine's refusal, holds the tool's role, and leaves other paths alone", async () => {
    run.mockResolvedValueOnce({ ok: false, error: 'A person verifies a certificate…' });
    expect((await post('customers/cus_1/tax-certificates/txc_1/verify', {})).status).toBe(409);
    run.mockResolvedValueOnce({ ok: false, status: 400, error: 'status: Invalid option' });
    expect((await post('promotions/pr_1/status', { status: 'gone' })).status).toBe(400);
    expect((await post('stock/review', {}, viewer)).status).toBe(403);
    run.mockResolvedValueOnce({ ok: true, value: { approvals: [] } });
    expect((await handleApi(new Request('https://app.test/api/v1/attention'), viewer)).status).toBe(
      200,
    );
    expect((await post('customers/cus_1/tax-certificates/txc_1/approve', {})).status).toBe(404);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('redelivers a webhook delivery as an admin only, the path naming the delivery', async () => {
    run.mockReset();
    // Webhooks are an admin's: a viewer or an operator is refused before the engine is asked.
    for (const as of [viewer, operator])
      expect((await post('webhook-deliveries/whd_1/redeliver', {}, as)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();

    run.mockResolvedValueOnce({
      ok: true,
      value: { done: 'Sent again, and the receiver took it', id: 'whd_1', status: 'delivered' },
    });
    const sent = await post(
      'webhook-deliveries/whd_1/redeliver',
      { deliveryId: 'whd_other' },
      admin,
    );
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ id: 'whd_1', status: 'delivered' });
    // The path names the delivery: a body can't name another.
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'redeliver_webhook_delivery',
      { deliveryId: 'whd_1' },
    ]);
    // A delivery the engine won't send (unknown, or still on its first attempt) is a 409.
    run.mockResolvedValueOnce({ ok: false, error: 'No webhook delivery whd_2.' });
    expect((await post('webhook-deliveries/whd_2/redeliver', {}, admin)).status).toBe(409);
    run.mockReset();
  });
  it('replays erasures as an admin only, a restore point in the body and an engine refusal a 409', async () => {
    run.mockReset();
    // Erasing people is an admin's: refused before the engine is asked, whatever the body.
    for (const as of [viewer, operator])
      expect((await post('erasures/replay', { since: 1_700_000_000_000 }, as)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();

    // The restore point is required, and is a time.
    run.mockResolvedValueOnce({ ok: false, status: 400, error: 'since: Invalid input' });
    expect((await post('erasures/replay', {}, admin)).status).toBe(400);
    run.mockReset();

    run.mockResolvedValueOnce({
      ok: true,
      value: { done: 'Dry run: 1 person would be erased again; nothing was', dryRun: true },
    });
    const dry = await post('erasures/replay', { since: 1_700_000_000_000, dryRun: true }, admin);
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dryRun: true });
    expect(run.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'replay_erasures',
      { since: 1_700_000_000_000, dryRun: true },
    ]);
    // A token's step-up, or any other refusal the engine makes, is a 409 with its words.
    run.mockResolvedValueOnce({ ok: false, error: 'Confirm it’s you first, then confirm again.' });
    expect((await post('erasures/replay', { since: 1_700_000_000_000 }, admin)).status).toBe(409);
    run.mockReset();
  });
});

describe('an OAuth grant at the REST API', () => {
  const run = engine.runOperation;
  // What `apiOAuthFetch` hands the router: the person who approved it, named by the grant.
  const app = {
    kind: 'user' as const,
    id: 'usr_1',
    name: 'Ann',
    email: 'ann@example.com',
    role: 'operator' as const,
    grant: 'grant_1',
    client: 'client_1',
    resource: 'https://app.test/api/v1',
    expiresAt: 1_900_000_000_000,
  };
  const verify = (c: Parameters<typeof handleApi>[1]) =>
    handleApi(
      new Request('https://app.test/api/v1/customers/cus_1/tax-certificates/txc_1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      c,
    );

  beforeEach(() => run.mockReset());

  it('is not a person: the engine is told it is not, as for an API token, so what a person confirms is refused', async () => {
    run.mockResolvedValue({ ok: false, status: 403, error: 'A person confirms this' });
    const { grant: _grant, ...session } = app;
    // The same person in the browser is one; through an app they approved, they are not.
    await verify(session);
    const [, , signedSession] = run.mock.calls.at(-1)!;
    const call = await operationCall('verify_tax_certificate', {
      customerId: 'cus_1',
      certificateId: 'txc_1',
    });
    expect(await actorOf(signedSession, call)).toMatchObject({ id: 'usr_1', person: true });

    const res = await verify(app);
    expect(res.status).toBe(403);
    const [, , signedApp] = run.mock.calls.at(-1)!;
    const actor = await actorOf(signedApp, call);
    expect(actor).toMatchObject({ id: 'usr_1', role: 'operator' });
    expect(actor).not.toHaveProperty('person');
    // The engine's trail names the app: its grant and client ride on the signed actor.
    expect(actor).toMatchObject({ grant: 'grant_1', client: 'client_1' });
    expect(await actorOf(signedSession, call)).not.toHaveProperty('grant');
  });

  it('is named on the actor the engine records a vote and a cart change under, a session is not', async () => {
    const { grant: _g, client: _c, ...session } = app;
    const vote = (c: Parameters<typeof handleApi>[1]) =>
      handleApi(
        new Request('https://app.test/api/v1/orders/ord_1/approvals/mgr', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision: 'approved' }),
        }),
        c,
      );
    const edit = (c: Parameters<typeof handleApi>[1]) =>
      handleApi(
        new Request('https://app.test/api/v1/carts/cart_1/ops', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'add', sku: 'SKU-1', qty: 1 }),
        }),
        c,
      );
    engine.decide.mockResolvedValue({ ok: true, outcome: 'recorded', tally: '1 of 2' });
    engine.changeCart.mockResolvedValue({ ok: true, cart: { id: 'cart_1', version: 2 } });

    await vote(app);
    expect(await actorOf(engine.decide.mock.calls.at(-1)![3], 'decide:ord_1')).toMatchObject({
      id: 'usr_1',
      grant: 'grant_1',
      client: 'client_1',
    });
    await vote(session);
    expect(await actorOf(engine.decide.mock.calls.at(-1)![3], 'decide:ord_1')).not.toHaveProperty(
      'grant',
    );

    await edit(app);
    expect(await actorOf(engine.changeCart.mock.calls.at(-1)![2], 'cart:cart_1')).toMatchObject({
      id: 'usr_1',
      grant: 'grant_1',
      client: 'client_1',
    });
    await edit(session);
    expect(
      await actorOf(engine.changeCart.mock.calls.at(-1)![2], 'cart:cart_1'),
    ).not.toHaveProperty('grant');
  });

  it('is named in the web audit rows of what it does, a session is not', async () => {
    engine.cancel.mockResolvedValue({ ok: true });
    audit.mockClear();
    const cancel = (c: Parameters<typeof handleApi>[1]) =>
      handleApi(
        new Request('https://app.test/api/v1/orders/ord_1/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        c,
      );
    await cancel(app);
    expect(audit.mock.calls.at(-1)![2].actor).toMatchObject({
      grant: 'grant_1',
      client: 'client_1',
    });
    const { grant: _g, client: _c, ...session } = app;
    await cancel(session);
    expect(audit.mock.calls.at(-1)![2].actor).not.toHaveProperty('grant');
  });
});

describe('GET /api/v1/me', () => {
  const me = (caller: Parameters<typeof handleApi>[1]) =>
    handleApi(new Request('https://app.test/api/v1/me'), caller);

  it('describes an API token without its secret, to a viewer, uncached', async () => {
    const res = await me({
      kind: 'token',
      id: 'tok_1',
      name: 'token:ci',
      role: 'viewer',
      expiresAt: 1_900_000_000_000,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      kind: 'api_token',
      role: 'viewer',
      expiresAt: 1_900_000_000_000,
      subject: { id: 'tok_1', label: 'ci' },
    });
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'kind', 'role', 'subject']);
  });

  it('describes an OAuth grant by its resource and the person it acts as', async () => {
    const res = await me({
      kind: 'user',
      id: 'usr_1',
      name: 'Ann',
      email: 'ann@example.com',
      role: 'approver',
      grant: 'grant_1',
      client: 'client_1',
      resource: 'https://app.test/api/v1',
      expiresAt: 1_900_000_000_000,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      kind: 'oauth',
      role: 'approver',
      resource: 'https://app.test/api/v1',
      expiresAt: 1_900_000_000_000,
      subject: { id: 'usr_1', name: 'Ann', email: 'ann@example.com' },
    });
    // The grant's and client's ids are not the caller's to read back.
    expect(JSON.stringify(body)).not.toContain('grant_1');
    expect(JSON.stringify(body)).not.toContain('client_1');
  });

  it('describes a signed-in person, with no expiry or resource', async () => {
    const res = await me({
      kind: 'user',
      id: 'usr_2',
      name: 'Bo',
      email: 'bo@example.com',
      role: 'admin',
      twoFactorDue: undefined,
    });
    expect(await res.json()).toEqual({
      kind: 'session',
      role: 'admin',
      subject: { id: 'usr_2', name: 'Bo', email: 'bo@example.com' },
    });
  });

  it('is described in the OpenAPI document with a typed response', async () => {
    const { openApiDocument } = await import('~/lib/openapi');
    const doc = openApiDocument('https://app.test') as unknown as {
      paths: Record<string, { get: { responses: Record<string, unknown> } }>;
      components: { schemas: { Whoami: { properties: Record<string, unknown> } } };
    };
    expect(doc.paths['/api/v1/me']?.get.responses['200']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Whoami' } } },
    });
    expect(Object.keys(doc.components.schemas.Whoami.properties).sort()).toEqual([
      'expiresAt',
      'kind',
      'resource',
      'role',
      'subject',
    ]);
  });
});
