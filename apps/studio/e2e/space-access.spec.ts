import { expect, test } from '@playwright/test';
import { api, openCms, SPACE, seedCms, useCmsScope } from './cms';

/**
 * Settings → Space access (the per-space team, apart from the deployment's People and sign-in):
 * changing a key's role asks in place, and the change reaches the api.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

test('changes a key’s role with an inline confirm', async ({ page, request }) => {
  const name = `e2e-team-${Date.now()}`;
  const minted = await api(request, 'POST', `/spaces/${SPACE}/api-keys`, { kind: 'cda', name });
  expect(minted.ok(), await minted.text()).toBe(true);

  await openCms(page, '/settings/team');
  await expect(page.getByRole('heading', { name: 'People in this space' })).toBeVisible();
  await expect(
    page.locator('#main').getByRole('link', { name: 'People and sign-in' }),
  ).toHaveAttribute('href', '/team');

  await page.getByLabel(`Role for ${name}`).selectOption({ label: 'Approver' });
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(`Change ${name} to Approver?`);
  await confirm.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByText(`${name} is now Approver`)).toBeVisible();

  const team = (await (await api(request, 'GET', `/spaces/${SPACE}/team`)).json()) as {
    keys: { name?: string; role: { preset?: string } | null }[];
  };
  expect(team.keys.find((k) => k.name === name)?.role?.preset).toBe('approver');
});
