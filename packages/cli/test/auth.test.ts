import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeCredentials } from '../src/credentials.js';
import { configDirFor } from '../src/io.js';
import { EXIT } from '../src/output.js';
import { type Call, harness, ISSUER, me, metadata, status, URL_ } from './harness.js';

const DEVICE = {
  device_code: 'cwd_device',
  user_code: 'BCDF-GHJK',
  verification_uri: `${ISSUER}/oauth/device`,
  verification_uri_complete: `${ISSUER}/oauth/device?user_code=BCDF-GHJK`,
  expires_in: 600,
  interval: 5,
};
const TOKENS = {
  access_token: 'cwo_access',
  refresh_token: 'cwr_refresh',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'content:write preview:read',
};

/** A deployment whose token endpoint answers each poll from `answers` in turn. */
function deviceRoutes(answers: unknown[], onToken?: (call: Call) => void) {
  return {
    'GET /.well-known/oauth-authorization-server': () => metadata,
    [`POST ${ISSUER}/oauth/register`]: () => status(201, { client_id: 'client-1' }),
    [`POST ${ISSUER}/oauth/device_authorization`]: () => DEVICE,
    [`POST ${ISSUER}/oauth/token`]: (call: Call) => {
      onToken?.(call);
      return answers.shift();
    },
    [`POST ${ISSUER}/oauth/revoke`]: () => new Response(null, { status: 200 }),
    'GET /auth/me': () => me(),
  };
}

const posix = process.platform !== 'win32';

