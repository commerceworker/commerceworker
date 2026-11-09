import { addMember, createRole, createSpace, updateMember } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { principalTarget, signPrincipal } from '@commerceworker/security/principal';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import { wire } from './wire';

const SESSION_SECRET = 's'.repeat(40);
/** The key the web Worker signs `x-cw-principal` with (PRINCIPAL_KEY). */
const PRINCIPAL_KEY = 'p'.repeat(40);
const ISSUER = 'https://cms.example.com';

const config = {
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  sessionSecret: SESSION_SECRET,
  principalKeys: [PRINCIPAL_KEY],
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
  oauthIssuer: ISSUER,
  oauthAccessTokenTtlSeconds: 3600,
  oauthRefreshTokenTtlSeconds: 2592000,
} as unknown as ApiConfig;

type App = ReturnType<typeof createApp>;

/**
 * Boots the app and returns it alongside the store context, for seeding. Requests carrying a
 * `Cookie: principal:<json>` stand-in (see {@link sessionCookie}) get it swapped for what the web
 * Worker's gateway sends for a signed-in person: an `x-cw-principal` signed for that exact path.
 */
function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  const request = app.request.bind(app);
  app.request = (async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const cookie = headers.get('cookie');
    if (cookie?.startsWith('principal:')) {
      headers.delete('cookie');
      const person = JSON.parse(cookie.slice('principal:'.length));
      const path = new URL(input, 'http://localhost').pathname;
      const target = principalTarget(init.method ?? 'GET', path);
      headers.set('x-cw-principal', await signPrincipal(PRINCIPAL_KEY, person, target));
    }
    return request(input, { ...init, headers });
  }) as typeof app.request;
  return { app, ctx: wired.ctx };
}

/** Registers a public client the way an MCP client would, over HTTP. */
async function register(app: App, body: Record<string, unknown> = {}) {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Client',
      redirect_uris: ['https://client.example.com/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
      ...body,
    }),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

/**
 * A signed-in person on space s1's team with a role holding `scopes`: returned as the stand-in
 * makeApp turns into a signed `x-cw-principal` per request.
 */
async function sessionCookie(
  ctx: ReturnType<typeof makeApp>['ctx'],
  scopes: readonly string[] = [SCOPES.deliveryRead, SCOPES.previewRead, SCOPES.searchRead],
) {
  const role = await createRole(ctx, 's1', {
    name: `editor-${scopes.length}-${Math.random()}`,
    scopes: [...scopes],
  });
  const existing = (await ctx.store.members.list('s1')).find(
    (m) => m.email === 'admin@example.com',
  );
  if (existing) await updateMember(ctx, 's1', existing.id, { role: role.id }, { sso: true });
  else await addMember(ctx, 's1', { email: 'admin@example.com', name: 'Admin', role: role.id });
  return `principal:${JSON.stringify({ sub: 'usr_admin', email: 'admin@example.com', name: 'Admin', role: 'member' })}`;
}

const VERIFIER = 'v'.repeat(64);
// S256 of VERIFIER, computed the same way the server does.
const CHALLENGE = await import('node:crypto').then((c) =>
  c.createHash('sha256').update(VERIFIER).digest('base64url'),
);

function authorizeUrl(clientId: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://client.example.com/cb',
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'abc',
    ...extra,
  });
  return `/oauth/authorize?${params}`;
}

/** Pulls the hidden form fields out of the rendered consent page. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out[m[1] as string] = (m[2] as string)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return out;
}

/** Runs register → authorize → consent → token, returning the token response. */
async function fullFlow(app: App, cookie: string) {
  const { body: client } = await register(app);
  const clientId = client.client_id as string;

  const consent = await app.request(authorizeUrl(clientId), { headers: { Cookie: cookie } });
  const fields = hiddenFields(await consent.text());

  const decision = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
  });
  const code = new URL(decision.headers.get('location') as string).searchParams.get(
    'code',
  ) as string;

  const token = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'https://client.example.com/cb',
      code_verifier: VERIFIER,
    }).toString(),
  });
  return { clientId, tokenRes: token, tokens: (await token.json()) as Record<string, string> };
}

describe('OAuth discovery metadata', () => {
  it('publishes authorization server metadata pointing at real endpoints', async () => {
    const { app } = makeApp();
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    // OAuth 2.1: S256 only, code only.
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.response_types_supported).toEqual(['code']);
  });

  it('publishes protected resource metadata naming this authorization server', async () => {
    const { app } = makeApp();
    const res = await app.request('/.well-known/oauth-protected-resource');
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.resource).toBe(`${ISSUER}/mcp`);
    expect(meta.authorization_servers).toEqual([ISSUER]);
  });

  it('does not mount the authorization server when no issuer is configured', async () => {
    const wired = wire({ ...config, oauthIssuer: undefined } as ApiConfig);
    const app = createApp(
      wired.ctx,
      { ...config, oauthIssuer: undefined } as ApiConfig,
      wired.rag,
      wired.blob,
      wired.ai,
      inMemoryEdge(),
    );
    expect((await app.request('/.well-known/oauth-authorization-server')).status).toBe(404);
    expect((await app.request('/oauth/token', { method: 'POST' })).status).toBe(404);
  });
});

