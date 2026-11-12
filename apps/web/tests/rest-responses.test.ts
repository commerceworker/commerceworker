import type {
  getUcpAdmin,
  integrationView,
  listAuditEvents,
  listWebhookDeliveries,
  subscriptionView,
  verifyAuditTrail,
} from '@commerceworker/application/commerce';
import type { OrderState } from '@commerceworker/core';
import {
  auditChainCheckSchema,
  auditEventsSchema,
  type CartIndexRow,
  cancelResultSchema,
  cartRowsSchema,
  cartSubmittedSchema,
  DEFAULT_TEMPLATE,
  decisionResultSchema,
  deliveriesSchema,
  type EngineRpc,
  ediInterchangeResultSchema,
  erasureDoneSchema,
  erasureRefusalSchema,
  errorSchema,
  flowListSchema,
  ignoredTopicSchema,
  inboundOrderResultSchema,
  integrationSecretSchema,
  integrationsSchema,
  okSchema,
  type orderListItem,
  orderPageSchema,
  orderRowSchema,
  orderStateSchema,
  type Principal,
  paymentEventResultSchema,
  pluginDisabledSchema,
  pluginInstallViewSchema,
  pluginListSchema,
  pluginUsageSchema,
  type Refusable,
  sendEventResultSchema,
  signWebhook,
  startOrderResultSchema,
  storefrontAdminSchema,
  storefrontOrderFlow,
  subjectExportSchema,
  subscriptionSecretSchema,
  subscriptionsSchema,
  TEMPLATES,
  ucpAdminSchema,
  ucpPlatformKeySchema,
} from '@commerceworker/core';
import {
  aliasResponseSchema,
  type BoardSummary,
  boardPageSchema,
  boardResponseSchema,
  categoriesDeletedSchema,
  channelDeletedSchema,
  discardedSchema,
  editResultsSchema,
  type FeedStatus,
  feedResponseSchema,
  feedsResponseSchema,
  gapsRebuiltSchema,
  type Product,
  type ProductDraftResult,
  type ProductSheet,
  productDraftResultSchema,
  productResponseSchema,
  publishResultsSchema,
  reindexedSchema,
  sheetResponseSchema,
  typeDeletedSchema,
  writeResultsSchema,
} from '@commerceworker/core/product';
import type { IndexedOrder } from '@commerceworker/ports/commerce';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';
import type { listFlows } from '~/lib/flows.server';

/**
 * Every success response of /api/v1 validates against the schema the OpenAPI document gives it.
 * The handlers run as they ship, over the real use-cases and the test kit's in-memory stores; what
 * the engine and the catalog answer is typed as their RPC contracts say. A response must also carry
 * nothing its schema doesn't name: parsing strips an unknown field, so the parsed value is held
 * equal to the one sent.
 */

const FLOW = TEMPLATES[DEFAULT_TEMPLATE.b2b]();
const SIGNED = {
  kind: 'token',
  id: 'tok_o',
  name: 'ci',
  role: 'admin',
} as const satisfies Principal;

const engine = {
  startOrder: vi.fn(),
  snapshot: vi.fn(),
  sendEvent: vi.fn(),
  decide: vi.fn(),
  cancel: vi.fn(),
  paymentEvent: vi.fn(),
  startOrderOnce: vi.fn(),
  exportDataSubject: vi.fn(),
  eraseDataSubject: vi.fn(),
  pluginCatalog: vi.fn(),
  pluginUsage: vi.fn(),
  uploadPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  submitCart: vi.fn(),
  draftProductContent: vi.fn(),
};
const catalog = {
  putProducts: vi.fn(),
  deleteProducts: vi.fn(),
  getProduct: vi.fn(),
  resolveAlias: vi.fn(),
  deleteType: vi.fn(),
  deleteChannel: vi.fn(),
  deleteCategories: vi.fn(),
  listFeeds: vi.fn(),
  startFeed: vi.fn(),
  feedStatus: vi.fn(),
  cancelFeed: vi.fn(),
  catalogBoard: vi.fn(),
  listBoard: vi.fn(),
  getProductSheet: vi.fn(),
  stageEdits: vi.fn(),
  discardStaged: vi.fn(),
  publishStaged: vi.fn(),
  putDrafts: vi.fn(),
  discardDrafts: vi.fn(),
  rebuildGaps: vi.fn(),
  reindex: vi.fn(),
};

const kit = await import('@commerceworker/test-kit/commerce');
const stores = {
  outbox: new kit.InMemoryWebhookOutbox(),
  integrations: new kit.InMemoryIntegrationStore(),
  ucp: new kit.InMemoryUcpStore(),
  workspace: new kit.InMemoryWorkspaceStore(),
  flows: new kit.InMemoryFlowStore(),
  audit: new kit.InMemoryAuditLog(),
  board: new kit.InMemoryOrderBoard(),
  carts: new kit.InMemoryCartRecords(),
  receipts: new kit.InMemoryWebhookReceipts(),
  orders: new kit.InMemoryOrderRecords(),
  plugins: new kit.InMemoryPluginInstallStore(),
};

const env: Record<string, unknown> = {};
vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({
  engine: () => engine,
  catalog: () => catalog,
  afterResponse: () => {},
  storefrontOrigin: () => 'https://shop.example',
}));
vi.mock('~/lib/wire.server', () => ({
  webhookOutbox: () => stores.outbox,
  integrationStore: () => stores.integrations,
  ucpStore: () => stores.ucp,
  workspaceStore: () => stores.workspace,
  flowStore: () => stores.flows,
  auditLog: () => stores.audit,
  orderBoard: () => stores.board,
  cartRecords: () => stores.carts,
  webhookReceipts: () => stores.receipts,
  orderRecords: () => stores.orders,
  pluginInstalls: () => stores.plugins,
}));
/** Sealing, as a reversible marker. */
vi.mock('~/lib/data-key.server', () => ({
  sealSecret: async (secret: string, context: string) => `sealed(${context}):${secret}`,
  openSecret: async (sealed: string) => sealed.replace(/^sealed\([^)]*\):/, ''),
}));
vi.mock('~/lib/orders.server', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/orders.server')>()),
  currencies: async () => [{ currency: 'USD', rate: 1 }],
  customerIdByEmail: async () => undefined,
}));
vi.mock('~/lib/principal.server', () => ({
  signedActor: async (a: unknown, call: string) => JSON.stringify({ a, call }),
  decider: (a: unknown) => a,
}));
vi.mock('~/lib/auth.server', () => ({
  actor: () => 'ops@example.com',
  forbidden: () => 'Forbidden',
  stepUp: async () => 'step-up needed',
}));

