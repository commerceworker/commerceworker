import { CONSENT_HEADER } from '@commerceworker/security/csp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Too many failed attempts.');
  }
}
class TokenExpired extends Error {}

const kv = new Map<string, string>();
/** How many keys one KV list answers with, whatever limit is asked for (to make pages). */
let pageSize = 1000;
/** A list that finds none of a prefix, as an eventually consistent one can just after a write. */
let blind: string | null = null;
/** Reads of a grant's record fail, as KV can. */
let failGrantReads = false;
const env = {
  PRINCIPAL_KEY: 'web-test-key',
  OAUTH_KV: {
    get: async (k: string, type?: string | { type?: string }) => {
      if (failGrantReads && k.startsWith('grant:')) throw new Error('KV unavailable');
      const v = kv.get(k) ?? null;
      const json = type === 'json' || (typeof type === 'object' && type.type === 'json');
      return v && json ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => {
      kv.set(k, v);
    },
    delete: async (k: string) => {
      kv.delete(k);
    },
    list: async ({
      prefix = '',
      limit = 1000,
      cursor,
    }: {
      prefix?: string;
      limit?: number;
      cursor?: string;
    } = {}) => {
      const all =
        blind && prefix.startsWith(blind)
          ? []
          : [...kv.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const to = from + Math.min(limit, pageSize);
      return {
        keys: all.slice(from, to).map((name) => ({ name })),
        list_complete: to >= all.length,
        ...(to < all.length ? { cursor: String(to) } : {}),
      };
    },
  },
};
const grantPrincipal = vi.fn();
const apiPrincipal = vi.fn();
const engineFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));
const dropA2aPushes = vi.fn(async (..._a: unknown[]) => ({ configs: 0 }));
const audit = vi.fn(async (..._a: unknown[]) => {});
const me = { kind: 'user', id: 'usr_1', name: 'Ann', email: 'ann@example.com', role: 'operator' };
const auth = {
  requireUser: vi.fn(async (): Promise<Record<string, unknown>> => me),
  stepUp: vi.fn(async (): Promise<string | null> => null),
  stepUpMethod: vi.fn(async (): Promise<string | null> => 'password'),
  authenticatedAt: vi.fn(async (): Promise<number | null> => Date.now()),
};

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({ engine: () => ({ fetch: engineFetch, dropA2aPushes }) }));
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/auth.server', () => ({
  ...auth,
  apiPrincipal,
  grantPrincipal,
  Throttled,
  TokenExpired,
  setupDue: () => null,
}));

const { apiOAuthFetch, MAX_REDIRECT_URIS, oauthApi, oauthFetch, REFUSAL_WINDOW_MS, userGrants } =
  await import('~/lib/oauth.server');
const authorize = await import('~/routes/oauth-authorize');

const ORIGIN = 'https://app.test';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const REDIRECT = 'https://client.test/cb';
const form = (body: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});
const server = (path: string, init?: RequestInit) =>
  oauthFetch(new Request(`${ORIGIN}${path}`, init), env as never, ctx);

const verifier = 'v'.repeat(64);
const challenge = async () => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

/** A public client, and a way to be granted tokens for a resource as the consent page grants them. */
async function connect() {
  const oauth = oauthApi(new Request(`${ORIGIN}/oauth/authorize`));
  const client = await oauth.createClient({
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'none',
    clientName: 'Test app',
  });
  const code = async (path: string) => {
    const { redirectTo } = await oauth.completeAuthorization({
      request: {
        responseType: 'code',
        clientId: client.clientId,
        redirectUri: REDIRECT,
        scope: ['viewer'],
        state: 's',
        codeChallenge: await challenge(),
        codeChallengeMethod: 'S256',
        resource: `${ORIGIN}${path}`,
      },
      userId: 'usr_1',
      metadata: { app: 'Test app' },
      scope: ['viewer'],
      props: { kind: 'user', id: 'usr_1', role: 'viewer' },
    });
    return new URL(redirectTo).searchParams.get('code') as string;
  };
  const redeem = (code: string) =>
    server(
      '/oauth/token',
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    );
  const grant = async (path: string) => {
    const res = await redeem(await code(path));
    return (await res.json()) as { access_token: string; refresh_token: string };
  };
  return { client, code, redeem, grant };
}