describe('OAuth dynamic client registration over HTTP', () => {
  it('registers a client and echoes RFC 7591 fields', async () => {
    const { app } = makeApp();
    const { res, body } = await register(app);
    expect(res.status).toBe(201);
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.redirect_uris).toEqual(['https://client.example.com/cb']);
  });

  it('returns an OAuth error envelope, not the generic API one', async () => {
    const { app } = makeApp();
    const { res, body } = await register(app, { redirect_uris: ['http://evil.example.com/cb'] });
    expect(res.status).toBe(400);
    // `{error, error_description}` — flat, per RFC, not `{error:{code,message}}`.
    expect(body.error).toBe('invalid_redirect_uri');
    expect(typeof body.error_description).toBe('string');
  });
});

describe('OAuth authorization endpoint', () => {
  let app: App;
  let ctx: ReturnType<typeof makeApp>['ctx'];

  beforeEach(async () => {
    const made = makeApp();
    app = made.app;
    ctx = made.ctx;
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(() => {});
  });

  it('redirects a signed-out person to sign-in, preserving the request', async () => {
    const { body: client } = await register(app);
    const res = await app.request(authorizeUrl(client.client_id as string));
    expect(res.status).toBe(302);
    const location = res.headers.get('location') as string;
    expect(location.startsWith('/login?next=')).toBe(true);
    expect(decodeURIComponent(location)).toContain('/oauth/authorize?');
  });

  it('renders a consent screen naming the client and the scopes', async () => {
    const cookie = await sessionCookie(ctx);
    const { body: client } = await register(app);
    const res = await app.request(authorizeUrl(client.client_id as string), {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Test Client');
    expect(html).toContain('Read published content');
    expect(html).toContain('admin@example.com');
    // Under no-referrer a browser posts the consent form with `Origin: null`, which the web
    // gateway treats as cross-site and so forwards without the session: approval could never
    // succeed. same-origin keeps the Origin on the form post and still sends nothing elsewhere.
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('escapes a hostile client name rather than rendering it as markup', async () => {
    const cookie = await sessionCookie(ctx);
    // Registration is unauthenticated, so client_name is attacker-controlled.
    const { body: client } = await register(app, {
      client_name: '<img src=x onerror=alert(1)>',
    });
    const res = await app.request(authorizeUrl(client.client_id as string), {
      headers: { Cookie: cookie },
    });
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('refuses an unregistered redirect_uri without redirecting to it', async () => {
    const cookie = await sessionCookie(ctx);
    const { body: client } = await register(app);
    const res = await app.request(
      authorizeUrl(client.client_id as string, {
        redirect_uri: 'https://attacker.example.com/cb',
      }),
      { headers: { Cookie: cookie } },
    );
    // Must be a rendered error, never a 302 — otherwise this is an open redirect.
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('rejects a consent POST whose fields were tampered with', async () => {
    const cookie = await sessionCookie(ctx);
    const { body: client } = await register(app);
    const consent = await app.request(authorizeUrl(client.client_id as string), {
      headers: { Cookie: cookie },
    });
    const fields = hiddenFields(await consent.text());

    const res = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...fields,
        // Swap in a scope the human never saw on the consent screen.
        scope: `${fields.scope} ${SCOPES.spaceAdmin}`,
        decision: 'approve',
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>).error).toBe('invalid_request');
  });

  it('refuses a consent form signed for one person when another posts it', async () => {
    // The signature binds the person it was rendered for: another member who obtains the form
    // can't approve with it, even for a space they are on themselves.
    const cookie = await sessionCookie(ctx);
    const role = await createRole(ctx, 's1', { name: 'other', scopes: [SCOPES.deliveryRead] });
    await addMember(ctx, 's1', { email: 'other@example.com', name: 'Other', role: role.id });
    const other = `principal:${JSON.stringify({ sub: 'usr_other', email: 'other@example.com', name: 'Other', role: 'member' })}`;
    const { body: client } = await register(app);
    const consent = await app.request(authorizeUrl(client.client_id as string), {
      headers: { Cookie: cookie },
    });
    const fields = hiddenFields(await consent.text());

    const res = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: other, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
    });
    expect(res.status).toBe(400);
    const refused = (await res.json()) as Record<string, string>;
    expect(refused.error).toBe('invalid_request');
    expect(refused.error_description).toContain('no longer valid');
  });

  it('rejects a consent form submitted after it expired', async () => {
    const cookie = await sessionCookie(ctx);
    const { body: client } = await register(app);
    const consent = await app.request(authorizeUrl(client.client_id as string), {
      headers: { Cookie: cookie },
    });
    const fields = hiddenFields(await consent.text());
    const later = Date.now() + 11 * 60_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const res = await app.request('/oauth/authorize', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, string>).error).toBe('invalid_request');
    } finally {
      now.mockRestore();
    }
  });

  it('rejects a consent POST with no session', async () => {
    const cookie = await sessionCookie(ctx);
    const { body: client } = await register(app);
    const consent = await app.request(authorizeUrl(client.client_id as string), {
      headers: { Cookie: cookie },
    });
    const fields = hiddenFields(await consent.text());
    const res = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
    });
    expect(res.status).toBe(401);
  });

  it('redirects with access_denied when the human declines', async () => {
    const cookie = await sessionCookie(ctx);
    const { body: client } = await register(app);
    const consent = await app.request(authorizeUrl(client.client_id as string), {
      headers: { Cookie: cookie },
    });
    const fields = hiddenFields(await consent.text());
    const res = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'deny' }).toString(),
    });
    const location = new URL(res.headers.get('location') as string);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('abc');
  });
});