const { handleApi, handleSignedEvent, handleSignedOrder, handleShopifyOrder } = await import(
  '~/lib/api.server'
);
const { handleStripeWebhook } = await import('~/lib/stripe.server');
const { forgetPluginStatuses } = await import('~/lib/plugins.server');

const admin: Principal = SIGNED;
const call = (method: string, path: string, body?: unknown, headers: HeadersInit = {}) =>
  handleApi(
    new Request(`https://app.test/api/v1/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    admin,
  );

/**
 * The response is `status` and its body validates against `schema`. Parsing strips a field the
 * schema doesn't name, so the parsed value must equal the one sent: an undocumented field fails.
 */
async function expectResponse(res: Response, status: number, schema: z.ZodType) {
  const body: unknown = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  const parsed = schema.safeParse(body);
  expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 1)).toBe(true);
  expect(parsed.data).toEqual(body);
  return body as Record<string, unknown>;
}

beforeEach(() => {
  for (const fn of [...Object.values(engine), ...Object.values(catalog)]) fn.mockReset();
  engine.pluginCatalog.mockResolvedValue([]);
  forgetPluginStatuses();
  env.EDI_PARTNERS = '';
  stores.outbox = new kit.InMemoryWebhookOutbox();
  stores.integrations = new kit.InMemoryIntegrationStore();
  stores.ucp = new kit.InMemoryUcpStore();
  stores.audit = new kit.InMemoryAuditLog();
});

// ── Orders ───────────────────────────────────────────────────────────────

const order: OrderState['order'] = {
  id: 'ord_1',
  createdAt: 1_700_000_000_000,
  model: 'b2b',
  channel: 'api',
  currency: 'USD',
  title: 'Acme restock',
  lines: [{ sku: 'SKU-1', name: 'Widget', qty: 2, unitPrice: 10 }],
  contact: { email: 'buyer@acme.example', name: 'Ada' },
  shippingOption: 'ground',
  meta: { buyerId: 'm_1' },
  subtotal: 20,
  shipping: 5,
  tax: 2,
  total: 27,
  taxRate: 0.1,
  taxShipping: false,
  fxRate: 1,
  baseTotal: 27,
};

const state: OrderState = {
  orderId: 'ord_1',
  status: 'waiting',
  order,
  flow: { ...FLOW, version: 3, publishedAt: 1_700_000_000_000 },
  nodes: {
    validate: {
      status: 'succeeded',
      runs: 1,
      summary: 'ok',
      output: { ok: true },
      startedAt: 1,
      endedAt: 2,
    },
    mgr: { status: 'waiting', runs: 1, branches: [], startedAt: 3 },
    pay: { status: 'pending', runs: 0, error: undefined },
  },
  edges: { 'validate-mgr': 'active', 'mgr-pay': 'pending', 'x-y': 'inactive' },
  waits: [
    {
      nodeId: 'mgr',
      eventType: 'approval:mgr#1',
      kind: 'approval',
      title: 'Manager approval',
      amount: 27,
      assignee: 'approver',
      approval: {
        approvers: 'staff:approver',
        mode: 'quorum',
        quorum: 2,
        majorityPercent: 50,
        companyId: 'co_1',
        eligible: ['u1', 'u2'],
      },
      deadline: 1_700_000_100_000,
      since: 3,
    },
    {
      nodeId: 'pay',
      eventType: 'payment.received',
      kind: 'event',
      title: 'Payment',
      event: 'payment.received',
      since: 4,
    },
  ],
  vars: { note: 'rush', nested: { a: [1, 2] } },
  timeline: [
    { at: 1, kind: 'order', message: 'Order started', key: 'start' },
    { at: 2, nodeId: 'validate', kind: 'node', message: 'Validated', data: { ok: true } },
  ],
  instanceId: 'inst_1',
  generation: 1,
  rollback: null,
  updatedAt: 5,
};

describe('orders', () => {
  it('the flows list', async () => {
    await stores.flows.seed([FLOW]);
    const body = await expectResponse(await call('GET', 'flows'), 200, flowListSchema);
    // The built-in templates are seeded on first use.
    expect((body.flows as unknown[]).length).toBe(Object.keys(TEMPLATES).length);
  });

  it('the orders list, with a next page cursor, and a page that is the last', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `ord_${i}`,
      status: 'waiting',
      createdAt: 1000 - i,
      model: 'b2b',
      channel: 'web',
      flowId: 'tpl-b2b-order',
      flowVersion: 1,
      instanceId: 'inst',
      waitingOn: 'Manager approval',
      waitingAt: 'Approve',
      waitingSince: 5,
      total: 27,
      idempotencyKey: 'k-1',
      idempotencyFingerprint: 'fp',
      addressPending: 1,
    }));
    stores.board = new kit.InMemoryOrderBoard({ orders: rows });
    const first = await expectResponse(await call('GET', 'orders?limit=2'), 200, orderPageSchema);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = await expectResponse(
      await call('GET', `orders?limit=2&cursor=${first.nextCursor}`),
      200,
      orderPageSchema,
    );
    expect(last.nextCursor).toBeNull();
    expect(orderRowSchema.safeParse((first.orders as unknown[])[0]).success).toBe(true);
    // The index's bookkeeping is not the caller's; the key the caller chose is.
    for (const o of [...(first.orders as object[]), ...(last.orders as object[])]) {
      expect(o).not.toHaveProperty('idempotencyFingerprint');
      expect(o).not.toHaveProperty('addressPending');
      expect(o).toHaveProperty('idempotencyKey');
    }
  });

  it('starting an order, and a replay of it', async () => {
    await stores.flows.seed([FLOW]);
    engine.startOrder.mockResolvedValueOnce({ orderId: 'ord_1' });
    const start = { flowId: FLOW.id, input: { model: 'b2b', lines: [{ sku: 'A', qty: 1 }] } };
    await expectResponse(await call('POST', 'orders', start), 201, startOrderResultSchema);
    engine.startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1', replayed: true });
    await expectResponse(
      await call('POST', 'orders', start, { 'idempotency-key': 'k1' }),
      200,
      startOrderResultSchema,
    );
  });

  it('an order’s live state, with an order, a flow, waits and a timeline', async () => {
    engine.snapshot.mockResolvedValueOnce(JSON.parse(JSON.stringify(state)));
    await expectResponse(await call('GET', 'orders/ord_1'), 200, orderStateSchema);
  });

  it('delivering an event: given to a step, held, and a resend', async () => {
    for (const res of [
      { delivered: true, nodeId: 'pay' },
      { delivered: false, held: true },
      { delivered: true, duplicate: true, nodeId: 'pay' },
    ] satisfies Awaited<ReturnType<EngineRpc['sendEvent']>>[]) {
      engine.sendEvent.mockResolvedValueOnce(res);
      await expectResponse(
        await call('POST', 'orders/ord_1/events', { event: 'payment.received' }),
        200,
        sendEventResultSchema,
      );
    }
  });

  it('deciding an approval, and cancelling an order', async () => {
    engine.decide.mockResolvedValueOnce({ ok: true, outcome: 'recorded', tally: '1 of 2' });
    await expectResponse(
      await call('POST', 'orders/ord_1/approvals/mgr', { decision: 'approved' }),
      200,
      decisionResultSchema,
    );
    engine.cancel.mockResolvedValueOnce({ ok: true });
    await expectResponse(await call('POST', 'orders/ord_1/cancel', {}), 200, cancelResultSchema);
  });
});

// ── Carts ────────────────────────────────────────────────────────────────

describe('carts', () => {
  it('the staff carts list leaves an external cart out and carries nothing of its plugin', async () => {
    const row = (over: Partial<CartIndexRow>): CartIndexRow => ({
      id: 'cart_1',
      flowId: 'tpl-b2b-order',
      pluginId: null,
      sessionRef: null,
      createdBy: 'tok_o',
      createdAt: 1,
      title: 'Acme',
      status: 'open',
      customerId: null,
      orderId: null,
      updatedAt: 2,
      expiresAt: null,
      buyerId: null,
      ...over,
    });
    await stores.carts.index(row({}));
    await stores.carts.index(
      row({ id: 'cart_2', status: 'submitted', orderId: 'ord_1', customerId: 'c1' }),
    );
    await stores.carts.index(
      row({ id: 'cart_x', pluginId: 'punchout', sessionRef: 's', buyerId: 'b' }),
    );
    const body = await expectResponse(await call('GET', 'carts'), 200, cartRowsSchema);
    expect((body.carts as unknown[]).length).toBe(2);
  });

  it('submitting a cart', async () => {
    engine.submitCart.mockResolvedValueOnce({ ok: true, orderId: 'ord_9' });
    await expectResponse(await call('POST', 'carts/cart_1/submit', {}), 201, cartSubmittedSchema);
  });
});

// ── Signed receivers and channels ────────────────────────────────────────

async function integrate(over: { events?: string[]; startOrders?: boolean; flows?: string[] }) {
  const made = (await (
    await call('POST', 'integrations', {
      name: 'ERP',
      events: ['*'],
      startOrders: true,
      flows: ['*'],
      ...over,
    })
  ).json()) as { integration: { id: string }; secret: string };
  return made;
}
const signed = async (
  path: string,
  body: unknown,
  made: { integration: { id: string }; secret: string },
  at = Math.floor(Date.now() / 1000),
) => {
  const raw = JSON.stringify(body);
  const header = await signWebhook(made.secret, raw, at, made.integration.id);
  return new Request(`https://app.test/api/v1/${path}`, {
    method: 'POST',
    headers: { 'x-commerceworker-signature': header, 'content-type': 'application/json' },
    body: raw,
  });
};

