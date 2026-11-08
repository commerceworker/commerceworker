import { deriveAssistantPrincipalKey } from '@commerceworker/security/assistant-key';
import {
  BOOKMARK_HEADER,
  DEV_PRINCIPAL_KEY,
  PRINCIPAL_HEADER,
  verifyPrincipal,
} from '@commerceworker/security/principal';
import { describe, expect, it, vi } from 'vitest';

const KEY = 'gateway-test-key';
vi.mock('cloudflare:workers', () => ({ env: { PRINCIPAL_KEY: 'gateway-test-key' } }));

const { forwardToApi, isApiPath } = await import('~/lib/gateway.server');
const { setPrincipalHeader, principalKey } = await import('~/lib/principal.server');

type Caller = Awaited<ReturnType<Parameters<typeof forwardToApi>[1]['principal']>>;

const ORIGIN = 'https://cms.example.com';
const ada = {
  kind: 'user' as const,
  id: 'usr_ada',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'admin' as const,
};

/** Forwards `request` with `who` signed in, and returns what reached the api. */
async function forward(request: Request, who: Caller = null) {
  const seen: Request[] = [];
  const api = {
    fetch: vi.fn(async (r: Request) => {
      seen.push(r);
      return new Response('ok', { headers: { [BOOKMARK_HEADER]: 'bm-2' } });
    }),
  };
  const principal = vi.fn(async () => who);
  const res = await forwardToApi(request, {
    api: api as unknown as Fetcher,
    principal,
    sign: setPrincipalHeader,
  });
  return { res, sent: seen[0], api, principal };
}

describe('isApiPath', () => {
  it('forwards the api’s surfaces', () => {
    for (const p of [
      '/spaces',
      '/starters',
      '/spaces/s1/environments/main/entries',
      '/preview/s1/entries',
      '/delivery/s1/entries',
      '/mcp',
      '/oauth/token',
      '/oauth/authorize',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/mcp',
      '/media/s1/a.png',
      '/openapi.json',
      '/docs',
      '/guides',
      '/guides/webhooks',
      '/health/api',
      '/agents/assistant-agent/usr_ada',
      '/agents/assistant-agent/usr_ada/get-messages',
      // Who the token or session is (the Management SDK's `me()`).
      '/auth/me',
    ])
      expect(isApiPath(p), p).toBe(true);
  });

  it('keeps the admin’s own pages', () => {
    for (const p of [
      '/',
      '/dashboard',
      '/content',
      '/login',
      '/team',
      '/health',
      '/health/deep',
      '/spacesuit',
      '/mcpx',
      '/agents',
      '/agentsx/assistant-agent/usr_ada',
      '/scim/v2/Users',
      '/.well-known/security.txt',
    ])
      expect(isApiPath(p), p).toBe(false);
  });
});

