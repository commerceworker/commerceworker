import { SHOPPER_ORDERS_PAGE } from '@commerceworker/core';
import { expect, test } from '@playwright/test';
import { accountSeed, ORDER_COUNT } from './account-seed';
import { CHECKOUT_ID, CHECKOUT_SECRET } from './checkout-seed';
import { clientHeaders, fits, isPrivate, noViolations, touchable } from './device';

/**
 * A signed-in shopper's pages on each device (`/account`, `/account/orders/:id`,
 * `/account/addresses`) and the hosted checkout's offer of their saved details: the page no wider
 * than the screen, every control 44px, nothing cached or sent in a Referer, and only what the
 * session's address owns: a stranger's order and an erased one are not listed, nor a business
 * customer's address under the same email. The shoppers and their rows are written by
 * `e2e/account-seed.ts`, one per device project.
 */

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders(clientHeaders(info.project.name));
});

test.beforeEach(async ({ context, baseURL }, info) => {
  const s = accountSeed(info.project.name);
  await context.addCookies([
    { name: 'cw_shop', value: s.secret, url: baseURL!, httpOnly: true, sameSite: 'Lax' },
  ]);
});

test('lists the orders under the address, newest first, a page at a time, and nothing else', async ({
  page,
}, info) => {
  const s = accountSeed(info.project.name);
  const res = (await page.goto('/account'))!;
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Your orders', level: 1 })).toBeVisible();
  const rows = page.locator('main ul a[href^="/account/orders/"]');
  await expect(rows).toHaveCount(SHOPPER_ORDERS_PAGE);
  // Newest first, whatever case the address was typed in; no stranger's, no erased order.
  await expect(rows.first()).toContainText(`Order ${s.ref(0)}`);
  await expect(rows.nth(1)).toContainText(`Order ${s.ref(1)}`);
  const hrefs = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(hrefs.join()).not.toContain('stranger');
  expect(hrefs.join()).not.toContain('erased');
  await fits(page);
  await touchable(page);
  await isPrivate(page, res);
  await noViolations(page);
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // The page after: the rest, then a way back to the newest.
  await page.getByRole('link', { name: 'Older orders' }).click();
  await expect(page).toHaveURL(/\/account\?after=/);
  await expect(rows).toHaveCount(ORDER_COUNT - SHOPPER_ORDERS_PAGE);
  await expect(rows.first()).toContainText(`Order ${s.ref(SHOPPER_ORDERS_PAGE)}`);
  await expect(page.getByRole('link', { name: 'Older orders' })).toHaveCount(0);
  await fits(page);
  await touchable(page);
  await page.getByRole('link', { name: 'Newest orders' }).click();
  await expect(rows).toHaveCount(SHOPPER_ORDERS_PAGE);

  // A cursor someone made up is the engine's to refuse: it starts from the top.
  const forged = (await page.goto("/account?after=0:x'%20or%201=1"))!;
  expect(forged.status()).toBe(200);
  await expect(rows).toHaveCount(SHOPPER_ORDERS_PAGE);
});

test('an order the shopper doesn’t own is refused exactly as one that doesn’t exist', async ({
  page,
}, info) => {
  const s = accountSeed(info.project.name);
  const seen: string[] = [];
  for (const id of [s.stranger, s.erased, 'ord_nothing_here']) {
    const res = (await page.goto(`/account/orders/${id}`))!;
    expect(res.status(), id).toBe(404);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['referrer-policy']).toBe('same-origin');
    await expect(page.getByText('We can’t find that order under your account.')).toBeVisible();
    seen.push(await page.locator('main').innerText());
    await fits(page);
  }
  // The same words each time: nothing says whether the order exists.
  expect(new Set(seen.map((t) => t.replaceAll(/ord_\w+/g, ''))).size).toBe(1);
  await touchable(page);
  await noViolations(page);
  await page.getByRole('link', { name: 'Back to your account' }).click();
  await expect(page).toHaveURL(/\/account$/);
});