describe('webhook receivers’ acknowledgements', () => {
  it('a signed event: delivered, held, and a replay of the same request', async () => {
    const made = await integrate({});
    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    await expectResponse(
      await handleSignedEvent(
        await signed('webhooks/events', { orderId: 'ord_1', event: 'payment.received' }, made),
      ),
      200,
      sendEventResultSchema,
    );
    engine.sendEvent.mockResolvedValueOnce({ delivered: false, held: true });
    await expectResponse(
      await handleSignedEvent(
        await signed('webhooks/events', { orderId: 'ord_2', event: 'payment.received' }, made),
      ),
      202,
      sendEventResultSchema,
    );
    // The exact request again is acknowledged without touching the order.
    const at = Math.floor(Date.now() / 1000);
    const resend = { orderId: 'ord_3', event: 'payment.received' };
    engine.sendEvent.mockResolvedValueOnce({ delivered: true, nodeId: 'pay' });
    await handleSignedEvent(await signed('webhooks/events', resend, made, at));
    const again = await expectResponse(
      await handleSignedEvent(await signed('webhooks/events', resend, made, at)),
      200,
      sendEventResultSchema,
    );
    expect(again).toEqual({ delivered: true, duplicate: true });
  });

  it('a signed order: started, and received before', async () => {
    const made = await integrate({});
    const body = {
      model: 'b2c',
      channel: 'web',
      externalId: 'W-1',
      lines: [{ sku: 'A', qty: 1 }],
      flowId: FLOW.id,
    };
    await stores.flows.seed([FLOW]);
    engine.startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1' });
    await expectResponse(
      await handleSignedOrder(await signed('webhooks/orders', body, made)),
      201,
      inboundOrderResultSchema,
    );
    engine.startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1', replayed: true });
    await expectResponse(
      await handleSignedOrder(await signed('webhooks/orders', body, made)),
      200,
      inboundOrderResultSchema,
    );
  });

  it('Stripe’s: handled, and a retry it is asked to make', async () => {
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const send = async (id: string) => {
      const raw = JSON.stringify({ id, type: 'invoice.paid', data: { object: { id: 'in_1' } } });
      return handleStripeWebhook(
        new Request('https://app.test/api/v1/webhooks/stripe', {
          method: 'POST',
          headers: { 'stripe-signature': await signWebhook('whsec_test', raw) },
          body: raw,
        }),
      );
    };
    engine.paymentEvent.mockResolvedValueOnce({
      outcome: 'handled',
      orderId: 'ord_1',
      delivered: 'payment.received',
    });
    await expectResponse(await send('evt_1'), 200, paymentEventResultSchema);
    engine.paymentEvent.mockResolvedValueOnce({
      outcome: 'ignored',
      reason: 'not an invoice we issued',
    });
    await expectResponse(await send('evt_2'), 200, paymentEventResultSchema);
    engine.paymentEvent.mockResolvedValueOnce({ outcome: 'retry', orderId: 'ord_1' });
    await expectResponse(await send('evt_3'), 409, paymentEventResultSchema);
  });

  it('Shopify’s: an order started, one received before, and a topic ignored', async () => {
    env.SHOPIFY_WEBHOOK_SECRET = 'shpss_test';
    env.SHOPIFY_SHOPS = 'acme.myshopify.com';
    await stores.flows.seed([FLOW]);
    const raw = JSON.stringify({
      id: 1001,
      email: 'buyer@example.com',
      currency: 'USD',
      source_name: 'web',
      line_items: [{ sku: 'A', quantity: 1, title: 'A', price: '10.00' }],
    });
    const mac = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign(
            'HMAC',
            await crypto.subtle.importKey(
              'raw',
              new TextEncoder().encode('shpss_test'),
              { name: 'HMAC', hash: 'SHA-256' },
              false,
              ['sign'],
            ),
            new TextEncoder().encode(raw),
          ),
        ),
      ),
    );
    const send = (topic: string) =>
      handleShopifyOrder(
        new Request('https://app.test/api/v1/channels/shopify/orders', {
          method: 'POST',
          headers: {
            'x-shopify-hmac-sha256': mac,
            'x-shopify-topic': topic,
            'x-shopify-shop-domain': 'acme.myshopify.com',
          },
          body: raw,
        }),
      );
    engine.startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1' });
    await expectResponse(await send('orders/create'), 201, inboundOrderResultSchema);
    engine.startOrderOnce.mockResolvedValueOnce({ orderId: 'ord_1', replayed: true });
    await expectResponse(await send('orders/create'), 200, inboundOrderResultSchema);
    await expectResponse(await send('orders/paid'), 200, ignoredTopicSchema);
  });

  it('an EDI interchange: an order started, one replayed, one refused, and the 997', async () => {
    env.EDI_PARTNERS = JSON.stringify({ SENDERID: 'cust_1' });
    await stores.flows.seed([FLOW]);
    const edi = [
      'ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVER       *240101*1200*U*00401*000000001*0*P*>~',
      'GS*PO*SENDERID*RECEIVER*20240101*1200*1*X*004010~',
      'ST*850*0001~',
      'BEG*00*SA*PO-1**20240101~',
      'PO1*1*2*EA*10**VP*SKU-1~',
      'SE*4*0001~',
      'ST*850*0002~',
      'BEG*00*SA*PO-2**20240101~',
      'PO1*1*1*EA*10**VP*SKU-2~',
      'SE*4*0002~',
      'GE*2*1~',
      'IEA*1*000000001~',
    ].join('');
    // The route starts the POs at once and each awaits a real digest first, so they reach the
    // engine in either order: answer by idempotency key, never by call order.
    engine.startOrderOnce.mockImplementation(
      async ({ idempotencyKey }: { idempotencyKey: string }) =>
        idempotencyKey === 'order:edi:SENDERID:PO-1'
          ? { orderId: 'ord_1' }
          : { orderId: 'ord_2', replayed: true },
    );
    const res = await handleApi(
      new Request('https://app.test/api/v1/channels/edi/850', {
        method: 'POST',
        headers: { 'content-type': 'application/edi-x12' },
        body: edi,
      }),
      admin,
    );
    const body = await expectResponse(res, 200, ediInterchangeResultSchema);
    expect((body.results as { status: number }[]).map((r) => r.status)).toEqual([201, 200]);
  });
});

