import { hostedCall, hostedGuestId, hostedHash, verifyGuestActor } from '@commerceworker/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = { STOREFRONT_KEY: 'storefront-test-key' };
const engineFetch = vi.fn(async (_r: Request) => new Response('ok'));
const redeemCheckoutStart = vi.fn();
const checkout = vi.fn();
const storefrontSettings = vi.fn(async () => ({
  checkout: { enabled: true, editLines: false, testPayments: true, publishableKey: null },
}));

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: engineFetch, redeemCheckoutStart, checkout, storefrontSettings }),
}));

const { default: worker } = await import('../workers/app');
const start = await import('../app/routes/checkout-start');
const page = await import('../app/routes/checkout');
const lib = await import('../app/lib/hosted-checkout.server');

const SECRET = 'a1'.repeat(32);
const later = () => Date.now() + 3_600_000;
const startRequest = (url = 'https://shop.test/checkout/start/chk_1/tok') => new Request(url);
const pageRequest = (cookie?: string, url = 'https://shop.test/checkout/chk_1') =>
  new Request(url, { headers: cookie ? { cookie } : {} });

/** What a loader threw: a `data()` refusal or a Response (a 429). */
async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    if (e instanceof Response) return { status: e.status, headers: e.headers, message: null };
    const { data, init } = e as { data: string; init: ResponseInit };
    return { message: data, status: init.status, headers: new Headers(init.headers) };
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  lib.forgetStorefrontSettings();
  storefrontSettings.mockResolvedValue({
    checkout: { enabled: true, editLines: false, testPayments: true, publishableKey: null },
  });
  delete env.API_LIMIT;
});

const post = (url = 'https://shop.test/checkout/start/chk_1/tok') =>
  new Request(url, { method: 'POST', headers: { origin: 'https://shop.test' } });
const redeem = (request = post(), token = 'tok') =>
  start.action({ params: { id: 'chk_1', token }, request } as never) as Promise<Response>;

describe('a hosted checkout’s start link: a GET only shows a page', () => {
  it('never redeems, sets no cookie, and is never cached or referred', async () => {
    const res = (await start.loader({
      params: { id: 'chk_1', token: 'tok' },
      request: startRequest(),
    } as never)) as unknown as { data: unknown; init: ResponseInit };
    const headers = new Headers(res.init.headers);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('referrer-policy')).toBe('same-origin');
    expect(headers.has('set-cookie')).toBe(false);
    // The token isn't in what the page is given, and the engine wasn't asked for anything.
    expect(JSON.stringify(res.data)).not.toContain('tok');
    expect(redeemCheckoutStart).not.toHaveBeenCalled();
    expect(storefrontSettings).not.toHaveBeenCalled();
    // React Router hands `headers` all three sets, the unused ones empty: the page is private anyway.
    const sent = start.headers({
      loaderHeaders: headers,
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    } as never);
    expect(sent.get('cache-control')).toBe('no-store');
    expect(sent.get('referrer-policy')).toBe('same-origin');
  });

  it('refuses a malformed id and still redeems nothing', async () => {
    const r = await refusal(() =>
      start.loader({ params: { id: '../x', token: 't' }, request: startRequest() } as never),
    );
    expect(r.status).toBe(404);
    expect(redeemCheckoutStart).not.toHaveBeenCalled();
  });

  it('is a form that posts back to the same path, with a 44px button', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const html = renderToStaticMarkup(createElement(start.default));
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(html).not.toContain('action=');
    expect(html).toContain('Continue to checkout');
    expect(html).toContain('min-h-11');
    expect(html).toMatch(/pt-safe-6|pb-safe-6/);
  });

  it('is not redeemed by a Worker GET or HEAD either, `.data` twin included', async () => {
    for (const [method, path] of [
      ['GET', '/checkout/start/chk_1/tok'],
      ['HEAD', '/checkout/start/chk_1/tok'],
      ['GET', '/checkout/start/chk_1/tok.data'],
    ] as const) {
      await worker
        .fetch(new Request(`https://shop.test${path}`, { method }) as never)
        .catch(() => null);
    }
    expect(redeemCheckoutStart).not.toHaveBeenCalled();
  });
});