const run = vi.fn(async (_caller: unknown) => Response.json({ ran: true }));
const rest = (token: string) =>
  apiOAuthFetch(
    new Request(`${ORIGIN}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } }),
    env as never,
    ctx,
    run,
  );
const rpc = (path: string, token: string) =>
  server(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

let t = Date.parse('2026-11-10T12:00:00Z');
beforeEach(() => {
  kv.clear();
  pageSize = 1000;
  blind = null;
  failGrantReads = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t);
  for (const f of [grantPrincipal, apiPrincipal, engineFetch, audit, dropA2aPushes, run])
    f.mockClear();
  for (const f of Object.values(auth)) f.mockClear();
  grantPrincipal.mockResolvedValue(me);
  auth.requireUser.mockResolvedValue(me);
  auth.stepUp.mockResolvedValue(null);
  auth.stepUpMethod.mockResolvedValue('password');
  auth.authenticatedAt.mockImplementation(async () => Date.now());
});
afterEach(() => {
  t += 24 * 3_600_000;
  vi.useRealTimers();
});

describe('a revoked grant', () => {
  it('stops working at once at /mcp, /a2a and /api/v1, though its access token has not expired', async () => {
    const { grant } = await connect();
    const tokens = {
      '/mcp': (await grant('/mcp')).access_token,
      '/a2a': (await grant('/a2a')).access_token,
      '/api/v1': (await grant('/api/v1')).access_token,
    };
    expect((await rpc('/mcp', tokens['/mcp'])).status).toBe(200);
    expect((await rpc('/a2a', tokens['/a2a'])).status).toBe(200);
    expect((await rest(tokens['/api/v1'])).status).toBe(200);

    // The provider deletes a grant's tokens by listing them; a list that misses them (KV lists are
    // eventually consistent) leaves them behind. The grant's record is what is checked.
    blind = 'token:';
    const grants = await userGrants(new Request(ORIGIN), 'usr_1');
    expect(grants).toHaveLength(3);
    const oauth = oauthApi(new Request(ORIGIN));
    for (const g of grants) await oauth.revokeGrant(g.id, 'usr_1');
    expect([...kv.keys()].filter((k) => k.startsWith('token:'))).toHaveLength(3);

    engineFetch.mockClear();
    run.mockClear();
    for (const path of ['/mcp', '/a2a'] as const) {
      const res = await rpc(path, tokens[path]);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('www-authenticate'), path).toContain('invalid_token');
    }
    const api = await rest(tokens['/api/v1']);
    expect(api.status).toBe(401);
    expect(api.headers.get('www-authenticate')).toContain('invalid_token');
    expect(engineFetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(grantPrincipal).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the grant’s record can’t be read: 503, and no handler runs', async () => {
    const { grant } = await connect();
    const tokens = {
      '/mcp': (await grant('/mcp')).access_token,
      '/a2a': (await grant('/a2a')).access_token,
      '/api/v1': (await grant('/api/v1')).access_token,
    };
    failGrantReads = true;
    engineFetch.mockClear();
    run.mockClear();
    expect((await rpc('/mcp', tokens['/mcp'])).status).toBe(503);
    expect((await rpc('/a2a', tokens['/a2a'])).status).toBe(503);
    expect((await rest(tokens['/api/v1'])).status).toBe(503);
    expect(engineFetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(grantPrincipal).not.toHaveBeenCalled();
  });

  it('leaves the person’s other grants working', async () => {
    const { grant } = await connect();
    const a = await grant('/mcp');
    const b = await grant('/mcp');
    const oauth = oauthApi(new Request(ORIGIN));
    await oauth.revokeGrant(a.access_token.split(':')[1] as string, 'usr_1');
    expect((await rpc('/mcp', a.access_token)).status).toBe(401);
    expect((await rpc('/mcp', b.access_token)).status).toBe(200);
  });
});

describe('a client revoking its own token (RFC 7009)', () => {
  const revoke = (client: string, token: string, hint?: string) =>
    server(
      '/oauth/token',
      form({ client_id: client, token, ...(hint ? { token_type_hint: hint } : {}) }),
    );

  it('ends the grant with its refresh token, drops its A2A push configs and says who did it', async () => {
    const { client, grant } = await connect();
    const tokens = await grant('/a2a');
    const grantId = tokens.access_token.split(':')[1] as string;
    expect((await rpc('/a2a', tokens.access_token)).status).toBe(200);

    const res = await revoke(client.clientId, tokens.refresh_token, 'refresh_token');
    expect(res.status).toBe(200);
    expect(kv.has(`grant:usr_1:${grantId}`)).toBe(false);
    expect(dropA2aPushes).toHaveBeenCalledWith('user', 'usr_1', [grantId], true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'oauth.grant.revoke', {
      target: 'Test app',
      detail: { via: 'client', userId: 'usr_1', grant: grantId, clientId: client.clientId },
    });
    // Nothing the client holds works any more.
    expect((await rpc('/a2a', tokens.access_token)).status).toBe(401);
    const again = await server(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.clientId,
      }),
    );
    expect(again.status).toBe(400);
  });

  it('treats an empty grant_type as a revocation, as the provider does', async () => {
    const { client, grant } = await connect();
    const tokens = await grant('/a2a');
    const grantId = tokens.access_token.split(':')[1] as string;
    const res = await server(
      '/oauth/token',
      form({ client_id: client.clientId, token: tokens.refresh_token, grant_type: '' }),
    );
    expect(res.status).toBe(200);
    expect(kv.has(`grant:usr_1:${grantId}`)).toBe(false);
    expect(dropA2aPushes).toHaveBeenCalledWith('user', 'usr_1', [grantId], true);
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'oauth.grant.revoke', expect.anything());
  });

  it('answers a second revocation of the same token without dropping or logging again', async () => {
    const { client, grant } = await connect();
    const tokens = await grant('/mcp');
    await revoke(client.clientId, tokens.refresh_token);
    dropA2aPushes.mockClear();
    audit.mockClear();
    expect((await revoke(client.clientId, tokens.refresh_token)).status).toBe(200);
    expect(dropA2aPushes).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('ends only the token for an access token, which leaves the grant standing', async () => {
    const { client, grant } = await connect();
    const tokens = await grant('/mcp');
    expect((await revoke(client.clientId, tokens.access_token, 'access_token')).status).toBe(200);
    expect((await rpc('/mcp', tokens.access_token)).status).toBe(401);
    expect(kv.has(`grant:usr_1:${tokens.access_token.split(':')[1]}`)).toBe(true);
    expect(dropA2aPushes).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses to end another client’s grant: it stands, and nothing is dropped or logged', async () => {
    const { grant } = await connect();
    const other = await connect();
    const tokens = await grant('/mcp');
    const res = await revoke(other.client.clientId, tokens.refresh_token);
    // RFC 7009 §2.2: the answer says nothing of whose token it is.
    expect(res.status).toBe(200);
    expect(kv.has(`grant:usr_1:${tokens.access_token.split(':')[1]}`)).toBe(true);
    expect((await rpc('/mcp', tokens.access_token)).status).toBe(200);
    expect(dropA2aPushes).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalledWith(
      expect.anything(),
      'oauth.grant.revoke',
      expect.anything(),
    );
  });

  it('leaves a token request that names a grant type to the grant types', async () => {
    const { client, grant } = await connect();
    const tokens = await grant('/mcp');
    const res = await server(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        token: tokens.refresh_token,
        client_id: client.clientId,
      }),
    );
    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalledWith(
      expect.anything(),
      'oauth.grant.revoke',
      expect.anything(),
    );
  });
});

describe('the consent answer', () => {
  const params = async (clientId: string, extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${ORIGIN}/mcp`,
      ...extra,
    });
  const load = async (query: URLSearchParams) =>
    (await authorize.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${query}`),
      params: {},
      context: {},
    } as never)) as unknown as
      | Response
      | { data: Record<string, unknown>; init?: { status?: number; headers?: Headers } };

  /** The consent page loaded, and its form answered the way the browser would. */
  async function answer(decision: 'approve' | 'deny') {
    const { client } = await connect();
    const page = (await load(await params(client.clientId))) as {
      data: { handle: string };
      init: { headers: Headers };
    };
    const cookie = (page.init.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const res = (await authorize.action({
      request: new Request(`${ORIGIN}/oauth/authorize?${await params(client.clientId)}`, {
        ...form({ handle: page.data.handle, decision, role: 'viewer' }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      }),
      params: {},
      context: {},
    } as never)) as Response;
    return { client, page, res };
  }

  it('is a 303 when approved and when denied, so the client is reached with a GET', async () => {
    const approved = await answer('approve');
    expect(approved.res.status).toBe(303);
    const to = new URL(approved.res.headers.get('location') as string);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get('code')).toBeTruthy();
    expect(to.searchParams.get('state')).toBe('xyz');
    expect(to.searchParams.get('iss')).toBe(ORIGIN);
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'oauth.app_connected', expect.anything());

    const denied = await answer('deny');
    expect(denied.res.status).toBe(303);
    const back = new URL(denied.res.headers.get('location') as string);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
  });

  it('names the return address in the page’s own policy note, so Chromium lets the redirect through', async () => {
    const { page } = await answer('approve');
    // The note carries the validated address; entry.server.tsx turns it into this page's
    // form-action (packages/security) and drops it.
    expect(page.init.headers.get(CONSENT_HEADER)).toBe(REDIRECT);
  });

  it('turns a request with no PKCE challenge back to the app with invalid_request and iss', async () => {
    const oauth = oauthApi(new Request(`${ORIGIN}/oauth/authorize`));
    const confidential = await oauth.createClient({
      redirectUris: [REDIRECT],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    const query = await params(confidential.clientId);
    query.delete('code_challenge');
    query.delete('code_challenge_method');
    const res = (await load(query)) as Response;
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get('location') as string);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get('error')).toBe('invalid_request');
    expect(to.searchParams.get('error_description')).toContain('PKCE');
    expect(to.searchParams.get('state')).toBe('xyz');
    expect(to.searchParams.get('iss')).toBe(ORIGIN);
    expect([...kv.keys()].some((k) => k.includes('consent'))).toBe(false);
  });

  it('shows a page, never a redirect, when the client or its return address is not valid', async () => {
    const { client } = await connect();
    const bads: Record<string, string>[] = [
      { redirect_uri: 'https://evil.test/cb' },
      { client_id: 'nobody' },
      // Not even a missing challenge is told to an unverified return address.
      { redirect_uri: 'https://evil.test/cb', code_challenge: '' },
    ];
    for (const bad of bads) {
      const query = await params(client.clientId, bad);
      if (bad.code_challenge === '') query.delete('code_challenge');
      const res = (await load(query)) as { data: { error: string }; init: { status: number } };
      expect('headers' in res).toBe(false);
      expect(res.init.status).toBe(400);
    }
  });
});

describe('max_age and prompt=login on the consent page', () => {
  const load = async (query: Record<string, string>) => {
    const { client } = await connect();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${ORIGIN}/mcp`,
      ...query,
    });
    const res = (await authorize.loader({
      request: new Request(`${ORIGIN}/oauth/authorize?${q}`),
      params: {},
      context: {},
    } as never)) as unknown as { data: Record<string, unknown>; init?: { headers?: Headers } };
    return { res, q };
  };
  const consentShown = (r: { data: Record<string, unknown> }) => 'handle' in r.data;
  const reauth = (r: { data: Record<string, unknown> }) =>
    r.data.reauth as { why: string; next: string; sso: boolean };

  it('asks a person whose sign-in is older than max_age to sign in again, before any consent exists', async () => {
    auth.authenticatedAt.mockResolvedValue(Date.now() - 120_000);
    const { res } = await load({ max_age: '60' });
    expect(consentShown(res)).toBe(false);
    expect(reauth(res).why).toContain('last 60 seconds');
    expect([...kv.keys()].some((k) => k.includes('consent'))).toBe(false);
    // They come back to this request, which no longer asks, so signing in is not asked for again.
    const next = new URL(reauth(res).next, ORIGIN);
    expect(next.pathname).toBe('/oauth/authorize');
    expect(next.searchParams.has('max_age')).toBe(false);
    expect(next.searchParams.get('state')).toBe('xyz');
    expect(next.searchParams.get('client_id')).toBeTruthy();
  });

  it('lets a recent enough sign-in through, and ignores a max_age that is not whole seconds', async () => {
    auth.authenticatedAt.mockResolvedValue(Date.now() - 30_000);
    expect(consentShown((await load({ max_age: '60' })).res)).toBe(true);
    auth.authenticatedAt.mockResolvedValue(Date.now() - 86_400_000);
    for (const max_age of ['abc', '-1', '1.5', '']) {
      expect(consentShown((await load({ max_age })).res), max_age).toBe(true);
    }
  });

  it('treats max_age=0 and a session it cannot date as needing a new sign-in', async () => {
    auth.authenticatedAt.mockResolvedValue(Date.now());
    expect(consentShown((await load({ max_age: '0' })).res)).toBe(false);
    auth.authenticatedAt.mockResolvedValue(null);
    expect(consentShown((await load({ max_age: '3600' })).res)).toBe(false);
  });

  it('asks for a new sign-in under prompt=login however fresh the session, and once', async () => {
    auth.authenticatedAt.mockResolvedValue(Date.now());
    const asked = await load({ prompt: 'login consent' });
    expect(consentShown(asked.res)).toBe(false);
    expect(reauth(asked.res).why).toContain('sign in again');
    // Only `login` is spent: the other prompt values stay for whoever reads them.
    const next = new URL(reauth(asked.res).next, ORIGIN);
    expect(next.searchParams.get('prompt')).toBe('consent');
    // The request they return to shows consent.
    const { client } = await connect();
    const again = (await authorize.loader({
      request: new Request(
        `${ORIGIN}${reauth(asked.res).next.replace(/client_id=[^&]+/, `client_id=${client.clientId}`)}`,
      ),
      params: {},
      context: {},
    } as never)) as unknown as { data: Record<string, unknown> };
    expect(consentShown(again)).toBe(true);
  });

  it('sends someone with only single sign-on to the provider instead of signing them out', async () => {
    auth.stepUpMethod.mockResolvedValue('sso');
    expect(reauth((await load({ prompt: 'login' })).res).sso).toBe(true);
    auth.stepUpMethod.mockResolvedValue('password');
    expect(reauth((await load({ prompt: 'login' })).res).sso).toBe(false);
  });

  it('asks nothing of a request that names neither, and never reads the session for it', async () => {
    expect(consentShown((await load({})).res)).toBe(true);
    expect(auth.authenticatedAt).not.toHaveBeenCalled();
  });

  it('does not apply to a token or the open local workspace, which have no sign-in to age', async () => {
    auth.requireUser.mockResolvedValue({ ...me, kind: 'open' });
    expect(consentShown((await load({ prompt: 'login' })).res)).toBe(true);
  });
});

