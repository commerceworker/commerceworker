import { LINK_USER_TOKEN_HEADER, SHOPPER_CALL, verifyGuestActor } from '@commerceworker/core';
import { CONSENT_HEADER } from '@commerceworker/security/csp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, unknown> = { STOREFRONT_KEY: 'storefront-test-key' };
const engineFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));
const ucpPlatform = vi.fn(async () => ({
  id: 'ucp_1',
  name: 'Agent',
  profileUrl: 'https://a.example/p',
}));
const ucpCheckoutOn = vi.fn(async () => true);
const ucpLinkMetadata = vi.fn();
const ucpLinkAuthorize = vi.fn();
const ucpLinkDecide = vi.fn();
const ucpLinkToken = vi.fn();
const ucpLinkRevoke = vi.fn();
const shopper = vi.fn();
const shopperLinks = vi.fn();
const shopperUnlink = vi.fn();
const shopperSignOut = vi.fn();

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({
    fetch: engineFetch,
    ucpPlatform,
    ucpCheckoutOn,
    ucpLinkMetadata,
    ucpLinkAuthorize,
    ucpLinkDecide,
    ucpLinkToken,
    ucpLinkRevoke,
    shopper,
    shopperLinks,
    shopperUnlink,
    shopperSignOut,
  }),
}));
const overBudget = vi.fn(async (_b: string, _k: string): Promise<Response | null> => null);
vi.mock('~/lib/rate-limit', () => ({ overBudget: (b: string, k: string) => overBudget(b, k) }));

const { default: realWorker } = await import('../workers/app');
/** The Worker's handler takes Cloudflare's request type; a test's is the plain one. */
const worker = {
  fetch: (r: Request) => (realWorker.fetch as (r: unknown) => Promise<Response>)(r),
};
const { forgetUcpSettings, ucpFetch } = await import('~/lib/ucp.server');
const authorize = await import('../app/routes/identity-authorize');
const apps = await import('../app/routes/account-apps');
const { safeNext } = await import('../app/lib/shopper.server');
const { authorizeParams } = await import('../app/lib/ucp-link.server');

const ORIGIN = 'https://shop.test';
const KEY = `cmw_ucp_${'k'.repeat(43)}`;
const SECRET = 'b2'.repeat(32);
const COOKIE = `__Host-cw_shop=${SECRET}`;
const QUERY =
  'response_type=code&client_id=ucp_1&redirect_uri=https%3A%2F%2Fa.example%2Fcb&scope=dev.ucp.shopping.order%3Aread&state=s&code_challenge=' +
  'c'.repeat(43) +
  '&code_challenge_method=S256';

type Answer = Response | { data: unknown; init?: ResponseInit };
function answered(a: unknown) {
  const x = a as Answer;
  if (x instanceof Response)
    return { status: x.status, headers: x.headers, data: undefined as unknown };
  return { status: x.init?.status ?? 200, headers: new Headers(x.init?.headers), data: x.data };
}
async function outcome(run: () => Promise<unknown>) {
  try {
    return answered(await run());
  } catch (e) {
    return answered(e);
  }
}
const formBody = (fields: Record<string, string>) => new URLSearchParams(fields);

beforeEach(() => {
  vi.clearAllMocks();
  forgetUcpSettings();
  overBudget.mockResolvedValue(null);
  shopper.mockResolvedValue({ email: 'pat@example.com', since: 1, expiresAt: Date.now() + 1e6 });
});

describe('metadata', () => {
  it('is public, short-cached JSON from the engine, and 404 while linking is off', async () => {
    ucpLinkMetadata.mockResolvedValueOnce({ issuer: ORIGIN });
    const res = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: ORIGIN });
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    ucpLinkMetadata.mockResolvedValueOnce(null);
    const off = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(off.status).toBe(404);
  });
});

