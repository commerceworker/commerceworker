import {
  hashShopperSecret,
  SHOPPER_CALL,
  SHOPPER_GUEST_ID,
  verifyGuestActor,
} from '@commerceworker/core';
import { TURNSTILE_HEADER } from '@commerceworker/security/csp';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = { STOREFRONT_KEY: 'storefront-test-key' };
const engineFetch = vi.fn(async (_r: Request) => new Response('ok'));
const startShopperSignIn = vi.fn();
const redeemShopperCode = vi.fn();
const redeemShopperLink = vi.fn();
const shopperLinkPreview = vi.fn();
const shopper = vi.fn();
const shopperSignOut = vi.fn();
const shopperOrders = vi.fn();

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({
    fetch: engineFetch,
    startShopperSignIn,
    redeemShopperCode,
    redeemShopperLink,
    shopperLinkPreview,
    shopper,
    shopperSignOut,
    shopperOrders,
  }),
}));

const { default: worker } = await import('../workers/app');
const signIn = await import('../app/routes/account-sign-in');
const codePage = await import('../app/routes/account-code');
const confirm = await import('../app/routes/account-confirm');
const account = await import('../app/routes/account');

const SECRET = 'b2'.repeat(32);
const TOKEN = 'c3'.repeat(32);
const later = () => Date.now() + 30 * 86_400_000;
const ORIGIN = 'https://shop.test';

type Answer = Response | { data: unknown; init?: ResponseInit };
/** What a loader or action answered, as one Response-shaped thing (a `data()` carries its init). */
function answered(a: unknown) {
  const x = a as Answer;
  if (x instanceof Response) return { status: x.status, headers: x.headers, data: undefined };
  return {
    status: x.init?.status ?? 200,
    headers: new Headers(x.init?.headers),
    data: x.data as Record<string, unknown>,
  };
}
async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    return answered(e);
  }
  throw new Error('expected a refusal');
}

const get = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const post = (path: string, fields: Record<string, string> = {}, headers: HeadersInit = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields),
  });

beforeEach(() => {
  vi.clearAllMocks();
  shopperLinkPreview.mockResolvedValue({ masked: 'p***@example.com' });
  for (const k of [
    'SIGNIN_IP_LIMIT',
    'SIGNIN_EMAIL_LIMIT',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
  ])
    delete env[k];
});

describe('where a session can be set', () => {
  const plain = (host: string, path = '/account/code') =>
    new Request(`http://${host}${path}`, {
      method: 'POST',
      body: new URLSearchParams({ email: 'pat@example.com', code: '123456', ...{} }),
    });

  it('is https anywhere, and plain http on localhost and 127.0.0.1 only', async () => {
    for (const host of ['localhost:5174', '127.0.0.1:5174']) {
      redeemShopperCode.mockResolvedValueOnce({
        secret: SECRET,
        email: 'pat@example.com',
        expiresAt: later(),
      });
      const res = (await codePage.action({
        request: plain(host),
        params: {},
      } as never)) as Response;
      expect(res.headers.get('set-cookie')!.startsWith(`cw_shop=${SECRET};`)).toBe(true);
    }
  });

  it('refuses a session over plain http on a real host, before the code is spent', async () => {
    const res = answered(
      await codePage.action({ request: plain('shop.example.com'), params: {} } as never),
    );
    expect(res.status).toBe(400);
    expect(String(res.data!.error)).toMatch(/https/);
    expect(res.headers.has('set-cookie')).toBe(false);
    expect(redeemShopperCode).not.toHaveBeenCalled();
    const link = answered(
      await confirm.action({
        params: { token: TOKEN },
        request: new Request(`http://shop.example.com/account/confirm/${TOKEN}`, {
          method: 'POST',
        }),
      } as never),
    );
    expect(link.status).toBe(400);
    expect(redeemShopperLink).not.toHaveBeenCalled();
  });

  it('never reads the unprefixed cookie there, so a planted one names no one', async () => {
    const res = await thrown(() =>
      account.loader({
        request: new Request('http://shop.example.com/account', {
          headers: { cookie: `cw_shop=${SECRET}` },
        }),
        params: {},
      } as never),
    );
    expect(res.headers.get('location')).toBe('/account/sign-in');
    expect(shopperOrders).not.toHaveBeenCalled();
  });
});

