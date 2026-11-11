import { chmod, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCredentials, withCredentialsLock, writeCredentials } from '../src/credentials.js';
import { EXIT } from '../src/output.js';
import { resolveCommerceSession } from '../src/session.js';
import { type Call, harness, metadata, status, URL_ } from './harness.js';

const ADMIN = 'https://app.test';
const API = `${ADMIN}/api/v1`;
const COMMERCE_META = {
  issuer: ADMIN,
  token_endpoint: `${ADMIN}/oauth/token`,
  registration_endpoint: `${ADMIN}/oauth/register`,
  device_authorization_endpoint: `${ADMIN}/oauth/device_authorization`,
  revocation_endpoint: `${ADMIN}/oauth/revoke`,
  scopes_supported: ['viewer', 'approver', 'operator'],
};
const DEVICE = {
  device_code: 'dev-1',
  user_code: 'WXYZ-1234',
  verification_uri: `${ADMIN}/oauth/device`,
  verification_uri_complete: `${ADMIN}/oauth/device?user_code=WXYZ-1234`,
  expires_in: 600,
  interval: 5,
};
const TOKENS = {
  access_token: 'cwo_commerce',
  refresh_token: 'cwr_commerce',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'viewer',
};
const ME = {
  kind: 'oauth',
  role: 'viewer',
  resource: API,
  subject: { id: 'usr_1', name: 'Ada', email: 'ada@example.com' },
};

/** A commerce deployment whose token endpoint answers each poll from `answers`. */
function deviceRoutes(answers: unknown[], onCall?: (call: Call) => void) {
  return {
    [`GET ${ADMIN}/.well-known/oauth-authorization-server`]: () => COMMERCE_META,
    [`POST ${ADMIN}/oauth/register`]: () => status(201, { client_id: 'client-c' }),
    [`POST ${ADMIN}/oauth/device_authorization`]: (call: Call) => {
      onCall?.(call);
      return DEVICE;
    },
    [`POST ${ADMIN}/oauth/token`]: (call: Call) => {
      onCall?.(call);
      return answers.shift();
    },
    [`POST ${ADMIN}/oauth/revoke`]: (call: Call) => {
      onCall?.(call);
      return new Response(null, { status: 200 });
    },
    [`GET ${API}/me`]: () => ME,
  };
}

const signedIn = (extra: Record<string, unknown> = {}) => ({
  current: 'default',
  profiles: {
    default: { product: 'commerce' as const, url: ADMIN, accessToken: 'cwo_live', ...extra },
  },
});