describe('the token endpoint', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}, path = '/identity/token') =>
    worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
      }),
    );
  const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;

  it('sends the engine the form and only the SHA-256 of the key, and answers uncached', async () => {
    ucpLinkToken.mockResolvedValueOnce({ status: 200, body: { access_token: 'a' } });
    const res = await post(formBody({ grant_type: 'refresh_token', refresh_token: 'r' }), {
      authorization: basic('ucp_1', KEY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    const [form, client] = ucpLinkToken.mock.calls[0]!;
    expect(form).toEqual({ grant_type: 'refresh_token', refresh_token: 'r' });
    expect(client).toEqual({ id: 'ucp_1', keyHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(ucpLinkToken.mock.calls)).not.toContain(KEY);
  });

  it('takes the credentials from the form too, and keeps the secret out of what it forwards', async () => {
    ucpLinkToken.mockResolvedValueOnce({ status: 200, body: {} });
    await post(formBody({ grant_type: 'refresh_token', client_id: 'ucp_1', client_secret: KEY }));
    expect(ucpLinkToken.mock.calls[0]![0]).toEqual({
      grant_type: 'refresh_token',
      client_id: 'ucp_1',
    });
  });

  it('is a platform’s, not a browser’s: a cross-site Origin doesn’t stop it, and a key is needed', async () => {
    ucpLinkToken.mockResolvedValueOnce({ status: 200, body: {} });
    const ok = await post(formBody({ grant_type: 'refresh_token' }), {
      authorization: basic('ucp_1', KEY),
      origin: 'https://evil.example',
    });
    expect(ok.status).toBe(200);
    const none = await post(formBody({ grant_type: 'refresh_token' }));
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: 'invalid_client' });
    const notAKey = await post(formBody({ grant_type: 'refresh_token' }), {
      authorization: basic('ucp_1', 'cmw_ucpa_x'),
    });
    expect(notAKey.status).toBe(401);
    expect(notAKey.headers.get('www-authenticate')).toBe('Basic realm="identity"');
    expect(ucpLinkToken).toHaveBeenCalledTimes(1);
  });

  it('refuses other methods and content types, repeated parameters, big bodies and a client over budget', async () => {
    expect((await worker.fetch(new Request(`${ORIGIN}/identity/token`))).status).toBe(405);
    expect((await post('{}', { 'content-type': 'application/json' })).status).toBe(415);
    expect(
      (await post('grant_type=a&grant_type=b', { authorization: basic('u', KEY) })).status,
    ).toBe(400);
    expect((await post('x='.padEnd(9000, 'y'), { authorization: basic('u', KEY) })).status).toBe(
      413,
    );
    overBudget.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    expect(
      (await post('grant_type=refresh_token', { authorization: basic('u', KEY) })).status,
    ).toBe(429);
    expect(ucpLinkToken).not.toHaveBeenCalled();
  });

  it('counts the caller’s address before any credential, and never the public client_id', async () => {
    const seen: string[] = [];
    overBudget.mockImplementation(async (_b, k) => {
      seen.push(k);
      return null;
    });
    await post(formBody({ grant_type: 'refresh_token', client_id: 'ucp_1' }), {
      'cf-connecting-ip': '203.0.113.9',
    });
    await post(formBody({ grant_type: 'refresh_token' }), {
      authorization: basic('ucp_1', 'wrong-key'),
      'cf-connecting-ip': '203.0.113.9',
    });
    expect(seen).toEqual(['identity:203.0.113.9', 'identity:203.0.113.9']);
    ucpLinkToken.mockResolvedValueOnce({ status: 200, body: {} });
    await post(formBody({ grant_type: 'refresh_token' }), {
      authorization: basic('ucp_1', KEY),
      'cf-connecting-ip': '203.0.113.10',
    });
    // With a key, the platform's own budget is its key's hash: nothing that names its id spends it.
    expect(seen.slice(2)).toEqual([
      'identity:203.0.113.10',
      expect.stringMatching(/^identity-key:[0-9a-f]{64}$/),
    ]);
    expect(seen.join()).not.toContain('ucp_1');
  });

  it('lets a platform’s real request through while others, naming its id with a wrong or no key, are refused', async () => {
    // A limiter of three a minute per key, as the Workers binding keeps one.
    const counts = new Map<string, number>();
    overBudget.mockImplementation(async (_b, k) => {
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n > 3 ? Response.json({}, { status: 429, headers: { 'retry-after': '60' } }) : null;
    });
    ucpLinkToken.mockResolvedValue({ status: 200, body: { access_token: 'a' } });
    for (let i = 0; i < 30; i++) {
      const wrong = await post(formBody({ grant_type: 'refresh_token', client_id: 'ucp_1' }), {
        ...(i % 2 ? { authorization: basic('ucp_1', `cmw_ucp_${i}`.padEnd(51, 'x')) } : {}),
        'cf-connecting-ip': `198.51.100.${i}`,
      });
      // No key at all is refused here; a wrong key goes to the engine, which refuses it.
      expect(wrong.status).toBe(i % 2 ? 200 : 401);
    }
    const real = await post(formBody({ grant_type: 'refresh_token' }), {
      authorization: basic('ucp_1', KEY),
      'cf-connecting-ip': '203.0.113.50',
    });
    expect(real.status).toBe(200);
    // Past its own budget a caller gets the OAuth 429: no-store, with Retry-After.
    let last = real;
    for (let i = 0; i < 4; i++)
      last = await post(formBody({ grant_type: 'refresh_token' }), {
        authorization: basic('ucp_1', KEY),
        'cf-connecting-ip': '203.0.113.50',
      });
    expect(last.status).toBe(429);
    expect(last.headers.get('cache-control')).toBe('no-store');
    expect(last.headers.get('pragma')).toBe('no-cache');
    expect(last.headers.get('retry-after')).toBe('60');
    expect(await last.json()).toMatchObject({ error: 'temporarily_unavailable' });
    overBudget.mockReset();
    overBudget.mockResolvedValue(null);
  });

  it('serves revocation the same way', async () => {
    ucpLinkRevoke.mockResolvedValueOnce({ status: 200, body: {} });
    const res = await post(
      formBody({ token: 't' }),
      { authorization: basic('ucp_1', KEY) },
      '/identity/revoke',
    );
    expect(res.status).toBe(200);
    expect(ucpLinkRevoke).toHaveBeenCalledTimes(1);
  });
});