describe('redeeming a hosted checkout’s start link by POST', () => {
  it('sets the engine’s secret as a __Host- cookie and 303s to the page, never cached', async () => {
    redeemCheckoutStart.mockResolvedValueOnce({ secret: SECRET, expiresAt: later() });
    const res = await redeem();
    expect(redeemCheckoutStart).toHaveBeenCalledTimes(1);
    expect(redeemCheckoutStart).toHaveBeenCalledWith('chk_1', 'tok');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/checkout/chk_1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(
      new RegExp(
        `^__Host-cw_chk_chk_1=${SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3[56]\\d\\d$`,
      ),
    );
    // A __Host- cookie has no Domain, and this one is its own top-level page's: not partitioned.
    expect(set).not.toMatch(/Domain|Partitioned|SameSite=None/);
  });

  it('is plain cw_chk_ and not Secure over http, local development only', async () => {
    redeemCheckoutStart.mockResolvedValueOnce({ secret: SECRET, expiresAt: later() });
    const res = await redeem(post('http://localhost/checkout/start/chk_1/tok'));
    const set = res.headers.get('set-cookie')!;
    expect(set.startsWith(`cw_chk_chk_1=${SECRET};`)).toBe(true);
    expect(set).not.toMatch(/Secure|__Host/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
  });

  it('refuses a used or expired link, uncached, without a cookie', async () => {
    redeemCheckoutStart.mockResolvedValueOnce(null);
    const r = await refusal(() => redeem());
    expect(r.status).toBe(410);
    expect(r.message).toMatch(/used or has expired/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.has('set-cookie')).toBe(false);
    const sent = start.headers({
      errorHeaders: r.headers,
      loaderHeaders: new Headers(),
      actionHeaders: new Headers(),
    } as never);
    expect(sent.get('cache-control')).toBe('no-store');
  });

  it('refuses while hosted checkout is off without asking the engine to redeem', async () => {
    storefrontSettings.mockResolvedValue({
      checkout: { enabled: false, editLines: false, testPayments: true, publishableKey: null },
    });
    expect((await refusal(() => redeem())).status).toBe(404);
    expect(redeemCheckoutStart).not.toHaveBeenCalled();
  });

  it('holds each link to its own budget', async () => {
    const spent = await hostedHash('tokx');
    const limit = vi.fn(async (o: { key: string }) => ({ success: !o.key.endsWith(spent) }));
    env.API_LIMIT = { limit };
    const r = await refusal(() => redeem(post(), 'tokx'));
    expect(r.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: `checkout-start:chk_1:${spent}` });
    expect(redeemCheckoutStart).not.toHaveBeenCalled();
    // Another link for the same checkout is another budget.
    redeemCheckoutStart.mockResolvedValueOnce(null);
    expect((await refusal(() => redeem(post(), 'tokz'))).status).toBe(410);
  });
});