describe('credentials from before commerce commands', () => {
  // Exactly what today's CLI writes: no `product`, `space` and `environment` set.
  const TODAYS_FILE = {
    current: 'default',
    profiles: {
      default: {
        url: URL_,
        space: 's1',
        environment: 'main',
        accessToken: 'cwo_access',
        refreshToken: 'cwr_refresh',
        expiresAt: Date.parse('2026-11-01T13:00:00Z'),
        clientId: 'client-1',
        scopes: ['content:write'],
        subject: 'ada@example.com',
      },
    },
  };

  it('loads as a content profile and keeps working with content commands', async () => {
    const h = await harness({
      'GET /auth/me': () => ({ spaceId: 's1', kind: 'cma', scopes: [], restricted: false }),
    });
    await mkdir(h.configDir, { recursive: true });
    await writeFile(join(h.configDir, 'credentials.json'), JSON.stringify(TODAYS_FILE));

    expect((await readCredentials(h.io)).profiles.default).toMatchObject({
      product: 'content',
      space: 's1',
      environment: 'main',
    });
    const out = await h.run('whoami', '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ space: 's1', environment: 'main', source: 'default' });
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer cwo_access');
  });

  it('refuses a commerce command with a clear error, and says how to get a profile', async () => {
    const h = await harness({});
    await mkdir(h.configDir, { recursive: true });
    await writeFile(join(h.configDir, 'credentials.json'), JSON.stringify(TODAYS_FILE));
    const out = await h.run('orders', 'list');
    expect(out.code).toBe(EXIT.usage);
    expect(JSON.parse(out.stderr).error).toMatchObject({ code: 'wrong_product' });
    expect(JSON.parse(out.stderr).error.message).toContain('content deployment');
    expect(h.calls).toHaveLength(0);
  });
});

describe('a content command with a commerce profile', () => {
  it('is refused before any request', async () => {
    const h = await harness({});
    await writeCredentials(h.io, signedIn());
    for (const argv of [['spaces'], ['entries', 'list'], ['doctor']]) {
      const out = await h.run(...argv, '--json');
      if (argv[0] === 'doctor') expect(out.stdout).toContain('commerce deployment');
      else {
        expect(out.code).toBe(EXIT.usage);
        expect(out.stderr).toContain('commerce deployment');
      }
    }
    expect(h.calls.filter((c) => c.path !== '/health' && c.path !== '/openapi.json')).toHaveLength(
      0,
    );
  });
});

describe('login to a commerce deployment', () => {
  it('detects the product from the issuer, runs the device flow for the API resource and stores a commerce profile', async () => {
    const seen: Record<string, string>[] = [];
    const h = await harness(
      deviceRoutes(
        [
          status(400, { error: 'authorization_pending' }),
          status(400, { error: 'slow_down' }),
          TOKENS,
        ],
        (call) =>
          seen.push({ path: call.path, ...Object.fromEntries(new URLSearchParams(call.body)) }),
      ),
    );
    const out = await h.run('login', '--url', `${ADMIN}/`, '--role', 'operator');
    expect(out.code).toBe(EXIT.ok);
    // 5 s, 5 s, then 10 s after slow_down.
    expect(h.sleeps).toEqual([5000, 5000, 10000]);

    const start = seen.find((s) => s.path === '/oauth/device_authorization');
    expect(start).toMatchObject({
      client_id: 'commerceworker-cli',
      scope: 'operator',
      resource: API,
    });
    for (const poll of seen.filter((s) => s.path === '/oauth/token')) {
      expect(poll).toMatchObject({ resource: API, device_code: 'dev-1' });
    }

    // The code and where to enter it are shown; nothing opened.
    expect(out.stderr).toContain('WXYZ-1234');
    expect(out.stderr).toContain(`${ADMIN}/oauth/device`);
    expect(h.opened).toEqual([]);
    expect(JSON.parse(out.stdout)).toMatchObject({
      product: 'commerce',
      url: ADMIN,
      method: 'device',
      subject: 'ada@example.com',
    });

    const saved = JSON.parse(await readFile(join(h.configDir, 'credentials.json'), 'utf8'));
    expect(saved.profiles.default).toMatchObject({
      product: 'commerce',
      url: ADMIN,
      accessToken: 'cwo_commerce',
      refreshToken: 'cwr_commerce',
      clientId: 'commerceworker-cli',
    });
    expect(saved.profiles.default.space).toBeUndefined();
    expect(h.calls.at(-1)?.headers.get('authorization')).toBe('Bearer cwo_commerce');
  });

  it('opens the browser only with --open', async () => {
    const h = await harness(deviceRoutes([TOKENS]));
    expect((await h.run('login', '--url', ADMIN, '--open')).code).toBe(EXIT.ok);
    expect(h.opened).toEqual([DEVICE.verification_uri_complete]);
  });

  it('defaults to the viewer role and refuses admin', async () => {
    const seen: string[] = [];
    const h = await harness(
      deviceRoutes([TOKENS], (call) => {
        if (call.path === '/oauth/device_authorization') seen.push(h.form(call).scope as string);
      }),
    );
    expect((await h.run('login', '--url', ADMIN)).code).toBe(EXIT.ok);
    expect(seen).toEqual(['viewer']);
    expect((await h.run('login', '--url', ADMIN, '--role', 'admin')).code).toBe(EXIT.usage);
  });

  it('gives up with the auth exit code when the code expires or the person denies', async () => {
    const expired = await harness(deviceRoutes([status(400, { error: 'expired_token' })]));
    const out = await expired.run('login', '--url', ADMIN);
    expect(out.code).toBe(EXIT.auth);
    expect(out.stderr).toContain('expired');
    expect(await readCredentials(expired.io)).toEqual({ current: undefined, profiles: {} });

    const denied = await harness(deviceRoutes([status(400, { error: 'access_denied' })]));
    expect((await denied.run('login', '--url', ADMIN)).code).toBe(EXIT.auth);
  });

  it('refuses metadata whose issuer is another origin (RFC 8414 §3.3)', async () => {
    const h = await harness({
      ...deviceRoutes([TOKENS]),
      [`GET ${ADMIN}/.well-known/oauth-authorization-server`]: () => ({
        ...COMMERCE_META,
        issuer: 'https://evil.test',
      }),
    });
    const out = await h.run('login', '--url', ADMIN, '--product', 'commerce');
    expect(out.code).toBe(EXIT.auth);
    expect(out.stderr).toContain('issuer');
    // Nothing was registered or started on the other origin's say-so.
    expect(h.calls.map((c) => c.path)).toEqual(['/.well-known/oauth-authorization-server']);
  });

  it('keeps the content path for a content server that is its own issuer on one host', async () => {
    const own = `https://cms.test`;
    const h = await harness({
      [`GET ${own}/.well-known/oauth-authorization-server`]: () => ({
        ...metadata,
        issuer: own,
        scopes_supported: ['content:write', 'preview:read'],
      }),
      [`POST ${own}/oauth/register`]: () => status(201, { client_id: 'c' }),
      [`POST ${own}/oauth/device_authorization`]: () => DEVICE,
      [`POST ${own}/oauth/token`]: () => TOKENS,
      [`GET ${own}/auth/me`]: () => ({ spaceId: 's1', kind: 'cma', scopes: [], restricted: false }),
    });
    expect((await h.run('login', '--url', own)).code).toBe(EXIT.ok);
    expect((await readCredentials(h.io)).profiles.default).toMatchObject({
      product: 'content',
      space: 's1',
    });
  });

  it('keeps the content path for a server whose issuer is the admin, not the API', async () => {
    const h = await harness({
      'GET /.well-known/oauth-authorization-server': () => metadata,
      'GET /auth/me': () => ({ spaceId: 's1', kind: 'cma', scopes: [], restricted: false }),
      [`POST ${metadata.issuer}/oauth/register`]: () => status(201, { client_id: 'c' }),
      [`POST ${metadata.issuer}/oauth/device_authorization`]: () => ({
        ...DEVICE,
        verification_uri: `${metadata.issuer}/oauth/device`,
      }),
      [`POST ${metadata.issuer}/oauth/token`]: () => TOKENS,
    });
    expect((await h.run('login', '--url', URL_)).code).toBe(EXIT.ok);
    const saved = await readCredentials(h.io);
    expect(saved.profiles.default).toMatchObject({ product: 'content', space: 's1' });
  });

  it('stores an API token after checking it with /me', async () => {
    const h = await harness({
      [`GET ${API}/me`]: () => ({
        kind: 'api_token',
        role: 'operator',
        subject: { id: 't', label: 'ci' },
      }),
    });
    const out = await h.run('login', '--url', ADMIN, '--token', 'cmw_live_abc', '--profile', 'ci');
    expect(out.code).toBe(EXIT.ok);
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer cmw_live_abc');
    const saved = await readCredentials(h.io);
    expect(saved.current).toBe('ci');
    expect(saved.profiles.ci).toMatchObject({
      product: 'commerce',
      url: ADMIN,
      accessToken: 'cmw_live_abc',
    });
    expect(saved.profiles.ci?.refreshToken).toBeUndefined();

    const bad = await harness({ [`GET ${API}/me`]: () => status(401, { error: 'Invalid token' }) });
    expect((await bad.run('login', '--url', ADMIN, '--token', 'cmw_live_nope')).code).toBe(
      EXIT.auth,
    );
  });
});

describe('logout', () => {
  it('revokes the refresh token at the revocation endpoint and deletes the profile', async () => {
    const revoked: Record<string, string>[] = [];
    const h = await harness(
      deviceRoutes([], (call) => {
        if (call.path === '/oauth/revoke') revoked.push(h.form(call));
      }),
    );
    await writeCredentials(
      h.io,
      signedIn({ refreshToken: 'cwr_x', clientId: 'client-c', expiresAt: h.now() + 3_600_000 }),
    );
    const out = await h.run('logout');
    expect(out.code).toBe(EXIT.ok);
    expect(revoked[0]).toEqual({
      token: 'cwr_x',
      token_type_hint: 'refresh_token',
      client_id: 'client-c',
    });
    expect(JSON.parse(out.stdout)).toMatchObject({ removed: true, revoked: true });
    expect((await readCredentials(h.io)).profiles).toEqual({});
  });
});

describe('refresh safety', () => {
  /** A token endpoint that rotates: a refresh token works once, then is spent. */
  function rotating() {
    const spent = new Set<string>();
    const used: string[] = [];
    const routes = {
      [`GET ${ADMIN}/.well-known/oauth-authorization-server`]: () => COMMERCE_META,
      [`POST ${ADMIN}/oauth/token`]: async (call: Call) => {
        const token = new URLSearchParams(call.body).get('refresh_token') as string;
        used.push(token);
        // A real server takes time; the other process gets in while this one is mid-request.
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (spent.has(token)) return status(400, { error: 'invalid_grant' });
        spent.add(token);
        return { access_token: 'cwo_new', refresh_token: 'cwr_new', expires_in: 3600 };
      },
    };
    return { routes, used };
  }
  const expiring = (h: { now: () => number }) =>
    signedIn({ refreshToken: 'cwr_old', clientId: 'client-c', expiresAt: h.now() + 1000 });

  it('two concurrent refreshes spend the refresh token once and both get the new one', async () => {
    const { routes, used } = rotating();
    const h = await harness(routes);
    await writeCredentials(h.io, expiring(h));

    const sessions = await Promise.all([
      resolveCommerceSession({}, h.io),
      resolveCommerceSession({}, h.io),
    ]);
    expect(sessions.map((s) => s.token)).toEqual(['cwo_new', 'cwo_new']);
    expect(used).toEqual(['cwr_old']);
    const saved = await readCredentials(h.io);
    expect(saved.profiles.default).toMatchObject({
      accessToken: 'cwo_new',
      refreshToken: 'cwr_new',
    });
    // The lock is gone once the work is.
    await expect(readFile(join(h.configDir, 'credentials.lock'))).rejects.toThrow();
  });

  it('breaks a lock left by a process that died', async () => {
    const { routes, used } = rotating();
    const h = await harness(routes);
    await writeCredentials(h.io, expiring(h));
    const lock = join(h.configDir, 'credentials.lock');
    await writeFile(lock, '999999');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect((await resolveCommerceSession({}, h.io)).token).toBe('cwo_new');
    expect(used).toEqual(['cwr_old']);
  });
});

describe('commerce commands', () => {
  const setup = async (routes: Record<string, (call: Call) => unknown>) => {
    const h = await harness(routes);
    await writeCredentials(h.io, signedIn());
    return h;
  };

  it('whoami asks /me and prints JSON by default, indented with --pretty', async () => {
    const h = await setup({ [`GET ${API}/me`]: () => ME });
    const out = await h.run('whoami');
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).not.toContain('\n');
    expect(JSON.parse(out.stdout)).toMatchObject({ url: ADMIN, kind: 'oauth', role: 'viewer' });
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer cwo_live');
    expect((await h.run('whoami', '--pretty')).stdout).toContain('\n  "role"');
  });

  it('orders list sends its filters, and --all follows the cursor', async () => {
    const pages = [{ orders: [{ id: 'o1' }], nextCursor: 'c2' }, { orders: [{ id: 'o2' }] }];
    const queries: string[] = [];
    const h = await setup({
      [`GET ${API}/orders`]: (call) => {
        queries.push(new URL(call.url).search);
        return pages.shift();
      },
    });
    const one = await h.run('orders', 'list', '--status', 'waiting', '--limit', '1');
    expect(JSON.parse(one.stdout)).toEqual({ orders: [{ id: 'o1' }], nextCursor: 'c2' });
    expect(queries[0]).toBe('?status=waiting&limit=1');

    pages.splice(
      0,
      pages.length,
      { orders: [{ id: 'o1' }], nextCursor: 'c2' },
      { orders: [{ id: 'o2' }] },
    );
    const all = await h.run('orders', 'list', '--all');
    expect(JSON.parse(all.stdout)).toEqual({ orders: [{ id: 'o1' }, { id: 'o2' }] });
    expect(queries.at(-1)).toBe('?cursor=c2');
  });

  it('orders get and cancel, flows publish and approvals decide hit their routes', async () => {
    const bodies: Record<string, unknown> = {};
    const record = (key: string) => (call: Call) => {
      bodies[key] = call.body ? JSON.parse(call.body) : null;
      return { ok: true };
    };
    const h = await setup({
      [`GET ${API}/orders/ord_1`]: () => ({ id: 'ord_1', status: 'waiting' }),
      [`POST ${API}/orders/ord_1/cancel`]: record('cancel'),
      [`POST ${API}/flows/checkout/publish`]: record('publish'),
      [`POST ${API}/flows/checkout/test`]: record('test'),
      [`POST ${API}/orders/ord_1/approvals/mgr`]: record('decide'),
    });
    expect(JSON.parse((await h.run('orders', 'get', 'ord_1')).stdout)).toMatchObject({
      status: 'waiting',
    });
    expect((await h.run('orders', 'cancel', 'ord_1', '--reason', 'duplicate')).code).toBe(EXIT.ok);
    expect((await h.run('flows', 'publish', 'checkout', '--draft', 'd1')).code).toBe(EXIT.ok);
    expect((await h.run('flows', 'test', 'checkout')).code).toBe(EXIT.ok);
    expect(
      (await h.run('approvals', 'decide', 'ord_1', 'mgr', '--decision', 'approved', '--note', 'ok'))
        .code,
    ).toBe(EXIT.ok);
    expect(bodies).toEqual({
      cancel: { reason: 'duplicate' },
      publish: { draft: 'd1' },
      test: {},
      decide: { decision: 'approved', note: 'ok' },
    });
  });

  it('is a usage error, exit 2, to leave out what a command needs', async () => {
    const h = await setup({});
    expect((await h.run('orders', 'get')).code).toBe(EXIT.usage);
    expect((await h.run('approvals', 'decide', 'o', 'n')).code).toBe(EXIT.usage);
    expect((await h.run('approvals', 'decide', 'o', 'n', '--decision', 'maybe')).code).toBe(
      EXIT.usage,
    );
    expect((await h.run('catalog', 'products', 'put')).code).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
  });

  it('lists carts, flows and catalog products, and puts products from a file', async () => {
    let put: unknown;
    const h = await setup({
      [`GET ${API}/carts`]: () => ({ carts: [] }),
      [`GET ${API}/carts/cart_1`]: () => ({ id: 'cart_1' }),
      [`GET ${API}/flows`]: () => ({ flows: [] }),
      [`GET ${API}/flows/checkout`]: () => ({ flowId: 'checkout', draft: 'd1' }),
      [`GET ${API}/catalog/products/tee`]: () => ({ key: 'tee' }),
      [`POST ${API}/catalog/products`]: (call) => {
        put = JSON.parse(call.body ?? 'null');
        return { written: 1 };
      },
    });
    expect((await h.run('carts', 'list', '--status', 'open')).code).toBe(EXIT.ok);
    expect(h.calls[0]?.url).toBe(`${API}/carts?status=open`);
    expect(JSON.parse((await h.run('carts', 'get', 'cart_1')).stdout)).toEqual({ id: 'cart_1' });
    expect((await h.run('flows', 'list')).code).toBe(EXIT.ok);
    expect(JSON.parse((await h.run('flows', 'get', 'checkout')).stdout).draft).toBe('d1');
    expect(JSON.parse((await h.run('catalog', 'products', 'get', 'tee')).stdout)).toEqual({
      key: 'tee',
    });

    const products = [{ key: 'tee', type: 'apparel', title: { en: 'Tee' }, variants: [] }];
    const file = join(h.configDir, 'products.json');
    await writeFile(file, JSON.stringify(products));
    expect((await h.run('catalog', 'products', 'put', '--input', `@${file}`)).code).toBe(EXIT.ok);
    expect(put).toEqual({ products });
  });

  it('run reaches any operation by id with --input, and lists them', async () => {
    let seen: Call | undefined;
    const h = await setup({
      [`POST ${API}/orders`]: (call) => {
        seen = call;
        return { orderId: 'ord_9' };
      },
    });
    const out = await h.run(
      'run',
      'start_order',
      '--input',
      '{"flowId":"checkout","input":{"model":"b2c"}}',
      '--idempotency-key',
      'k1',
    );
    expect(out.code).toBe(EXIT.ok);
    expect(JSON.parse(out.stdout)).toEqual({ orderId: 'ord_9' });
    expect(JSON.parse(seen?.body ?? '')).toEqual({ flowId: 'checkout', input: { model: 'b2c' } });
    expect(seen?.headers.get('idempotency-key')).toBe('k1');

    const listed = JSON.parse((await h.run('run', '--list')).stdout) as { operationId: string }[];
    expect(listed.map((o) => o.operationId)).toContain('cancel_order');

    expect((await h.run('run', 'no_such_op')).code).toBe(EXIT.usage);
    expect((await h.run('run', 'get_order_state', '--input', '{}')).code).toBe(EXIT.usage);
    expect((await h.run('run', 'get_order_state', '--input', '[1]')).code).toBe(EXIT.usage);
    expect((await h.run('run', 'get_order_state', '--input', '{nope')).code).toBe(EXIT.usage);
  });

  it('prints an API error’s kind, status, request id and issues to stderr, exit 1', async () => {
    const h = await setup({
      [`POST ${API}/orders/ord_1/cancel`]: () =>
        new Response(
          JSON.stringify({
            error: 'Invalid body',
            issues: [{ path: 'reason', message: 'too long' }],
          }),
          {
            status: 400,
            headers: { 'x-request-id': 'req_42', 'content-type': 'application/json' },
          },
        ),
    });
    const out = await h.run('orders', 'cancel', 'ord_1');
    expect(out.code).toBe(EXIT.failure);
    expect(out.stdout).toBe('');
    expect(JSON.parse(out.stderr).error).toEqual({
      code: 'bad_request',
      message: 'Invalid body',
      status: 400,
      requestId: 'req_42',
      operationId: 'cancel_order',
      issues: [{ path: 'reason', message: 'too long' }],
    });
  });

  it('exits 3 for a refused token and 1 for a missing order', async () => {
    const unauthorized = await setup({
      [`GET ${API}/orders/x`]: () => status(401, { error: 'Invalid token' }),
    });
    expect((await unauthorized.run('orders', 'get', 'x')).code).toBe(EXIT.auth);
    const missing = await setup({
      [`GET ${API}/orders/x`]: () => status(404, { error: 'No such order' }),
    });
    const out = await missing.run('orders', 'get', 'x');
    expect(out.code).toBe(EXIT.failure);
    expect(JSON.parse(out.stderr).error).toMatchObject({ code: 'not_found', status: 404 });
    const none = await harness({});
    expect((await none.run('orders', 'list')).code).toBe(EXIT.auth);
  });

  it('points at the admin when the server says a person must do it', async () => {
    const h = await setup({
      [`POST ${API}/fx-rates/EUR`]: () =>
        status(403, { error: 'This needs a person signed in, not a token.' }),
      [`POST ${API}/orders/ord_1/cancel`]: () =>
        status(403, { error: 'Requires the operator role' }),
    });
    const person = await h.run('run', 'set_fx_rate', '--input', '{"currency":"EUR","rate":0.9}');
    expect(person.code).toBe(EXIT.failure);
    expect(JSON.parse(person.stderr).error).toMatchObject({
      code: 'forbidden',
      status: 403,
      adminLink: `${ADMIN}/`,
    });
    // An ordinary role refusal is not a person-only one: no link.
    const role = await h.run('orders', 'cancel', 'ord_1');
    expect(JSON.parse(role.stderr).error.adminLink).toBeUndefined();
  });

  it('links to the order itself when a person must act on it', async () => {
    const h = await setup({
      [`POST ${API}/orders/ord_7/cancel`]: () =>
        status(403, { error: 'A person must confirm this' }),
    });
    const out = await h.run('orders', 'cancel', 'ord_7');
    expect(JSON.parse(out.stderr).error.adminLink).toBe(`${ADMIN}/orders/ord_7`);
  });

  it('uses COMMERCEWORKER_TOKEN and COMMERCEWORKER_URL without a profile', async () => {
    const h = await harness(
      { [`GET ${API}/orders`]: () => ({ orders: [] }) },
      { env: { COMMERCEWORKER_TOKEN: 'cmw_live_env', COMMERCEWORKER_URL: `${ADMIN}/` } },
    );
    expect((await h.run('orders', 'list')).code).toBe(EXIT.ok);
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer cmw_live_env');
    const noUrl = await harness({}, { env: { COMMERCEWORKER_TOKEN: 'cmw_live_env' } });
    expect((await noUrl.run('orders', 'list')).code).toBe(EXIT.usage);
  });

  it('refreshes an expiring commerce session before the command', async () => {
    const h = await setup({
      ...deviceRoutes([{ access_token: 'cwo_fresh', refresh_token: 'cwr_2', expires_in: 3600 }]),
      [`GET ${API}/orders`]: (call) =>
        call.headers.get('authorization') === 'Bearer cwo_fresh' ? { orders: [] } : status(401),
    });
    await writeCredentials(
      h.io,
      signedIn({ refreshToken: 'cwr_1', clientId: 'client-c', expiresAt: h.now() + 10_000 }),
    );
    expect((await h.run('orders', 'list')).code).toBe(EXIT.ok);
  });
});

