import { expect, test } from '@playwright/test';
import { clientHeaders, fits, isPrivate, noViolations, touchable } from './device';
import { CODE, codeSeed, linkSeed } from './shopper-seed';

/**
 * A shopper's sign-in on each device: the pages (`/account/sign-in`, `/account/code`,
 * `/account/confirm/<token>`, `/account`) fit the screen, every control is 44px and every field 16px,
 * nothing is cached or sent in a Referer, and a code and a link each sign in once, with the cookie
 * an HttpOnly one the page can't read. The sign-ins are written by `e2e/shopper-seed.ts`, one pair per
 * device project, since each works once. The device tests' engine has no Email Sending, so asking for
 * a code is tested to say so.
 */

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders(clientHeaders(info.project.name));
});

test('asking for a code: a form that fits, is private, and says when mail can’t be sent', async ({
  page,
}) => {
  const res = (await page.goto('/account/sign-in'))!;
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'email');
  await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email');
  await fits(page);
  await touchable(page);
  await isPrivate(page, res);
  await noViolations(page);
  // Guest checkout stays on, and the page says so.
  await expect(page.getByText(/as a guest works without an account/)).toBeVisible();

  // The device tests' engine can't send mail: the answer says so, keeps what was typed, and sets no cookie.
  await page.getByLabel('Email').fill('Pat@Example.com');
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Send code' }).click(),
  ]);
  expect(answer.status()).toBe(503);
  await expect(page.getByText('Signing in isn’t available here.')).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(/^pat@example\.com$/i);
  expect(await page.context().cookies()).toEqual([]);
  await fits(page);
});

test('a link signs in once, only when tapped, and never by being opened', async ({
  page,
  context,
}, info) => {
  const link = linkSeed(info.project.name, 'flow');
  const path = `/account/confirm/${link.token}`;
  const res = (await page.goto(path))!;
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
  // Who the link is for, masked, before anything is tapped.
  await expect(page.getByText(`${link.email[0]}***@e2e.test`)).toBeVisible();
  await fits(page);
  await touchable(page);
  await isPrivate(page, res);
  await noViolations(page);
  // Opening it, as a mail scanner does, signed no one in and used nothing up: it opens again.
  expect(await context.cookies()).toEqual([]);
  expect(res.headers()['set-cookie']).toBeUndefined();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Your orders', level: 1 })).toBeVisible();
  await expect(page.getByText(link.email, { exact: true })).toBeVisible();
  await fits(page);
  await touchable(page);
  await noViolations(page);

  // The session's cookie: HttpOnly, SameSite=Lax, held by the browser and not by any script.
  const [cookie] = await context.cookies();
  expect(cookie).toMatchObject({ name: 'cw_shop', httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(cookie!.value).toMatch(/^[0-9a-f]{64}$/);
  expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(29 * 86_400);
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // Still signed in on a reload, and the sign-in pages send them on to their account.
  await page.reload();
  await expect(page.getByText(link.email, { exact: true })).toBeVisible();
  await page.goto('/account/sign-in');
  await expect(page).toHaveURL(/\/account$/);

  // The link is spent.
  await context.clearCookies();
  // Its page now says so, with no button, since the preview finds nothing to sign in.
  const spent = (await page.goto(path))!;
  expect(spent.status()).toBe(410);
  await expect(page.getByText(/has been used or has expired/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await fits(page);
  expect(await context.cookies()).toEqual([]);
});

test('a code signs in once: a wrong one is refused without saying why, the right one works', async ({
  page,
  context,
}, info) => {
  const code = codeSeed(info.project.name);
  const res = (await page.goto(`/account/code?email=${encodeURIComponent(code.email)}`))!;
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Check your email', level: 1 })).toBeVisible();
  await expect(page.getByText(code.email, { exact: true })).toBeVisible();
  const field = page.getByLabel('Code');
  await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(field).toHaveAttribute('inputmode', 'numeric');
  await fits(page);
  await touchable(page);
  await isPrivate(page, res);
  await noViolations(page);

  await field.fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/That code didn’t work/)).toBeVisible();
  expect(await context.cookies()).toEqual([]);
  // The address is still shown, ready for another try.
  await expect(page.getByText(code.email, { exact: true })).toBeVisible();
  await fits(page);

  await page.getByLabel('Code').fill(CODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText(code.email, { exact: true })).toBeVisible();
  expect((await context.cookies())[0]).toMatchObject({ name: 'cw_shop', httpOnly: true });
});

test('signing out ends the session at the engine, and the old cookie is no longer anyone', async ({
  page,
  context,
}, info) => {
  const link = linkSeed(info.project.name, 'signout');
  await page.goto(`/account/confirm/${link.token}`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The cookie is set by the response that redirects here: read it once the page has arrived.
  await expect(page).toHaveURL(/\/account$/);
  const secret = (await context.cookies()).find((c) => c.name === 'cw_shop')!.value;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/account\/sign-in$/);
  expect((await context.cookies()).find((c) => c.name === 'cw_shop')).toBeUndefined();
  // Put the old cookie back: the engine ended it, so it names no one.
  await context.addCookies([
    { name: 'cw_shop', value: secret, url: page.url(), httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto('/account');
  await expect(page).toHaveURL(/\/account\/sign-in$/);
});

test('the account page without a session goes to sign-in, and the code page without an address too', async ({
  page,
}) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/account\/sign-in$/);
  await page.goto('/account/code');
  await expect(page).toHaveURL(/\/account\/sign-in$/);
  await page.goto('/account/confirm/not-a-token');
  await expect(page.getByText('This link isn’t valid.')).toBeVisible();
  await fits(page);
});
