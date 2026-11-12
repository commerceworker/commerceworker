/**
 * A signed-in shopper's pages beyond sign-in: the order list (`/account`), one order
 * (`/account/orders/:id`), the addresses (`/account/addresses`), and the hosted checkout's offer to
 * fill from them. Each sends the engine only the cookie's secret and an actor signed for `shopper`,
 * decides nothing about who owns what (the engine answers null for anything not the session's),
 * is never cached and refers nowhere but its own origin, and posts only plain, same-origin forms.
 */
import {
  type BuyerOrderView,
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
  type ShopperAddress,
  verifyGuestActor,
} from '@commerceworker/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = { STOREFRONT_KEY: 'storefront-test-key' };
const shopperOrders = vi.fn();
const shopperOrder = vi.fn();
const shopperAddresses = vi.fn();
const forgetAddress = vi.fn();
const checkout = vi.fn();
const updateCheckout = vi.fn();
const storefrontSettings = vi.fn();
const limit = vi.fn(async (_o: { key: string }) => ({ success: true }));

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({
    fetch: async () => new Response('ok'),
    shopperOrders,
    shopperOrder,
    shopperAddresses,
    forgetAddress,
    checkout,
    updateCheckout,
    storefrontSettings,
  }),
}));

const { default: worker } = await import('../workers/app');
const list = await import('../app/routes/account');
const orderPage = await import('../app/routes/account-order');
const addressesPage = await import('../app/routes/account-addresses');
const checkoutPage = await import('../app/routes/checkout');
const lib = await import('../app/lib/hosted-checkout.server');
const { CheckoutForm } = await import('../app/components/checkout-form');

const ORIGIN = 'https://shop.test';
const SECRET = 'b2'.repeat(32);
const COOKIE = `__Host-cw_shop=${SECRET}`;

/** What a loader or action sent: a `data()` (body and status), a Response (redirect, 429), or a thrown one. */
async function answer(run: () => Promise<unknown>) {
  const out = await run().catch((e: unknown) => e);
  if (out instanceof Response)
    return {
      status: out.status,
      location: out.headers.get('location'),
      headers: out.headers,
      data: null as unknown,
    };
  const d = out as { data: unknown; init?: ResponseInit };
  return {
    status: d.init?.status ?? 200,
    location: null,
    headers: new Headers(d.init?.headers),
    data: d.data,
  };
}

const get = (path: string, cookie: string | null = COOKIE) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const post = (path: string, fields: Record<string, string>, cookie: string | null = COOKIE) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });

const item = (n: number) => ({
  id: `ord_${n}`,
  ref: `#ord_${n}`,
  placedAt: Date.UTC(2026, 10, n),
  status: 'completed' as const,
  currency: 'USD',
  total: 10 * n,
});
const view: BuyerOrderView = {
  id: 'ord_1',
  ref: '#ord_1',
  status: 'completed',
  placedAt: Date.UTC(2026, 10, 1),
  currency: 'USD',
  lines: [{ sku: 'MUG', name: 'Blue mug', qty: 2, unitPrice: 12, lineTotal: 24 }],
  subtotal: 24,
  shipping: 5,
  tax: 0,
  total: 29,
  shipTo: ['Pat Buyer', '1 Main St', 'Springfield, IL 62701', 'US'],
  shipments: [{ carrier: 'UPS', tracking: '1Z999' }],
};
const place = (over: Partial<ShopperAddress> = {}): ShopperAddress => ({
  id: 'order:ord_1',
  source: 'order',
  name: 'Pat Buyer',
  line1: '1 Main St',
  line2: null,
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'US',
  lastUsedAt: 1,
  ...over,
});

function draw(Component: () => React.JSX.Element, loaderData: object, path = '/p') {
  const Stub = createRoutesStub([{ path, Component: Component as never }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [path],
      hydrationData: { loaderData: { '0': loaderData } },
    }),
  );
}

const private_ = (h: Headers) => {
  expect(h.get('cache-control')).toBe('no-store');
  expect(h.get('referrer-policy')).toBe('same-origin');
};

beforeEach(() => {
  vi.clearAllMocks();
  delete env.API_LIMIT;
  lib.forgetStorefrontSettings();
});