describe('the first-party client', () => {
  it('signs commerce in as commerceworker-cli without registering', async () => {
    const h = await harness(deviceRoutes([TOKENS]));
    expect((await h.run('login', '--url', ADMIN)).code).toBe(EXIT.ok);
    expect(h.calls.some((c) => c.path === '/oauth/register')).toBe(false);
    expect(
      h.form(h.calls.find((c) => c.path === '/oauth/device_authorization') as Call),
    ).toMatchObject({
      client_id: 'commerceworker-cli',
    });
  });
});

describe('the client id for commerce', () => {
  it('prefers the id the metadata names, and never registers', async () => {
    const h = await harness({
      ...deviceRoutes([TOKENS]),
      [`GET ${ADMIN}/.well-known/oauth-authorization-server`]: () => ({
        ...COMMERCE_META,
        commerceworker_cli_client_id: 'from-metadata',
      }),
    });
    expect((await h.run('login', '--url', ADMIN)).code).toBe(EXIT.ok);
    expect(h.calls.some((c) => c.path === '/oauth/register')).toBe(false);
    expect(
      h.form(h.calls.find((c) => c.path === '/oauth/device_authorization') as Call).client_id,
    ).toBe('from-metadata');
    expect((await readCredentials(h.io)).profiles.default?.clientId).toBe('from-metadata');
  });
});

