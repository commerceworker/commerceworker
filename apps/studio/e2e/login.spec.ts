import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { open } from './helpers';
import { settle } from './settle';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page, testInfo: TestInfo) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  await testInfo.attach('axe', { body: JSON.stringify(results.violations, null, 2) });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`),
  ).toEqual([]);
}

/**
 * Sign-in end to end. It turns sign-in on for the whole dev server (the first admin ends open
 * local development), so it runs in its own project after every device project
 * (playwright.config.ts), once.
 */
test('the first admin turns sign-in on; signing out and in again lands on the two-factor step', async ({
  page,
}, testInfo) => {
  const email = 'first-admin@example.com';
  const password = 'correct horse battery staple';

  await open(page, '/team');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  // Admins must use two-factor sign-in until an admin chooses otherwise: the first admin gets
  // setup's two-factor step, that alone, and nothing else opens meanwhile.
  await expect(page).toHaveURL(/\/setup\/two-factor$/);
  await expect(page.getByRole('heading', { name: 'Turn on two-factor sign-in' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await expect(page.getByLabel('Code from the app')).toBeFocused();
  await scan(page, testInfo);
  // Nothing else opens until it is on, Account included.
  for (const path of ['/dashboard', '/account', '/team']) {
    await open(page, path);
    await expect(page).toHaveURL(/\/setup\/two-factor$/);
  }

  // Signing out is the one other way off it.
  await page.getByRole('link', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/logout/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Signed out, the shell sends you to sign in, and the gateway forwards without credentials.
  await open(page, '/dashboard');
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('don’t match');

  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/two-factor$/);

  // Forgotten passwords: asking for a code answers the same for any address, and a wrong code
  // reads the same as an expired one. (The code itself goes to the dev server's log, so the rest
  // of the flow is tested in tests/password-reset.test.ts.) The password stays as it was, for
  // the projects that sign in after this one.
  await test.step('a forgotten password can be reset by email', async () => {
    await open(page, '/logout');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeFocused();
    await scan(page, testInfo);

    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a code' }).click();
    await expect(page).toHaveURL(/\/login\/reset$/);
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(`If ${email} belongs to an account`)).toBeVisible();
    await expect(page.getByLabel('Code')).toBeFocused();
    await scan(page, testInfo);

    await page.getByLabel('Code').fill('2222-2222');
    await page.getByLabel('New password').fill('a brand new horse battery');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('alert')).toContainText('isn’t right');
    await scan(page, testInfo);
  });
});
