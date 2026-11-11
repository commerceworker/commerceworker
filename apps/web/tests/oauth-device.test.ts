import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Too many failed attempts.');
  }
}
class TokenExpired extends Error {}

const kv = new Map<string, { value: string; metadata?: unknown }>();
const env = {
  PRINCIPAL_KEY: 'web-test-key',
  OAUTH_KV: {
    get: async (k: string, type?: string | { type?: string }) => {
      const v = kv.get(k)?.value ?? null;
      const json = type === 'json' || (typeof type === 'object' && type.type === 'json');
      return v && json ? JSON.parse(v) : v;
    },
    put: async (k: string, value: string, opts?: { metadata?: unknown }) => {
      kv.set(k, { value, metadata: opts?.metadata });
    },
    delete: async (k: string) => {
      kv.delete(k);
    },
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: [...kv]
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, v]) => ({ name, metadata: v.metadata })),
      list_complete: true,
    }),
  },
};
const grantPrincipal = vi.fn();
const apiPrincipal = vi.fn();
const engineFetch = vi.fn(async (_r: Request) => Response.json({ ok: true }));
const audit = vi.fn(async (..._a: unknown[]) => {});
const me = { kind: 'user', id: 'usr_1', name: 'Ann', email: 'ann@example.com', role: 'operator' };
const auth = {
  requireUser: vi.fn(async (): Promise<Record<string, unknown>> => me),
  stepUp: vi.fn(async (): Promise<string | null> => null),
  stepUpMethod: vi.fn(async () => 'password'),
};

vi.mock('cloudflare:workers', () => ({ env, WorkerEntrypoint: class {} }));
vi.mock('~/lib/env.server', () => ({
  engine: () => ({ fetch: engineFetch, dropA2aPushes: async () => ({ configs: 0 }) }),
}));
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));
vi.mock('~/lib/auth.server', () => ({
  ...auth,
  apiPrincipal,
  grantPrincipal,
  Throttled,
  TokenExpired,
  setupDue: () => null,
}));

const { apiOAuthFetch, isOAuthPath, oauthApi, oauthFetch } = await import('~/lib/oauth.server');
const { action, loader } = await import('~/routes/oauth-device');
const authorize = await import('~/routes/oauth-authorize');
const device = await import('~/lib/oauth-device.server');

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never;
const ORIGIN = 'https://app.test';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const form = (body: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});
const server = (path: string, init?: RequestInit) =>
  oauthFetch(new Request(`${ORIGIN}${path}`, init), env as never, ctx);