// ── Audit ────────────────────────────────────────────────────────────────

describe('the audit log', () => {
  it('lists events, oldest first by seq, and checks the chain, ending and continuing', async () => {
    // Writing through the API audits itself: three events in the chain.
    for (const name of ['a', 'b', 'c'])
      await call('POST', 'webhook-subscriptions', { url: `https://hooks.example/${name}` });
    const events = await expectResponse(await call('GET', 'audit-events'), 200, auditEventsSchema);
    expect((events.events as unknown[]).length).toBe(3);
    const oldestFirst = await expectResponse(
      await call('GET', 'audit-events?after=0'),
      200,
      auditEventsSchema,
    );
    expect((oldestFirst.events as { seq: number }[]).map((e) => e.seq)).toEqual([1, 2, 3]);
    const check = await expectResponse(
      await call('GET', 'audit-events/verify'),
      200,
      auditChainCheckSchema,
    );
    expect(check).toMatchObject({ ok: true, checked: 3 });
  });

  it('a chain that fails says where', async () => {
    await call('POST', 'webhook-subscriptions', { url: 'https://hooks.example/a' });
    await call('POST', 'webhook-subscriptions', { url: 'https://hooks.example/b' });
    const [first] = stores.audit.events;
    if (first) first.target = 'tampered';
    const check = await expectResponse(
      await call('GET', 'audit-events/verify'),
      200,
      auditChainCheckSchema,
    );
    expect(check).toMatchObject({ ok: false, brokenAt: 1 });
  });
});

// ── Catalog ──────────────────────────────────────────────────────────────

const product: Product = {
  key: 'tee',
  type: 'apparel',
  typeVersion: 1,
  status: 'active',
  title: { en: 'Tee', fr: 'Tee-shirt' },
  slug: { en: 'tee' },
  description: { en: 'A tee' },
  brand: 'Acme',
  categories: ['shirts'],
  primaryCategory: 'shirts',
  media: [
    {
      src: 'https://img.example/tee.jpg',
      alt: { en: 'A tee' },
      width: 10,
      height: 10,
      focus: [0.5, 0.5],
    },
  ],
  attributes: { color: 'red', sizes: ['s', 'm'], weight: { value: 1, unit: 'kg' } },
  variants: [
    {
      sku: 'TEE-S',
      status: 'active',
      gtin: '4006381333931',
      mpn: 'T1',
      attributes: { size: 's' },
      prices: { web: { amount: 1000, currency: 'USD' } },
      weightKg: 0.2,
      dimensionsCm: { length: 1, width: 2, height: 3 },
    },
  ],
  channels: { web: { visible: true, price: { amount: 1000, currency: 'USD' } } },
  extra: { source: 'erp' },
  version: 2,
  hash: 'abc',
  updatedAt: 1_700_000_000_000,
};
const feed: FeedStatus = {
  id: 'feed_1',
  name: 'feed.csv',
  format: 'csv',
  state: 'done',
  by: 'ops@example.com',
  createdAt: 1,
  finishedAt: 2,
  rows: 10,
  parts: 1,
  partsDone: 1,
  created: 8,
  updated: 1,
  unchanged: 0,
  rejected: 1,
  errors: [{ row: 4, key: 'bad', message: 'sku is required' }],
};

