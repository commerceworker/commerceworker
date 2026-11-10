import { type CartGuest, signCartGuestSession, verifyGuestActor } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));
const env = { STOREFRONT_KEY: 'storefront-test-key', API_LIMIT: { limit } };
const searchCartProducts = vi.fn();

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ searchCartProducts }) }));
const route = await import('../app/routes/cart-products');

const guest: CartGuest = { cartId: 'cart_1', id: 'guest:b1', name: 'Pat Buyer' };
const guestCookie = async (g = guest) =>
  `__Host-ol_${g.cartId}=${await signCartGuestSession(env.STOREFRONT_KEY, g, Date.now() + 60_000)}`;
const found = {
  ok: true,
  currency: 'USD',
  more: false,
  products: [{ sku: 'WID-100', name: 'Industrial widget', unitPrice: 21.5 }],
};

/** The loader's answer: its data, or the status and body of what it threw. */
const get = (q: string | null, headers: Record<string, string> = {}, cartId = 'cart_1') =>
  route
    .loader({
      request: new Request(
        `https://shop.test/carts/${cartId}/products${q === null ? '' : `?q=${encodeURIComponent(q)}`}`,
        { headers },
      ),
      params: { cartId },
    } as never)
    .then(
      (r) => ({ status: r.init?.status ?? 200, data: r.data, headers: r.init?.headers }),
      async (e: { init?: { status: number }; data?: unknown } | Response) =>
        e instanceof Response
          ? { status: e.status, data: await e.json(), headers: Object.fromEntries(e.headers) }
          : { status: e.init?.status, data: e.data, headers: undefined },
    );

beforeEach(() => {
  searchCartProducts.mockReset();
  limit.mockReset();
  limit.mockResolvedValue({ success: true });
});

describe('searching products from a cart', () => {
  it('asks as the buyer a cart admitted, signed for that cart only, and answers the page', async () => {
    searchCartProducts.mockResolvedValue(found);
    const r = await get('widget', { cookie: await guestCookie() });
    expect(r).toMatchObject({
      status: 200,
      data: { currency: 'USD', more: false, products: found.products },
      headers: { 'cache-control': 'private, no-store' },
    });
    expect(r.data).not.toHaveProperty('ok');
    const actor = searchCartProducts.mock.calls[0]![2];
    expect(await verifyGuestActor([env.STOREFRONT_KEY], actor, 'cart:cart_1')).toEqual({
      kind: 'guest',
      id: 'guest:b1',
      name: 'Pat Buyer',
    });
    // Their cookie for cart_1 opens no other cart's search.
    expect(await get('widget', { cookie: await guestCookie() }, 'cart_2')).toMatchObject({
      status: 401,
    });
    // Nor does a cookie named for cart_2 that was signed for cart_1.
    const moved = (await guestCookie()).replace('__Host-ol_cart_1=', '__Host-ol_cart_2=');
    expect(await get('widget', { cookie: moved }, 'cart_2')).toMatchObject({ status: 401 });
    expect(searchCartProducts).toHaveBeenCalledTimes(1);
  });

  it('refuses a stranger, a forged cookie and an expired one without asking the engine', async () => {
    expect(await get('widget')).toMatchObject({ status: 401 });
    // A staff token is no way in here: staff search on the admin.
    expect(await get('widget', { authorization: 'Bearer cmw_live_x' })).toMatchObject({
      status: 401,
    });
    expect(await get('widget', { cookie: '__Host-ol_cart_1=forged.value' })).toMatchObject({
      status: 401,
    });
    const lapsed = `__Host-ol_cart_1=${await signCartGuestSession(env.STOREFRONT_KEY, guest, Date.now() - 1)}`;
    expect(await get('widget', { cookie: lapsed })).toMatchObject({ status: 401 });
    const otherKey = `__Host-ol_cart_1=${await signCartGuestSession('another-key', guest, Date.now() + 60_000)}`;
    expect(await get('widget', { cookie: otherKey })).toMatchObject({ status: 401 });
    expect(searchCartProducts).not.toHaveBeenCalled();
  });

  it('passes on what the engine refuses: an unknown cart, a viewer, a closed cart', async () => {
    searchCartProducts.mockResolvedValueOnce({ ok: false, error: 'No such cart.', notFound: true });
    expect(await get('widget', { cookie: await guestCookie() })).toMatchObject({
      status: 404,
      data: { error: 'No such cart.' },
    });
    searchCartProducts.mockResolvedValueOnce({ ok: false, error: "You can't change this cart." });
    expect(await get('widget', { cookie: await guestCookie() })).toMatchObject({
      status: 403,
      data: { error: "You can't change this cart." },
    });
    searchCartProducts.mockResolvedValueOnce({ ok: false, error: 'The cart has closed.' });
    expect(await get('widget', { cookie: await guestCookie() })).toMatchObject({ status: 403 });
  });

  it('passes an empty search on as one, and only so much of a long one', async () => {
    searchCartProducts.mockResolvedValue(found);
    await get(null, { cookie: await guestCookie() });
    await get('x'.repeat(5_000), { cookie: await guestCookie() });
    expect(searchCartProducts.mock.calls.map((c) => (c[1] as string).length)).toEqual([0, 200]);
  });

  it('has no page size to ask for: the engine answers CART_SEARCH_LIMIT at most', async () => {
    searchCartProducts.mockResolvedValue(found);
    await route.loader({
      request: new Request('https://shop.test/carts/cart_1/products?q=w&limit=100000&offset=5', {
        headers: { cookie: await guestCookie() },
      }),
      params: { cartId: 'cart_1' },
    } as never);
    const call = searchCartProducts.mock.calls[0]!;
    expect(call).toHaveLength(3);
    expect(call.slice(0, 2)).toEqual(['cart_1', 'w']);
  });

  it('spends a budget of its own per buyer and cart, refusing past it', async () => {
    searchCartProducts.mockResolvedValue(found);
    await get('widget', { cookie: await guestCookie() });
    // Per cart, since a cart's buyers share an id only with themselves; not the admin's per-person key.
    expect(limit.mock.calls.map((c) => c[0].key)).toEqual(['cart-search:cart_1:guest:b1']);
    searchCartProducts.mockClear();
    limit.mockResolvedValue({ success: false });
    const r = await get('widget', { cookie: await guestCookie() });
    expect(r).toMatchObject({ status: 429, headers: { 'retry-after': '60' } });
    expect(r.data).toMatchObject({ error: expect.stringMatching(/Too many requests/) });
    expect(searchCartProducts).not.toHaveBeenCalled();
    // A stranger is refused before spending anyone's budget.
    limit.mockClear();
    expect(await get('widget')).toMatchObject({ status: 401 });
    expect(limit).not.toHaveBeenCalled();
  });
});