describe('content registration', () => {
  it('names the client something the server won’t take for the first-party CLI', async () => {
    let name = '';
    const h = await harness({
      'GET /.well-known/oauth-authorization-server': () => metadata,
      [`POST ${metadata.issuer}/oauth/register`]: (call) => {
        name = JSON.parse(call.body ?? '{}').client_name;
        return status(201, { client_id: 'c' });
      },
      [`POST ${metadata.issuer}/oauth/device_authorization`]: () => DEVICE,
      [`POST ${metadata.issuer}/oauth/token`]: () => TOKENS,
      'GET /auth/me': () => ({ spaceId: 's1', kind: 'cma', scopes: [], restricted: false }),
    });
    expect((await h.run('login', '--url', URL_)).code).toBe(EXIT.ok);
    expect(name).not.toMatch(/commerceworker|official|terminal/i);
  });
});

describe('--open', () => {
  const withVerification = (uri: string) => ({
    ...deviceRoutes([TOKENS]),
    [`POST ${ADMIN}/oauth/device_authorization`]: () => ({
      ...DEVICE,
      verification_uri: uri,
      verification_uri_complete: uri,
    }),
  });

  it.each([
    ['a file URL', 'file:///etc/passwd'],
    ['a leading dash', '--version'],
    ['an ampersand', `${ADMIN}/oauth/device?a=1&calc.exe`],
    ['a double quote', `${ADMIN}/oauth/device?"x`],
    ['another origin', 'https://evil.test/oauth/device'],
    ['plain http', 'http://app.test/oauth/device'],
  ])('refuses %s: nothing opens, the code is still shown', async (_name, uri) => {
    const h = await harness(withVerification(uri));
    const out = await h.run('login', '--url', ADMIN, '--open');
    expect(out.code).toBe(EXIT.ok);
    expect(h.opened).toEqual([]);
    expect(out.stderr).toContain('WXYZ-1234');
    expect(out.stderr).toContain('Not opening');
  });

  it('opens the parsed href on the deployment’s origin', async () => {
    const h = await harness(withVerification(`${ADMIN}/oauth/device?user_code=WXYZ-1234`));
    await h.run('login', '--url', ADMIN, '--open');
    expect(h.opened).toEqual([`${ADMIN}/oauth/device?user_code=WXYZ-1234`]);
  });
});