describe('the order list', () => {
  const page = { email: 'pat@example.com', orders: [item(2), item(1)], next: null };

  it('asks for the first page, then the one a cursor names, never anything else from the URL', async () => {
    shopperOrders.mockResolvedValue(page);
    const first = await answer(() => list.loader({ request: get('/account') } as never));
    expect(first.data).toEqual({ ...page, paged: false });
    private_(first.headers);
    expect(shopperOrders.mock.calls[0]![2]).toBeUndefined();

    await answer(() => list.loader({ request: get('/account?after=170:ord_9') } as never));
    expect(shopperOrders.mock.calls[1]![2]).toBe('170:ord_9');
    // A cursor that is too long to be the engine's is not passed on; one of the wrong shape is the engine's to refuse.
    await answer(() => list.loader({ request: get(`/account?after=${'9'.repeat(200)}`) } as never));
    expect(shopperOrders.mock.calls[2]![2]).toBeUndefined();
    // And nothing else in the URL reaches it: not an email, not an id.
    await answer(() =>
      list.loader({ request: get('/account?email=evil@x.test&id=ord_9&customer=cus_1') } as never),
    );
    expect(shopperOrders.mock.calls[3]!.slice(0, 2)).toEqual([SECRET, expect.any(String)]);
    expect(shopperOrders.mock.calls[3]).toHaveLength(3);
  });

  it('presents the actor signed for `shopper`, and the secret as the cookie holds it', async () => {
    shopperOrders.mockResolvedValue(page);
    await answer(() => list.loader({ request: get('/account') } as never));
    const [secret, actor] = shopperOrders.mock.calls[0]!;
    expect(secret).toBe(SECRET);
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, SHOPPER_CALL),
    ).toMatchObject({ id: SHOPPER_GUEST_ID });
  });

  it('goes to sign-in for no session, asking nothing without a cookie', async () => {
    const none = await answer(() => list.loader({ request: get('/account', null) } as never));
    expect([none.status, none.location]).toEqual([303, '/account/sign-in']);
    expect(shopperOrders).not.toHaveBeenCalled();
    shopperOrders.mockResolvedValue(null);
    const ended = await answer(() => list.loader({ request: get('/account') } as never));
    expect([ended.status, ended.location]).toEqual([303, '/account/sign-in']);
    private_(ended.headers);
  });

  it('draws each order as a 44px link to its page, with a link to the next page', () => {
    const html = draw(list.default, { ...page, next: '170:ord_1', paged: false });
    expect(html).toContain('href="/account/orders/ord_2"');
    expect(html).toContain('href="/account/orders/ord_1"');
    expect(html).toContain('Order #ord_2');
    expect(html).toContain('$20.00');
    expect(html).toContain('2026-11-02 · Complete');
    expect(html).toContain('href="/account?after=170%3Aord_1"');
    expect(html).not.toContain('Newest orders');
    expect(html).toMatch(/min-h-11/);
    // A later page can go back to the first.
    expect(draw(list.default, { ...page, next: null, paged: true })).toContain('Newest orders');
    // Sign out is a plain form to /account, and the nav is plain links.
    expect(html).toMatch(/<form [^>]*action="\/account"[^>]*method="post"/);
    expect(html).toContain('href="/account/addresses"');
  });

  it('says there are no orders, without a link to page on', () => {
    const html = draw(list.default, {
      email: 'pat@example.com',
      orders: [],
      next: null,
      paged: false,
    });
    expect(html).toContain('No orders yet');
    expect(html).not.toContain('Older orders');
  });
});