describe('forwardToApi', () => {
  it('passes a bearer request through, but never with a caller’s principal or cookies', async () => {
    const request = new Request(`${ORIGIN}/spaces/s1/entries`, {
      headers: {
        authorization: 'Bearer cw_pat_123',
        cookie: '__Host-cw_session=secret',
        [PRINCIPAL_HEADER]: 'forged.value',
        [BOOKMARK_HEADER]: 'bm-1',
      },
    });
    const { sent, principal } = await forward(request, ada);
    expect(sent?.headers.get('authorization')).toBe('Bearer cw_pat_123');
    expect(sent?.headers.get(PRINCIPAL_HEADER)).toBeNull();
    expect(sent?.headers.get(BOOKMARK_HEADER)).toBe('bm-1');
    // Cookies never cross the binding, even alongside a bearer token.
    expect(sent?.headers.get('cookie')).toBeNull();
    // The session is never looked at for a bearer call.
    expect(principal).not.toHaveBeenCalled();
  });

  it('swaps a session for a signed principal bound to the path, and drops the cookie', async () => {
    const request = new Request(`${ORIGIN}/spaces/s1/entries?limit=5`, {
      method: 'POST',
      body: '{"a":1}',
      headers: {
        cookie: '__Host-cw_session=secret',
        origin: ORIGIN,
        'content-type': 'application/json',
        [BOOKMARK_HEADER]: 'bm-1',
      },
    });
    const { res, sent } = await forward(request, ada);
    expect(sent?.headers.get('cookie')).toBeNull();
    expect(sent?.headers.get(BOOKMARK_HEADER)).toBe('bm-1');
    expect(sent?.method).toBe('POST');
    expect(await sent?.text()).toBe('{"a":1}');
    expect(new URL(sent!.url).search).toBe('?limit=5');
    const header = sent?.headers.get(PRINCIPAL_HEADER);
    expect(await verifyPrincipal(KEY, header, 'POST /spaces/s1/entries')).toEqual({
      sub: 'usr_ada',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'admin',
    });
    expect(await verifyPrincipal(KEY, header, 'POST /spaces/s2/entries')).toBeNull();
    // Bound to the method too: the same header can't be replayed as a DELETE.
    expect(await verifyPrincipal(KEY, header, 'DELETE /spaces/s1/entries')).toBeNull();
    // The api's bookmark comes back to the browser untouched.
    expect(res.headers.get(BOOKMARK_HEADER)).toBe('bm-2');
  });

  it('replaces a principal the browser sent with its own', async () => {
    const request = new Request(`${ORIGIN}/mcp`, {
      headers: { cookie: 's=1', [PRINCIPAL_HEADER]: 'forged.value' },
    });
    const { sent } = await forward(request, ada);
    const header = sent?.headers.get(PRINCIPAL_HEADER);
    expect(header).not.toBe('forged.value');
    expect(await verifyPrincipal(KEY, header, 'GET /mcp')).not.toBeNull();
  });

  it('forwards without credentials when nobody is signed in', async () => {
    const request = new Request(`${ORIGIN}/spaces`, {
      headers: { cookie: 'junk=1', [PRINCIPAL_HEADER]: 'forged.value' },
    });
    const { sent } = await forward(request, null);
    expect(sent?.headers.get('cookie')).toBeNull();
    expect(sent?.headers.get(PRINCIPAL_HEADER)).toBeNull();
    expect(sent?.headers.get('authorization')).toBeNull();
  });

  it('never lends the session to a cross-site request', async () => {
    const request = new Request(`${ORIGIN}/spaces/s1/entries`, {
      method: 'POST',
      headers: { cookie: '__Host-cw_session=secret', origin: 'https://evil.example' },
    });
    const { sent, principal } = await forward(request, ada);
    expect(principal).not.toHaveBeenCalled();
    expect(sent?.headers.get(PRINCIPAL_HEADER)).toBeNull();
    expect(sent?.headers.get('cookie')).toBeNull();
  });

  it('refuses someone whose two-factor sign-in or password is due', async () => {
    const request = new Request(`${ORIGIN}/spaces`, { headers: { cookie: 's=1' } });
    const { res, api } = await forward(request, { ...ada, due: 'Set up two-factor first.' });
    expect(res.status).toBe(403);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('passes the assistant’s socket through, signed for its path with the session it came on', async () => {
    const path = '/agents/assistant-agent/usr_ada';
    const request = new Request(`${ORIGIN}${path}`, {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        origin: ORIGIN,
        cookie: '__Host-cw_session=secret',
      },
    });
    const { sent } = await forward(request, { ...ada, sid: 'sess-hash' });
    expect(sent?.headers.get('upgrade')).toBe('websocket');
    expect(sent?.headers.get('sec-websocket-key')).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(sent?.headers.get('cookie')).toBeNull();
    // Signed with the assistant's derived key, never the main one.
    const assistantKey = await deriveAssistantPrincipalKey(KEY);
    expect(
      await verifyPrincipal(KEY, sent?.headers.get(PRINCIPAL_HEADER), `GET ${path}`),
    ).toBeNull();
    expect(
      await verifyPrincipal(assistantKey, sent?.headers.get(PRINCIPAL_HEADER), `GET ${path}`),
    ).toEqual({
      sub: 'usr_ada',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'admin',
      sid: 'sess-hash',
    });
    // Signed for that person's socket only: not for another's, nor for its message history.
    const header = sent?.headers.get(PRINCIPAL_HEADER);
    expect(
      await verifyPrincipal(assistantKey, header, 'GET /agents/assistant-agent/usr_bob'),
    ).toBeNull();
    expect(await verifyPrincipal(assistantKey, header, `GET ${path}/get-messages`)).toBeNull();
    expect(await verifyPrincipal(assistantKey, header, `POST ${path}`)).toBeNull();
  });

  it('never lends the session to a socket opened from another site', async () => {
    const request = new Request(`${ORIGIN}/agents/assistant-agent/usr_ada`, {
      headers: {
        upgrade: 'websocket',
        origin: 'https://evil.example',
        cookie: '__Host-cw_session=secret',
      },
    });
    const { sent, principal } = await forward(request, ada);
    expect(principal).not.toHaveBeenCalled();
    expect(sent?.headers.get(PRINCIPAL_HEADER)).toBeNull();
  });

  it('signs as `local` in open local development', async () => {
    const request = new Request('http://localhost:5173/spaces', { headers: {} });
    const { sent } = await forward(request, {
      kind: 'open',
      id: 'local',
      name: 'local',
      role: 'admin',
    });
    expect(await verifyPrincipal(KEY, sent?.headers.get(PRINCIPAL_HEADER), 'GET /spaces')).toEqual({
      sub: 'local',
      email: '',
      name: 'local',
      role: 'admin',
    });
  });
});

describe('forwardToApi with the delivery Worker bound', () => {
  /** Forwards `request` with both bindings, and reports which one answered. */
  async function route(request: Request, who: Caller = ada) {
    const hit = (name: string, seen: Request[]) => ({
      fetch: vi.fn(async (r: Request) => {
        seen.push(r);
        return new Response(name);
      }),
    });
    const toApi: Request[] = [];
    const toDelivery: Request[] = [];
    const res = await forwardToApi(request, {
      api: hit('api', toApi) as unknown as Fetcher,
      delivery: hit('delivery', toDelivery) as unknown as Fetcher,
      principal: vi.fn(async () => who),
      sign: setPrincipalHeader,
    });
    return { answeredBy: await res.text(), toApi, toDelivery };
  }

  it('sends a bearer-key delivery call through the delivery Worker, stripped of ambient credentials', async () => {
    const { answeredBy, toDelivery } = await route(
      new Request(`${ORIGIN}/delivery/s1/main/entries`, {
        headers: {
          authorization: 'Bearer cda',
          cookie: '__Host-cw_session=secret',
          [PRINCIPAL_HEADER]: 'forged.value',
        },
      }),
    );
    expect(answeredBy).toBe('delivery');
    expect(toDelivery[0]?.headers.get('authorization')).toBe('Bearer cda');
    expect(toDelivery[0]?.headers.get('cookie')).toBeNull();
    expect(toDelivery[0]?.headers.get(PRINCIPAL_HEADER)).toBeNull();
  });

  it('keeps a signed-in session delivery call on the api, which trusts the signed principal', async () => {
    const { answeredBy, toApi } = await route(new Request(`${ORIGIN}/delivery/s1/main/live`));
    expect(answeredBy).toBe('api');
    expect(toApi[0]?.headers.get(PRINCIPAL_HEADER)).not.toBeNull();
  });

  it('keeps every other bearer call on the api, look-alike paths included', async () => {
    for (const path of ['/spaces/s1/environments/main/entries', '/deliveryx/s1', '/delivery']) {
      const { answeredBy } = await route(
        new Request(`${ORIGIN}${path}`, { headers: { authorization: 'Bearer cma' } }),
      );
      expect(answeredBy, path).toBe('api');
    }
  });

  it('falls back to the api when the delivery Worker is not bound', async () => {
    const { res, api } = await forward(
      new Request(`${ORIGIN}/delivery/s1/main/entries`, {
        headers: { authorization: 'Bearer cda' },
      }),
    );
    expect(res.status).toBe(200);
    expect(api.fetch).toHaveBeenCalledOnce();
  });
});

describe('principalKey', () => {
  it('uses the deployment’s key, never the dev key, when one is set', () => {
    expect(principalKey()).toBe(KEY);
    expect(principalKey()).not.toBe(DEV_PRINCIPAL_KEY);
  });
});