describe('https only', () => {
  it('refuses plain http before any request, for both products', async () => {
    const h = await harness({});
    for (const argv of [
      ['login', '--url', 'http://app.example.com'],
      ['login', '--url', 'http://app.example.com', '--product', 'content'],
      ['login', '--url', 'http://app.example.com', '--token', 'cmw_live_x'],
    ]) {
      expect((await h.run(...argv)).code).toBe(EXIT.usage);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a plain-http env URL or --url override at run time', async () => {
    const env = await harness(
      {},
      { env: { COMMERCEWORKER_TOKEN: 'cmw_live_x', COMMERCEWORKER_URL: 'http://app.example.com' } },
    );
    expect((await env.run('orders', 'list')).code).toBe(EXIT.usage);
    const content = await harness(
      {},
      {
        env: {
          COMMERCEWORKER_TOKEN: 'k',
          COMMERCEWORKER_URL: 'http://api.example.com',
          COMMERCEWORKER_SPACE: 's',
        },
      },
    );
    expect((await content.run('spaces')).code).toBe(EXIT.usage);
    expect(env.calls.length + content.calls.length).toBe(0);
  });

  it('still allows localhost, 127.0.0.0/8 and [::1]', async () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '127.1.2.3', '[::1]:8787']) {
      const base = `http://${host}`;
      const origin = new URL(base).origin;
      const h = await harness({ [`GET ${origin}/api/v1/orders`]: () => ({ orders: [] }) });
      await writeCredentials(h.io, {
        current: 'default',
        profiles: { default: { product: 'commerce', url: origin, accessToken: 't' } },
      });
      expect((await h.run('orders', 'list')).code, host).toBe(EXIT.ok);
    }
  });
});

