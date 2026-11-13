import type { Principal } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import shopify from '../../../packages/core/tests/fixtures/shopify-order.json';

const put = vi.fn();
const send = vi.fn();
const env: Record<string, unknown> = {
  SHOPIFY_WEBHOOK_SECRET: 'shpss_test',
  SHOPIFY_SHOPS: 'acme.myshopify.com',
  EDI_PARTNERS: JSON.stringify({ NORTHWIND: 'cus_northwind' }),
  ORDER_ROUTES: '',
  DOCS: { put },
  INTAKE_QUEUE: { send },
};
const startOrderOnce = vi.fn();

vi.mock('cloudflare:workers', () => ({ env }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ startOrderOnce }) }));
vi.mock('~/lib/flows.server', () => ({ ensureSeeded: async () => {}, listFlows: async () => [] }));
const currencies = vi.fn();
vi.mock('~/lib/orders.server', () => ({
  currencies: () => currencies(),
  listOrders: async () => [],
  customerIdByEmail: async () => undefined,
}));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn(), listAudit: async () => [] }));
vi.mock('~/lib/auth.server', () => ({ actor: () => 'api', forbidden: () => 'Forbidden' }));
vi.mock('~/lib/webhooks.server', () => ({}));

const { handleApi, handleShopifyOrder } = await import('~/lib/api.server');

async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...mac));
}

async function fromShopify(opts: { secret?: string; topic?: string; shop?: string } = {}) {
  const raw = JSON.stringify(shopify);
  return handleShopifyOrder(
    new Request('https://app.test/api/v1/channels/shopify/orders', {
      method: 'POST',
      headers: {
        'x-shopify-hmac-sha256': await hmac(opts.secret ?? 'shpss_test', raw),
        'x-shopify-topic': opts.topic ?? 'orders/create',
        'x-shopify-shop-domain': opts.shop ?? 'acme.myshopify.com',
        'x-shopify-webhook-id': 'wh-123',
      },
      body: raw,
    }),
  );
}

const today = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  currencies.mockReset().mockResolvedValue([{ currency: 'USD' }]);
  put.mockReset().mockResolvedValue(undefined);
  send.mockReset().mockResolvedValue(undefined);
  startOrderOnce.mockReset().mockRejectedValue(new Error('engine is down'));
  env.INTAKE_QUEUE = { send };
  env.SHOPIFY_WEBHOOK_SECRET = 'shpss_test';
});

