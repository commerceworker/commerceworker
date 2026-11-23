import { expect, test } from '@playwright/test';
import { isTouch, open } from './helpers';

// Addresses no seeded record holds: erasing a seeded customer would change other tests' data.
const someone = (info: { project: { name: string } }) =>
  `nobody-${info.project.name}-${Date.now()}@example.com`;

test('an admin downloads what is held about a person, as a file', async ({ page }, info) => {
  await open(page, '/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy requests', level: 1 })).toBeVisible();
  const button = page.getByRole('button', { name: 'Download their data' });
  await expect(button).toBeDisabled();
  const email = someone(info);
  await page.getByLabel('Email address').fill(email);
  if (isTouch(info)) {
    const size = await page
      .getByLabel('Email address')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  }
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toBe('personal-data.json');
});

test('erasing asks for the address again, then says what it erased', async ({ page }, info) => {
  await open(page, '/privacy');
  const email = someone(info);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Type the address again to confirm').fill('someone-else@example.com');
  await page.getByRole('button', { name: 'Erase this person' }).click();
  await expect(page.getByRole('alert')).toContainText('Type the address again');
  await page.getByLabel('Type the address again to confirm').fill(email);
  await page.getByRole('button', { name: 'Erase this person' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Erased.' })).toContainText(
    'Nothing was held about this address',
  );
  // The request is listed, naming the person by a hash only.
  const recent = page.getByRole('table', { name: 'Recent privacy requests' });
  await expect(recent.getByText('Erased', { exact: true }).first()).toBeVisible();
  await expect(recent).not.toContainText(email);
});
