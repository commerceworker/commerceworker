import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { PLATFORM, sessionSeed } from './identity-seed';

/**
 * UCP identity linking on each device: the consent page (`/identity/authorize`) fits the screen,
 * has 44px controls and is never cached, framed or referred. Allowing and cancelling each send the browser back to the
 * platform with the right answer, `state` and issuer; a shopper who isn't signed in is sent to sign
 * in; a request from a platform that can't be trusted is shown, not redirected to; and `/account`
 * lists a linked platform and unlinks it. The platform's address is intercepted: nothing leaves.
 * The shoppers and the platform are seeded by `e2e/identity-seed.ts`.
 */

/** Each project is a client of its own: the authorize budget is per client address (see account.spec.ts). */
const CLIENT = Object.fromEntries(
  ['iphone', 'iphone-landscape', 'ipad', 'ipad-landscape', 'desktop'].map((p, i) => [
    p,
    `198.51.100.${i + 11}`,
  ]),
);

test.beforeEach(async ({ context, baseURL }, info) => {
  await context.setExtraHTTPHeaders({ 'cf-connecting-ip': CLIENT[info.project.name]! });
  // The platform's pages are not reached: the redirect is read off the request.
  await context.route('https://platform.e2e.test/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<p>platform</p>' }),
  );
  void baseURL;
});

/** The shopper's cookie: the unprefixed `cw_shop`, which the Worker reads on localhost only. */
async function signedIn(page: Page, project: string, role: 'consent' | 'unlink') {
  await page.context().addCookies([
    {
      name: 'cw_shop',
      value: sessionSeed(project, role).secret,
      url: new URL(page.url() === 'about:blank' ? 'http://localhost' : page.url()).origin,
    },
  ]);
}

const authorizeUrl = (over: Record<string, string> = {}) =>
  `/identity/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: PLATFORM.id,
    redirect_uri: PLATFORM.redirect,
    scope: 'dev.ucp.shopping.order:read',
    state: 'e2e-state',
    code_challenge: 'c'.repeat(43),
    code_challenge_method: 'S256',
    ...over,
  })}`;

const styled = (page: Page) =>
  page.waitForFunction(() => {
    const main = document.querySelector('main');
    return !!main && getComputedStyle(main).maxWidth !== 'none';
  });

async function boot(page: Page, baseURL: string | undefined) {
  await page.goto(baseURL ?? '/health');
}

test('the consent page: fits, is private and unframed, and has no leaked internal header', async ({
  page,
  baseURL,
}, info) => {
  await boot(page, baseURL);
  await signedIn(page, info.project.name, 'consent');
  const res = (await page.goto(authorizeUrl()))!;
  expect(res.status()).toBe(200);
  await styled(page);
  await expect(
    page.getByRole('heading', { name: `Link ${PLATFORM.name} to your account`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(sessionSeed(info.project.name, 'consent').email)).toBeVisible();
  await expect(page.getByText('See the orders you placed with this store.')).toBeVisible();

  const h = res.headers();
  expect(h['cache-control']).toBe('no-store');
  expect(h['referrer-policy']).toBe('same-origin');
  expect(h['x-frame-options']).toBe('DENY');
  // The dev server sets no CSP (its inline scripts carry no nonce): the policy is checked in
  // tests/identity-linking.test.ts. The route's note to entry.server must not reach the browser.
  expect(h['x-commerceworker-consent']).toBeUndefined();

  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
  for (const el of await page.locator('main button, main a').all()) {
    const box = await el.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(43.5);
  }
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test('Allow sends the browser to the platform with a code, the state and the issuer', async ({
  page,
  baseURL,
}, info) => {
  await boot(page, baseURL);
  await signedIn(page, info.project.name, 'consent');
  await page.goto(authorizeUrl());
  await Promise.all([
    page.waitForURL(`${PLATFORM.redirect}?**`),
    page.getByRole('button', { name: 'Allow' }).click(),
  ]);
  const back = new URL(page.url());
  expect(back.origin + back.pathname).toBe(PLATFORM.redirect);
  expect(back.searchParams.get('code')).toMatch(/^cmw_ucpc_[A-Za-z0-9_-]{43}$/);
  expect(back.searchParams.get('state')).toBe('e2e-state');
  expect(back.searchParams.get('iss')).toBe(new URL(baseURL!).origin);
});

test('Cancel sends access_denied, with no code', async ({ page, baseURL }, info) => {
  await boot(page, baseURL);
  await signedIn(page, info.project.name, 'consent');
  await page.goto(authorizeUrl());
  await Promise.all([
    page.waitForURL(`${PLATFORM.redirect}?**`),
    page.getByRole('button', { name: 'Cancel' }).click(),
  ]);
  const back = new URL(page.url());
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe('e2e-state');
  expect(back.searchParams.has('code')).toBe(false);
});

test('a shopper who is not signed in is sent to sign in, and the way back is kept', async ({
  page,
}) => {
  await page.goto(authorizeUrl());
  await expect(page).toHaveURL(/\/account\/sign-in\?next=/);
  const next = new URL(page.url()).searchParams.get('next')!;
  expect(next.startsWith('/identity/authorize?')).toBe(true);
  expect(next).toContain('client_id=ucp_e2e');
  await expect(page.locator('input[name="next"]')).toHaveValue(next);
});

test('a request from a platform that can’t be trusted is shown, never redirected to', async ({
  page,
  baseURL,
}, info) => {
  await boot(page, baseURL);
  await signedIn(page, info.project.name, 'consent');
  for (const over of <Record<string, string>[]>[
    { redirect_uri: 'https://evil.example/callback' },
    { client_id: 'ucp_unknown' },
  ]) {
    const res = (await page.goto(authorizeUrl(over)))!;
    expect(res.status()).toBe(400);
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    await expect(
      page.getByRole('heading', { name: 'We couldn’t link this account' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
  }
  // A fault past those goes back to the platform, which can say what was wrong.
  await Promise.all([
    page.waitForURL(`${PLATFORM.redirect}?**`),
    page.goto(authorizeUrl({ scope: 'dev.ucp.shopping.order:manage' })).catch(() => undefined),
  ]);
  expect(new URL(page.url()).searchParams.get('error')).toBe('invalid_scope');
});

test('/account/apps lists a linked platform and unlinks it', async ({ page, baseURL }, info) => {
  await boot(page, baseURL);
  await signedIn(page, info.project.name, 'unlink');
  await page.goto('/account/apps');
  await styled(page);
  await expect(page.getByRole('heading', { name: 'Linked apps', level: 1 })).toBeVisible();
  await expect(page.getByText(PLATFORM.name)).toBeVisible();
  const unlink = page.getByRole('button', { name: `Unlink ${PLATFORM.name}` });
  const box = await unlink.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(43.5);
  await unlink.click();
  await expect(page.getByRole('heading', { name: 'Nothing linked' })).toBeVisible();
});