describe('OAuth token endpoint', () => {
  let app: App;
  let ctx: ReturnType<typeof makeApp>['ctx'];

  beforeEach(async () => {
    const made = makeApp();
    app = made.app;
    ctx = made.ctx;
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(() => {});
  });

  it('completes the full flow and the token works on the delivery API', async () => {
    const cookie = await sessionCookie(ctx);
    const { tokenRes, tokens } = await fullFlow(app, cookie);
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('cache-control')).toBe('no-store');
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.refresh_token).toBeTruthy();

    // The point of the whole exercise: the minted token authenticates.
    const delivery = await app.request('/delivery/s1/main/entries', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(delivery.status).toBe(200);
  });

  it('does not grant management access when the human only holds read scopes', async () => {
    const cookie = await sessionCookie(ctx);
    const { tokens } = await fullFlow(app, cookie);
    const res = await app.request('/spaces/s1/environments/main/entries', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contentTypeApiId: 'article', fields: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unsupported grant type', async () => {
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password' }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>).error).toBe('unsupported_grant_type');
  });

  it('rejects a code redeemed without its verifier', async () => {
    const cookie = await sessionCookie(ctx);
    const { body: client } = await register(app);
    const clientId = client.client_id as string;
    const consent = await app.request(authorizeUrl(clientId), { headers: { Cookie: cookie } });
    const fields = hiddenFields(await consent.text());
    const decision = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
    });
    const code = new URL(decision.headers.get('location') as string).searchParams.get(
      'code',
    ) as string;

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>).error).toBe('invalid_request');
  });

  it('refreshes and then revokes, killing the access token', async () => {
    const cookie = await sessionCookie(ctx);
    const { clientId, tokens } = await fullFlow(app, cookie);

    const refreshed = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token as string,
      }).toString(),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Record<string, string>;

    const revoked = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: next.refresh_token as string }).toString(),
    });
    expect(revoked.status).toBe(200);

    const after = await app.request('/delivery/s1/main/entries', {
      headers: { Authorization: `Bearer ${next.access_token}` },
    });
    expect(after.status).toBe(401);
  });
});