describe('/ucp with a linked shopper’s token', () => {
  const call = (headers: Record<string, string>) =>
    ucpFetch(
      new Request(`${ORIGIN}/ucp/v1/orders/o1`, {
        headers: { 'ucp-agent': 'profile="https://a.example/p"', ...headers },
      }),
    );

  it('passes the bearer on beside the platform’s key, never as the platform’s own', async () => {
    await call({ 'x-api-key': KEY, authorization: `Bearer cmw_ucpa_${'t'.repeat(43)}` });
    const sent = engineFetch.mock.calls[0]![0].headers;
    expect(sent.get(LINK_USER_TOKEN_HEADER)).toBe(`cmw_ucpa_${'t'.repeat(43)}`);
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('x-api-key')).toBeNull();
  });

  it('forwards no token when the key is the bearer, and drops one a caller forged as the header', async () => {
    await call({ authorization: `Bearer ${KEY}` });
    await call({ 'x-api-key': KEY, [LINK_USER_TOKEN_HEADER]: 'forged' });
    await call({ 'x-api-key': KEY, authorization: `Bearer ${KEY}` });
    for (const [req] of engineFetch.mock.calls)
      expect(req.headers.get(LINK_USER_TOKEN_HEADER)).toBeNull();
  });
});

describe('the consent page', () => {
  const get = (query = QUERY, cookie = COOKIE) =>
    new Request(`${ORIGIN}/identity/authorize?${query}`, { headers: cookie ? { cookie } : {} });
  const consentView = {
    status: 'consent',
    platform: 'Agent',
    email: 'pat@example.com',
    scopes: [{ scope: 's', description: 'See orders' }],
    redirectUri: 'https://a.example/cb',
  };

  it('describes the request to a signed-in shopper, uncached, with a policy that lets the form reach the platform', async () => {
    ucpLinkAuthorize.mockResolvedValueOnce(consentView);
    const res = answered(await authorize.loader({ request: get(), params: {} } as never));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get(CONSENT_HEADER)).toBe('https://a.example/cb');
    // They are told where they will land before they choose.
    expect((res.data as { returnTo: string }).returnTo).toBe('https://a.example');
    const [params, secret, actor] = ucpLinkAuthorize.mock.calls[0]!;
    expect(params).toMatchObject({ client_id: 'ucp_1', code_challenge_method: 'S256' });
    expect(secret).toBe(SECRET);
    expect(await verifyGuestActor(['storefront-test-key'], actor, SHOPPER_CALL)).toBeTruthy();
    const h = authorize.headers({
      loaderHeaders: res.headers,
      actionHeaders: new Headers(),
      errorHeaders: undefined,
      parentHeaders: new Headers(),
    } as never);
    expect(h.get(CONSENT_HEADER)).toBe('https://a.example/cb');
    expect(h.get('cache-control')).toBe('no-store');
  });

  it('sends a shopper who is not signed in to sign in, coming back to this request', async () => {
    ucpLinkAuthorize.mockResolvedValueOnce({ status: 'sign_in', platform: 'Agent' });
    const res = await outcome(() =>
      authorize.loader({ request: get(QUERY, ''), params: {} } as never),
    );
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get('location')!, ORIGIN);
    expect(to.pathname).toBe('/account/sign-in');
    expect(safeNext(to.searchParams.get('next'))).toBe(
      `/identity/authorize?${new URLSearchParams(authorizeParams(new URLSearchParams(QUERY))!)}`,
    );
  });

  it('redirects a fault back to the platform and shows one it can’t trust', async () => {
    ucpLinkAuthorize.mockResolvedValueOnce({
      status: 'refused',
      error: 'invalid_scope',
      description: 'x',
      redirect: 'https://a.example/cb?error=invalid_scope&iss=https%3A%2F%2Fshop.test',
    });
    const back = await outcome(() => authorize.loader({ request: get(), params: {} } as never));
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toContain('error=invalid_scope');
    ucpLinkAuthorize.mockResolvedValueOnce({
      status: 'refused',
      error: 'invalid_request',
      description: 'Unknown platform',
      redirect: null,
    });
    const shown = await outcome(() => authorize.loader({ request: get(), params: {} } as never));
    expect(shown.status).toBe(400);
    expect(shown.headers.get('cache-control')).toBe('no-store');
    expect(shown.headers.has('location')).toBe(false);
  });

  it('refuses a request that repeats a parameter, before the engine is asked', async () => {
    const res = await outcome(() =>
      authorize.loader({ request: get(`${QUERY}&scope=x`), params: {} } as never),
    );
    expect(res.status).toBe(400);
    expect(ucpLinkAuthorize).not.toHaveBeenCalled();
  });

  const post = (
    fields: Record<string, string>,
    headers: HeadersInit = { origin: ORIGIN, cookie: COOKIE },
  ) =>
    new Request(`${ORIGIN}/identity/authorize`, {
      method: 'POST',
      headers,
      body: formBody(fields),
    });
  const fields = { ...Object.fromEntries(new URLSearchParams(QUERY)), decision: 'approve' };

  it('approves with the shopper’s own session, and 303s to the address the engine returns', async () => {
    ucpLinkDecide.mockResolvedValueOnce({
      status: 'redirect',
      redirect: 'https://a.example/cb?code=c&iss=x',
    });
    const res = await outcome(() =>
      authorize.action({ request: post(fields), params: {} } as never),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://a.example/cb?code=c&iss=x');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(ucpLinkDecide.mock.calls[0]![1]).toBe(true);
    expect(ucpLinkDecide.mock.calls[0]![2]).toBe(SECRET);
  });

  it('denies on Cancel, and refuses any other answer or an extra parameter smuggled in', async () => {
    ucpLinkDecide.mockResolvedValueOnce({
      status: 'redirect',
      redirect: 'https://a.example/cb?error=access_denied',
    });
    await outcome(() =>
      authorize.action({
        request: post({ ...fields, decision: 'deny', evil: '1' }),
        params: {},
      } as never),
    );
    expect(ucpLinkDecide.mock.calls[0]![1]).toBe(false);
    expect(ucpLinkDecide.mock.calls[0]![0]).not.toHaveProperty('evil');
    const bad = await outcome(() =>
      authorize.action({ request: post({ ...fields, decision: 'maybe' }), params: {} } as never),
    );
    expect(bad.status).toBe(400);
    expect(ucpLinkDecide).toHaveBeenCalledTimes(1);
  });

  it('sends a shopper whose session is gone back to sign in, approving nothing', async () => {
    ucpLinkDecide.mockResolvedValueOnce({ status: 'sign_in', platform: 'Agent' });
    const res = await outcome(() =>
      authorize.action({ request: post(fields, { origin: ORIGIN }), params: {} } as never),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/account/sign-in?next=');
    expect(ucpLinkDecide.mock.calls[0]![2]).toBeNull();
  });

  it('is refused cross-site before the route runs: another origin, or a browser’s cross-site fetch', async () => {
    for (const headers of <HeadersInit[]>[
      { origin: 'https://evil.example', cookie: COOKIE },
      { 'sec-fetch-site': 'cross-site', cookie: COOKIE },
    ]) {
      const res = await worker.fetch(post(fields, headers));
      expect(res.status).toBe(403);
    }
    expect(ucpLinkDecide).not.toHaveBeenCalled();
  });

  it('is over budget as a page: a 429, nothing decided', async () => {
    overBudget.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    let thrown: { init?: { status?: number }; status?: number } | undefined;
    try {
      await authorize.action({ request: post(fields), params: {} } as never);
    } catch (e) {
      thrown = e as typeof thrown;
    }
    expect(thrown).toBeDefined();
    expect(ucpLinkDecide).not.toHaveBeenCalled();
  });
});