/** Registers the CLI as it does: the device grant, no redirect, no secret. */
async function registerCli() {
  const res = await server('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Terminal tool',
      grant_types: [GRANT, 'refresh_token'],
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

type Started = { device_code: string; user_code: string; [k: string]: unknown };
async function start(clientId: string, extra: Record<string, string> = {}) {
  const res = await server('/oauth/device_authorization', form({ client_id: clientId, ...extra }));
  return { res, body: (await res.json()) as Started };
}
const poll = async (clientId: string, deviceCode: string) => {
  const res = await server(
    '/oauth/token',
    form({ grant_type: GRANT, client_id: clientId, device_code: deviceCode }),
  );
  return { res, body: (await res.json()) as Record<string, string | number> };
};
const post = (body: Record<string, string>) =>
  action({
    request: new Request(`${ORIGIN}/oauth/device`, form(body)),
    params: {},
    context: {},
  } as never) as Promise<
    { data: Record<string, unknown>; init?: { status?: number } } | Record<string, unknown>
  >;
/** A react-router `data()` answer, or the plain object. */
const payload = (r: Awaited<ReturnType<typeof post>>) =>
  ('data' in r ? r.data : r) as Record<string, unknown> & { step: string };

/** A person enters the code, then approves. */
async function approve(userCode: string, role = 'viewer', extra: Record<string, string> = {}) {
  const found = payload(await post({ intent: 'lookup', user_code: userCode }));
  expect(found.step).toBe('confirm');
  return payload(
    await post({ intent: 'approve', id: found.id as string, user_code: userCode, role, ...extra }),
  );
}

let t = Date.parse('2026-11-10T12:00:00Z');
const later = (ms: number) => {
  t += ms;
  vi.setSystemTime(t);
};

beforeEach(() => {
  kv.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t);
  for (const f of [grantPrincipal, apiPrincipal, engineFetch, audit, ...Object.values(auth)])
    f.mockClear();
  grantPrincipal.mockResolvedValue(me);
  auth.requireUser.mockResolvedValue(me);
  auth.stepUp.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('a device code', () => {
  it('is asked for by a public client, with a short unambiguous code', async () => {
    const clientId = await registerCli();
    const { res, body } = await start(clientId);
    expect(res.status).toBe(200);
    expect(body.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    expect(body).toMatchObject({
      verification_uri: `${ORIGIN}/oauth/device`,
      verification_uri_complete: `${ORIGIN}/oauth/device?user_code=${body.user_code}`,
      expires_in: 600,
      interval: 5,
    });
    expect(body.device_code).toHaveLength(43);
    // Anyone on the internet can start one: that isn't an audit row.
    expect(audit).not.toHaveBeenCalled();
  });

  it('is stored hashed: neither the device code nor the user code is in the namespace', async () => {
    const { body } = await start(await registerCli());
    const everything = [...kv].map(([k, v]) => k + v.value).join('\n');
    expect(everything).not.toContain(body.device_code);
    expect(everything).not.toContain(body.user_code.replace('-', ''));
    expect(everything).not.toContain(body.user_code);
  });

  it('refuses admin, several roles and an unknown resource, and allows any of the three resources', async () => {
    const clientId = await registerCli();
    expect((await start(clientId, { scope: 'admin' })).body).toMatchObject({
      error: 'invalid_scope',
    });
    expect((await start(clientId, { scope: 'viewer operator' })).body).toMatchObject({
      error: 'invalid_scope',
    });
    expect((await start(clientId, { scope: 'nonsense' })).body).toMatchObject({
      error: 'invalid_scope',
    });
    expect((await start(clientId, { resource: 'https://evil.test/api/v1' })).body).toMatchObject({
      error: 'invalid_target',
    });
    expect((await start('nobody')).res.status).toBe(401);
    for (const path of ['/mcp', '/a2a', '/api/v1'])
      expect((await start(clientId, { resource: `${ORIGIN}${path}` })).res.status).toBe(200);
  });

  it('is only for clients that registered for the device grant', async () => {
    // A confidential client, and a public one that registered for the browser flow, are refused.
    const oauth = oauthApi(new Request(ORIGIN));
    const confidential = await oauth.createClient({ redirectUris: ['https://client.test/cb'] });
    const browser = await oauth.createClient({
      redirectUris: ['https://client.test/cb'],
      tokenEndpointAuthMethod: 'none',
    });
    for (const c of [confidential, browser])
      expect((await start(c.clientId)).body).toMatchObject({ error: 'unauthorized_client' });
    // Even one that names our device return address by itself: registration marks, not the URI.
    const mimic = await oauth.createClient({
      redirectUris: [device.DEVICE_REDIRECT],
      tokenEndpointAuthMethod: 'none',
    });
    expect((await start(mimic.clientId)).body).toMatchObject({ error: 'unauthorized_client' });
    expect(kv.size).toBeGreaterThan(0);
    expect(audit).not.toHaveBeenCalledWith(
      expect.anything(),
      'oauth.device.start',
      expect.anything(),
    );
  });

  it('is never for a client id that is a URL, so no publisher’s name can be borrowed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { res, body } = await start('https://well-known.example/client.json');
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_client' });
    // Not even looked up: nothing fetched, nothing stored.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect([...kv].filter(([k]) => k.startsWith('cmw_device:'))).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it('records where and when it was asked, for the person who approves it', async () => {
    const clientId = await registerCli();
    const request = new Request(
      `${ORIGIN}/oauth/device_authorization`,
      form({ client_id: clientId }),
    );
    Object.defineProperty(request, 'cf', {
      value: { city: 'Lyon', region: 'Auvergne-Rhone-Alpes', country: 'FR' },
    });
    const started = (await (await oauthFetch(request, env as never, ctx)).json()) as Started;
    const found = payload(await post({ intent: 'lookup', user_code: started.user_code }));
    expect(found.startedFrom).toEqual({
      ip: '203.0.113.7',
      place: 'Lyon, Auvergne-Rhone-Alpes, FR',
      at: new Date(t).toISOString(),
    });
    expect(found).not.toHaveProperty('publisher');
  });

  it('is only for POST', async () => {
    expect((await server('/oauth/device_authorization')).status).toBe(405);
  });
});

describe('polling a device code', () => {
  it('answers pending, then slow_down (and a longer interval) when polled too soon', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('authorization_pending');
    later(2_000);
    const fast = await poll(clientId, started.device_code);
    expect(fast.res.status).toBe(400);
    expect(fast.body).toMatchObject({ error: 'slow_down', interval: 10 });
    // The new interval holds: 5 seconds after the slow poll is still too soon.
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('slow_down');
    later(15_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('authorization_pending');
  });

  it('answers access_denied once, then nothing is left', async () => {
    const clientId = await registerCli();
    const startedAt = t;
    const { body: started } = await start(clientId, { scope: 'approver' });
    const found = payload(await post({ intent: 'lookup', user_code: started.user_code }));
    const denied = payload(
      await post({ intent: 'deny', id: found.id as string, user_code: started.user_code }),
    );
    expect(denied.step).toBe('denied');
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'oauth.device.deny', {
      actor: me,
      target: 'Terminal tool',
      detail: {
        clientId,
        resource: `${ORIGIN}/api/v1`,
        role: 'approver',
        startedAt: new Date(startedAt).toISOString(),
        startedFromIp: '203.0.113.7',
      },
    });
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('access_denied');
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('expired_token');
    // The code can no longer be entered either.
    expect(payload(await post({ intent: 'lookup', user_code: started.user_code })).step).toBe(
      'enter',
    );
  });

  it('answers expired_token after ten minutes, approved or not', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    const approved = await approve(started.user_code);
    expect(approved.step).toBe('approved');
    later(601_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('expired_token');
    const second = await start(clientId);
    later(601_000);
    expect(payload(await post({ intent: 'lookup', user_code: second.body.user_code })).step).toBe(
      'enter',
    );
  });

  it('does not tell another client anything, nor slow the owner down', async () => {
    const clientId = await registerCli();
    const other = await registerCli();
    const { body: started } = await start(clientId);
    later(5_000);
    for (let i = 0; i < 3; i++) {
      const { res, body } = await poll(other, started.device_code);
      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
    }
    expect((await poll(clientId, started.device_code)).body.error).toBe('authorization_pending');
    // Approved, the other client still gets no token.
    await approve(started.user_code);
    later(5_000);
    expect((await poll(other, started.device_code)).body.error).toBe('invalid_grant');
    expect((await poll(clientId, started.device_code)).res.status).toBe(200);
  });

  it('needs both a device code and a client', async () => {
    const res = await server('/oauth/token', form({ grant_type: GRANT, device_code: 'x' }));
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_request' });
  });
});

describe('an approved device code', () => {
  /** Signs a terminal in end to end and returns its tokens. */
  async function signIn(extra: Record<string, string> = {}, role = 'viewer') {
    const clientId = await registerCli();
    const { body: started } = await start(clientId, extra);
    const approved = await approve(started.user_code, role);
    expect(approved).toMatchObject({ step: 'approved', app: 'Terminal tool', role });
    later(5_000);
    const { res, body } = await poll(clientId, started.device_code);
    expect(res.status).toBe(200);
    return { clientId, started, tokens: body as Record<string, string> };
  }

  it('ends in a token that works at /api/v1', async () => {
    const { clientId, tokens } = await signIn();
    expect(tokens).toMatchObject({
      token_type: 'bearer',
      scope: 'viewer',
      resource: `${ORIGIN}/api/v1`,
    });
    expect(tokens.refresh_token).toBeTruthy();
    const run = vi.fn(async (_c: unknown) => Response.json({ ran: true }));
    const res = await apiOAuthFetch(
      new Request(`${ORIGIN}/api/v1/me`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      env as never,
      ctx,
      run,
    );
    expect(res.status).toBe(200);
    expect(run.mock.calls[0]![0]).toMatchObject({
      id: 'usr_1',
      client: clientId,
      resource: `${ORIGIN}/api/v1`,
    });
    expect(audit).toHaveBeenCalledWith(expect.any(Request), 'oauth.device.approve', {
      actor: me,
      target: 'Terminal tool',
      detail: {
        clientId,
        resource: `${ORIGIN}/api/v1`,
        role: 'viewer',
        startedAt: expect.any(String),
        startedFromIp: '203.0.113.7',
      },
    });
  });

  it('is on the Account page like any grant, and ends when the person revokes it', async () => {
    const { clientId, tokens } = await signIn();
    const oauth = oauthApi(new Request(ORIGIN));
    const grants = await oauth.listUserGrants('usr_1');
    expect(grants.items).toHaveLength(1);
    expect(grants.items[0]).toMatchObject({
      clientId,
      metadata: { app: 'Terminal tool', channel: 'API', via: 'device' },
    });
    await oauth.revokeGrant(grants.items[0]!.id, 'usr_1');
    const run = vi.fn(async () => Response.json({}));
    const res = await apiOAuthFetch(
      new Request(`${ORIGIN}/api/v1/me`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      env as never,
      ctx,
      run,
    );
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('is redeemed once: a second poll finds it spent, and tokens are never issued twice', async () => {
    const { clientId, started } = await signIn();
    later(5_000);
    const again = await poll(clientId, started.device_code);
    expect(again.res.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('can’t be redeemed from the stored authorization code without the device code', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    await approve(started.user_code);
    const record = [...kv].find(([k]) => k.startsWith('cmw_device_decision:'))![1];
    const stored = JSON.parse(record.value) as { code: string; redirectUri: string };
    expect(stored.code).toBeTruthy();
    // Someone who reads the namespace holds the code and the challenge, but not the verifier.
    const res = await server(
      '/oauth/token',
      form({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: stored.code,
        redirect_uri: stored.redirectUri,
        code_verifier: 'a'.repeat(43),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rotates its refresh token, and revokes the grant when an old one comes back', async () => {
    const { clientId, tokens } = await signIn();
    const refresh = async (token: string) =>
      server(
        '/oauth/token',
        form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token }),
      );
    const first = await refresh(tokens.refresh_token!);
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as { refresh_token: string; access_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    // Past the grace for a lost response, the old token is a stolen copy.
    later(120_000);
    const replay = await refresh(tokens.refresh_token!);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
  });

  it('holds for the resource it was approved for, and no other', async () => {
    const { tokens: api } = await signIn();
    const mcp = (await signIn({ resource: `${ORIGIN}/mcp` })).tokens;
    expect(mcp.resource).toBe(`${ORIGIN}/mcp`);
    const call = (path: string, token: string) =>
      server(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await call('/mcp', api.access_token!)).status).toBe(401);
    expect((await call('/a2a', api.access_token!)).status).toBe(401);
    expect(engineFetch).not.toHaveBeenCalled();
    expect((await call('/mcp', mcp.access_token!)).status).toBe(200);
    const run = vi.fn(async () => Response.json({}));
    const atApi = await apiOAuthFetch(
      new Request(`${ORIGIN}/api/v1/me`, {
        headers: { authorization: `Bearer ${mcp.access_token}` },
      }),
      env as never,
      ctx,
      run,
    );
    expect(atApi.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('hands out tokens to one of two polls that arrive together', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    await approve(started.user_code);
    later(5_000);
    const both = await Promise.all([
      poll(clientId, started.device_code),
      poll(clientId, started.device_code),
    ]);
    expect(both.map((p) => p.res.status).sort()).toEqual([200, 400]);
    expect(both.find((p) => p.res.status === 400)!.body.error).toBe('invalid_grant');
  });

  it('can’t be asked at the token endpoint for another resource', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    await approve(started.user_code);
    later(5_000);
    const res = await server(
      '/oauth/token',
      form({
        grant_type: GRANT,
        client_id: clientId,
        device_code: started.device_code,
        resource: `${ORIGIN}/mcp`,
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('approving', () => {
  it('offers no role above the person’s own or above what the terminal asked for', async () => {
    const clientId = await registerCli();
    auth.requireUser.mockResolvedValue({ ...me, role: 'approver' });
    const { body: wantsOperator } = await start(clientId, { scope: 'operator' });
    const found = payload(await post({ intent: 'lookup', user_code: wantsOperator.user_code }));
    expect(found).toMatchObject({ requested: 'operator', roles: ['viewer', 'approver'] });
    auth.requireUser.mockResolvedValue(me);
    const { body: wantsViewer } = await start(clientId);
    expect(
      payload(await post({ intent: 'lookup', user_code: wantsViewer.user_code })).roles,
    ).toEqual(['viewer']);
  });

  it('refuses a role above the approver’s own, and leaves the code pending', async () => {
    const clientId = await registerCli();
    auth.requireUser.mockResolvedValue({ ...me, role: 'viewer' });
    const { body: started } = await start(clientId, { scope: 'operator' });
    const refused = await approve(started.user_code, 'operator');
    expect(refused).toMatchObject({
      step: 'confirm',
      error: expect.stringContaining('role you have'),
    });
    for (const role of ['admin', 'owner'])
      expect((await approve(started.user_code, role)).step).toBe('confirm');
    expect(kv.size).toBeGreaterThan(0);
    expect(audit).not.toHaveBeenCalledWith(
      expect.anything(),
      'oauth.device.approve',
      expect.anything(),
    );
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('authorization_pending');
  });

  it('never gives more than the terminal asked for', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId, { scope: 'viewer' });
    expect((await approve(started.user_code, 'operator')).step).toBe('confirm');
  });

  it('asks for a step-up above viewer, and burns the code after repeated wrong answers', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId, { scope: 'operator' });
    auth.stepUp.mockResolvedValue('Your password is not right.');
    for (let i = 0; i < 4; i++)
      expect(await approve(started.user_code, 'operator', { password: 'no' })).toMatchObject({
        step: 'confirm',
        error: 'Your password is not right.',
      });
    expect(audit).toHaveBeenCalledWith(
      expect.any(Request),
      'auth.step_up_failed',
      expect.anything(),
    );
    const fifth = await approve(started.user_code, 'operator', { password: 'no' });
    expect(fifth).toMatchObject({
      step: 'enter',
      error: expect.stringContaining('Too many wrong answers'),
    });
    // Burned: even the right answer finds nothing.
    auth.stepUp.mockResolvedValue(null);
    const found = payload(await post({ intent: 'lookup', user_code: started.user_code }));
    expect(found.step).toBe('enter');
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('access_denied');
  });

  it('asks for a step-up on every approval, viewer included, and never on a denial', async () => {
    const clientId = await registerCli();
    expect((await approve((await start(clientId)).body.user_code, 'viewer')).step).toBe('approved');
    expect(auth.stepUp).toHaveBeenCalledOnce();
    // A wrong answer for a viewer approval approves nothing.
    auth.stepUp.mockResolvedValue('Your password is not right.');
    const { body: second } = await start(clientId);
    expect((await approve(second.user_code, 'viewer')).step).toBe('confirm');
    later(5_000);
    expect((await poll(clientId, second.device_code)).body.error).toBe('authorization_pending');
    auth.stepUp.mockClear();
    const found = payload(await post({ intent: 'lookup', user_code: second.user_code }));
    await post({ intent: 'deny', id: found.id as string, user_code: second.user_code });
    expect(auth.stepUp).not.toHaveBeenCalled();
  });

  it('doesn’t act from a verification link, nor even read its code', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    const res = (await loader({
      request: new Request(`${ORIGIN}/oauth/device?user_code=${started.user_code.toLowerCase()}`),
      params: {},
      context: {},
    } as never)) as unknown as { data: Record<string, unknown> };
    // The link's code is neither read nor echoed: the person types it from the terminal.
    expect(res.data).toEqual({ host: 'app.test', fromLink: true, who: 'ann@example.com' });
    // Nothing was decided, and nothing was looked up.
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('authorization_pending');
    expect(audit).not.toHaveBeenCalledWith(
      expect.anything(),
      'oauth.device.approve',
      expect.anything(),
    );
  });
});

describe('guessing a user code', () => {
  it('locks a person out after ten wrong codes, even for a right one', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    for (let i = 0; i < 10; i++)
      expect(
        payload(await post({ intent: 'lookup', user_code: `BBBB-BBB${(i % 8) + 2}` })).step,
      ).toBe('enter');
    const locked = payload(await post({ intent: 'lookup', user_code: started.user_code }));
    expect(locked.step).toBe('enter');
    expect(locked.error).toContain('Too many wrong codes');
    // Someone else is not locked out by it.
    auth.requireUser.mockResolvedValue({ ...me, id: 'usr_2' });
    expect(payload(await post({ intent: 'lookup', user_code: started.user_code })).step).toBe(
      'confirm',
    );
  });

  it('accepts the code however it is typed', () => {
    expect(device.normalizeUserCode('bcdf 2345')).toBe('BCDF2345');
    expect(device.normalizeUserCode('BCDF-2345')).toBe('BCDF2345');
    for (const bad of ['', 'BCDF-234', 'BCDF-23456', 'AEIO-2345', 'BCDF-0123', 'BCDF-2345!'])
      expect(device.normalizeUserCode(bad)).toBeNull();
  });

  it('counts each miss in the rate-limit budget when there is one', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    Object.assign(env, { OAUTH_TOKEN_LIMIT: { limit } });
    try {
      const r = payload(await post({ intent: 'lookup', user_code: 'BCDF-2345' }));
      expect(r.error).toContain('Too many codes');
      expect(limit).toHaveBeenCalledWith({ key: 'device-entry:usr_1' });
    } finally {
      delete (env as { OAUTH_TOKEN_LIMIT?: unknown }).OAUTH_TOKEN_LIMIT;
    }
  });
});

describe('discovery and registration', () => {
  it('names the device endpoint and grant in the server metadata', async () => {
    const meta = (await (await server('/.well-known/oauth-authorization-server')).json()) as {
      device_authorization_endpoint: string;
      grant_types_supported: string[];
      token_endpoint: string;
    };
    expect(meta.device_authorization_endpoint).toBe(`${ORIGIN}/oauth/device_authorization`);
    expect(meta.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token', GRANT]),
    );
    expect(meta.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
  });

  it('serves the endpoint from the OAuth server and the page from the app', () => {
    expect(isOAuthPath('/oauth/device_authorization')).toBe(true);
    expect(isOAuthPath('/oauth/device')).toBe(false);
    expect(isOAuthPath('/oauth/device.data')).toBe(false);
  });

  it('registers a device client for the browserless return address, never one of ours', async () => {
    const res = await server('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_types: [GRANT], token_endpoint_auth_method: 'none' }),
    });
    const body = (await res.json()) as { redirect_uris: string[]; grant_types: string[] };
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body.redirect_uris).toEqual([device.DEVICE_REDIRECT]);
    expect(body.redirect_uris.join()).not.toContain(ORIGIN);
  });

  it('refuses that return address on the ordinary consent page', async () => {
    const clientId = await registerCli();
    const consent = (redirectUri: string) =>
      authorize.loader({
        request: new Request(
          `${ORIGIN}/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: 'c'.repeat(43),
            code_challenge_method: 'S256',
            state: 's',
          })}`,
        ),
        params: {},
        context: {},
      } as never) as unknown as Promise<{ data: { error: string }; init: { status: number } }>;
    const refused = await consent(device.DEVICE_REDIRECT);
    expect(refused.init.status).toBe(400);
    expect(refused.data.error).toContain('code from a terminal');
    expect(JSON.stringify([...kv])).not.toContain('cmw_consent');
  });
});

describe('the first-party CLI client', () => {
  it('signs in without registering, as an official, device-only client', async () => {
    const { res, body } = await start(device.CLI_CLIENT_ID);
    expect(res.status).toBe(200);
    const found = payload(await post({ intent: 'lookup', user_code: body.user_code }));
    expect(found).toMatchObject({
      official: true,
      app: 'CommerceWorker CLI',
      clientId: 'commerceworker-cli',
    });
    // Seeded once, and left as it was on later starts.
    const before = kv.get('client:commerceworker-cli')!.value;
    later(1_000);
    await start(device.CLI_CLIENT_ID);
    expect(kv.get('client:commerceworker-cli')!.value).toBe(before);
    expect(JSON.parse(before)).toMatchObject({
      tokenEndpointAuthMethod: 'none',
      redirectUris: [device.DEVICE_REDIRECT],
    });
    // The token it gets works like any device grant's.
    expect((await approve(body.user_code)).step).toBe('approved');
    later(5_000);
    expect((await poll(device.CLI_CLIENT_ID, body.device_code)).res.status).toBe(200);
  });

  it('is never a browser app: the consent page refuses its only return address', async () => {
    await start(device.CLI_CLIENT_ID);
    const refused = (await authorize.loader({
      request: new Request(
        `${ORIGIN}/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: device.CLI_CLIENT_ID,
          redirect_uri: device.DEVICE_REDIRECT,
          code_challenge: 'c'.repeat(43),
          code_challenge_method: 'S256',
        })}`,
      ),
      params: {},
      context: {},
    } as never)) as unknown as { init: { status: number } };
    expect(refused.init.status).toBe(400);
  });

  it('is advertised in the metadata so the CLI needs no registration', async () => {
    const meta = (await (await server('/.well-known/oauth-authorization-server')).json()) as {
      commerceworker_cli_client_id: string;
    };
    expect(meta.commerceworker_cli_client_id).toBe('commerceworker-cli');
  });

  it('is not imitated: names like it are refused at registration, and others are unverified', async () => {
    const register = (client_name: string) =>
      server('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name,
          grant_types: [GRANT],
          token_endpoint_auth_method: 'none',
        }),
      });
    for (const name of [
      'CommerceWorker CLI',
      'commerceworker CLI',
      'Commerce-Worker  Cli',
      'CommerceWorker Official',
      'C0mmerceW0rker CL1',
      'Cömmérceworker Terminal',
      'The official CommerceWorker CLI (beta)',
    ])
      expect((await register(name)).status, name).toBe(400);
    // The same for a browser-flow registration, and a name that merely mentions us is fine.
    const browser = await server('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'CommerceWorker CLI',
        redirect_uris: ['https://a.test/cb'],
      }),
    });
    expect(browser.status).toBe(400);
    expect(((await browser.json()) as { error: string }).error).toBe('invalid_client_metadata');
    expect((await register('Acme connector for CommerceWorker')).status).toBe(201);
    // A self-registered client is shown unverified, with its id.
    const clientId = await registerCli();
    const { body } = await start(clientId);
    const found = payload(await post({ intent: 'lookup', user_code: body.user_code }));
    expect(found).toMatchObject({ official: false, clientId });
  });
});

describe('races and failing closed', () => {
  it('keeps an approval that lands between a poll’s read and its write', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    const found = payload(await post({ intent: 'lookup', user_code: started.user_code }));
    later(5_000);
    // The poll has read the record as pending; the person approves; then the poll writes back.
    const put = env.OAUTH_KV.put;
    let landed = false;
    env.OAUTH_KV.put = async (k: string, v: string, o?: { metadata?: unknown }) => {
      if (!landed && k.startsWith('cmw_device:')) {
        landed = true;
        await approve(started.user_code);
      }
      return put(k, v, o);
    };
    try {
      expect((await poll(clientId, started.device_code)).body.error).toBe('authorization_pending');
    } finally {
      env.OAUTH_KV.put = put;
    }
    expect(landed).toBe(true);
    expect(found.step).toBe('confirm');
    later(5_000);
    const { res, body } = await poll(clientId, started.device_code);
    expect(res.status).toBe(200);
    expect(body.access_token).toBeTruthy();
  });

  it('keeps a denial that lands the same way', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId);
    const found = payload(await post({ intent: 'lookup', user_code: started.user_code }));
    later(5_000);
    const put = env.OAUTH_KV.put;
    let landed = false;
    env.OAUTH_KV.put = async (k: string, v: string, o?: { metadata?: unknown }) => {
      if (!landed && k.startsWith('cmw_device:')) {
        landed = true;
        await post({ intent: 'deny', id: found.id as string, user_code: started.user_code });
      }
      return put(k, v, o);
    };
    try {
      await poll(clientId, started.device_code);
    } finally {
      env.OAUTH_KV.put = put;
    }
    later(5_000);
    expect((await poll(clientId, started.device_code)).body.error).toBe('access_denied');
  });

  it('refuses code entry when the rate limiter is not bound, outside local development', async () => {
    vi.stubEnv('DEV', false);
    try {
      const r = payload(await post({ intent: 'lookup', user_code: 'BCDF-2345' }));
      expect(r.step).toBe('enter');
      expect(r.error).toContain('Too many codes');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the token request after approval', () => {
  it('refuses a confidential client that registered with the device grant, at start', async () => {
    const res = await server('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Server app', grant_types: [GRANT] }),
    });
    const { client_id } = (await res.json()) as { client_id: string; client_secret?: string };
    const started = await start(client_id);
    expect(started.body).toMatchObject({ error: 'unauthorized_client' });
  });

  it('can’t be widened at the poll: asking for more than was granted is invalid_scope', async () => {
    const clientId = await registerCli();
    const { body: started } = await start(clientId, { scope: 'operator' });
    await approve(started.user_code, 'viewer');
    later(5_000);
    const res = await server(
      '/oauth/token',
      form({
        grant_type: GRANT,
        client_id: clientId,
        device_code: started.device_code,
        scope: 'operator',
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
  });
});
