import { beforeEach, describe, expect, it, vi } from 'vitest';

class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Too many failed attempts.');
  }
}
class TokenExpired extends Error {}

const kv = new Map<string, string>();
const env = {
  OAUTH_KV: {
    get: async (k: string, type?: string | { type?: string }) => {
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
    list: async () => ({ keys: [], list_complete: true }),
  },
};
const cookieSession = { kind: 'user', id: 'usr_cookie', name: 'Cookie', role: 'admin' };
/** What `apiPrincipal` does with a request: a bearer is judged alone, no bearer is the cookie. */
const apiPrincipal = vi.fn(async (request: Request) => {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!bearer) return request.headers.get('cookie') ? cookieSession : null;
  return bearer === 'cmw_live_good'
    ? { kind: 'token', id: 'tok_1', name: 'token:ci', role: 'viewer' }
    : null;
});
const grantPrincipal = vi.fn();
const handleApi = vi.fn(async (_r: Request, caller: { id: string }) =>
  Response.json({ caller: caller.id }),
);

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: async () => Response.json({}), dropA2aPushes: async () => ({}) }),
}));
vi.mock('~/lib/audit.server', () => ({ audit: async () => {}, clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/rate-limit', () => ({ overBudget: async () => null }));
vi.mock('~/lib/api.server', () => ({ handleApi }));
vi.mock('~/lib/auth.server', () => ({
  apiPrincipal,
  grantPrincipal,
  Throttled,
  TokenExpired,
  setupDue: () => null,
}));

const { apiRoute } = await import('~/lib/api-route.server');
const { oauthApi, oauthFetch } = await import('~/lib/oauth.server');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const call = (headers: Record<string, string>) =>
  apiRoute(new Request('https://app.test/api/v1/me', { headers }), env as never, ctx);

async function grantFor(path: string) {
  const oauth = oauthApi(new Request('https://app.test/oauth/authorize'));
  const client = await oauth.createClient({
    redirectUris: ['https://client.test/cb'],
    tokenEndpointAuthMethod: 'none',
  });
  const verifier = 'v'.repeat(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const { redirectTo } = await oauth.completeAuthorization({
    request: {
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.test/cb',
      scope: ['viewer'],
      state: 's',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource: `https://app.test${path}`,
    },
    userId: 'usr_1',
    metadata: {},
    scope: ['viewer'],
    props: { kind: 'user', id: 'usr_1', role: 'viewer' },
  });
  const res = await oauthFetch(
    new Request('https://app.test/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(redirectTo).searchParams.get('code')!,
        redirect_uri: 'https://client.test/cb',
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    }),
    env as never,
    ctx,
  );
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('who a REST request is', () => {
  beforeEach(() => {
    apiPrincipal.mockClear();
    handleApi.mockClear();
    grantPrincipal.mockReset();
    grantPrincipal.mockResolvedValue({ kind: 'user', id: 'usr_1', name: 'Ann', role: 'viewer' });
  });

  it('serves each credential as its own, and a cookie alone as the session', async () => {
    expect(await (await call({ cookie: 'session=x' })).json()).toEqual({ caller: 'usr_cookie' });
    expect(await (await call({ authorization: 'Bearer cmw_live_good' })).json()).toEqual({
      caller: 'tok_1',
    });
    const token = await grantFor('/api/v1');
    expect(await (await call({ authorization: `Bearer ${token}` })).json()).toEqual({
      caller: 'usr_1',
    });
  });

  it('never falls back to the cookie for a bearer it refuses', async () => {
    const cookie = 'session=valid';
    for (const authorization of [
      'Bearer u:g:x',
      'Bearer u:g:x junk',
      'Bearer cmw_live_wrong',
      'Bearer nonsense',
    ]) {
      const res = await call({ authorization, cookie });
      expect(res.status, authorization).toBe(401);
      expect(res.headers.get('www-authenticate'), authorization).toContain(
        'oauth-protected-resource/api/v1',
      );
    }
    expect(handleApi).not.toHaveBeenCalled();
  });

  it('refuses a token granted for another resource, cookie or not', async () => {
    const mcp = await grantFor('/mcp');
    const res = await call({ authorization: `Bearer ${mcp}`, cookie: 'session=valid' });
    expect(res.status).toBe(401);
    expect(handleApi).not.toHaveBeenCalled();
  });

  it('offers no CORS to any credential', async () => {
    const token = await grantFor('/api/v1');
    const origin = 'https://evil.test';
    const answers = [
      await call({ authorization: `Bearer ${token}`, origin }),
      // A refused one too, which the resource server challenges itself.
      await call({ authorization: 'Bearer u:g:x', origin }),
      await call({ authorization: 'Bearer cmw_live_good', origin }),
      await call({ cookie: 'session=x', origin }),
    ];
    for (const res of answers)
      expect([...res.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
    expect(answers.map((r) => r.status)).toEqual([200, 401, 200, 200]);
  });
});
