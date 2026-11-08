import { expect, test } from '@playwright/test';
import { asFreshDeployment, openCms } from './cms';

/**
 * The first run: a deployment admin (local development is open, so the person is one) meets the
 * no-spaces notice, creates a space with the sample content from it, and lands in that space with
 * the sample content model and entries on screen.
 */
test('a deployment admin creates the first space with sample content and lands in it', async ({
  page,
}) => {
  const stamp = Date.now().toString(36);
  const name = `First ${stamp}`;
  const id = `first-${stamp}`;
  await asFreshDeployment(page, (spaceId) => spaceId === id);

  await openCms(page, '/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first space' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a space' }).click();

  const dialog = page.getByRole('dialog', { name: 'New space' });
  await expect(dialog.getByRole('radio', { name: /Start with sample content/ })).toBeChecked();
  await dialog.getByLabel('Name').fill(name);
  await expect(dialog.getByLabel('Space ID')).toHaveValue(id);
  await dialog.getByRole('button', { name: 'Create space' }).click();
  // The install runs in the request; allow it its time on a shared CI runner.
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // In the new space, with the sample content model on the Content page.
  await expect(page.getByRole('heading', { name: 'Create your first space' })).toBeHidden();
  await openCms(page, '/content');
  for (const type of ['Article', 'Author', 'Product']) {
    await expect(page.getByRole('main').getByText(type, { exact: true }).first()).toBeVisible();
  }
  const scope = await page.evaluate(() => localStorage.getItem('commerceworker-scope'));
  expect(JSON.parse(scope ?? '{}').space).toBe(id);
});

/**
 * Setup's first-space step: Coworker's conversation, with the form one press away. The form makes
 * the space and lands in it; skipping goes to the overview, where the notice still offers one.
 */
test('setup’s first-space step creates the space from its form and lands in it', async ({
  page,
}) => {
  const stamp = Date.now().toString(36);
  const id = `step-${stamp}`;
  await asFreshDeployment(page, (spaceId) => spaceId === id);

  await openCms(page, '/setup/space');
  await expect(page.getByRole('heading', { name: 'Your first space', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Set up with Coworker' })).toBeVisible();
  await page.getByRole('button', { name: 'Fill in a form instead' }).click();

  const dialog = page.getByRole('dialog', { name: 'New space' });
  await dialog.getByLabel('Name').fill(`Step ${stamp}`);
  await dialog.getByRole('radio', { name: /Empty space/ }).check();
  await dialog.getByRole('button', { name: 'Create space' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Create your first space' })).toBeHidden();
  const scope = await page.evaluate(() => localStorage.getItem('commerceworker-scope'));
  expect(JSON.parse(scope ?? '{}').space).toBe(id);
});

test('skipping setup’s first-space step leaves the overview offering one', async ({ page }) => {
  await asFreshDeployment(page, () => false);
  await openCms(page, '/setup/space');
  await page.getByRole('link', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Create your first space' })).toBeVisible();
});