describe('registration policy', () => {
  const register = async (meta: Record<string, unknown>) => {
    const res = await server('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Policy app',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        ...meta,
      }),
    });
    return { res, body: (await res.json()) as Record<string, unknown> };
  };
  const stored = () => [...kv.keys()].filter((k) => k.startsWith('client:')).length;

  it('registers a client that keeps to it', async () => {
    const { res } = await register({
      client_uri: 'https://client.test',
      logo_uri: 'https://client.test/logo.png',
      policy_uri: 'https://client.test/privacy',
      tos_uri: 'https://client.test/terms',
    });
    expect(res.status).toBe(201);
    expect(stored()).toBe(1);
  });

  it('refuses a software_statement, which nothing here verifies', async () => {
    const { res, body } = await register({ software_statement: 'eyJhbGciOiJub25lIn0.e30.' });
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_software_statement');
    expect(stored()).toBe(0);
  });

  it('allows ten return addresses and refuses an eleventh', async () => {
    const uris = (n: number) => Array.from({ length: n }, (_, i) => `https://client.test/cb/${i}`);
    expect((await register({ redirect_uris: uris(MAX_REDIRECT_URIS) })).res.status).toBe(201);
    const { res, body } = await register({ redirect_uris: uris(MAX_REDIRECT_URIS + 1) });
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
    expect(stored()).toBe(1);
  });

  it('wants https for the addresses a consent page shows or links', async () => {
    for (const name of ['client_uri', 'logo_uri', 'policy_uri', 'tos_uri']) {
      for (const bad of [
        'http://client.test/x',
        'javascript:alert(1)',
        'data:text/html,x',
        'https://user:pw@client.test/x',
        'not a url',
        42,
      ]) {
        const { res, body } = await register({ [name]: bad });
        expect(res.status, `${name} ${bad}`).toBe(400);
        expect(body.error).toBe('invalid_client_metadata');
        expect(body.error_description).toContain(name);
      }
    }
    expect(stored()).toBe(0);
  });

  it('refuses a wildcard in a return address’s host', async () => {
    for (const bad of ['https://*/cb', 'https://*.x.test/cb', 'https://a.test,*/cb']) {
      const { res, body } = await register({ redirect_uris: [bad] });
      expect(res.status, bad).toBe(400);
      expect(body.error).toBe('invalid_redirect_uri');
    }
    expect(stored()).toBe(0);
  });

  it('still keeps the first-party CLI’s name to itself', async () => {
    const { res, body } = await register({ client_name: 'CommerceWorker CLI' });
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('does not count the device grant’s own return address against the ten', async () => {
    const { res } = await register({
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
      redirect_uris: Array.from(
        { length: MAX_REDIRECT_URIS },
        (_, i) => `https://client.test/${i}`,
      ),
    });
    expect(res.status).toBe(201);
  });
});

