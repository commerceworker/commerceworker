import { expect, test } from '@playwright/test';
import { isTouch, open } from './helpers';

test('an admin adds an integration with what it may do, and sees its secret once', async ({
  page,
}, info) => {
  await open(page, '/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New integration' }).click();
  const sheet = page.getByRole('dialog');
  const name = `Payments ${info.project.name} ${Date.now()}`;
  await sheet.getByLabel('Name').fill(name);
  // Neither events nor orders: it would do nothing, so it's refused.
  await sheet.getByRole('button', { name: 'Add integration' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Choose the events it may send');
  await sheet.getByLabel('payment.received').click();
  await sheet.getByLabel('Others your flows wait for').fill('carrier.exception');
  await sheet.getByLabel('It may start orders').click();
  await expect(sheet.getByLabel('On any flow, or the one routing picks')).toBeChecked();
  await sheet.getByLabel('Only orders on').selectOption('edi');
  if (isTouch(info)) {
    const size = await sheet
      .getByLabel('Name')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  }
  await sheet.getByRole('button', { name: 'Add integration' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('note')).toContainText(`Signing secret for ${name}`);
  await expect(page.getByRole('note').locator('code')).toHaveText(/^whsec_[0-9a-f]{48}$/);
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toContainText(
    'Sends Payment, carrier.exception · starts orders · EDI orders only',
  );
  await expect(row).toContainText('Not used yet');
  await page.reload();
  await expect(page.getByRole('note')).toHaveCount(0);
});

test('rotating shows the new secret once and says the old one still works', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'the same form on every device');
  await open(page, '/integrations');
  await page.getByRole('button', { name: 'New integration' }).click();
  const name = `Rotate ${Date.now()}`;
  await page.getByRole('dialog').getByLabel('Name').fill(name);
  await page.getByRole('dialog').getByLabel('Any event').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add integration' }).click();
  const first = await page.getByRole('note').locator('code').textContent();
  const row = page.getByRole('listitem').filter({ hasText: name });
  await row.getByRole('button', { name: 'Rotate secret' }).click();
  await row.getByRole('button', { name: 'Rotate now' }).click();
  await expect(page.getByRole('note')).toContainText(`New signing secret for ${name}`);
  await expect(page.getByRole('note').locator('code')).not.toHaveText(first!);
  await expect(page.getByRole('listitem').filter({ hasText: name })).toContainText(
    'the previous secret also works until',
  );
});