describe('the catalog', () => {
  it('products: written, one rejected, read, deleted and found by alias', async () => {
    catalog.putProducts.mockResolvedValueOnce([
      { key: 'tee', status: 'created', version: 1 },
      { key: 'bad', status: 'rejected', issues: [{ path: 'variants', message: 'needs one' }] },
    ]);
    await expectResponse(
      await call('POST', 'catalog/products', {
        products: [
          { key: 'tee', type: 'apparel', title: { en: 'Tee' }, variants: [{ sku: 'TEE-S' }] },
        ],
      }),
      200,
      writeResultsSchema,
    );
    catalog.getProduct.mockResolvedValueOnce(product);
    await expectResponse(await call('GET', 'catalog/products/tee'), 200, productResponseSchema);
    catalog.deleteProducts.mockResolvedValueOnce([{ key: 'tee', status: 'deleted' }]);
    await expectResponse(
      await call('POST', 'catalog/products/delete', { keys: ['tee'] }),
      200,
      writeResultsSchema,
    );
    catalog.resolveAlias.mockResolvedValueOnce('tee');
    await expectResponse(await call('GET', 'catalog/aliases/sku:TEE-S'), 200, aliasResponseSchema);
  });

  it('what deleting a type, a channel and categories answers', async () => {
    catalog.deleteType.mockResolvedValueOnce({ ok: true, code: 'apparel', versions: 2 });
    await expectResponse(await call('DELETE', 'catalog/types/apparel'), 200, typeDeletedSchema);
    catalog.deleteChannel.mockResolvedValueOnce({ ok: true, code: 'web', unpublished: 12 });
    await expectResponse(await call('DELETE', 'catalog/channels/web'), 200, channelDeletedSchema);
    catalog.deleteCategories.mockResolvedValueOnce({ ok: true, deleted: ['shirts'] });
    await expectResponse(
      await call('POST', 'catalog/categories/delete', { codes: ['shirts'] }),
      200,
      categoriesDeletedSchema,
    );
  });

  it('feeds: listed, started, read and cancelled', async () => {
    catalog.listFeeds.mockResolvedValueOnce([
      feed,
      { ...feed, id: 'feed_2', state: 'cancelled', cancelledBy: 'ops' },
    ]);
    await expectResponse(await call('GET', 'catalog/feeds'), 200, feedsResponseSchema);
    catalog.startFeed.mockResolvedValueOnce({
      ...feed,
      state: 'queued',
      finishedAt: undefined,
      rows: 0,
      errors: [],
    });
    const started = await handleApi(
      new Request('https://app.test/api/v1/catalog/feeds?format=csv', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: 'sku,title\nA,A\n',
      }),
      admin,
    );
    await expectResponse(started, 202, feedResponseSchema);
    catalog.feedStatus.mockResolvedValueOnce({ ...feed, state: 'failed', failure: 'unreadable' });
    await expectResponse(await call('GET', 'catalog/feeds/feed_1'), 200, feedResponseSchema);
    catalog.cancelFeed.mockResolvedValueOnce({
      ...feed,
      state: 'cancelled',
      cancelledBy: 'ops@example.com',
    });
    await expectResponse(
      await call('POST', 'catalog/feeds/feed_1/cancel', {}),
      200,
      feedResponseSchema,
    );
  });

  it('the board, a column of it, and a product’s sheet', async () => {
    const board: BoardSummary = {
      columns: { gaps: 3, drafted: 1, staged: 2, published: 4 },
      gapGroups: { conflict: 0, rejected: 1, missing_required: 0, missing: 2 },
      gapsByKind: { missing_title: { gaps: 2, products: 2 }, rejected: { gaps: 1, products: 1 } },
      lastFeed: feed,
      runningFeed: null,
      indexBuilt: true,
    };
    catalog.catalogBoard.mockResolvedValueOnce(board);
    await expectResponse(await call('GET', 'catalog/board'), 200, boardResponseSchema);
    catalog.listBoard.mockResolvedValueOnce({
      items: [
        {
          key: 'tee',
          title: 'Tee',
          column: 'gaps',
          kinds: { missing_title: 1 },
          rejection: {
            feed: 'feed_1',
            row: 4,
            issues: [{ path: 'title', message: 'required' }],
            at: 5,
          },
          locales: ['fr'],
          staged: 0,
          drafts: 1,
          failure: null,
          at: 6,
        },
      ],
      cursor: 'tee',
    });
    await expectResponse(await call('GET', 'catalog/board/gaps'), 200, boardPageSchema);
    const sheet: ProductSheet = {
      product,
      feed: (({ version: _v, hash: _h, updatedAt: _u, ...data }) => data)(product),
      overrides: [
        {
          ref: { field: 'title', locale: 'fr' },
          value: 'Tee',
          base: null,
          feed: 'T',
          conflict: true,
          source: 'person',
          by: 'ops',
          at: 1,
        },
      ],
      staged: [
        {
          ref: { field: 'attribute', code: 'blurb', locale: 'en' },
          op: 'set',
          value: 'Soft',
          seen: null,
          source: 'assistant',
          by: 'ops',
          at: 2,
          failure: 'changed since',
        },
      ],
      drafts: [
        {
          ref: { field: 'description', locale: 'fr' },
          value: 'Un tee',
          seen: null,
          stale: false,
          model: null,
          by: 'ops',
          at: 3,
        },
      ],
      gaps: [{ kind: 'missing_description', field: 'description', locale: 'fr', channel: 'web' }],
      rejection: null,
      revisions: [
        {
          ref: { field: 'status' },
          op: 'clear',
          value: null,
          previous: 'draft',
          source: 'person',
          by: 'ops',
          at: 4,
        },
      ],
    };
    catalog.getProductSheet.mockResolvedValueOnce(sheet);
    await expectResponse(await call('GET', 'catalog/products/tee/sheet'), 200, sheetResponseSchema);
  });

  it('editing: staged, discarded, published, drafted and the assistant’s drafts', async () => {
    const ref = { field: 'title', locale: 'fr' } as const;
    catalog.stageEdits.mockResolvedValueOnce([
      { key: 'tee', ref, ok: true },
      { key: 'tee', ref, ok: false, issues: ['too long'] },
    ]);
    await expectResponse(
      await call('POST', 'catalog/edits', { edits: [{ key: 'tee', ref, op: 'set', value: 'T' }] }),
      200,
      editResultsSchema,
    );
    catalog.discardStaged.mockResolvedValueOnce({ discarded: 1 });
    await expectResponse(
      await call('POST', 'catalog/edits/discard', { items: [{ key: 'tee' }] }),
      200,
      discardedSchema,
    );
    catalog.publishStaged.mockResolvedValueOnce([
      { key: 'tee', status: 'published', version: 3 },
      { key: 'x', status: 'failed', issues: ['stale'] },
      { key: 'y', status: 'unchanged' },
    ]);
    await expectResponse(
      await call('POST', 'catalog/edits/publish', { keys: ['tee', 'x', 'y'] }),
      200,
      publishResultsSchema,
    );
    catalog.putDrafts.mockResolvedValueOnce([{ key: 'tee', ref, ok: true }]);
    await expectResponse(
      await call('POST', 'catalog/drafts', { drafts: [{ key: 'tee', ref, value: 'T' }] }),
      200,
      editResultsSchema,
    );
    catalog.discardDrafts.mockResolvedValueOnce({ discarded: 1 });
    await expectResponse(
      await call('POST', 'catalog/drafts/discard', { items: [{ key: 'tee' }] }),
      200,
      discardedSchema,
    );
    catalog.getProduct.mockResolvedValueOnce(product);
    const drafted: ProductDraftResult = {
      key: 'tee',
      title: 'Tee',
      drafted: [{ ref, value: 'Tee-shirt' }],
      refused: [{ ref: { field: 'description', locale: 'de' }, issues: ['too long'] }],
      more: 3,
      model: null,
    };
    engine.draftProductContent.mockResolvedValueOnce({
      ok: true,
      value: drafted,
    } satisfies Refusable<ProductDraftResult>);
    await expectResponse(
      await call('POST', 'catalog/products/tee/draft', {}),
      200,
      productDraftResultSchema,
    );
  });

  it('recounting gaps and republishing', async () => {
    catalog.rebuildGaps.mockResolvedValueOnce({ products: 40 });
    await expectResponse(await call('POST', 'catalog/gaps/rebuild', {}), 200, gapsRebuiltSchema);
    catalog.reindex.mockResolvedValueOnce({ queued: 40 });
    await expectResponse(await call('POST', 'catalog/reindex', {}), 202, reindexedSchema);
  });
});

