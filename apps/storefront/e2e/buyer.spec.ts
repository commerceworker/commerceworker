import { DEV_PRINCIPAL_KEY, signCartGuestSession, storefrontKey } from '@commerceworker/core';
import { expect, type Page, test } from '@playwright/test';

/**
 * What a buyer's device sees on the storefront. A cart's own page needs an external cart a plugin
 * opened, which the device tests' engine has none of, so these are the pages every buyer can reach
 * without one: the refusals (a used link, a missing cookie, a cart that isn't there), and the Worker's
 * own routes. They are the pages the buyer's frame shows when something is wrong, so they must fit
 * every device and pad for their safe areas.
 */

/** The page is no wider than the screen, and its text is on it. */
async function fits(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}

test('a start link that can’t be redeemed says so, and admits no one', async ({ page }) => {
  const res = await page.goto('/cart/start/cart_unknown/0a9f');
  expect(res?.status()).toBe(410);
  await expect(page.getByRole('heading', { name: 'This cart isn’t available' })).toBeVisible();
  await expect(page.getByText(/has been used or has expired/)).toBeVisible();
  await fits(page);
  // No cookie was set for a link that admitted no one. (The frame policy is the dev server's to
  // omit; tests/page-headers.test.ts holds it on the built entry.)
  expect(res?.headers()['set-cookie']).toBeUndefined();
});

test('a cart page without the buyer’s cookie asks them to open it from their system', async ({
  page,
}) => {
  const res = await page.goto('/cart/cart_unknown');
  expect(res?.status()).toBe(401);
  await expect(page.getByText('Open this cart from your purchasing system.')).toBeVisible();
  await fits(page);
});

test('a buyer’s cookie for a cart the engine doesn’t have is a 404, not a page', async ({
  context,
  page,
  baseURL,
}) => {
  const guest = { cartId: 'cart_unknown', id: 'guest:b1', name: 'Pat Buyer' };
  await context.addCookies([
    {
      // As the start link sets it over plain http, which is local dev only: deployed over https it
      // is `__Host-ol_<cartId>` and Secure (tests/cart-guest.test.ts holds both).
      name: `ol_${guest.cartId}`,
      value: await signCartGuestSession(
        await storefrontKey(DEV_PRINCIPAL_KEY),
        guest,
        Date.now() + 60_000,
      ),
      url: baseURL!,
    },
  ]);
  const res = await page.goto('/cart/cart_unknown');
  expect(res?.status()).toBe(404);
  await expect(page.getByText('This cart doesn’t exist.')).toBeVisible();
  await fits(page);
});

test('the pages pad for the notch and size to the device', async ({ page }) => {
  await page.goto('/cart/cart_unknown');
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  // The cart's own pages carry no admin: no shell, no sign-in, no navigation to it.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /sign in|overview/i })).toHaveCount(0);
});

test('serves no admin: its routes are not here, and /health answers', async ({ request }) => {
  expect((await request.get('/health')).ok()).toBe(true);
  for (const path of ['/login', '/orders', '/api/v1/openapi.json', '/mcp']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  // Agentic checkout takes a platform's key: nothing without one.
  expect((await request.post('/ucp/v1/checkout-sessions')).status()).toBe(401);
  // Its profile is off until an admin turns agentic checkout on.
  expect((await request.get('/.well-known/ucp')).status()).toBe(404);
});

test('a hosted checkout’s start link shows a Continue page that spends nothing, sized for a finger', async ({
  page,
}) => {
  for (const visit of [1, 2]) {
    const res = await page.goto('/checkout/start/chk_e2e/0a9f');
    // Opening the link twice is no use of it: only the button's POST redeems.
    expect(res?.status(), `visit ${visit}`).toBe(200);
    expect(res?.headers()['set-cookie']).toBeUndefined();
    expect(res?.headers()['cache-control']).toBe('no-store');
    expect(res?.headers()['referrer-policy']).toBe('same-origin');
    await expect(page.getByRole('heading', { name: 'Your checkout is ready' })).toBeVisible();
  }
  const button = page.getByRole('button', { name: 'Continue to checkout' });
  await expect(button).toBeVisible();
  expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await fits(page);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  await expect(page.getByRole('navigation')).toHaveCount(0);
});