describe('what the provider turns away at the token endpoint', () => {
  const refuse = (clientId: string, token: string) =>
    server(
      '/oauth/token',
      form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }),
    );
  const refusals = () =>
    audit.mock.calls.filter((c) => c[1] === 'oauth.refused') as unknown as [
      Request,
      string,
      { target: string; detail: Record<string, unknown> },
    ][];

  it('audits a refresh token that doesn’t match its grant, naming the client and the reason only', async () => {
    const { client, grant } = await connect();
    const tokens = await grant('/mcp');
    const [user, grantId] = tokens.refresh_token.split(':');
    const forged = `${user}:${grantId}:${'x'.repeat(24)}`;
    const res = await refuse(client.clientId, forged);
    expect(res.status).toBe(400);
    // What the client is told is unchanged.
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]![2]).toEqual({
      target: client.clientId,
      detail: {
        reason: 'refresh_token_mismatch',
        category: 'refresh-token-grant',
        code: 'invalid_grant',
        count: 1,
      },
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('x'.repeat(24));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(tokens.refresh_token);
  });

  it('audits an authorization code used twice', async () => {
    const { client, code, redeem } = await connect();
    const c = await code('/mcp');
    expect((await redeem(c)).status).toBe(200);
    expect((await redeem(c)).status).toBe(400);
    expect(refusals().map((r) => [r[2].target, r[2].detail.reason])).toEqual([
      [client.clientId, 'code_replayed'],
    ]);
  });

  it('audits one refusal per client and reason in a window, and counts the rest into the next', async () => {
    const { client, grant } = await connect();
    const tokens = await grant('/mcp');
    const [user, grantId] = tokens.refresh_token.split(':');
    const forged = `${user}:${grantId}:forged`;
    for (let i = 0; i < 25; i++) await refuse(client.clientId, forged);
    expect(refusals()).toHaveLength(1);

    // Another client's refusals are its own count.
    const other = await connect();
    const otherTokens = await other.grant('/mcp');
    const [ou, og] = otherTokens.refresh_token.split(':');
    await refuse(other.client.clientId, `${ou}:${og}:forged`);
    expect(refusals()).toHaveLength(2);

    t = Date.now() + REFUSAL_WINDOW_MS + 1;
    vi.setSystemTime(t);
    await refuse(client.clientId, forged);
    expect(refusals()).toHaveLength(3);
    // The 24 in the window and this one.
    expect(refusals()[2]![2].detail.count).toBe(25);
  });

  it('only logs what it can’t pin to a client: a wrong secret, an unknown client, a malformed request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await refuse('no-such-client', 'usr_1:g:secret');
      const oauth = oauthApi(new Request(ORIGIN));
      const confidential = await oauth.createClient({
        redirectUris: [REDIRECT],
        tokenEndpointAuthMethod: 'client_secret_post',
      });
      await server(
        '/oauth/token',
        form({
          grant_type: 'refresh_token',
          refresh_token: 'usr_1:g:secret',
          client_id: confidential.clientId,
          client_secret: 'wrong',
        }),
      );
      await server('/oauth/token', form({ grant_type: 'nonsense', client_id: 'x' }));
      expect(refusals()).toHaveLength(0);
      const logged = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as { reason: string });
      expect(logged.map((l) => l.reason)).toEqual(
        expect.arrayContaining(['client_not_found', 'client_secret_mismatch']),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('wrong');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('listing a person’s grants', () => {
  it('pages through all of them, not just the first page', async () => {
    const ids = new Set<string>();
    // One grant per client: a client's new grant replaces its earlier one.
    for (let i = 0; i < 5; i++)
      ids.add((await (await connect()).grant('/mcp')).access_token.split(':')[1] as string);
    pageSize = 2;
    const oauth = oauthApi(new Request(ORIGIN));
    const first = await oauth.listUserGrants('usr_1');
    expect(first.items.length).toBeLessThan(5);
    expect(first.cursor).toBeTruthy();
    const all = await userGrants(new Request(ORIGIN), 'usr_1');
    expect(new Set(all.map((g) => g.id))).toEqual(ids);
    expect(all).toHaveLength(5);
  });

  it('is empty for a person with none', async () => {
    expect(await userGrants(new Request(ORIGIN), 'usr_9')).toEqual([]);
  });
});
