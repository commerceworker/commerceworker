import { expect, type Page, test } from '@playwright/test';
import { isTouch, open } from './helpers';

/** The sheet's own fields start and end inside the screen, never scroll it sideways, and read at 16px on touch. */
async function fits(page: Page, touch: boolean) {
  const sheet = page.getByRole('dialog');
  const width = page.viewportSize()!.width;
  for (const field of await sheet
    .locator('input:not([type=hidden], [type=checkbox]), select')
    .all()) {
    await field.scrollIntoViewIfNeeded();
    const box = await field.boundingBox();
    expect(box!.x, 'a field starts inside the screen').toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, 'and ends inside it').toBeLessThanOrEqual(width);
    if (touch)
      expect(
        await field.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
  }
  expect(
    await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'the sheet has no sideways scroll',
  ).toBe(true);
}

test('a business customer’s page shows its company, members and teams without scrolling sideways', async ({
  page,
}) => {
  await open(page, '/customers/cus_northwind');
  await expect(page.getByRole('heading', { name: 'Company', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
  await expect(page.getByText('Northwind Traders Ltd')).toBeVisible();
  await expect(page.getByText('nora@northwind.example')).toBeAttached();
  await expect(page.getByRole('list', { name: 'Company teams' })).toContainText('Warehouse');
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
});

test('the company’s controls take a 44px tap on touch screens', async ({ page }, info) => {
  test.skip(!isTouch(info), 'touch screens only');
  await open(page, '/customers/cus_northwind');
  const small = await page.$$eval('#company button, #members button, #teams button', (els) =>
    els
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        // A control's tap area is its `hit-area` pseudo-element: a 44px box on touch.
        const after = getComputedStyle(el, '::after');
        const h = Math.max(el.getBoundingClientRect().height, Number.parseFloat(after.height) || 0);
        return { name: el.getAttribute('aria-label') ?? el.textContent, h };
      })
      .filter((c) => c.h < 44),
  );
  expect(small).toEqual([]);
});

test('adding a member opens a form that fits the screen and reads at 16px on touch', async ({
  page,
}, info) => {
  await open(page, '/customers/cus_northwind');
  await page.getByRole('button', { name: 'Add member' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Work email')).toBeVisible();
  await expect(sheet.getByLabel('Role')).toBeVisible();
  await expect(sheet.getByLabel('Team')).toBeVisible();
  await fits(page, isTouch(info));
});

test('editing the customer offers its fields, but not the credit limit', async ({ page }, info) => {
  await open(page, '/customers/cus_northwind');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Name')).toHaveValue('Northwind Traders');
  await expect(sheet.getByLabel('Pricing tier')).toHaveValue('gold');
  await expect(sheet.getByLabel(/credit/i)).toHaveCount(0);
  await fits(page, isTouch(info));
});

test('the customers list filters by kind and company status, and offers a new customer', async ({
  page,
}, info) => {
  await open(page, '/commerce');
  const customers = page.locator('#customers');
  await expect(customers.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();
  await customers.getByLabel('Company status').selectOption('active');
  await expect(page).toHaveURL(/customer-status=active/);
  await expect(customers.getByRole('link', { name: 'Northwind Traders' })).toBeVisible();
  // A consumer has no company, so a status leaves it out.
  await expect(customers.getByRole('link', { name: 'Ada Lovelace' })).toHaveCount(0);
  await customers.getByLabel('Kind').selectOption('consumer');
  await expect(page).toHaveURL(/customer-kind=consumer/);
  await expect(customers).toContainText('No customers match those filters');
  await customers.getByRole('link', { name: 'Clear filters' }).click();
  await expect(customers.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();

  await customers.getByRole('button', { name: 'New customer' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Name', { exact: true })).toBeVisible();
  await expect(sheet.getByLabel('Legal name (optional)')).toBeVisible();
  // Only a business customer has a company's details.
  await sheet.getByLabel('Kind').selectOption('consumer');
  await expect(sheet.getByLabel('Legal name (optional)')).toHaveCount(0);
  await sheet.getByLabel('Kind').selectOption('business');
  await fits(page, isTouch(info));
});

test('a company’s budgets show their spend as a bar and in words, and its ledger opens', async ({
  page,
}) => {
  await open(page, '/customers/cus_northwind');
  const budgets = page.locator('#budgets');
  await expect(budgets.getByRole('heading', { name: 'Budgets', exact: true })).toBeVisible();
  const fitout = budgets.getByRole('listitem').filter({ hasText: 'Warehouse fit-out' });
  // The figure is words as well as a bar, and the meter is there for assistive tech.
  await expect(fitout).toContainText('$9,600.00');
  await expect(fitout).toContainText('Nearly spent');
  await expect(fitout.getByLabel('Warehouse fit-out spend')).toHaveAttribute('value', '9600');
  await expect(budgets.getByRole('listitem').filter({ hasText: 'Office supplies' })).toContainText(
    'Within budget',
  );
  await fitout.getByRole('link', { name: 'Spend ledger of Warehouse fit-out' }).click();
  const ledger = page.getByRole('region', { name: 'Spend ledger' });
  await expect(ledger).toContainText('ord_demo_fitout_1');
  // The reversed order's spend is on the ledger, marked as given back.
  await expect(ledger.getByRole('row').filter({ hasText: 'ord_demo_fitout_2' })).toContainText(
    'Reversed',
  );
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
});

test('the budgets’ controls take a 44px tap on touch screens', async ({ page }, info) => {
  test.skip(!isTouch(info), 'touch screens only');
  await open(page, '/customers/cus_northwind');
  const small = await page.$$eval('#budgets button, #budgets a', (els) =>
    els
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const after = getComputedStyle(el, '::after');
        const h = Math.max(el.getBoundingClientRect().height, Number.parseFloat(after.height) || 0);
        return { name: el.getAttribute('aria-label') ?? el.textContent, h };
      })
      .filter((c) => c.h < 44),
  );
  expect(small).toEqual([]);
});

test('adding a budget opens a form that fits the screen and reads at 16px on touch', async ({
  page,
}, info) => {
  await open(page, '/customers/cus_northwind');
  await page.getByRole('button', { name: 'Add budget' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Amount')).toBeVisible();
  await expect(sheet.getByLabel('Period')).toBeVisible();
  await expect(sheet.getByLabel('Applies to')).toBeVisible();
  await expect(sheet.getByLabel('Enforcement')).toBeVisible();
  await fits(page, isTouch(info));
});

test('editing a budget fixes its period and team', async ({ page }) => {
  await open(page, '/customers/cus_northwind');
  await page.getByRole('button', { name: 'Edit Office supplies' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Name')).toHaveValue('Office supplies');
  await expect(sheet.getByLabel('Period')).toBeDisabled();
  await expect(sheet.getByLabel('Applies to')).toBeDisabled();
});