// ── Data subjects ────────────────────────────────────────────────────────

describe('data subjects', () => {
  it('an export, an erasure pass, and an erasure refused for running orders', async () => {
    engine.exportDataSubject.mockResolvedValueOnce({
      email: 'ada@example.com',
      exportedAt: 1,
      customers: [{ id: 'c1' }],
      orders: [{ id: 'ord_1', lines: [] }],
      messages: [],
      inboundEmails: [],
      documents: [{ key: 'k', kind: 'po', contentType: 'application/pdf', createdAt: 1 }],
      checkouts: [],
      carts: [],
      taxCertificates: [],
      addresses: [],
      companies: [],
      companyMembers: [],
      purchaseOrders: [],
      quotes: [],
      shopperSignIns: [],
      shopperSessions: [],
      truncated: false,
      teamMember: false,
    });
    await expectResponse(
      await call('POST', 'data-subjects/export', { email: 'ada@example.com' }),
      200,
      subjectExportSchema,
    );
    engine.eraseDataSubject.mockResolvedValueOnce({
      ok: true,
      done: false,
      orders: 100,
      customers: 1,
      documents: 2,
      messages: 3,
      inboundEmails: 0,
      carts: 1,
      taxCertificates: 0,
      addresses: 4,
      companyMembers: 1,
      purchaseOrders: 0,
      quotes: 0,
      shopperSignIns: 0,
      shopperSessions: 0,
      teamMember: false,
    });
    await expectResponse(
      await call('POST', 'data-subjects/erase', { email: 'ada@example.com' }),
      200,
      erasureDoneSchema,
    );
    engine.eraseDataSubject.mockResolvedValueOnce({
      ok: false,
      reason: 'active_orders',
      orders: ['ord_1'],
    });
    const refused = await expectResponse(
      await call('POST', 'data-subjects/erase', { email: 'ada@example.com' }),
      409,
      erasureRefusalSchema,
    );
    expect(refused).toMatchObject({ ok: false, reason: 'active_orders', orders: ['ord_1'] });
  });
});

// ── Webhook subscriptions, integrations, plugins, UCP ────────────────────

describe('webhook subscriptions and their deliveries', () => {
  it('subscribing, listing, rotating, deliveries and deleting', async () => {
    const made = await expectResponse(
      await call('POST', 'webhook-subscriptions', {
        url: 'https://hooks.example/x',
        events: ['order.shipped'],
      }),
      201,
      subscriptionSecretSchema,
    );
    const id = (made.subscription as { id: string }).id;
    await expectResponse(await call('GET', 'webhook-subscriptions'), 200, subscriptionsSchema);
    const rotated = await expectResponse(
      await call('POST', `webhook-subscriptions/${id}/rotate`, {}),
      200,
      subscriptionSecretSchema,
    );
    expect((rotated.subscription as { previousExpiresAt: number }).previousExpiresAt).toEqual(
      expect.any(Number),
    );
    const first = await expectResponse(
      await call('GET', `webhook-subscriptions/${id}/deliveries`),
      200,
      deliveriesSchema,
    );
    expect(first.deliveries).toEqual([]);
    // A delivery of an order event, as the engine's outbox records it.
    await stores.outbox.record(
      [
        {
          id: 'dlv_1',
          subscriptionId: id,
          subject: 'ord_1',
          event: 'order.shipped',
          payload: JSON.stringify({
            id: 'dlv_1',
            event: 'order.shipped',
            occurredAt: 1,
            orderId: 'ord_1',
            data: {},
          }),
        },
      ],
      10,
    );
    await stores.outbox.attempted([{ id: 'dlv_1', ok: false, status: 500, error: 'boom' }], 11);
    const list = await expectResponse(
      await call('GET', `webhook-subscriptions/${id}/deliveries`),
      200,
      deliveriesSchema,
    );
    expect((list.deliveries as unknown[]).length).toBe(1);
    await expectResponse(await call('DELETE', `webhook-subscriptions/${id}`), 200, okSchema);
  });
});