describe('--url with a stored profile', () => {
  it('is refused when its origin is not the profile’s, for both products', async () => {
    const h = await harness({});
    await writeCredentials(h.io, {
      current: 'default',
      profiles: {
        default: { product: 'commerce', url: ADMIN, accessToken: 't' },
        site: { product: 'content', url: URL_, space: 's', environment: 'main', accessToken: 't' },
      },
    });
    const commerce = await h.run('orders', 'list', '--url', 'https://other.test');
    expect(commerce.code).toBe(EXIT.usage);
    expect(commerce.stderr).toContain('--profile');
    expect(commerce.stderr).toContain('COMMERCEWORKER_TOKEN');
    const content = await h.run('spaces', '--profile', 'site', '--url', 'https://evil.test');
    expect(content.code).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
  });

  it('passes for the profile’s own origin', async () => {
    const h = await harness({ [`GET ${API}/orders`]: () => ({ orders: [] }) });
    await writeCredentials(h.io, signedIn());
    expect((await h.run('orders', 'list', '--url', `${ADMIN}/`)).code).toBe(EXIT.ok);
  });
});

describe('what a server sends to the terminal', () => {
  it('has control characters stripped from errors, the code and human output', async () => {
    const ESC = String.fromCharCode(27);
    const h = await harness({
      [`GET ${API}/orders/x`]: () =>
        new Response(JSON.stringify({ error: `bad${ESC}[31m\u0085red\nforged` }), {
          status: 404,
          headers: { 'x-request-id': `r${ESC}]0;t\u0007` },
        }),
    });
    await writeCredentials(h.io, signedIn());
    const out = await h.run('orders', 'get', 'x');
    expect(out.stderr).not.toMatch(/\p{Cc}/u);
    expect(JSON.parse(out.stderr).error.message).toBe('bad[31mredforged');

    const dev = await harness({
      ...deviceRoutes([TOKENS]),
      [`POST ${ADMIN}/oauth/device_authorization`]: () => ({
        ...DEVICE,
        user_code: `AB${ESC}[2JCD`,
      }),
    });
    const login = await dev.run('login', '--url', ADMIN);
    expect(login.stderr).not.toContain(ESC);
    expect(login.stderr).toContain('AB[2JCD');

    const refused = await harness({
      ...deviceRoutes([status(400, { error: 'x', error_description: `no${ESC}[0m` })]),
    });
    expect((await refused.run('login', '--url', ADMIN)).stderr).not.toContain(ESC);
  });
});

