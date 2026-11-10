import {
  type Cart,
  type CartGuest,
  type CartState,
  PRINCIPAL_HEADER,
  signCartGuestSession,
  verifyCartGuest,
  verifyPrincipal,
} from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = { PRINCIPAL_KEY: 'storefront-test-key' };
const engineFetch = vi.fn(async (_r: Request) => new Response('ok'));
const redeemCartStart = vi.fn();
const cartSnapshot = vi.fn();
const customers = vi.fn(async (_ids: string[]): Promise<{ id: string; name: string }[]> => []);

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: engineFetch, redeemCartStart, cartSnapshot }),
  docs: () => ({}),
}));
vi.mock('~/lib/wire.server', () => ({ pricingStore: () => ({ customers }) }));

const { default: worker } = await import('../workers/app');
const cartStart = await import('../app/routes/cart-start');
const cartBuy = await import('../app/routes/cart-buy');

const guest: CartGuest = { cartId: 'cart_1', id: 'guest:b1', name: 'Pat Buyer' };
const guestCookie = async (g = guest) =>
  `ol_${g.cartId}=${await signCartGuestSession(env.PRINCIPAL_KEY, g, Date.now() + 60_000)}`;
const socket = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://shop.test${path}`, {
      headers: { upgrade: 'websocket', origin: 'https://shop.test', ...headers },
    }) as never,
    env as never,
  );

