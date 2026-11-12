import type { BuyerOrderView } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = {};
const orderReceipt = vi.fn();

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ orderReceipt }) }));

const receipt = await import('../app/routes/order-receipt');

const TOKEN = 'a'.repeat(64);
const view: BuyerOrderView = {
  id: 'ord_1',
  ref: '#ord_1',
  status: 'completed',
  placedAt: 0,
  currency: 'USD',
  lines: [{ sku: 'MUG', name: 'Mug', qty: 1, unitPrice: 5, lineTotal: 5 }],
  subtotal: 5,
  shipping: 0,
  tax: 0,
  total: 5,
  shipTo: ['1 Main St'],
  shipments: [],
};
const load = (path: string) =>
  receipt.loader({
    request: new Request(`https://shop.test${path}`),
    params: { orderId: path.split('?')[0]!.split('/')[2] },
  } as never);

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    const { data, init } = e as { data: string; init: ResponseInit };
    return { message: data, status: init.status, headers: new Headers(init.headers) };
  }
  throw new Error('expected a refusal');
}

const private_ = (h: Headers) => {
  expect(h.get('cache-control')).toBe('no-store');
  expect(h.get('referrer-policy')).toBe('no-referrer');
  expect(h.get('x-robots-tag')).toContain('noindex');
};

beforeEach(() => {
  orderReceipt.mockReset();
  delete env.API_LIMIT;
});

describe('the receipt page', () => {
  it('shows the order for a valid credential, never cached and with no referrer', async () => {
    orderReceipt.mockResolvedValueOnce(view);
    const res = (await load(`/orders/ord_1?t=${TOKEN}`)) as unknown as {
      data: BuyerOrderView;
      init: ResponseInit;
    };
    expect(orderReceipt).toHaveBeenCalledWith('ord_1', TOKEN);
    expect(res.data).toEqual(view);
    private_(new Headers(res.init.headers));
  });

  it('answers a wrong, expired or unknown credential alike, and cached nowhere', async () => {
    orderReceipt.mockResolvedValue(null);
    for (const path of [`/orders/ord_1?t=${'b'.repeat(64)}`, '/orders/ord_nope?t=x']) {
      const r = await refusal(() => load(path));
      expect(r.status).toBe(404);
      expect(r.message).toMatch(/isn’t valid, or it has expired/);
      private_(r.headers);
    }
  });

  it('refuses a link with no credential or a malformed id without asking the engine', async () => {
    expect((await refusal(() => load('/orders/ord_1'))).status).toBe(404);
    expect((await refusal(() => load(`/orders/${'x'.repeat(200)}?t=${TOKEN}`))).status).toBe(404);
    expect(orderReceipt).not.toHaveBeenCalled();
  });

  it('is rate limited per caller', async () => {
    env.API_LIMIT = { limit: async () => ({ success: false }) };
    const res = await load(`/orders/ord_1?t=${TOKEN}`).catch((r: Response) => r);
    expect((res as Response).status).toBe(429);
    expect(orderReceipt).not.toHaveBeenCalled();
  });

  it('hands React Router the refusal’s headers when it errors', () => {
    const h = new Headers({ 'cache-control': 'no-store' });
    expect(receipt.headers({ errorHeaders: h, loaderHeaders: new Headers() } as never)).toBe(h);
  });
});