describe('login with the device flow', () => {
  it('polls at the server’s interval, backs off on slow_down, and stores tokens owner-only', async () => {
    const polls: Record<string, string>[] = [];
    const h = await harness(
      deviceRoutes(
        [
          status(400, { error: 'authorization_pending' }),
          status(400, { error: 'slow_down' }),
          status(400, { error: 'authorization_pending' }),
          TOKENS,
        ],
        (call) => polls.push(Object.fromEntries(new URLSearchParams(call.body))),
      ),
    );

    const out = await h.run('login', '--url', `${URL_}/`, '--json');
    expect(out.code).toBe(EXIT.ok);
    // 5 s, 5 s, then 10 s after slow_down (RFC 8628 §3.5), and 10 s again.
    expect(h.sleeps).toEqual([5000, 5000, 10000, 10000]);
    expect(polls).toHaveLength(4);
    expect(polls[0]).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'client-1',
      device_code: 'cwd_device',
    });

    // Registered as a public device-flow client that can refresh.
    const register = h.calls.find((c) => c.url === `${ISSUER}/oauth/register`);
    expect(JSON.parse(register?.body ?? '{}')).toMatchObject({
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      redirect_uris: [],
    });

    // Where to approve goes to stderr as one JSON line; stdout is only the result.
    expect(JSON.parse(out.stderr)).toEqual({
      event: 'device_authorization',
      verificationUri: DEVICE.verification_uri_complete,
      userCode: 'BCDF-GHJK',
      expiresIn: 600,
    });
    expect(h.json()).toEqual({
      profile: 'default',
      url: URL_,
      space: 's1',
      environment: 'main',
      subject: 'ada@example.com',
      scopes: ['content:write', 'preview:read'],
      method: 'device',
    });

    const file = join(h.configDir, 'credentials.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.current).toBe('default');
    expect(saved.profiles.default).toMatchObject({
      url: URL_,
      space: 's1',
      accessToken: 'cwo_access',
      refreshToken: 'cwr_refresh',
      clientId: 'client-1',
      expiresAt: h.now() + 3600_000,
    });
    if (posix) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(h.configDir)).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps the file owner-only when it is rewritten over a wider one', async () => {
    const h = await harness(deviceRoutes([TOKENS]));
    await writeCredentials(h.io, { profiles: {} });
    const file = join(h.configDir, 'credentials.json');
    if (posix) {
      const { chmod } = await import('node:fs/promises');
      await chmod(file, 0o644);
    }
    expect((await h.run('login', '--url', URL_)).code).toBe(EXIT.ok);
    if (posix) expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('fails with the auth exit code when the person denies, or the code expires', async () => {
    const denied = await harness(deviceRoutes([status(400, { error: 'access_denied' })]));
    const out = await denied.run('login', '--url', URL_, '--json');
    expect(out.code).toBe(EXIT.auth);
    expect(JSON.parse(out.stderr.split('\n').slice(1).join('\n')).error.code).toBe('access_denied');

    // Pending until the code's lifetime runs out: give up rather than poll forever.
    const pending = Array.from({ length: 200 }, () =>
      status(400, { error: 'authorization_pending' }),
    );
    const slow = await harness(deviceRoutes(pending));
    expect((await slow.run('login', '--url', URL_)).code).toBe(EXIT.auth);
    expect(slow.sleeps.reduce((a, b) => a + b, 0)).toBe(600_000);
    expect(slow.stderr.join('\n')).toContain('expired');
  });

  it('registers again when the client from an earlier login is gone', async () => {
    const routes = deviceRoutes([TOKENS]);
    const started: string[] = [];
    const h = await harness({
      ...routes,
      [`POST ${ISSUER}/oauth/device_authorization`]: (call) => {
        const clientId = new URLSearchParams(call.body).get('client_id') as string;
        started.push(clientId);
        return clientId === 'client-old'
          ? status(401, { error: 'invalid_client', error_description: 'Unknown client_id' })
          : DEVICE;
      },
    });
    await writeCredentials(h.io, {
      current: 'default',
      profiles: {
        default: {
          url: URL_,
          space: 's1',
          environment: 'main',
          accessToken: 'x',
          clientId: 'client-old',
        },
      },
    });
    expect((await h.run('login')).code).toBe(EXIT.ok);
    expect(started).toEqual(['client-old', 'client-1']);
    const saved = JSON.parse(await readFile(join(h.configDir, 'credentials.json'), 'utf8'));
    expect(saved.profiles.default.clientId).toBe('client-1');
  });

  it('says how to use a key when the deployment has no OAuth sign-in', async () => {
    const h = await harness({});
    const out = await h.run('login', '--url', URL_, '--json');
    expect(out.code).toBe(EXIT.auth);
    expect(JSON.parse(out.stderr).error).toMatchObject({ code: 'oauth_unavailable' });
    expect(JSON.parse(out.stderr).error.message).toContain('--token');
  });

  it('stores a key with --token after checking it, with nothing to refresh', async () => {
    const h = await harness({ 'GET /auth/me': () => me('s2') });
    const out = await h.run('login', '--url', URL_, '--token', 'cma_key', '--profile', 'ci');
    expect(out.code).toBe(EXIT.ok);
    const saved = JSON.parse(await readFile(join(h.configDir, 'credentials.json'), 'utf8'));
    expect(saved.current).toBe('ci');
    expect(saved.profiles.ci).toMatchObject({ space: 's2', accessToken: 'cma_key' });
    expect(saved.profiles.ci.refreshToken).toBeUndefined();
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer cma_key');
  });
});