describe('one order', () => {
  const load = (id: string, cookie: string | null = COOKIE) =>
    answer(() =>
      orderPage.loader({
        request: get(`/account/orders/${id}`, cookie),
        params: { id },
      } as never),
    );

  it('shows the engine’s buyer-safe view, uncached, and asks with the session’s credentials', async () => {
    shopperOrder.mockResolvedValue(view);
    const r = await load('ord_1');
    expect(r.status).toBe(200);
    expect(r.data).toEqual(view);
    private_(r.headers);
    const [secret, actor, id] = shopperOrder.mock.calls[0]!;
    expect([secret, id]).toEqual([SECRET, 'ord_1']);
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, SHOPPER_CALL),
    ).toMatchObject({ id: SHOPPER_GUEST_ID });
  });

  it('answers an order that isn’t theirs exactly as one that doesn’t exist', async () => {
    shopperOrder.mockResolvedValue(null);
    const theirs = await load('ord_someone_elses');
    const unknown = await load('ord_nothing');
    expect(theirs.status).toBe(404);
    expect({ ...theirs, headers: undefined }).toEqual({
      ...unknown,
      headers: undefined,
      // Only what the id said differs, and nothing in the answer carries it.
    });
    expect(String(theirs.data)).not.toContain('someone_elses');
    private_(theirs.headers);
  });

  it('never asks the engine about an id that can’t be one', async () => {
    for (const id of ['', 'a b', 'ord/../1', '%00', "x'--", 'x'.repeat(101)]) {
      const r = await load(id);
      expect(r.status, id).toBe(404);
    }
    expect(shopperOrder).not.toHaveBeenCalled();
  });

  it('goes to sign-in without a cookie', async () => {
    const r = await load('ord_1', null);
    expect([r.status, r.location]).toEqual([303, '/account/sign-in']);
    expect(shopperOrder).not.toHaveBeenCalled();
  });

  it('draws the receipt’s own view, with a way back', () => {
    const html = draw(orderPage.default as never, view, '/account/orders/ord_1').replace(
      /<!--.*?-->/g,
      '',
    );
    expect(html).toContain('Order #ord_1');
    expect(html).toContain('Blue mug');
    expect(html).toContain('$29.00');
    expect(html).toContain('Springfield, IL 62701');
    expect(html).toContain('1Z999');
    expect(html).toContain('href="/account"');
  });

  it('sends the same private headers as the rest of the account, errors included', () => {
    const sent = orderPage.headers({
      loaderHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: new Headers({ 'retry-after': '30' }),
    } as never);
    expect(sent.get('cache-control')).toBe('no-store');
    expect(sent.get('referrer-policy')).toBe('same-origin');
    expect(sent.get('retry-after')).toBe('30');
  });
});

describe('the addresses', () => {
  const found = {
    email: 'pat@example.com',
    addresses: [
      place({ id: 'book:adr_1', source: 'book' }),
      place({ id: 'order:ord_2', line1: '9 Oak Ave' }),
    ],
  };

  it('lists what the engine says, uncached', async () => {
    shopperAddresses.mockResolvedValue(found);
    const r = await answer(() =>
      addressesPage.loader({ request: get('/account/addresses') } as never),
    );
    expect(r.data).toEqual(found);
    private_(r.headers);
    expect(shopperAddresses.mock.calls[0]![0]).toBe(SECRET);
  });

  it('goes to sign-in without a session, and is rate limited per client', async () => {
    shopperAddresses.mockResolvedValue(null);
    const ended = await answer(() =>
      addressesPage.loader({ request: get('/account/addresses') } as never),
    );
    expect(ended.location).toBe('/account/sign-in');
    const none = await answer(() =>
      addressesPage.loader({ request: get('/account/addresses', null) } as never),
    );
    expect(none.location).toBe('/account/sign-in');

    env.API_LIMIT = { limit: limit.mockResolvedValueOnce({ success: false }) };
    shopperAddresses.mockClear();
    const limited = await answer(() =>
      addressesPage.loader({
        request: new Request(`${ORIGIN}/account/addresses`, {
          headers: { cookie: COOKIE, 'cf-connecting-ip': '203.0.113.9' },
        }),
      } as never),
    );
    expect(limited.status).toBe(429);
    expect(limit.mock.calls[0]![0].key).toBe('addresses:203.0.113.9');
    expect(shopperAddresses).not.toHaveBeenCalled();
  });

  it('draws Forget only on a saved entry, and says an order’s place comes from the orders', () => {
    const html = draw(addressesPage.default as never, found);
    expect(html.match(/name="forget"/g)).toHaveLength(1);
    expect(html).toContain('value="book:adr_1"');
    expect(html).not.toContain('value="order:ord_2"');
    expect(html).toContain('aria-label="Forget 1 Main St"');
    expect(html).toContain('From your orders');
    expect(html).toContain('9 Oak Ave');
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(html).toContain('min-h-11');
  });

  it('forgets by posting the id, then goes back, the same whether or not anything was forgotten', async () => {
    for (const result of [true, false]) {
      forgetAddress.mockResolvedValueOnce(result);
      const r = await answer(() =>
        addressesPage.action({
          request: post('/account/addresses', { forget: 'book:adr_1' }),
        } as never),
      );
      expect([r.status, r.location]).toEqual([303, '/account/addresses']);
      private_(r.headers);
    }
    const [secret, actor, id] = forgetAddress.mock.calls[0]!;
    expect([secret, id]).toEqual([SECRET, 'book:adr_1']);
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, SHOPPER_CALL),
    ).toMatchObject({ id: SHOPPER_GUEST_ID });
  });

  it('asks nothing for no id, a long one, or without a session', async () => {
    for (const fields of [{}, { forget: 'x'.repeat(101) }, { other: 'book:adr_1' }] as Record<
      string,
      string
    >[])
      await answer(() =>
        addressesPage.action({ request: post('/account/addresses', fields) } as never),
      );
    const none = await answer(() =>
      addressesPage.action({
        request: post('/account/addresses', { forget: 'book:adr_1' }, null),
      } as never),
    );
    expect(none.location).toBe('/account/sign-in');
    expect(forgetAddress).not.toHaveBeenCalled();
  });
});