describe('integrations', () => {
  it('creating, listing, rotating and revoking', async () => {
    const made = await expectResponse(
      await call('POST', 'integrations', {
        name: 'ERP',
        events: ['payment.received'],
        startOrders: true,
        flows: ['*'],
        channel: 'edi',
      }),
      201,
      integrationSecretSchema,
    );
    const id = (made.integration as { id: string }).id;
    await expectResponse(await call('GET', 'integrations'), 200, integrationsSchema);
    await expectResponse(
      await call('POST', `integrations/${id}/rotate`, {}),
      200,
      integrationSecretSchema,
    );
    await expectResponse(await call('DELETE', `integrations/${id}`), 200, okSchema);
    // Revoked: still listed, with when.
    const listed = await expectResponse(await call('GET', 'integrations'), 200, integrationsSchema);
    expect((listed.integrations as { revokedAt: number | null }[])[0]?.revokedAt).toEqual(
      expect.any(Number),
    );
  });
});

describe('plugins', () => {
  const manifest = {
    apiVersion: 1,
    id: 'rules',
    name: 'Rules',
    version: '1.0.0',
    nodes: [],
    events: ['order.completed'],
    nav: [],
    publicPaths: [],
    requires: [],
    pageRole: 'admin',
    personalData: 'send',
    secrets: [],
    provides: ['tax'],
    capabilities: [],
    egress: [],
    limits: {},
  };

  it('listing, usage, an upload for review and turning one off', async () => {
    engine.pluginCatalog.mockResolvedValueOnce([
      {
        id: 'rules',
        runtime: 'sandboxed',
        source: 'installed',
        sha: 'abc',
        manifest,
        healthy: true,
      },
      {
        id: 'broken',
        runtime: 'worker',
        source: 'deployment',
        manifest: null,
        healthy: false,
        error: 'apiVersion must be 1',
      },
    ]);
    const list = await expectResponse(await call('GET', 'plugins'), 200, pluginListSchema);
    expect((list.plugins as { error?: string }[])[0]).not.toHaveProperty('error');
    engine.pluginUsage.mockResolvedValueOnce({
      flows: [{ id: 'f1', version: 2 }],
      orders: [{ id: 'ord_1', flowId: 'f1', version: 2 }],
      labels: [{ id: 'lbl_1', orderId: 'ord_1' }],
    });
    await expectResponse(await call('GET', 'plugins/rules/usage'), 200, pluginUsageSchema);
    engine.uploadPlugin.mockResolvedValueOnce({
      ok: true,
      value: {
        id: 'rules',
        sha: 'abc',
        version: '1.0.0',
        publisher: 'acme',
        status: 'pending',
        personalDataGranted: false,
        uploadedBy: 'tok_o',
        uploadedAt: 1,
        approvedBy: null,
        approvedAt: null,
        manifest,
        secrets: [],
        request: null,
        cases: [
          {
            name: 'free',
            node: 'free',
            order: {},
            config: {},
            expect: { branch: 'yes' },
            pass: true,
            got: { branch: 'yes', vars: { a: 1 } },
          },
        ],
        code: null,
      },
    });
    await expectResponse(
      await call('POST', 'plugins', { bundle: 'x' }),
      201,
      pluginInstallViewSchema,
    );
    engine.setPluginEnabled.mockResolvedValueOnce({ ok: true, value: { id: 'rules' } });
    await expectResponse(
      await call('POST', 'plugins/rules/disable', {}),
      200,
      pluginDisabledSchema,
    );
  });
});

describe('agentic checkout', () => {
  it('its settings and platforms, and letting one in and revoking it', async () => {
    const empty = await expectResponse(await call('GET', 'ucp'), 200, ucpAdminSchema);
    expect(empty.platforms).toEqual([]);
    const made = await expectResponse(
      await call('POST', 'ucp/platforms', {
        name: 'Shopper',
        profileUrl: 'https://shopper.example/.well-known/ucp',
      }),
      201,
      ucpPlatformKeySchema,
    );
    await stores.workspace.setSetting(
      'ucp',
      JSON.stringify({
        checkoutFlowId: FLOW.id,
        links: [{ type: 'terms', url: 'https://shop.example/terms', title: 'Terms' }],
        orderUrl: 'https://shop.example/o/{id}',
      }),
      'ops',
    );
    const listed = await expectResponse(await call('GET', 'ucp'), 200, ucpAdminSchema);
    expect((listed.platforms as unknown[]).length).toBe(1);
    await expectResponse(
      await call('DELETE', `ucp/platforms/${(made.platform as { id: string }).id}`),
      200,
      okSchema,
    );
    const after = await expectResponse(await call('GET', 'ucp'), 200, ucpAdminSchema);
    expect((after.platforms as { revokedAt: number | null }[])[0]?.revokedAt).toEqual(
      expect.any(Number),
    );
  });
});