describe('Personal access tokens', () => {
  it('mints a token for the person asking that authenticates on the delivery API', async () => {
    const { app, ctx } = makeApp();
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(() => {});
    const cookie = await sessionCookie(ctx, [
      SCOPES.spaceAdmin,
      SCOPES.deliveryRead,
      SCOPES.searchRead,
    ]);
    const res = await app.request('/spaces/s1/personal-access-tokens', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ci', scopes: [SCOPES.deliveryRead, SCOPES.searchRead] }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { token: string };
    expect(created.token.startsWith('cwpat_')).toBe(true);

    const delivery = await app.request('/delivery/s1/main/entries', {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(delivery.status).toBe(200);
  });

  it('refuses to mint one for a key or the admin token: a personal token belongs to a person', async () => {
    const { app } = makeApp();
    const res = await app.request('/spaces/s1/personal-access-tokens', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ci', scopes: [SCOPES.deliveryRead] }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses to let an OAuth token mint a longer-lived credential than itself', async () => {
    const { app, ctx } = makeApp();
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(() => {});
    // Give the approver space:admin so the request clears requireScope and the
    // refusal is provably about delegation, not about a missing scope.
    const cookie = await sessionCookie(ctx, [SCOPES.spaceAdmin, SCOPES.deliveryRead]);
    const { tokens } = await fullFlow(app, cookie);

    const res = await app.request('/spaces/s1/personal-access-tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'escalate', scopes: [SCOPES.deliveryRead] }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses to let a personal access token mint an API key or widen one, unlike the person', async () => {
    const { app, ctx } = makeApp();
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(() => {});
    const cookie = await sessionCookie(ctx, [SCOPES.spaceAdmin, SCOPES.deliveryRead]);
    const minted = await app.request('/spaces/s1/personal-access-tokens', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ci', scopes: [SCOPES.spaceAdmin], expiresInDays: 7 }),
    });
    const { token } = (await minted.json()) as { token: string };
    const as = (headers: Record<string, string>) => ({
      ...headers,
      'Content-Type': 'application/json',
    });
    const mint = (headers: Record<string, string>) =>
      app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: as(headers),
        body: JSON.stringify({ kind: 'cma', name: 'forever' }),
      });

    const refused = await mint({ Authorization: `Bearer ${token}` });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain("can't mint an API key");
    // The person who holds the same scopes, signed in, still can.
    const byPerson = await mint({ Cookie: cookie });
    expect(byPerson.status).toBe(201);
    const { id } = (await byPerson.json()) as { id: string };
    await app.request(`/spaces/s1/api-keys/${id}/role`, {
      method: 'PUT',
      headers: as({ Cookie: cookie }),
      body: JSON.stringify({ role: 'viewer' }),
    });
    const widen = await app.request(`/spaces/s1/api-keys/${id}/role`, {
      method: 'PUT',
      headers: as({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(widen.status).toBe(403);
    // Nor through the role the key holds, nor by minting another personal access token.
    await app.request(`/spaces/s1/api-keys/${id}/role`, {
      method: 'PUT',
      headers: as({ Cookie: cookie }),
      body: JSON.stringify({ role: null }),
    });
    const role = (await (
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: as({ Cookie: cookie }),
        body: JSON.stringify({ name: 'Build', scopes: [SCOPES.deliveryRead] }),
      })
    ).json()) as { id: string };
    await app.request(`/spaces/s1/api-keys/${id}/role`, {
      method: 'PUT',
      headers: as({ Cookie: cookie }),
      body: JSON.stringify({ role: role.id }),
    });
    const widenRole = await app.request(`/spaces/s1/roles/${role.id}`, {
      method: 'PUT',
      headers: as({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify({ name: 'Build', scopes: [SCOPES.deliveryRead, SCOPES.spaceAdmin] }),
    });
    expect(widenRole.status).toBe(403);
    const patFromPat = await app.request('/spaces/s1/personal-access-tokens', {
      method: 'POST',
      headers: as({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify({ name: 'forever', scopes: [SCOPES.spaceAdmin] }),
    });
    expect(patFromPat.status).toBe(403);
  });

  it('drops scopes the caller does not hold', async () => {
    const { app, ctx } = makeApp();
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(() => {});
    const cookie = await sessionCookie(ctx, [SCOPES.spaceAdmin, SCOPES.deliveryRead]);
    const res = await app.request('/spaces/s1/personal-access-tokens', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ci',
        scopes: [SCOPES.deliveryRead, SCOPES.contentPublish],
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, string>;

    // content:publish was requested but not held, so it is not granted.
    const publish = await app.request('/spaces/s1/environments/main/entries', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentTypeApiId: 'article', fields: {} }),
    });
    expect(publish.status).toBe(403);
  });
});

describe('OAuth device flow over HTTP', () => {
  it('starts, is approved by a human, and completes', async () => {
    const { app, ctx } = makeApp();
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' }).catch(() => {});
    const cookie = await sessionCookie(ctx);

    const { body: client } = await register(app, {
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
      redirect_uris: [],
    });
    const clientId = client.client_id as string;

    const started = await app.request('/oauth/device_authorization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId }).toString(),
    });
    const device = (await started.json()) as Record<string, string>;
    expect(device.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Polling before approval is normal, and must say so precisely.
    const pending = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: device.device_code as string,
      }).toString(),
    });
    expect(((await pending.json()) as Record<string, string>).error).toBe('authorization_pending');

    // The human opens the verification URL and approves.
    const confirm = await app.request(
      `/oauth/device?user_code=${encodeURIComponent(device.user_code as string)}`,
      { headers: { Cookie: cookie } },
    );
    const fields = hiddenFields(await confirm.text());
    const approved = await app.request('/oauth/device', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, decision: 'approve' }).toString(),
    });
    expect(approved.status).toBe(200);

    const done = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: device.device_code as string,
      }).toString(),
    });
    expect(done.status).toBe(200);
    const tokens = (await done.json()) as Record<string, string>;
    const delivery = await app.request('/delivery/s1/main/entries', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(delivery.status).toBe(200);
  });

  it('sends a signed-out person to sign-in before showing any code', async () => {
    const { app } = makeApp();
    const res = await app.request('/oauth/device?user_code=BCDF-GHJK');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?next=');
  });
});
