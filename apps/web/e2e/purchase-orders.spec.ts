import { expect, type Page, test } from '@playwright/test';
import { isTouch, open } from './helpers';

const noSidewaysScroll = async (page: Page) => {
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
};

test('purchase orders: the list and its filters fit the screen', async ({ page }) => {
  await open(page, '/purchase-orders');
  await expect(page.getByRole('heading', { name: 'Purchase orders', level: 1 })).toBeVisible();
  const filters = page.getByRole('form', { name: 'Filter purchase orders' });
  await expect(filters.getByLabel('Status')).toBeVisible();
  await expect(filters.getByLabel('Company')).toBeVisible();
  await noSidewaysScroll(page);
  // A filter is a link: it survives a reload.
  await filters.getByLabel('PO number').fill('NOPE-NOT-A-PO');
  await filters.getByRole('button', { name: 'Filter' }).click();
  await expect(page).toHaveURL(/q=NOPE-NOT-A-PO/);
  await expect(page.getByText('No purchase orders match.')).toBeVisible();
  await noSidewaysScroll(page);
});

test('purchase orders: the new form reads at 16px on touch and starts a draft that opens in its editor', async ({
  page,
}, info) => {
  await open(page, '/purchase-orders');
  await page.getByRole('button', { name: 'New purchase order' }).click();
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
  const number = `E2E-${info.project.name}-${Date.now()}`;
  await sheet.getByLabel('Company').selectOption({ label: 'Northwind Traders' });
  await sheet.getByLabel('PO number').fill(number);
  await sheet.getByLabel('SKU').first().fill('WID-100');
  await sheet.getByLabel('Qty').first().fill('3');
  await sheet.getByRole('button', { name: 'Save draft' }).click();
  // A draft opens in its editor, with Submit and Cancel offered.
  await expect(page).toHaveURL(/\/purchase-orders\/po_/);
  await expect(page.getByRole('heading', { name: `Purchase order ${number}` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Draft', exact: true })).toBeVisible();
  await expect(page.getByLabel('PO number')).toHaveValue(number);
  await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel PO' })).toBeVisible();
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