describe('hosted checkout’s settings', () => {
  it('are off until saved, saved only for a flow that takes cards, and read back as saved', async () => {
    const off = await expectResponse(await call('GET', 'storefront'), 200, storefrontAdminSchema);
    expect(off.settings).toEqual({
      storeName: null,
      checkout: { enabled: false, checkoutFlowId: null, editLines: false },
    });
    const card = { ...storefrontOrderFlow(), id: 'tpl-card' };
    const noCard = { ...storefrontOrderFlow(), id: 'tpl-no-card', nodes: [], edges: [] };
    await stores.flows.seed([card, noCard] as never);

    // Turning it on needs a flow that authorizes a card: unknown, or one that doesn't, is a 422.
    for (const checkoutFlowId of ['tpl-missing', 'tpl-no-card', null]) {
      const refused = await call('POST', 'storefront/settings', {
        checkout: { enabled: true, checkoutFlowId, editLines: false },
      });
      expect(refused.status, String(checkoutFlowId)).toBe(422);
      expect(
        storefrontAdminSchema.safeParse(await (await call('GET', 'storefront')).json()).success,
      ).toBe(true);
    }
    const saved = {
      storeName: 'Acme Supply',
      checkout: { enabled: true, checkoutFlowId: 'tpl-card', editLines: true },
    };
    const set = await expectResponse(
      await call('POST', 'storefront/settings', saved),
      200,
      storefrontAdminSchema,
    );
    expect(set.settings).toEqual(saved);
    const read = await expectResponse(await call('GET', 'storefront'), 200, storefrontAdminSchema);
    expect(read.settings).toEqual(saved);
    // Off needs no flow, and is audited with what it was.
    await expectResponse(
      await call('POST', 'storefront/settings', {
        checkout: { enabled: false, checkoutFlowId: null, editLines: false },
      }),
      200,
      storefrontAdminSchema,
    );
    const trail = await stores.audit.list({ limit: 10 });
    expect(trail.filter((e) => e.action === 'checkout.settings')).toHaveLength(2);
  });
});

// ── Refusals the document describes ─────────────────────────────────────

describe('refusals with a body of their own', () => {
  it('an event whose payload sets a field the delivery records is 422, over REST and signed', async () => {
    const bad = { event: 'payment.received', payload: { by: 'someone' } };
    await expectResponse(await call('POST', 'orders/ord_1/events', bad), 422, errorSchema);
    const made = await integrate({});
    await expectResponse(
      await handleSignedEvent(await signed('webhooks/events', { orderId: 'ord_1', ...bad }, made)),
      422,
      errorSchema,
    );
    expect(engine.sendEvent).not.toHaveBeenCalled();
  });

  it('a signed event the order won’t wait for is 409 with its result', async () => {
    const made = await integrate({});
    engine.sendEvent.mockResolvedValueOnce({ delivered: false });
    await expectResponse(
      await handleSignedEvent(
        await signed('webhooks/events', { orderId: 'ord_1', event: 'payment.received' }, made),
      ),
      409,
      sendEventResultSchema,
    );
  });

  it('a Stripe event the engine fails on is 500 with an error', async () => {
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const raw = JSON.stringify({
      id: 'evt_9',
      type: 'invoice.paid',
      data: { object: { id: 'in_1' } },
    });
    engine.paymentEvent.mockRejectedValueOnce(new Error('boom'));
    const res = await handleStripeWebhook(
      new Request('https://app.test/api/v1/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': await signWebhook('whsec_test', raw) },
        body: raw,
      }),
    );
    expect(await expectResponse(res, 500, errorSchema)).toEqual({ error: 'Internal error' });
  });
});

// ── The views the handlers answer with ───────────────────────────────────

type Out<S extends z.ZodType> = z.output<S>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Item<T> = T extends readonly (infer I)[] ? I : never;

/**
 * What the web app answers is built by use-cases over the ports' plain records: each response
 * schema must say what that view's type says, so a field added to one and not the other fails here.
 */
describe('the response schemas say what the views the handlers answer with say', () => {
  it('subscriptions, deliveries and integrations', () => {
    expectTypeOf<ReturnType<typeof subscriptionView>>().branded.toEqualTypeOf<
      Out<typeof subscriptionSecretSchema>['subscription']
    >();
    expectTypeOf<Item<Awaited<ReturnType<typeof listWebhookDeliveries>>>>().branded.toEqualTypeOf<
      Item<Out<typeof deliveriesSchema>['deliveries']>
    >();
    expectTypeOf<ReturnType<typeof integrationView>>().branded.toEqualTypeOf<
      Out<typeof integrationSecretSchema>['integration']
    >();
  });

  it('audit events and the chain check', () => {
    expectTypeOf<Item<Awaited<ReturnType<typeof listAuditEvents>>>>().branded.toEqualTypeOf<
      Item<Out<typeof auditEventsSchema>['events']>
    >();
    // `next` only ever comes with a chain that held; the type lets a failure carry one too.
    type Check = Awaited<ReturnType<typeof verifyAuditTrail>>;
    type Schema = Out<typeof auditChainCheckSchema>;
    expectTypeOf<Extract<Check, { ok: true }>>().branded.toEqualTypeOf<
      Extract<Schema, { ok: true }>
    >();
    expectTypeOf<Omit<Extract<Check, { ok: false }>, 'next'>>().branded.toEqualTypeOf<
      Extract<Schema, { ok: false }>
    >();
  });

  it('agentic checkout’s settings and platforms', () => {
    type Admin = Awaited<ReturnType<typeof getUcpAdmin>>;
    expectTypeOf<Admin['settings']>().branded.toEqualTypeOf<
      Out<typeof ucpAdminSchema>['settings']
    >();
    expectTypeOf<Mutable<Item<Admin['platforms']>>>().branded.toEqualTypeOf<
      Item<Out<typeof ucpAdminSchema>['platforms']>
    >();
  });

  it('an order’s row in the index, and a flow in the list', () => {
    // The index stores the model, channel and status as text; the schema names the values they take.
    type Row = Mutable<
      Omit<ReturnType<typeof orderListItem<IndexedOrder>>, 'model' | 'channel' | 'status'>
    >;
    expectTypeOf<Row>().branded.toEqualTypeOf<
      Omit<Out<typeof orderRowSchema>, 'model' | 'channel' | 'status'>
    >();
    expectTypeOf<Out<typeof orderRowSchema>['status']>().toExtend<IndexedOrder['status']>();
    type Flow = Item<Awaited<ReturnType<typeof listFlows>>>;
    expectTypeOf<
      Pick<
        Flow,
        | 'id'
        | 'name'
        | 'description'
        | 'model'
        | 'channels'
        | 'publishedVersion'
        | 'updatedAt'
        | 'nodeCount'
      > & { hasUnpublishedChanges: boolean }
    >().branded.toEqualTypeOf<Item<Out<typeof flowListSchema>['flows']>>();
  });
});