describe('an external cart’s buyer on its socket', () => {
  beforeEach(() => {
    engineFetch.mockClear();
  });

  it('forwards the buyer to their own cart with a guest header and no credentials', async () => {
    const res = await socket('/agents/cart-agent/cart_1', {
      cookie: await guestCookie(),
      authorization: 'Basic eDp5',
    });
    expect(res.status).toBe(200);
    const forwarded = engineFetch.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe('/agents/cart-agent/cart_1');
    expect(forwarded.headers.get('cookie')).toBeNull();
    expect(forwarded.headers.get('authorization')).toBeNull();
    const header = forwarded.headers.get(PRINCIPAL_HEADER);
    expect(await verifyCartGuest([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_1')).toEqual(
      guest,
    );
    // Signed for this path alone, and never as a principal.
    expect(await verifyCartGuest([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_2')).toBe(
      null,
    );
    expect(await verifyPrincipal([env.PRINCIPAL_KEY], header, '/agents/cart-agent/cart_1')).toBe(
      null,
    );
  });

  it('refuses a buyer’s cookie on another cart’s socket', async () => {
    const res = await socket('/agents/cart-agent/cart_2', { cookie: await guestCookie() });
    expect(res.status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('refuses a malformed cart id instead of failing on it', async () => {
    for (const path of ['/agents/cart-agent/%E0%A4%A', '/agents/cart-agent/cart%5F1']) {
      const res = await socket(path, { cookie: await guestCookie() });
      expect(res.status).toBe(401);
    }
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('takes no sign-in: a staff session or token is no way onto a cart’s socket', async () => {
    // Staff reach a cart's socket on the admin. Here only the cookie a start link set admits.
    for (const headers of [
      { authorization: 'Bearer cmw_live_x' } as Record<string, string>,
      { cookie: 'ol_session=anything; ol_cart_1=forged' },
    ]) {
      expect((await socket('/agents/cart-agent/cart_1', headers)).status).toBe(401);
    }
    // Not a buyer's cookie for another cart's name either.
    expect((await socket('/agents/cart-agent/cart_1?as=guest')).status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('serves no other agent’s socket', async () => {
    // The order and assistant sockets are the admin's: they are not routes here.
    for (const path of ['/agents/order-agent/ord_1', '/agents/assistant-agent/usr_1']) {
      // They fall through to the app's own routes, which have none for them.
      await socket(path, { cookie: await guestCookie() }).catch(() => null);
    }
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it('refuses a cross-site socket upgrade even with the buyer’s cookie', async () => {
    const res = await socket('/agents/cart-agent/cart_1', {
      cookie: await guestCookie(),
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(engineFetch).not.toHaveBeenCalled();
  });
});

/** What a loader threw, as React Router sees a `data()` refusal. */
async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    const { data, init } = e as { data: string; init: ResponseInit };
    return { message: data, status: init.status, headers: new Headers(init.headers) };
  }
  throw new Error('expected a refusal');
}

const external = {
  pluginId: 'punchout',
  sessionRef: 's1',
  expiresAt: Date.now() + 60_000,
  idleMs: null,
  returnUrl: 'https://buyer.example/punchout;jsessionid=A',
  frameOrigins: ['https://buyer.example'],
  buyer: { id: 'b1', name: 'Pat Buyer' },
};
const snapshot = (cart: Partial<Cart>): CartState => ({
  cart: { id: 'cart_1', status: 'open', customerId: null, external, ...cart } as Cart,
  members: [],
  chat: [],
});

describe('the buyer’s pages refuse in a frame they can show', () => {
  const frameable = (headers: Headers) =>
    expect(JSON.parse(headers.get('x-commerceworker-embed') ?? '{}')).toEqual({
      frameAncestors: ['https:'],
    });

  it('a used or expired start link', async () => {
    redeemCartStart.mockResolvedValueOnce(null);
    const r = await refusal(() =>
      cartStart.loader({ params: { cartId: 'cart_1', token: 't' } } as never),
    );
    expect(r.status).toBe(410);
    expect(r.message).toMatch(/used or has expired/);
    frameable(r.headers);
    expect(
      cartStart.headers({ errorHeaders: r.headers, loaderHeaders: new Headers() } as never),
    ).toBe(r.headers);
  });

  it('a cart page without the buyer’s cookie', async () => {
    const r = await refusal(() =>
      cartBuy.loader({
        request: new Request('https://shop.test/cart/cart_1'),
        params: { cartId: 'cart_1' },
      } as never),
    );
    expect(r.status).toBe(401);
    frameable(r.headers);
    expect(cartSnapshot).not.toHaveBeenCalled();
  });

  it('a cart that has closed, and one that went back to the buyer past its time', async () => {
    const request = new Request('https://shop.test/cart/cart_1', {
      headers: { cookie: await guestCookie() },
    });
    const load = () => cartBuy.loader({ request, params: { cartId: 'cart_1' } } as never);
    for (const cart of [
      { status: 'canceled' as const },
      { status: 'submitted' as const },
      { external: { ...external, expiresAt: Date.now() - 1 } },
      // Its cookie may outlast it (an idle window's cap), but a returned cart ends at its time.
      { status: 'returned' as const, external: { ...external, expiresAt: Date.now() - 1 } },
    ]) {
      cartSnapshot.mockResolvedValueOnce(snapshot(cart));
      const r = await refusal(load);
      expect(r.status).toBe(410);
      expect(r.message).toMatch(/has closed/);
      frameable(r.headers);
    }
    cartSnapshot.mockResolvedValueOnce(snapshot({ status: 'returned' }));
    const page = (await load()) as unknown as { init: ResponseInit };
    expect(JSON.parse(new Headers(page.init.headers).get('x-commerceworker-embed')!)).toEqual({
      frameAncestors: ['https://buyer.example'],
      formAction: ['https://buyer.example/punchout;jsessionid=A'],
    });
  });
});

describe('the buyer’s cart page', () => {
  it('names the customer the cart is for, read here and never from the admin', async () => {
    customers.mockResolvedValueOnce([{ id: 'cus_1', name: 'Contoso Ltd' }]);
    cartSnapshot.mockResolvedValueOnce(snapshot({ customerId: 'cus_1' }));
    const page = (await cartBuy.loader({
      request: new Request('https://shop.test/cart/cart_1', {
        headers: { cookie: await guestCookie() },
      }),
      params: { cartId: 'cart_1' },
    } as never)) as unknown as { data: { customerName: string | null; guest: CartGuest } };
    expect(customers).toHaveBeenCalledWith(['cus_1']);
    expect(page.data.customerName).toBe('Contoso Ltd');
    expect(page.data.guest).toEqual(guest);
  });
});
