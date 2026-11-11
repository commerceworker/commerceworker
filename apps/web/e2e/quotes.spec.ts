import { expect, type Page, test } from '@playwright/test';
import { isTouch, open } from './helpers';

const noSidewaysScroll = async (page: Page) => {
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
};

test('quotes: the list and its filters fit the screen', async ({ page }) => {
  await open(page, '/quotes');
  await expect(page.getByRole('heading', { name: 'Quotes', level: 1 })).toBeVisible();
  const filters = page.getByRole('form', { name: 'Filter quotes' });
  await expect(filters.getByLabel('Status')).toBeVisible();
  await expect(filters.getByLabel('Company')).toBeVisible();
  await noSidewaysScroll(page);
  // A filter is a link: it survives a reload.
  await filters.getByLabel('Name').fill('NOPE-NOT-A-QUOTE');
  await filters.getByRole('button', { name: 'Filter' }).click();
  await expect(page).toHaveURL(/q=NOPE-NOT-A-QUOTE/);
  await expect(page.getByText('No quotes match.')).toBeVisible();
  await noSidewaysScroll(page);
});

test('quotes: the new form reads at 16px on touch and starts a draft that opens in its editor', async ({
  page,
}, info) => {
  await open(page, '/quotes');
  await page.getByRole('button', { name: 'New quote' }).click();
  const sheet = page.getByRole('dialog');
  const width = page.viewportSize()!.width;
  for (const field of await sheet.locator('input:not([type=hidden]), select').all()) {
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (isTouch(info))
      expect(
        await field.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
  }
  const name = `E2E quote ${info.project.name} ${Date.now()}`;
  await sheet.getByLabel('Company').selectOption({ label: 'Northwind Traders' });
  await sheet.getByLabel('Name', { exact: true }).fill(name);
  await sheet.getByLabel('SKU').first().fill('WID-100');
  await sheet.getByLabel('Up to qty').first().fill('10');
  await sheet.getByLabel('Quoted price').first().fill('20');
  await sheet.getByRole('button', { name: 'Save draft' }).click();
  // A draft opens in its editor, with Send and Withdraw offered, and its one version listed.
  await expect(page).toHaveURL(/\/quotes\/qt_/);
  await expect(page.getByRole('heading', { name: `Quote ${name}` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Draft', exact: true })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
  // The assistant panel has a Send button of its own: the page's is in main.
  await expect(
    page.locator('main').getByRole('button', { name: 'Send', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  await expect(page.getByText('Version 1', { exact: true })).toBeVisible();
  await noSidewaysScroll(page);
  if (isTouch(info)) {
    const small = await page.$$eval('main button, main a[href^="/customers/"]', (els) =>
      els
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => {
          const after = getComputedStyle(el, '::after');
          const h = Math.max(
            el.getBoundingClientRect().height,
            Number.parseFloat(after.height) || 0,
          );
          return { name: el.getAttribute('aria-label') ?? el.textContent, h };
        })
        .filter((c) => c.h < 44),
    );
    expect(small.map((s) => s.name)).toEqual([]);
  }
});