describe('the Worker around them', () => {
  it('refuses a cross-site POST to the addresses and to a checkout before they run', async () => {
    for (const path of ['/account', '/account/addresses', '/checkout/chk_1']) {
      const res = await worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', cookie: COOKIE },
          body: new URLSearchParams({ forget: 'book:adr_1', intent: 'fill', saved: 'order:ord_1' }),
        }) as never,
      );
      expect(res.status, path).toBe(403);
    }
    expect(forgetAddress).not.toHaveBeenCalled();
    expect(updateCheckout).not.toHaveBeenCalled();
  });
});

describe('a hosted checkout offering a shopper’s own details', () => {
  const CHECKOUT_COOKIE = `__Host-cw_chk_chk_1=${'a1'.repeat(32)}`;
  const both = `${CHECKOUT_COOKIE}; ${COOKIE}`;
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'chk_1',
    status: 'incomplete',
    currency: 'USD',
    lines: [{ id: 'li_1', sku: 'MON-27', qty: 2, title: 'Monitor', unitPrice: 100 }],
    buyer: { firstName: 'Ada' },
    fulfillment: 'ship',
    shipTo: null,
    shippingOption: 'ground',
    pickupLocationId: null,
    pickupStores: [],
    promoCodes: [],
    quote: null,
    issues: [],
    orderId: null,
    expiresAt: 4_102_444_800_000,
    version: 3,
    ...over,
  });
  const saved = {
    email: 'pat@example.com',
    addresses: [
      place({ id: 'book:adr_1', source: 'book' }),
      place({ id: 'order:ord_2', line1: '9 Oak Ave' }),
    ],
  };
  const load = (cookie = both) =>
    answer(() =>
      checkoutPage.loader({
        params: { id: 'chk_1' },
        request: new Request(`${ORIGIN}/checkout/chk_1`, { headers: { cookie } }),
      } as never),
    );
  const fill = (fields: Record<string, string>, cookie = both) =>
    answer(() =>
      checkoutPage.action({
        params: { id: 'chk_1' },
        request: new Request(`${ORIGIN}/checkout/chk_1`, {
          method: 'POST',
          headers: { origin: ORIGIN, cookie },
          body: new URLSearchParams({ version: '3', intent: 'fill', ...fields }),
        }),
      } as never),
    );

  beforeEach(() => {
    storefrontSettings.mockResolvedValue({
      checkout: { enabled: true, editLines: false, testPayments: true, publishableKey: null },
    });
    checkout.mockResolvedValue(session());
  });

  it('offers a signed-in shopper what the engine read, and asks no one else', async () => {
    shopperAddresses.mockResolvedValue(saved);
    const r = await load();
    expect((r.data as { saved: unknown }).saved).toEqual(saved);
    expect(shopperAddresses.mock.calls[0]![0]).toBe(SECRET);

    shopperAddresses.mockClear();
    // Not signed in: nothing asked, nothing offered.
    expect(((await load(CHECKOUT_COOKIE)).data as { saved: unknown }).saved).toBeNull();
    // A cookie the engine no longer knows, or an engine that fails: the checkout still loads, with no offer.
    shopperAddresses.mockResolvedValueOnce(null);
    expect(((await load()).data as { saved: unknown }).saved).toBeNull();
    shopperAddresses.mockRejectedValueOnce(new Error('engine down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down = await load();
    expect(down.status).toBe(200);
    expect((down.data as { saved: unknown }).saved).toBeNull();
    warn.mockRestore();
    // A checkout that is over is not offered anything.
    shopperAddresses.mockClear();
    checkout.mockResolvedValue(session({ status: 'canceled' }));
    expect(((await load()).data as { saved: unknown }).saved).toBeNull();
    expect(shopperAddresses).not.toHaveBeenCalled();
  });

  it('draws the offer inside the one form, as a button and radios that work without a script', () => {
    const form = (over: Record<string, unknown> = {}) =>
      renderToStaticMarkup(
        createElement(
          createRoutesStub([
            {
              path: '/p',
              Component: () =>
                createElement(CheckoutForm, {
                  checkout: session() as never,
                  saved,
                  testPayments: true,
                  editLines: false,
                  attempted: false,
                  busy: false,
                  ...over,
                }),
            },
          ]),
          { initialEntries: ['/p'] },
        ),
      );
    const html = form();
    expect(html).toContain('Signed in as pat@example.com');
    expect(html).toMatch(/<button [^>]*value="fill"[^>]*name="intent"/);
    expect(html).toContain('Use these details');
    expect(html.match(/name="saved"/g)).toHaveLength(2);
    expect(html).toContain('1 Main St');
    // Only the first (the newest) starts chosen.
    expect(html.match(/checked=""/g)?.length).toBe(1);
    expect(form({ saved: { email: 'pat@example.com', addresses: [] } })).toContain('Use my email');
    expect(form({ saved: null })).not.toContain('value="fill"');
    expect(form({ errors: { saved: 'That address isn’t saved any more.' } })).toContain(
      'isn’t saved any more',
    );
  });

  it('fills the email and the chosen place from the engine’s list, whatever the form says', async () => {
    shopperAddresses.mockResolvedValue(saved);
    updateCheckout.mockResolvedValue({ ok: true, checkout: session({ version: 4 }) });
    const r = await fill({
      saved: 'order:ord_2',
      // What a page could post to try to pass its own details off as the shopper's.
      email: 'evil@example.com',
      'shipTo.line1': '1 Evil Rd',
      'shipTo.city': 'Nowhere',
      shippingOption: 'air',
    });
    expect([r.status, r.location]).toEqual([303, '/checkout/chk_1']);
    const [id, patch, secret, , version] = updateCheckout.mock.calls[0]!;
    expect([id, secret, version]).toEqual(['chk_1', 'a1'.repeat(32), 3]);
    expect(patch).toEqual({
      buyer: { firstName: 'Ada', email: 'pat@example.com' },
      shipTo: {
        name: 'Pat Buyer',
        line1: '9 Oak Ave',
        city: 'Springfield',
        region: 'IL',
        postalCode: '62701',
        country: 'US',
      },
      // The address changed, so the option chosen for the old one goes.
      shippingOption: null,
    });
    expect(JSON.stringify(patch)).not.toMatch(/evil|Evil|Nowhere|air/);
    expect(JSON.stringify(patch)).not.toMatch(/price|total|owner|status/i);
  });

  it('fills only the email when no place is chosen', async () => {
    shopperAddresses.mockResolvedValue(saved);
    updateCheckout.mockResolvedValue({ ok: true, checkout: session({ version: 4 }) });
    await fill({});
    expect(updateCheckout.mock.calls[0]![1]).toEqual({
      buyer: { firstName: 'Ada', email: 'pat@example.com' },
    });
  });

  it('refuses a place the engine doesn’t list, an id of another’s, and a shopper who signed out', async () => {
    shopperAddresses.mockResolvedValue(saved);
    for (const id of ['order:ord_someone_elses', 'book:adr_not_mine', 'x', "'; drop"]) {
      const r = await fill({ saved: id });
      expect(r.status, id).toBe(422);
      expect(r.data).toMatchObject({ intent: 'update', errors: { saved: expect.any(String) } });
    }
    shopperAddresses.mockResolvedValue(null);
    const out = await fill({ saved: 'order:ord_2' });
    expect(out.status).toBe(422);
    expect(out.data).toMatchObject({ errors: { saved: expect.stringContaining('Sign in again') } });
    // Not signed in at all: nothing to read from, so nothing to fill with.
    const anon = await fill({ saved: 'order:ord_2' }, CHECKOUT_COOKIE);
    expect(anon.status).toBe(422);
    expect(updateCheckout).not.toHaveBeenCalled();
  });

  it('says the checkout changed when the page was out of date, as any update does', async () => {
    shopperAddresses.mockResolvedValue(saved);
    updateCheckout.mockResolvedValue({
      ok: false,
      changed: true,
      error: 'This checkout changed.',
      checkout: session({ version: 5 }),
    });
    const r = await fill({ saved: 'order:ord_2' });
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ intent: 'update', changed: true });
  });
});