describe('the cookie', () => {
  const redeem = (request = post('/account/code', { email: 'pat@example.com', code: '123456' })) =>
    codePage.action({ request, params: {} } as never) as Promise<Response>;

  it('is __Host-cw_shop, HttpOnly, Secure, SameSite=Lax, for the session’s length, over https', async () => {
    redeemShopperCode.mockResolvedValueOnce({
      secret: SECRET,
      email: 'pat@example.com',
      expiresAt: later(),
    });
    const res = await redeem();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/account');
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(
      new RegExp(
        `^__Host-cw_shop=${SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=259[12]\\d{3}$`,
      ),
    );
    // ~30 days, no Domain (a __Host- cookie has none), never partitioned or cross-site.
    expect(set).not.toMatch(/Domain|Partitioned|SameSite=None/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('is plain cw_shop and not Secure over http, local development only', async () => {
    redeemShopperCode.mockResolvedValueOnce({
      secret: SECRET,
      email: 'pat@example.com',
      expiresAt: later(),
    });
    const res = await redeem(
      new Request('http://localhost/account/code', {
        method: 'POST',
        body: new URLSearchParams({ email: 'pat@example.com', code: '123456' }),
      }),
    );
    const set = res.headers.get('set-cookie')!;
    expect(set.startsWith(`cw_shop=${SECRET};`)).toBe(true);
    expect(set).not.toMatch(/Secure|__Host/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
  });

  it('is cleared with the same attributes at sign-out', async () => {
    shopper.mockResolvedValue({ email: 'pat@example.com', since: 1, expiresAt: later() });
    const res = (await account.action({
      request: post('/account', {}, { cookie: `__Host-cw_shop=${SECRET}` }),
      params: {},
    } as never)) as Response;
    const set = res.headers.get('set-cookie')!;
    expect(set).toBe('__Host-cw_shop=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  });
});

describe('the sign-in link: a GET only shows a page', () => {
  it('never redeems, sets no cookie, and is never cached or referred', async () => {
    const res = answered(
      await confirm.loader({
        params: { token: TOKEN },
        request: get(`/account/confirm/${TOKEN}`),
      } as never),
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.has('set-cookie')).toBe(false);
    // The page is given who the link is for, masked, and not the token; the engine was only asked
    // to preview (a read), and nothing was redeemed.
    expect(res.data).toEqual({ masked: 'p***@example.com', signedInAs: null });
    expect(JSON.stringify(res.data)).not.toContain(TOKEN);
    expect(shopperLinkPreview).toHaveBeenCalledTimes(1);
    expect(shopperLinkPreview.mock.calls[0]![0]).toBe(TOKEN);
    expect(redeemShopperLink).not.toHaveBeenCalled();
    expect(shopper).not.toHaveBeenCalled();
    const sent = confirm.headers({
      loaderHeaders: res.headers,
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    } as never);
    expect(sent.get('cache-control')).toBe('no-store');
    expect(sent.get('referrer-policy')).toBe('same-origin');
  });

  it('is a form that posts back to the same path, with a 44px button', () => {
    const html = draw(confirm.default, { masked: 'p***@example.com', signedInAs: null });
    expect(html).toContain('p***@example.com');
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(html).not.toContain('action=');
    expect(html).toContain('min-h-11');
    expect(html).toMatch(/pt-safe-6|pb-safe-8/);
  });

  it('is not redeemed by a Worker GET or HEAD either, `.data` twin included', async () => {
    for (const [method, path] of [
      ['GET', `/account/confirm/${TOKEN}`],
      ['HEAD', `/account/confirm/${TOKEN}`],
      ['GET', `/account/confirm/${TOKEN}.data`],
    ] as const)
      await worker.fetch(new Request(`${ORIGIN}${path}`, { method }) as never).catch(() => null);
    expect(redeemShopperLink).not.toHaveBeenCalled();
  });

  it('is redeemed by the POST: the engine’s secret becomes the cookie, then a 303', async () => {
    redeemShopperLink.mockResolvedValueOnce({
      secret: SECRET,
      email: 'pat@example.com',
      expiresAt: later(),
    });
    const res = (await confirm.action({
      params: { token: TOKEN },
      request: post(`/account/confirm/${TOKEN}`),
    } as never)) as Response;
    expect(redeemShopperLink).toHaveBeenCalledTimes(1);
    expect(redeemShopperLink.mock.calls[0]![0]).toBe(TOKEN);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/account');
    expect(res.headers.get('set-cookie')).toContain(`__Host-cw_shop=${SECRET}`);
  });

  it('refuses a used or expired link, uncached, without a cookie', async () => {
    redeemShopperLink.mockResolvedValueOnce(null);
    const r = await thrown(() =>
      confirm.action({
        params: { token: TOKEN },
        request: post(`/account/confirm/${TOKEN}`),
      } as never),
    );
    expect(r.status).toBe(410);
    expect(r.data).toMatch(/used or has expired/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.has('set-cookie')).toBe(false);
  });

  it('shows a link that is used or expired as such on the GET, without a form', async () => {
    shopperLinkPreview.mockResolvedValueOnce(null);
    const r = await thrown(() =>
      confirm.loader({
        params: { token: TOKEN },
        request: get(`/account/confirm/${TOKEN}`),
      } as never),
    );
    expect(r.status).toBe(410);
    expect(r.data).toMatch(/used or has expired/);
  });

  describe('when someone is already signed in (login CSRF through a forwarded link)', () => {
    const cookie = `__Host-cw_shop=${SECRET}`;
    beforeEach(() => {
      shopper.mockResolvedValue({ email: 'victim@example.com', since: 1, expiresAt: later() });
    });

    it('says so on the GET and offers to replace it, redeeming nothing', async () => {
      const res = answered(
        await confirm.loader({
          params: { token: TOKEN },
          request: get(`/account/confirm/${TOKEN}`, cookie),
        } as never),
      );
      expect(res.data).toEqual({ masked: 'p***@example.com', signedInAs: 'victim@example.com' });
      const html = draw(confirm.default, res.data!);
      expect(html).toContain('victim@example.com');
      expect(html).toContain('name="replace"');
      expect(html).toContain('Sign out and continue');
      expect(redeemShopperLink).not.toHaveBeenCalled();
    });

    it('refuses the POST that doesn’t confirm: no session is swapped, no link spent, no cookie set', async () => {
      const res = answered(
        await confirm.action({
          params: { token: TOKEN },
          request: post(`/account/confirm/${TOKEN}`, {}, { cookie }),
        } as never),
      );
      expect(res.status).toBe(409);
      expect(res.data).toEqual({ masked: 'p***@example.com', signedInAs: 'victim@example.com' });
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(redeemShopperLink).not.toHaveBeenCalled();
      expect(shopperSignOut).not.toHaveBeenCalled();
    });

    it('replaces the session when they confirm, ending the old one at the engine', async () => {
      redeemShopperLink.mockResolvedValueOnce({
        secret: 'd4'.repeat(32),
        email: 'p@example.com',
        expiresAt: later(),
      });
      const res = (await confirm.action({
        params: { token: TOKEN },
        request: post(`/account/confirm/${TOKEN}`, { replace: '1' }, { cookie }),
      } as never)) as Response;
      expect(res.status).toBe(303);
      expect(res.headers.get('set-cookie')).toContain(`__Host-cw_shop=${'d4'.repeat(32)}`);
      expect(redeemShopperLink).toHaveBeenCalledTimes(1);
      expect(shopperSignOut).toHaveBeenCalledTimes(1);
      expect(shopperSignOut.mock.calls[0]![0]).toBe(SECRET);
    });
  });

  it('refuses a malformed token on either method without asking the engine', async () => {
    for (const run of [
      () =>
        confirm.loader({ params: { token: '../x' }, request: get('/account/confirm/x') } as never),
      () =>
        confirm.action({
          params: { token: 'short' },
          request: post('/account/confirm/short'),
        } as never),
    ])
      expect((await thrown(run)).status).toBe(404);
    expect(redeemShopperLink).not.toHaveBeenCalled();
  });

  it('holds the client to a budget on a link, GET or POST, with no per-address budget', async () => {
    const limit = vi.fn(async (o: { key: string }) => ({ success: !o.key.startsWith('link:') }));
    env.SIGNIN_IP_LIMIT = { limit };
    // A link has no address, so there is no per-address budget to spend.
    const emailLimit = vi.fn(async () => ({ success: true }));
    env.SIGNIN_EMAIL_LIMIT = { limit: emailLimit };
    const r = await thrown(() =>
      confirm.action({
        params: { token: TOKEN },
        request: post(`/account/confirm/${TOKEN}`),
      } as never),
    );
    expect(r.status).toBe(429);
    expect(redeemShopperLink).not.toHaveBeenCalled();
    const g = await thrown(() =>
      confirm.loader({
        params: { token: TOKEN },
        request: get(`/account/confirm/${TOKEN}`),
      } as never),
    );
    expect(g.status).toBe(429);
    expect(shopperLinkPreview).not.toHaveBeenCalled();
    expect(emailLimit).not.toHaveBeenCalled();
  });
});

describe('entering the code', () => {
  const enter = (fields: Record<string, string>, headers: HeadersInit = {}) =>
    codePage.action({ request: post('/account/code', fields, headers), params: {} } as never);

  it('says one thing for any code that didn’t work, and sets no cookie', async () => {
    redeemShopperCode.mockResolvedValue(null);
    const r = answered(await enter({ email: 'pat@example.com', code: '123456' }));
    expect(r.status).toBe(400);
    expect(r.data).toMatchObject({ email: 'pat@example.com' });
    expect(String(r.data!.error)).toMatch(/didn’t work/);
    expect(r.headers.has('set-cookie')).toBe(false);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('sends the engine the address and the digits, with an actor signed for `shopper`', async () => {
    redeemShopperCode.mockResolvedValueOnce(null);
    await enter({ email: ' Pat@Example.com ', code: '123 456' });
    const [email, code, actor] = redeemShopperCode.mock.calls[0]!;
    expect([email, code]).toEqual(['pat@example.com', '123456']);
    expect(await verifyGuestActor([env.STOREFRONT_KEY as string], actor, SHOPPER_CALL)).toEqual({
      kind: 'guest',
      id: SHOPPER_GUEST_ID,
      name: 'Shopper',
    });
    // It names no one else's call.
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, 'checkout:chk_1'),
    ).toBeNull();
  });

  it('never asks the engine about what isn’t six digits or an address', async () => {
    for (const code of ['12345', 'abcdef', '1234567', '']) {
      const r = answered(await enter({ email: 'pat@example.com', code }));
      expect(r.status).toBe(400);
    }
    const back = (await enter({ email: 'nope', code: '123456' })) as Response;
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe('/account/sign-in');
    expect(redeemShopperCode).not.toHaveBeenCalled();
  });

  it('keeps a budget per address and per client, spending neither on a refusal before it', async () => {
    const keys: string[] = [];
    const limit = vi.fn(async (o: { key: string }) => {
      keys.push(o.key);
      return { success: !o.key.startsWith('code:') || o.key.includes('203.0.113.9') === false };
    });
    env.SIGNIN_IP_LIMIT = { limit };
    env.SIGNIN_EMAIL_LIMIT = { limit };
    const r = answered(
      await enter(
        { email: 'pat@example.com', code: '123456' },
        { 'cf-connecting-ip': '203.0.113.9' },
      ),
    );
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(redeemShopperCode).not.toHaveBeenCalled();
    expect(keys[0]).toBe('code:203.0.113.9');
    // The address's key is a hash: no address is in a limiter's key.
    keys.length = 0;
    env.SIGNIN_IP_LIMIT = { limit: async () => ({ success: true }) };
    await enter({ email: 'pat@example.com', code: '123456' });
    expect(keys[0]).toMatch(/^code:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain('pat');
    // An HMAC under the storefront key, not a bare SHA-256 anyone could compute for an address.
    const mac = await crypto.subtle.sign(
      'HMAC',
      await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(String(env.STOREFRONT_KEY)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
      new TextEncoder().encode('shopper\0pat@example.com'),
    );
    expect(keys[0]).toBe(
      `code:${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    );
    const sha = await hashShopperSecret('pat@example.com');
    expect(keys[0]).not.toBe(`code:${sha}`);
  });
});

/** A page drawn with the loader data it would have, as the server renders it. */
function draw(
  Component: () => React.JSX.Element,
  loaderData: Record<string, unknown>,
  actionData?: Record<string, unknown>,
) {
  const Stub = createRoutesStub([{ path: '/p', Component: Component as never }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ['/p'],
      hydrationData: {
        loaderData: { '0': loaderData },
        ...(actionData ? { actionData: { '0': actionData } } : {}),
      },
    }),
  );
}

describe('the pages', () => {
  it('draws the code field for a browser to fill, with a numeric keypad, 16px and a 44px button', () => {
    const html = draw(codePage.default, { email: 'pat@example.com' });
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="hidden"');
    expect(html).toContain('text-base');
    expect(html).toContain('min-h-11');
    expect(html).toMatch(/pt-safe-6|pb-safe-8/);
    // No script is needed: nothing but the form posts.
    expect(html).not.toContain('<script');
  });

  it('shows what went wrong beside the field, announced with it', () => {
    const html = draw(
      codePage.default,
      { email: 'pat@example.com' },
      {
        error: 'That code didn’t work. Check it and try again, or ask for a new one.',
        email: 'pat@example.com',
      },
    );
    expect(html).toContain('That code didn’t work');
    expect(html).toContain('aria-invalid="true"');
  });

  it('draws the sign-in form with an email field, and no widget where there is no site key', () => {
    const html = draw(signIn.default, { siteKey: null });
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('Send code');
    expect(html).toContain('guest');
  });

  it('draws the signed-in page with the address, and a sign-out form that posts', () => {
    const html = draw(account.default, {
      email: 'pat@example.com',
      orders: [],
      next: null,
      paged: false,
    });
    expect(html).toContain('pat@example.com');
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(html).toContain('Sign out');
  });
});

describe('asking for a code', () => {
  const ask = (fields: Record<string, string>, headers: HeadersInit = {}) =>
    signIn.action({ request: post('/account/sign-in', fields, headers), params: {} } as never);

  it('sends any valid address to the code page, the same whichever it is', async () => {
    startShopperSignIn.mockResolvedValue({ status: 'sent' });
    const [a, b] = (await Promise.all([
      ask({ email: 'has-orders@example.com' }),
      ask({ email: 'never-ordered@example.com' }),
    ])) as Response[];
    expect(a!.status).toBe(303);
    expect(a!.headers.get('location')).toBe('/account/code?email=has-orders%40example.com');
    expect(b!.status).toBe(a!.status);
    expect(b!.headers.get('cache-control')).toBe(a!.headers.get('cache-control'));
    const [email, actor] = startShopperSignIn.mock.calls[0]!;
    expect(email).toBe('has-orders@example.com');
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, SHOPPER_CALL),
    ).not.toBeNull();
  });

  it('says to wait when the engine says it just sent one, and when it can’t send at all', async () => {
    startShopperSignIn.mockResolvedValueOnce({ status: 'wait' });
    const wait = answered(await ask({ email: 'pat@example.com' }));
    expect(wait.status).toBe(429);
    expect(wait.data).toMatchObject({ waiting: true, email: 'pat@example.com' });
    expect(wait.headers.get('retry-after')).toBe('60');
    startShopperSignIn.mockResolvedValueOnce({ status: 'unavailable' });
    expect(answered(await ask({ email: 'pat@example.com' })).status).toBe(503);
    startShopperSignIn.mockResolvedValueOnce({ status: 'failed' });
    expect(answered(await ask({ email: 'pat@example.com' })).status).toBe(502);
  });

  it('refuses what is not an address without asking the engine', async () => {
    for (const email of ['', 'nope', 'a@b', ' ']) {
      const r = answered(await ask({ email }));
      expect(r.status).toBe(400);
    }
    expect(startShopperSignIn).not.toHaveBeenCalled();
  });

  it('holds each address and each client to a budget before the engine is asked', async () => {
    const keys: string[] = [];
    env.SIGNIN_EMAIL_LIMIT = {
      limit: async (o: { key: string }) => {
        keys.push(o.key);
        return { success: false };
      },
    };
    env.SIGNIN_IP_LIMIT = { limit: async () => ({ success: true }) };
    const r = answered(await ask({ email: 'pat@example.com' }));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(keys[0]).toMatch(/^start:[0-9a-f]{64}$/);
    expect(startShopperSignIn).not.toHaveBeenCalled();
    env.SIGNIN_EMAIL_LIMIT = { limit: async () => ({ success: true }) };
    env.SIGNIN_IP_LIMIT = { limit: async () => ({ success: false }) };
    expect(answered(await ask({ email: 'pat@example.com' })).status).toBe(429);
    expect(startShopperSignIn).not.toHaveBeenCalled();
  });

  describe('with Turnstile', () => {
    const verdict = (body: unknown) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));

    beforeEach(() => {
      env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
      env.TURNSTILE_SECRET_KEY = 'secret';
    });

    it('asks for the check first, and asks the engine nothing without it', async () => {
      const spy = vi.spyOn(globalThis, 'fetch');
      const r = answered(await ask({ email: 'pat@example.com' }));
      expect(r.status).toBe(400);
      expect(String(r.data!.error)).toMatch(/Complete the check/);
      expect(startShopperSignIn).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('refuses a token Siteverify failed, or solved for another action or host', async () => {
      for (const body of [
        { success: false, 'error-codes': ['timeout-or-duplicate'] },
        { success: true, hostname: 'shop.test', action: 'login' },
        { success: true, hostname: 'other.test', action: 'shop_sign_in' },
      ]) {
        const spy = verdict(body);
        const r = answered(await ask({ email: 'pat@example.com', 'cf-turnstile-response': 'tok' }));
        expect(r.status).toBe(403);
        spy.mockRestore();
      }
      expect(startShopperSignIn).not.toHaveBeenCalled();
    });

    it('goes on when the check passed for this action on this host, telling Siteverify who asked', async () => {
      const spy = verdict({ success: true, hostname: 'shop.test', action: 'shop_sign_in' });
      startShopperSignIn.mockResolvedValueOnce({ status: 'sent' });
      const r = (await ask(
        { email: 'pat@example.com', 'cf-turnstile-response': 'tok' },
        { 'cf-connecting-ip': '203.0.113.7' },
      )) as Response;
      expect(r.status).toBe(303);
      const body = spy.mock.calls[0]![1]!.body as URLSearchParams;
      expect(Object.fromEntries(body)).toEqual({
        secret: 'secret',
        response: 'tok',
        remoteip: '203.0.113.7',
      });
      spy.mockRestore();
    });

    it('refuses everything when the site key has no secret, rather than skipping the check', async () => {
      delete env.TURNSTILE_SECRET_KEY;
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = answered(await ask({ email: 'pat@example.com', 'cf-turnstile-response': 'tok' }));
      expect(r.status).toBe(503);
      expect(startShopperSignIn).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('lets the page load Turnstile, and no other account page does', () => {
      const withIt = signIn.headers({ errorHeaders: undefined } as never);
      expect(withIt.get(TURNSTILE_HEADER)).toBe('1');
      expect(withIt.get('cache-control')).toBe('no-store');
      for (const page of [codePage, confirm, account])
        expect(page.headers({ errorHeaders: undefined } as never).has(TURNSTILE_HEADER)).toBe(
          false,
        );
      delete env.TURNSTILE_SITE_KEY;
      expect(signIn.headers({ errorHeaders: undefined } as never).has(TURNSTILE_HEADER)).toBe(
        false,
      );
    });
  });
});

describe('the signed-in page', () => {
  const cookie = `__Host-cw_shop=${SECRET}`;
  const page = {
    email: 'pat@example.com',
    orders: [
      {
        id: 'ord_1',
        ref: '#ord_1',
        placedAt: 1_700_000_000_000,
        status: 'completed',
        currency: 'USD',
        total: 25,
      },
    ],
    next: null,
  };

  it('sends the engine the cookie’s secret and an actor signed for `shopper`', async () => {
    shopperOrders.mockResolvedValueOnce(page);
    const res = answered(
      await account.loader({ request: get('/account', cookie), params: {} } as never),
    );
    expect(res.data).toEqual({ ...page, paged: false });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const [secret, actor, cursor] = shopperOrders.mock.calls[0]!;
    // The engine hashes the secret to compare; this Worker holds no hash and stores nothing.
    expect(secret).toBe(SECRET);
    expect(secret).not.toBe(await hashShopperSecret(SECRET));
    expect(cursor).toBeUndefined();
    expect(
      await verifyGuestActor([env.STOREFRONT_KEY as string], actor, SHOPPER_CALL),
    ).toMatchObject({
      id: SHOPPER_GUEST_ID,
    });
  });

  it('goes to sign-in without a cookie, or with one that isn’t the engine’s shape, asking nothing', async () => {
    for (const c of [
      undefined,
      'cw_shop=x',
      `cw_shop=${SECRET}`,
      `__Host-cw_shop=${'B2'.repeat(32)}`,
    ]) {
      const res = await thrown(() =>
        account.loader({ request: get('/account', c), params: {} } as never),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/account/sign-in');
    }
    expect(shopperOrders).not.toHaveBeenCalled();
  });

  it('goes to sign-in when the engine no longer knows the session', async () => {
    shopperOrders.mockResolvedValueOnce(null);
    const res = await thrown(() =>
      account.loader({ request: get('/account', cookie), params: {} } as never),
    );
    expect(res.headers.get('location')).toBe('/account/sign-in');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('signs out at the engine, then clears the cookie', async () => {
    const res = (await account.action({
      request: post('/account', {}, { cookie }),
      params: {},
    } as never)) as Response;
    expect(shopperSignOut).toHaveBeenCalledTimes(1);
    expect(shopperSignOut.mock.calls[0]![0]).toBe(SECRET);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/account/sign-in');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('sends a signed-in shopper from the sign-in pages to their account', async () => {
    shopper.mockResolvedValue({ email: 'pat@example.com', since: 1, expiresAt: later() });
    for (const loader of [signIn.loader, codePage.loader]) {
      const res = (await loader({
        request: get('/account/sign-in?email=pat@example.com', cookie),
        params: {},
      } as never)) as Response;
      expect(res.headers.get('location')).toBe('/account');
    }
  });
});

describe('the Worker around them', () => {
  it('refuses a cross-site POST to every account page before it reaches one', async () => {
    for (const path of [
      '/account',
      '/account/sign-in',
      '/account/code',
      `/account/confirm/${TOKEN}`,
    ]) {
      const res = await worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
          body: new URLSearchParams({ email: 'pat@example.com', code: '123456' }),
        }) as never,
      );
      expect(res.status, path).toBe(403);
    }
    expect(startShopperSignIn).not.toHaveBeenCalled();
    expect(redeemShopperCode).not.toHaveBeenCalled();
    expect(redeemShopperLink).not.toHaveBeenCalled();
    expect(shopperSignOut).not.toHaveBeenCalled();
  });
});