describe('the consent page’s policy', () => {
  it('lets its form go to the platform’s address and no other, and lets nothing frame it', async () => {
    const { pageHeaders } = await import('@commerceworker/security/csp');
    const csp = pageHeaders(new Headers({ [CONSENT_HEADER]: 'https://a.example/cb' }), 'n0nce').get(
      'content-security-policy',
    )!;
    expect(csp).toContain("form-action 'self' https://a.example");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('https://a.example/cb');
    // A return address that isn't https (or loopback) is not allowed into the policy.
    const bad = pageHeaders(new Headers({ [CONSENT_HEADER]: 'javascript:alert(1)' }), 'n').get(
      'content-security-policy',
    )!;
    expect(bad).toContain("form-action 'self';");
  });
});

describe('sign-in’s way back', () => {
  it('returns only to a linking request on this host', () => {
    expect(safeNext('/identity/authorize?client_id=x')).toBe('/identity/authorize?client_id=x');
    for (const bad of [
      'https://evil.example/identity/authorize?x=1',
      '//evil.example/identity/authorize?x=1',
      '/account',
      '/identity/authorize',
      '/identity/authorize/../../x?a=1',
      '/identity/authorizeX?a=1',
      `/identity/authorize?${'a'.repeat(2000)}`,
      null,
      7,
    ])
      expect(safeNext(bad)).toBeNull();
  });
});

