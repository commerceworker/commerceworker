import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { SPACE } from './cms';

/**
 * OAuth for MCP clients, end to end, the way a client and a person meet it: dynamic registration,
 * consent in the browser by a signed-in team member, the PKCE code exchange, then the token at
 * work, refreshed and revoked. Runs after the `auth` project, which turns sign-in on with the
 * first admin (playwright.config.ts). Each step here once failed on every deployment: the
 * resource was "" (OAUTH_RESOURCE declared empty), the consent POST lost the session
 * (Referrer-Policy: no-referrer → `Origin: null`), and a client registered without scopes could
 * never write.
 */

const ADMIN = { email: 'first-admin@example.com', password: 'correct horse battery staple' };
const admin = { Authorization: 'Bearer dev-admin-token' };

/** RFC 6238 TOTP for a base32 secret (what an authenticator app shows). */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const off = (mac[mac.length - 1] as number) & 0xf;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('an MCP client connects with OAuth: consent, code exchange, use, refresh, revoke', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // The CMS projects made the space while sign-in was still open; make sure, as the admin token.
  const space = await request.post('/spaces', {
    headers: admin,
    data: { spaceId: SPACE, name: 'E2E', defaultLocale: 'en-US' },
  });
  expect([200, 201, 409]).toContain(space.status());

  // The first admin signs in and turns on two-factor, which their role requires before anything
  // but the two-factor step opens (OAuth consent included).
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/two-factor$/);
  const enable = page.locator('form:has(input[name=secret])');
  const secret = await enable.locator('input[name=secret]').inputValue();
  await enable.locator('input[name=code]').fill(totp(secret));
  await enable.locator('input[name=password]').fill(ADMIN.password);
  await enable.locator('button[type=submit]').click();
  await expect(page.getByText('Two-factor sign-in is on.')).toBeVisible();

  // On the e2e space's team as an Editor (applications act as a team member).
  const roles = (await (await request.get(`/spaces/${SPACE}/roles`, { headers: admin })).json()) as
    | { items: { id: string; name: string }[] }
    | { id: string; name: string }[];
  const editor = ('items' in roles ? roles.items : roles).find((r) => r.name === 'Editor');
  expect(editor, 'the space has an Editor role').toBeTruthy();
  const joined = await request.post(`/spaces/${SPACE}/members`, {
    headers: admin,
    data: { email: ADMIN.email, name: 'First admin', role: editor?.id },
  });
  expect([201, 409]).toContain(joined.status());

  // The client's redirect target: a real local server, as a native MCP client runs.
  let callback: URL | undefined;
  const server = createServer((req, res) => {
    callback = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.end('connected');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  try {
    // Registers without asking for scopes, as MCP clients commonly do.
    const registered = await request.post('/oauth/register', {
      data: {
        client_name: 'E2E MCP client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      },
    });
    expect(registered.status()).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(8).toString('hex');
    const origin = new URL(page.url()).origin;
    const authorize = new URL('/oauth/authorize', origin);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      scope: 'content:write preview:read delivery:read',
      resource: `${origin}/mcp`,
    })) {
      authorize.searchParams.set(k, v);
    }

    // The consent screen names the client, the person and every scope; Approve sends the code.
    await page.goto(authorize.href);
    await expect(page.getByRole('heading', { name: 'E2E MCP client' })).toBeVisible();
    await expect(page.getByText(ADMIN.email)).toBeVisible();
    await expect(page.getByText('Create and edit content')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => callback?.searchParams.get('code') ?? null).not.toBeNull();
    expect(callback?.searchParams.get('state')).toBe(state);

    const exchanged = await request.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code: callback?.searchParams.get('code') ?? '',
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      },
    });
    expect(exchanged.status(), await exchanged.text()).toBe(200);
    const tokens = (await exchanged.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.scope.split(' ').sort()).toEqual([
      'content:write',
      'delivery:read',
      'preview:read',
    ]);

    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const types = `/spaces/${SPACE}/environments/main/content-types`;
    expect((await request.get(types, { headers: bearer(tokens.access_token) })).status()).toBe(200);

    const refreshed = await request.post('/oauth/token', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      },
    });
    expect(refreshed.status()).toBe(200);
    const { access_token: next } = (await refreshed.json()) as { access_token: string };

    const revoked = await request.post('/oauth/revoke', {
      form: { token: next, client_id: clientId },
    });
    expect(revoked.status()).toBe(200);
    expect((await request.get(types, { headers: bearer(next) })).status()).toBe(401);
  } finally {
    server.close();
  }
});