describe('--token -', () => {
  it('reads the token from stdin', async () => {
    const h = await harness(
      {
        [`GET ${API}/me`]: () => ({
          kind: 'api_token',
          role: 'operator',
          subject: { id: 't', label: 'ci' },
        }),
      },
      { stdin: 'cmw_live_fromstdin\n' },
    );
    expect((await h.run('login', '--url', ADMIN, '--token', '-')).code).toBe(EXIT.ok);
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer cmw_live_fromstdin');
    expect((await readCredentials(h.io)).profiles.default?.accessToken).toBe('cmw_live_fromstdin');
    const empty = await harness({}, { stdin: '  \n' });
    expect((await empty.run('login', '--url', ADMIN, '--token', '-')).code).toBe(EXIT.usage);
  });

  it('is recommended in --help', async () => {
    const h = await harness({});
    expect((await h.run('login', '--help')).stdout).toContain('stdin');
  });
});

describe('the credentials lock', () => {
  it('two waiters that both see a stale lock never hold it at once', async () => {
    const h = await harness({});
    await mkdir(h.configDir, { recursive: true });
    const lock = join(h.configDir, 'credentials.lock');
    await writeFile(lock, 'dead');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    let inside = 0;
    let max = 0;
    const work = async () => {
      inside++;
      max = Math.max(max, inside);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inside--;
    };
    await Promise.all([
      withCredentialsLock(h.io, work),
      withCredentialsLock(h.io, work),
      withCredentialsLock(h.io, work),
    ]);
    expect(max).toBe(1);
    await expect(readFile(lock)).rejects.toThrow();
  });

  it('removes only a lock that still holds its own nonce', async () => {
    const h = await harness({});
    const lock = join(h.configDir, 'credentials.lock');
    await withCredentialsLock(h.io, async () => {
      // Broken as stale and retaken by another process while this one was slow.
      await writeFile(lock, 'someone-elses-nonce');
    });
    expect(await readFile(lock, 'utf8')).toBe('someone-elses-nonce');
  });

  it('gives a refresh a deadline inside the stale window, and sends the resource', async () => {
    const forms: Record<string, string>[] = [];
    const h = await harness({
      [`GET ${ADMIN}/.well-known/oauth-authorization-server`]: () => COMMERCE_META,
      [`POST ${ADMIN}/oauth/token`]: (call) => {
        forms.push(Object.fromEntries(new URLSearchParams(call.body)));
        return { access_token: 'cwo_new', refresh_token: 'cwr_new', expires_in: 3600 };
      },
    });
    await writeCredentials(
      h.io,
      signedIn({
        refreshToken: 'cwr_old',
        clientId: 'commerceworker-cli',
        expiresAt: h.now() + 1000,
      }),
    );
    await resolveCommerceSession({}, h.io);
    expect(forms[0]).toMatchObject({ grant_type: 'refresh_token', resource: API });
    for (const call of h.calls) expect(call.signal, call.url).toBeInstanceOf(AbortSignal);
  });
});