describe('Shopify intake', () => {
  it('writes the raw body, queues a pointer and answers 202 with the engine down', async () => {
    const res = await fromShopify();
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, externalId: '820982911946154500' });
    // The bytes as they came, under the webhook's own id, before anything else happened.
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toBe(`intake/shopify/${today}/wh-123`);
    expect(put.mock.calls[0]![1]).toBe(JSON.stringify(shopify));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      channel: 'shopify',
      key: `intake/shopify/${today}/wh-123`,
      shop: 'acme.myshopify.com',
      flowId: 'tpl-storefront-order',
    });
    expect(startOrderOnce).not.toHaveBeenCalled();
  });

  it('refuses a bad signature, another store and a missing secret before anything is written', async () => {
    expect((await fromShopify({ secret: 'wrong' })).status).toBe(401);
    expect((await fromShopify({ shop: 'rival.myshopify.com' })).status).toBe(403);
    env.SHOPIFY_WEBHOOK_SECRET = undefined;
    expect((await fromShopify()).status).toBe(503);
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps nothing for another topic or a body that can never start an order', async () => {
    expect(await (await fromShopify({ topic: 'orders/updated' })).json()).toEqual({
      ignored: true,
      topic: 'orders/updated',
    });
    const raw = JSON.stringify({ ...shopify, line_items: [] });
    const res = await handleShopifyOrder(
      new Request('https://app.test/api/v1/channels/shopify/orders', {
        method: 'POST',
        headers: {
          'x-shopify-hmac-sha256': await hmac('shpss_test', raw),
          'x-shopify-topic': 'orders/create',
          'x-shopify-shop-domain': 'acme.myshopify.com',
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('answers 503 so Shopify retries when the body or the queue cannot be written', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    put.mockRejectedValueOnce(new Error('R2 is down'));
    expect((await fromShopify()).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    send.mockRejectedValueOnce(new Error('Queues is down'));
    expect((await fromShopify()).status).toBe(503);
    // The retry writes the same key again.
    expect((await fromShopify()).status).toBe(202);
    expect(put.mock.calls.map((c) => c[0])).toEqual(
      Array(3).fill(`intake/shopify/${today}/wh-123`),
    );
    err.mockRestore();
  });

  it('starts the order before it answers when no queue is bound, as before', async () => {
    env.INTAKE_QUEUE = undefined;
    startOrderOnce.mockReset().mockResolvedValue({ orderId: 'ord_1' });
    const res = await fromShopify();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orderId: 'ord_1', flowId: 'tpl-storefront-order' });
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

const operator: Principal = { kind: 'token', id: 'tok_1', name: 'edi', role: 'operator' };
const isa = (sender: string) =>
  `ISA*00*          *00*          *ZZ*${sender.padEnd(15)}*ZZ*COMMERCEWORKER *261014*1200*U*00401*000000001*0*P*>~`;
const tx = (control: string, po: string) =>
  [
    `ST*850*${control}`,
    `BEG*00*SA*${po}**20261014`,
    'PO1*1*120*EA*21.50**VP*WID-100',
    'CTT*1',
    `SE*5*${control}`,
  ].join('~');
const noPo = ['ST*850*0002', 'PO1*1*1*EA*1**VP*WID-100', 'CTT*1', 'SE*4*0002'].join('~');
const x12 = (sender: string, txs: string[]) =>
  `${isa(sender)}GS*PO*${sender}*COMMERCEWORKER*20261014*1200*1*X*004010~${txs.join('~')}~GE*${txs.length}*1~IEA*1*000000001~`;
const postEdi = (body: string, role: Principal['role'] = 'operator') =>
  handleApi(
    new Request('https://app.test/api/v1/channels/edi/850', {
      method: 'POST',
      headers: { 'content-type': 'application/edi-x12' },
      body,
    }),
    { ...operator, role },
  );

describe('EDI intake', () => {
  it('keeps the interchange, queues it and still answers its 997, with the engine down', async () => {
    const text = x12('NORTHWIND', [tx('0001', 'NW-1'), tx('0002', 'NW-2')]);
    const res = await postEdi(text);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { functionalAck: string; results: { status: number }[] };
    expect(body.results.map((r) => r.status)).toEqual([202, 202]);
    expect(body.functionalAck).toContain(
      '~AK1*PO*1~AK2*850*0001~AK5*A~AK2*850*0002~AK5*A~AK9*A*2*2*2~',
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toMatch(new RegExp(`^intake/edi/${today}/[0-9a-f]{40}$`));
    expect(put.mock.calls[0]![1]).toBe(text);
    expect(send.mock.calls[0]![0]).toMatchObject({
      channel: 'edi',
      sender: 'NORTHWIND',
      customerId: 'cus_northwind',
      flows: { '0001': 'tpl-b2b-order', '0002': 'tpl-b2b-order' },
      actor: { kind: 'token', id: 'tok_1' },
    });
    // An id only: a dead letter keeps this message for months.
    expect(send.mock.calls[0]![0].actor).not.toHaveProperty('name');
    expect(startOrderOnce).not.toHaveBeenCalled();
    // The same interchange sent again names the same object.
    await postEdi(text);
    expect(put.mock.calls[1]![0]).toBe(put.mock.calls[0]![0]);
  });

  it('rejects in the 997 a PO that cannot map, and queues only the rest', async () => {
    const res = await postEdi(x12('NORTHWIND', [tx('0001', 'NW-3'), noPo]));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { results: { status: number }[]; functionalAck: string };
    expect(body.results.map((r) => r.status)).toEqual([202, 400]);
    expect(body.functionalAck).toContain('~AK2*850*0001~AK5*A~AK2*850*0002~AK5*R*5~AK9*P*2*2*1~');
    expect(send.mock.calls[0]![0].flows).toEqual({ '0001': 'tpl-b2b-order' });
  });

  it('writes nothing for an unknown partner, bad X12, a caller below operator or nothing it can start', async () => {
    expect((await postEdi(x12('STRANGER', [tx('0001', 'X-1')]))).status).toBe(403);
    expect((await postEdi('not x12')).status).toBe(400);
    expect((await postEdi(x12('NORTHWIND', [tx('0001', 'NW-1')]), 'viewer')).status).toBe(403);
    const none = await postEdi(x12('NORTHWIND', [noPo]));
    expect(none.status).toBe(200);
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('answers 503 when the interchange cannot be kept, and stays synchronous with no queue', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    put.mockRejectedValueOnce(new Error('R2 is down'));
    expect((await postEdi(x12('NORTHWIND', [tx('0001', 'NW-1')]))).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    err.mockRestore();

    env.INTAKE_QUEUE = undefined;
    startOrderOnce.mockReset().mockResolvedValue({ orderId: 'ord_a' });
    const res = await postEdi(x12('NORTHWIND', [tx('0001', 'NW-1')]));
    expect(res.status).toBe(200);
    expect(startOrderOnce).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('rejects in the 997 a PO in a currency with no rate, as the synchronous route does', async () => {
    currencies.mockResolvedValue([{ currency: 'EUR' }]);
    const res = await postEdi(x12('NORTHWIND', [tx('0001', 'NW-7')]));
    // Nothing in it can start, so nothing is kept and the answer is the same 200 as before.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { status: number; error?: string }[];
      functionalAck: string;
    };
    expect(body.results[0]).toMatchObject({ status: 400 });
    expect(body.results[0]!.error).toMatch(/Unsupported currency USD/);
    expect(body.functionalAck).toContain('~AK5*R*5~');
    expect(put).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Shopify currency', () => {
  it('refuses a currency with no rate with a 400, and keeps nothing', async () => {
    currencies.mockResolvedValue([{ currency: 'EUR' }]);
    expect((await fromShopify()).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    currencies.mockRejectedValue(new Error('D1 is down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await fromShopify()).status).toBe(503);
    err.mockRestore();
  });
});
