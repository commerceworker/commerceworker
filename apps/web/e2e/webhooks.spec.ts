import { expect, test } from '@playwright/test';
import { isTouch, open } from './helpers';

test('an admin adds a webhook subscription, sees its secret once, and picks the events', async ({
  page,
}, info) => {
  await open(page, '/webhooks');
  await expect(page.getByRole('heading', { name: 'Webhooks', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New subscription' }).click();
  const sheet = page.getByRole('dialog');
  // A private address is refused when it's added, not at every delivery.
  await sheet.getByLabel('Address').fill('https://10.0.0.5/hooks');
  await sheet.getByRole('button', { name: 'Add subscription' }).click();
  await expect(sheet.getByRole('alert')).toContainText('public host name');
  // Choosing events one by one: none chosen is refused too.
  await sheet.getByLabel('Every event, including ones added later').click();
  await expect(sheet.getByLabel('order.shipped')).toBeVisible();
  const url = `https://hooks.example.com/${info.project.name}-${Date.now()}`;
  await sheet.getByLabel('Address').fill(url);
  await sheet.getByLabel('order.shipped').click();
  await sheet.getByLabel('order.paid').click();
  if (isTouch(info)) {
    const size = await sheet
      .getByLabel('Address')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  }
  await sheet.getByRole('button', { name: 'Add subscription' }).click();
  await expect(sheet).toBeHidden();
  const secret = page.getByRole('note');
  await expect(secret).toContainText('Signing secret for the new subscription');
  await expect(secret.locator('code')).toHaveText(/^whsec_[0-9a-f]{48}$/);
  const row = page.getByRole('listitem').filter({ hasText: url });
  await expect(row).toContainText('order.paid, order.shipped');
  // Its deliveries show under it once chosen; a new one has none.
  await row.getByRole('link', { name: url }).click();
  await expect(page.getByRole('heading', { name: 'Deliveries' })).toBeVisible();
  await expect(page.getByText('Nothing sent yet.')).toBeVisible();
  // The secret isn't shown again after a reload.
  await page.reload();
  await expect(page.getByRole('note')).toHaveCount(0);
});

test('rotating a secret shows the new one once and says the old one still signs', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'the same form on every device');
  await open(page, '/webhooks');
  await page.getByRole('button', { name: 'New subscription' }).click();
  const url = `https://hooks.example.com/rotate-${Date.now()}`;
  await page.getByRole('dialog').getByLabel('Address').fill(url);
  await page.getByRole('dialog').getByRole('button', { name: 'Add subscription' }).click();
  const first = await page.getByRole('note').locator('code').textContent();
  const row = page.getByRole('listitem').filter({ hasText: url });
  await row.getByRole('button', { name: 'Rotate secret' }).click();
  await row.getByRole('button', { name: 'Rotate now' }).click();
  await expect(page.getByRole('note')).toContainText('New signing secret');
  await expect(page.getByRole('note').locator('code')).not.toHaveText(first!);
  await expect(page.getByRole('listitem').filter({ hasText: url })).toContainText(
    'the previous secret also signs until',
  );
});
