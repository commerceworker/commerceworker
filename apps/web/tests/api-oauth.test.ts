import { beforeEach, describe, expect, it, vi } from 'vitest';

class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Too many failed attempts.');
  }
}
class TokenExpired extends Error {}

const kv = new Map<string, string>();
const env = {
  PRINCIPAL_KEY: 'web-test-key',
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
const apiPrincipal = vi.fn();
const grantPrincipal = vi.fn();
const engineFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: engineFetch, dropA2aPushes: async () => ({ configs: 0 }) }),
}));
vi.mock('~/lib/audit.server', () => ({ audit: async () => {}, clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/auth.server', () => ({
  apiPrincipal,
  grantPrincipal,
  Throttled,
  TokenExpired,
  setupDue: () => null,
}));

const {
  apiChallenge,
  apiOAuthFetch,
  channelOf,
  hasIssuedToken,
  isOAuthPath,
  oauthApi,
  oauthFetch,
} = await import('~/lib/oauth.server');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const person = { kind: 'user', id: 'usr_1', name: 'Ann', email: 'ann@example.com', role: 'viewer' };

/** The REST router's side: what a token that passes is run as. */
const run = vi.fn(async (_caller: unknown) => Response.json({ ran: true }));
const rest = (authorization?: string) =>
  apiOAuthFetch(
    new Request('https://app.test/api/v1/me', {
      headers: authorization ? { authorization } : {},
    }),
    env as never,
    ctx,
    run,
  );
const post = (path: string, authorization: string) =>
  oauthFetch(
    new Request(`https://app.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    env as never,
    ctx,
  );

/** An OAuth client and a way to be granted a token for one resource, as the consent page does. */
async function connect() {
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
  const grant = async (path: string, role: 'viewer' | 'operator' = 'viewer') => {
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
      props: { kind: 'user', id: 'usr_1', role },
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
  };
  return { client, grant };
}

describe('the REST API as an OAuth resource', () => {
  beforeEach(() => {
    run.mockClear();
    apiPrincipal.mockReset();
    grantPrincipal.mockReset();
    engineFetch.mockClear();
    grantPrincipal.mockResolvedValue(person);
  });

  it('is a resource of its own, whose routes stay the app’s', async () => {
    expect(isOAuthPath('/api/v1')).toBe(false);
    expect(isOAuthPath('/api/v1/me')).toBe(false);
    expect(isOAuthPath('/.well-known/oauth-protected-resource/api/v1')).toBe(true);
    expect(channelOf('https://app.test/api/v1')).toBe('API');
    const res = await oauthFetch(
      new Request('https://app.test/.well-known/oauth-protected-resource/api/v1'),
      env as never,
      ctx,
    );
    expect(await res.json()).toMatchObject({
      resource: 'https://app.test/api/v1',
      authorization_servers: ['https://app.test'],
      scopes_supported: ['viewer', 'approver', 'operator'],
    });
    const server = await oauthFetch(
      new Request('https://app.test/.well-known/oauth-authorization-server'),
      env as never,
      ctx,
    );
    expect(
      ((await server.json()) as { protected_resources: string[] }).protected_resources,
    ).toEqual(['https://app.test/mcp', 'https://app.test/a2a', 'https://app.test/api/v1']);
  });

  it('only takes an issued token for itself, leaving cmw_live_ tokens to the router', () => {
    const bearer = (authorization?: string) =>
      hasIssuedToken(
        new Request('https://app.test/x', authorization ? { headers: { authorization } } : {}),
      );
    expect(bearer('Bearer usr_1:g:s')).toBe(true);
    expect(bearer('Bearer cmw_live_abc')).toBe(false);
    expect(bearer()).toBe(false);
  });

  it('runs a token granted for it as the person who approved it, marked with its grant', async () => {
    const { client, grant } = await connect();
    const token = await grant('/api/v1');
    const res = await rest(`Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(grantPrincipal).toHaveBeenCalledWith({ kind: 'user', id: 'usr_1', role: 'viewer' });
    expect(apiPrincipal).not.toHaveBeenCalled();
    const caller = run.mock.calls[0]![0] as Record<string, unknown>;
    expect(caller).toMatchObject({
      ...person,
      grant: token.split(':')[1],
      client: client.clientId,
      resource: 'https://app.test/api/v1',
    });
    expect(caller.expiresAt).toBeGreaterThan(Date.now());
    expect(caller.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('caps the role by the token’s scope, and by the person’s role now', async () => {
    const { grant } = await connect();
    // Granted operator, but the token's scope names only viewer.
    await rest(`Bearer ${await grant('/api/v1', 'operator')}`);
    expect(grantPrincipal).toHaveBeenCalledWith({ kind: 'user', id: 'usr_1', role: 'viewer' });
    // grantPrincipal lowers it to the person's own role (see auth.server); the router sees that.
    grantPrincipal.mockResolvedValue({ ...person, role: 'viewer' });
    await rest(`Bearer ${await grant('/api/v1', 'operator')}`);
    expect((run.mock.calls.at(-1)![0] as { role: string }).role).toBe('viewer');
  });

  it('ends a grant whose person is disabled or gone', async () => {
    const { grant } = await connect();
    grantPrincipal.mockResolvedValue(null);
    const res = await rest(`Bearer ${await grant('/api/v1')}`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a token granted for MCP or A2A, and an API token at MCP or A2A', async () => {
    const { grant } = await connect();
    const api = await grant('/api/v1');
    const mcp = await grant('/mcp');
    const a2a = await grant('/a2a');

    for (const wrong of [mcp, a2a]) {
      const res = await rest(`Bearer ${wrong}`);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(
        'https://app.test/.well-known/oauth-protected-resource/api/v1',
      );
    }
    expect(run).not.toHaveBeenCalled();
    expect(grantPrincipal).not.toHaveBeenCalled();

    expect((await post('/mcp', `Bearer ${api}`)).status).toBe(401);
    expect((await post('/a2a', `Bearer ${api}`)).status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
    // And each still works where it was granted.
    expect((await rest(`Bearer ${api}`)).status).toBe(200);
    expect((await post('/mcp', `Bearer ${mcp}`)).status).toBe(200);
    expect((await post('/a2a', `Bearer ${a2a}`)).status).toBe(200);
  });

  it('challenges a missing, forged or API-token bearer with the resource metadata', async () => {
    for (const authorization of [undefined, 'Bearer usr_1:g:forged', 'Bearer cmw_live_abc']) {
      const res = await rest(authorization);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://app.test/.well-known/oauth-protected-resource/api/v1"',
      );
    }
    expect(run).not.toHaveBeenCalled();
    expect(apiChallenge('https://app.test')).toBe(
      'Bearer realm="OAuth", resource_metadata="https://app.test/.well-known/oauth-protected-resource/api/v1", scope="viewer approver operator"',
    );
  });
});