describe('/account/apps', () => {
  const req = (fields: Record<string, string>) =>
    new Request(`${ORIGIN}/account/apps`, {
      method: 'POST',
      headers: { cookie: COOKIE, origin: ORIGIN },
      body: formBody(fields),
    });
  const view = {
    email: 'pat@example.com',
    links: [{ id: 'lg_1', platform: 'Agent', scopes: ['s'], since: 1, expiresAt: 2 }],
  };

  it('lists the linked platforms with the session’s secret, uncached', async () => {
    shopperLinks.mockResolvedValueOnce(view);
    const res = answered(
      await apps.loader({
        request: new Request(`${ORIGIN}/account/apps`, { headers: { cookie: COOKIE } }),
        params: {},
      } as never),
    );
    expect((res.data as { links: unknown[] }).links).toHaveLength(1);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(shopperLinks.mock.calls[0]![0]).toBe(SECRET);
  });

  it('sends a shopper with no session to sign in', async () => {
    shopperLinks.mockResolvedValueOnce(null);
    const res = await outcome(() =>
      apps.loader({
        request: new Request(`${ORIGIN}/account/apps`, { headers: { cookie: COOKIE } }),
        params: {},
      } as never),
    );
    expect(res.status).toBe(303);
  });

  it('unlinks with the session’s secret and the link id, and does not sign out', async () => {
    const res = answered(
      await apps.action({ request: req({ unlink: 'lg_1' }), params: {} } as never),
    );
    expect(res.status).toBe(303);
    expect(shopperUnlink.mock.calls[0]!.slice(0, 2)).toEqual([SECRET, 'lg_1']);
    expect(shopperSignOut).not.toHaveBeenCalled();
    expect(res.headers.has('set-cookie')).toBe(false);
  });

  it('is refused cross-site before the route runs', async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/account/apps`, {
        method: 'POST',
        headers: { cookie: COOKIE, origin: 'https://evil.example' },
        body: formBody({ unlink: 'lg_1' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(shopperUnlink).not.toHaveBeenCalled();
  });
});