test('shows the shopper’s saved addresses, never a business customer’s, and forgets one at a time', async ({
  page,
  context,
  baseURL,
}, info) => {
  const s = accountSeed(info.project.name);
  const res = (await page.goto('/account/addresses'))!;
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Your addresses', level: 1 })).toBeVisible();
  await expect(page.getByText('1 Main St')).toBeVisible();
  await expect(page.getByText('9 Oak Ave')).toBeVisible();
  await expect(page.getByText('77 Dock Rd')).toHaveCount(0);
  await fits(page);
  await touchable(page);
  await isPrivate(page, res);
  await noViolations(page);

  // The other shopper of the project forgets one: a plain form post, back to the list.
  await context.clearCookies();
  await context.addCookies([
    { name: 'cw_shop', value: s.forgetSecret, url: baseURL!, httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto('/account/addresses');
  const forgettable = page.getByRole('button', { name: /^Forget / });
  const before = await forgettable.count();
  expect(before).toBeGreaterThan(1);
  const first = (await forgettable.first().getAttribute('aria-label'))!;
  await forgettable.first().click();
  await expect(page).toHaveURL(/\/account\/addresses$/);
  await expect(page.getByRole('button', { name: first })).toHaveCount(0);
  await expect(forgettable).toHaveCount(before - 1);
  // The first shopper's own list is untouched by it.
  await context.clearCookies();
  await context.addCookies([
    { name: 'cw_shop', value: s.secret, url: baseURL!, httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto('/account/addresses');
  await expect(page.getByText('1 Main St')).toBeVisible();
});

test('without a session the pages go to sign-in, and a cross-site post is refused', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  await context.clearCookies();
  for (const path of ['/account', '/account/addresses', '/account/orders/ord_1']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/account\/sign-in$/);
  }
  const s = accountSeed('desktop');
  const cross = await request.post(`${baseURL}/account/addresses`, {
    headers: {
      origin: 'https://evil.test',
      'sec-fetch-site': 'cross-site',
      cookie: `cw_shop=${s.forgetSecret}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    data: 'forget=book:adr_e2e_desktop_f2',
  });
  expect(cross.status()).toBe(403);
});

test('the hosted checkout offers a signed-in shopper their saved details, and no one else', async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: `cw_chk_${CHECKOUT_ID}`, value: CHECKOUT_SECRET, url: baseURL! },
  ]);
  const res = (await page.goto(`/checkout/${CHECKOUT_ID}`))!;
  expect(res.status()).toBe(200);
  const offer = page.getByRole('heading', { name: 'Your saved details', level: 2 });
  await expect(offer).toBeVisible();
  await expect(page.getByText(/Signed in as .*-acct@e2e\.test/)).toBeVisible();
  const shipTo = page.getByRole('radio', { name: /1 Main St/ });
  await expect(shipTo).toBeChecked();
  await expect(page.getByRole('radio', { name: /9 Oak Ave/ })).toBeVisible();
  await expect(page.getByText('77 Dock Rd')).toHaveCount(0);
  const fill = page.getByRole('button', { name: 'Use these details' });
  await expect(fill).toBeVisible();
  expect((await fill.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  await fits(page);
  // Plain controls in the one form, so it works without a script.
  expect(await fill.getAttribute('type')).toBe('submit');
  expect(await shipTo.getAttribute('name')).toBe('saved');
  expect(res.headers()['cache-control']).toBe('no-store');
  // Nothing of the page goes to another origin (`no-referrer` before #88, `same-origin` after).
  expect(['no-referrer', 'same-origin']).toContain(res.headers()['referrer-policy']);
  await noViolations(page);

  // Signed out, the page is the checkout and nothing is offered.
  await context.clearCookies({ name: 'cw_shop' });
  await page.goto(`/checkout/${CHECKOUT_ID}`);
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  await expect(offer).toHaveCount(0);
});