describe('metadata endpoints', () => {
  it.each([
    ['token_endpoint', 'https://evil.test/oauth/token'],
    ['device_authorization_endpoint', 'https://evil.test/device'],
    ['revocation_endpoint', 'https://evil.test/revoke'],
    ['registration_endpoint', 'https://evil.test/register'],
    ['token_endpoint', 'http://app.test/oauth/token'],
  ])('refuses a %s off the issuer’s origin or off https (%s)', async (key, value) => {
    const h = await harness({
      ...deviceRoutes([TOKENS]),
      [`GET ${ADMIN}/.well-known/oauth-authorization-server`]: () => ({
        ...COMMERCE_META,
        [key]: value,
      }),
    });
    const out = await h.run('login', '--url', ADMIN);
    expect(out.code).toBe(EXIT.auth);
    expect(h.calls.map((c) => c.path)).toEqual(['/.well-known/oauth-authorization-server']);
  });
});

describe('the config directory and credentials file', () => {
  const posix = process.platform !== 'win32';

  it.skipIf(!posix)('warns when the config dir is writable by others', async () => {
    const h = await harness({ [`GET ${API}/me`]: () => ME });
    await writeCredentials(h.io, signedIn());
    await chmod(h.configDir, 0o777);
    const out = await h.run('whoami');
    expect(out.code).toBe(EXIT.ok);
    expect(out.stderr).toContain('writable by others');
    await chmod(h.configDir, 0o700);
    expect((await h.run('whoami')).stderr).toBe('');
  });

  it('never writes through a file already at the temp name', async () => {
    const h = await harness({});
    await mkdir(h.configDir, { recursive: true });
    // Names are random per write, so a planted guess is never the one used.
    await writeFile(join(h.configDir, 'credentials.json.1.tmp'), 'planted');
    await writeCredentials(h.io, signedIn());
    expect(await readFile(join(h.configDir, 'credentials.json.1.tmp'), 'utf8')).toBe('planted');
  });
});
