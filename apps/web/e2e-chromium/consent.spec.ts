import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { contentSecurityPolicy, redirectSource } from '@commerceworker/security/csp';
import { expect, type Page, test } from '@playwright/test';
import { open } from '../e2e/helpers';

/**
 * Chromium holds the redirect that answers a form post to the page's `form-action`, so a consent
 * page that posts under `form-action 'self'` has its own answer, a 303 to the app, blocked.
 * routes/oauth-authorize.tsx names the app's return origin in that page's policy (and that page's
 * alone; `pageHeaders` in packages/security builds it). WebKit follows the redirect either way, so
 * this one spec runs in Chromium, the engine that would catch it; the device projects stay WebKit.
 *
 * The app is a real listener on loopback, as a native app's is (RFC 8252 §7.3). The dev server
 * sends no policy (its inline scripts carry no nonce) and strips the page's note to it, so the
 * policy's `form-action` is put on the consent page here from the same builder the Worker uses,
 * for the redirect origin the route names, and once without it as the control.
 */
let app: Server;
let redirect = '';
let clientId = '';
const arrived: string[] = [];

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ playwright, baseURL }) => {
  app = createServer((req, res) => {
    arrived.push(`http://127.0.0.1${req.url}`);
    res.setHeader('content-type', 'text/html');
    res.end('<h1>The app</h1>');
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  redirect = `http://127.0.0.1:${(app.address() as AddressInfo).port}/callback`;
  const request = await playwright.request.newContext({ baseURL: baseURL as string });
  const registered = await request.post('/oauth/register', {
    data: {
      client_name: 'Consent e2e',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(registered.status()).toBe(201);
  clientId = ((await registered.json()) as { client_id: string }).client_id;
  await request.dispose();
});
test.afterAll(() => app.close());
test.beforeEach(() => {
  arrived.length = 0;
});

/** The consent page, with the policy's form-action the Worker would send for `redirectTo`. */
async function consent(page: Page, redirectTo: string | null) {
  await page.route(/\/oauth\/authorize\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const csp = contentSecurityPolicy('e2e', null, { redirect: redirectTo });
    const formAction = csp.split('; ').find((d) => d.startsWith('form-action')) as string;
    return route.fulfill({
      response: res,
      headers: { ...res.headers(), 'content-security-policy': formAction },
    });
  });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'e2e-state',
  });
  await open(page, `/oauth/authorize?${query}`);
  await expect(page.getByRole('heading', { name: /Consent e2e/ })).toBeVisible();
}

for (const decision of ['Connect', 'Cancel'] as const) {
  test(`consent: ${decision} reaches the app when the page names its origin`, async ({
    page,
    baseURL,
  }) => {
    await consent(page, redirectSource(redirect));
    await page.getByRole('button', { name: decision }).click();
    await expect(page.getByRole('heading', { name: 'The app' })).toBeVisible();

    expect(arrived).toHaveLength(1);
    const back = new URL(arrived[0] as string);
    expect(back.pathname).toBe('/callback');
    expect(back.searchParams.get('state')).toBe('e2e-state');
    expect(back.searchParams.get('iss')).toBe(baseURL);
    if (decision === 'Connect') expect(back.searchParams.get('code')).toBeTruthy();
    else expect(back.searchParams.get('error')).toBe('access_denied');
  });
}

test('consent: under form-action self alone Chromium blocks the redirect (why the route names the origin)', async ({
  page,
}) => {
  const blocked: string[] = [];
  page.on('console', (m) => {
    if (/form-action/i.test(m.text())) blocked.push(m.text());
  });
  await consent(page, null);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect.poll(() => blocked.length).toBeGreaterThan(0);
  expect(arrived).toHaveLength(0);
});