describe('the buyer’s checkout page', () => {
  const session = { id: 'chk_1', status: 'incomplete', lines: [{ id: 'li_1', sku: 'A', qty: 1 }] };
  const cookie = `__Host-cw_chk_chk_1=${SECRET}`;

  it('sends the engine the cookie’s secret and an actor signed for this checkout', async () => {
    checkout.mockResolvedValueOnce(session);
    const res = (await page.loader({
      params: { id: 'chk_1' },
      request: pageRequest(cookie),
    } as never)) as unknown as { data: unknown; init: ResponseInit };
    expect(res.data).toEqual({
      checkout: session,
      saved: null,
      testPayments: true,
      editLines: false,
      publishableKey: null,
      turnstileKey: null,
    });
    const headers = new Headers(res.init.headers);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('referrer-policy')).toBe('same-origin');

    const [id, secret, actor] = checkout.mock.calls[0]!;
    expect(id).toBe('chk_1');
    // The engine is given the cookie's secret and hashes it to compare: nothing stored can be presented.
    expect(secret).toBe(SECRET);
    // Signed under the storefront key for this checkout alone, as the buyer of this checkout.
    const keys = [env.STOREFRONT_KEY as string];
    expect(await verifyGuestActor(keys, actor, hostedCall('chk_1'))).toEqual({
      kind: 'guest',
      id: hostedGuestId('chk_1'),
      name: 'Buyer',
    });
    expect(await verifyGuestActor(keys, actor, hostedCall('chk_2'))).toBeNull();
  });

  it('is refused without the cookie, with another checkout’s, a forged or the wrong scheme’s', async () => {
    for (const c of [
      undefined,
      `__Host-cw_chk_chk_2=${SECRET}`,
      `__Host-cw_chk_chk_1=not-a-secret`,
      `__Host-cw_chk_chk_1=${SECRET}x`,
      // The plain-http name is never read over https.
      `cw_chk_chk_1=${SECRET}`,
      `ol_session=anything; authorization=Bearer x`,
    ]) {
      const r = await refusal(() =>
        page.loader({ params: { id: 'chk_1' }, request: pageRequest(c) } as never),
      );
      expect(r.status, String(c)).toBe(401);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect(checkout).not.toHaveBeenCalled();
  });

  it('is 404 for a session the engine doesn’t give this buyer, and while off', async () => {
    checkout.mockResolvedValueOnce(null);
    expect(
      (
        await refusal(() =>
          page.loader({ params: { id: 'chk_1' }, request: pageRequest(cookie) } as never),
        )
      ).status,
    ).toBe(404);
    storefrontSettings.mockResolvedValue({
      checkout: { enabled: false, editLines: false, testPayments: true, publishableKey: null },
    });
    lib.forgetStorefrontSettings();
    checkout.mockClear();
    expect(
      (
        await refusal(() =>
          page.loader({ params: { id: 'chk_1' }, request: pageRequest(cookie) } as never),
        )
      ).status,
    ).toBe(404);
    expect(checkout).not.toHaveBeenCalled();
  });

  it('holds each cookie to its own API budget, so a wrong one spends only its own', async () => {
    const used = new Map<string, number>();
    env.API_LIMIT = {
      limit: vi.fn(async ({ key }: { key: string }) => {
        used.set(key, (used.get(key) ?? 0) + 1);
        return { success: (used.get(key) ?? 0) <= 2 };
      }),
    };
    const wrong = `__Host-cw_chk_chk_1=${'b'.repeat(64)}`;
    checkout.mockResolvedValue(null);
    const statuses: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push(
        (
          await refusal(() =>
            page.loader({ params: { id: 'chk_1' }, request: pageRequest(wrong) } as never),
          )
        ).status,
      );
    // Someone sending a wrong cookie is limited…
    expect(statuses).toEqual([404, 404, 429, 429]);
    // …and the real buyer's budget is untouched.
    checkout.mockResolvedValue(session);
    const ok = (await page.loader({
      params: { id: 'chk_1' },
      request: pageRequest(cookie),
    } as never)) as unknown as { data: unknown };
    expect(ok.data).toMatchObject({ checkout: session });
    expect(used.get(`checkout:chk_1:${await hostedHash(SECRET)}`)).toBe(1);
    expect(used.get(`checkout:chk_1:${await hostedHash('b'.repeat(64))}`)).toBe(4);
  });

  it('keeps the settings for 30 seconds', async () => {
    checkout.mockResolvedValue(session);
    for (let i = 0; i < 3; i++)
      await page.loader({ params: { id: 'chk_1' }, request: pageRequest(cookie) } as never);
    expect(storefrontSettings).toHaveBeenCalledTimes(1);
    lib.forgetStorefrontSettings();
    await page.loader({ params: { id: 'chk_1' }, request: pageRequest(cookie) } as never);
    expect(storefrontSettings).toHaveBeenCalledTimes(2);
  });
});

describe('a hosted checkout on the Worker', () => {
  it('refuses a cross-site POST even with the buyer’s cookie', async () => {
    for (const path of ['/checkout/chk_1', '/checkout/start/chk_1/tok'])
      for (const origin of ['https://evil.example', 'null']) {
        const res = await worker.fetch(
          new Request(`https://shop.test${path}`, {
            method: 'POST',
            headers: { cookie: `__Host-cw_chk_chk_1=${SECRET}`, origin },
            body: 'x=1',
          }) as never,
        );
        expect(res.status, `${path} ${origin}`).toBe(403);
      }
    // A fetch-metadata-only browser request from another site is refused too.
    const res = await worker.fetch(
      new Request('https://shop.test/checkout/chk_1', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      }) as never,
    );
    expect(res.status).toBe(403);
    expect(checkout).not.toHaveBeenCalled();
    expect(engineFetch).not.toHaveBeenCalled();
  });
});