describe('sessions', () => {
  it('refreshes an expiring access token before the command, and saves the rotated pair', async () => {
    const forms: Record<string, string>[] = [];
    const h = await harness({
      'GET /.well-known/oauth-authorization-server': () => metadata,
      [`POST ${ISSUER}/oauth/token`]: (call) => {
        forms.push(Object.fromEntries(new URLSearchParams(call.body)));
        return { ...TOKENS, access_token: 'cwo_new', refresh_token: 'cwr_new' };
      },
      'GET /auth/me': (call) =>
        call.headers.get('authorization') === 'Bearer cwo_new' ? me() : status(401),
    });
    await writeCredentials(h.io, {
      current: 'default',
      profiles: {
        default: {
          url: URL_,
          space: 's1',
          environment: 'main',
          accessToken: 'cwo_old',
          refreshToken: 'cwr_old',
          clientId: 'client-1',
          expiresAt: h.now() + 30_000, // inside the one-minute margin
        },
      },
    });

    const out = await h.run('whoami', '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(forms).toEqual([
      { grant_type: 'refresh_token', client_id: 'client-1', refresh_token: 'cwr_old' },
    ]);
    const file = join(h.configDir, 'credentials.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.profiles.default).toMatchObject({
      accessToken: 'cwo_new',
      refreshToken: 'cwr_new',
    });
    if (posix) expect((await stat(file)).mode & 0o777).toBe(0o600);

    // A refresh token that was revoked (or replayed) sends the person back to login.
    const revoked = await harness({
      'GET /.well-known/oauth-authorization-server': () => metadata,
      [`POST ${ISSUER}/oauth/token`]: () => status(400, { error: 'invalid_grant' }),
    });
    await writeCredentials(revoked.io, {
      current: 'default',
      profiles: { default: { ...saved.profiles.default, expiresAt: revoked.now() - 1 } },
    });
    expect((await revoked.run('whoami')).code).toBe(EXIT.auth);
  });

  it('uses COMMERCEWORKER_TOKEN without reading or writing credentials', async () => {
    const h = await harness(
      {
        'GET /auth/me': () => me('s9'),
        'GET /spaces': () => ({ items: [{ id: 's9', name: 'Nine' }] }),
      },
      { env: { COMMERCEWORKER_TOKEN: 'ci_key', COMMERCEWORKER_URL: URL_ } },
    );
    const out = await h.run('whoami', '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(h.json()).toMatchObject({ source: 'env', space: 's9', environment: 'main' });
    expect(h.calls.every((c) => c.headers.get('authorization') === 'Bearer ci_key')).toBe(true);
    await expect(stat(join(h.configDir, 'credentials.json'))).rejects.toThrow();

    // No URL to go with the token is a usage error, not a guess.
    const bare = await harness({}, { env: { COMMERCEWORKER_TOKEN: 'ci_key' } });
    expect((await bare.run('spaces')).code).toBe(EXIT.usage);
  });

  it('logout revokes what the CLI obtained and forgets the profile', async () => {
    const revoked: string[] = [];
    const h = await harness({
      'GET /.well-known/oauth-authorization-server': () => metadata,
      [`POST ${ISSUER}/oauth/revoke`]: (call) => {
        revoked.push(new URLSearchParams(call.body).get('token') as string);
        return new Response(null, { status: 200 });
      },
    });
    await writeCredentials(h.io, {
      current: 'default',
      profiles: {
        default: {
          url: URL_,
          space: 's1',
          environment: 'main',
          accessToken: 'cwo_a',
          refreshToken: 'cwr_r',
          clientId: 'client-1',
        },
      },
    });
    const out = await h.run('logout', '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(h.json()).toEqual({ profile: 'default', removed: true, revoked: true });
    expect(revoked).toEqual(['cwr_r', 'cwo_a']);
    expect((await h.run('whoami')).code).toBe(EXIT.auth);
  });
});

describe('the config directory', () => {
  it('follows COMMERCEWORKER_CONFIG_DIR, then XDG, then APPDATA on Windows, then ~/.config', () => {
    expect(configDirFor({ COMMERCEWORKER_CONFIG_DIR: '/c' }, 'linux', '/h')).toBe('/c');
    expect(configDirFor({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h')).toBe(
      join('/x', 'commerceworker'),
    );
    expect(configDirFor({ APPDATA: 'C:\\A' }, 'win32', 'C:\\h')).toBe(
      join('C:\\A', 'commerceworker'),
    );
    expect(configDirFor({}, 'darwin', '/h')).toBe(join('/h', '.config', 'commerceworker'));
  });
});

describe('a server with a built-in client for this CLI', () => {
  it('signs in as it without registering', async () => {
    const h = await harness({
      ...deviceRoutes([TOKENS]),
      'GET /.well-known/oauth-authorization-server': () => ({
        ...metadata,
        commerceworker_cli_client_id: 'commerceworker-cli',
      }),
    });
    const out = await h.run('login', '--url', `${URL_}/`, '--json');
    expect(out.code).toBe(EXIT.ok);
    expect(h.calls.some((c) => c.url === `${ISSUER}/oauth/register`)).toBe(false);
    const start = h.calls.find((c) => c.url === `${ISSUER}/oauth/device_authorization`);
    expect(start?.body).toContain('client_id=commerceworker-cli');
  });
});
