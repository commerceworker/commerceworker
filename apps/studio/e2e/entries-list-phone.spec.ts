import { expect, type Page, test } from '@playwright/test';
import { createDraft, openCms, seedCms, useCmsScope } from './cms';

/*
 * The entries list on a phone: each row is a card, and the toolbar has to leave the search room.
 * Layout is what jsdom can't judge, so it is measured here in WebKit on an iPhone.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** A row's status badge and when it changed: on one line, however the columns are ordered. */
async function expectStatusBesideUpdated(page: Page, title: string) {
  const row = page.getByRole('row', { name: new RegExp(title) });
  const status = row.getByText('Draft', { exact: true });
  const updated = row.locator('time');
  await expect(status).toBeVisible();
  await expect(updated).toBeVisible();
  const [s, u] = [(await status.boundingBox())!, (await updated.boundingBox())!];
  const middle = (b: typeof s) => b.y + b.height / 2;
  expect(Math.abs(middle(s) - middle(u)), 'status and Updated share a line').toBeLessThan(s.height);
  expect(u.x, 'the status comes first').toBeGreaterThan(s.x + s.width - 1);
}

test('a row’s status shares a line with Updated, and stays whatever the columns', async ({
  page,
  request,
}) => {
  const title = `Phone ${Date.now()}`;
  await createDraft(request, title);
  await openCms(page, '/content/article');
  await expectStatusBesideUpdated(page, title);

  // A view's own column order doesn't move the status to a line of its own.
  await openCms(page, '/content/article?columns=sys.updatedAt,sys.status');
  await expectStatusBesideUpdated(page, title);

  // Status left out of the columns still shows here: it is how a row reads on a phone.
  await openCms(page, '/content/article?columns=sys.updatedAt');
  await expectStatusBesideUpdated(page, title);
  await openCms(page, '/content/article?columns=title');
  await expect(
    page.getByRole('row', { name: new RegExp(title) }).getByText('Draft', { exact: true }),
  ).toBeVisible();
});

test('the search has its own full-width row, with the buttons beside each other', async ({
  page,
}) => {
  await openCms(page, '/content/article');
  const search = page.getByRole('searchbox', { name: 'Search entries' });
  await expect(search).toBeVisible();
  const box = (await search.boundingBox())!;
  const { width } = page.viewportSize()!;
  expect(box.width, `the search is ${box.width}px of ${width}`).toBeGreaterThan(width * 0.8);

  const views = (await page.getByRole('button', { name: 'Views' }).boundingBox())!;
  const filters = (await page.getByRole('button', { name: /^Filters/ }).boundingBox())!;
  const mine = (await page.getByRole('button', { name: 'Mine' }).boundingBox())!;
  expect(views.y, 'the buttons sit under the search').toBeGreaterThanOrEqual(box.y + box.height);
  expect(filters.y).toBe(views.y);
  expect(mine.y).toBe(views.y);
  // A phone's rows show no field columns, so there is nothing for the picker to do here.
  await expect(page.getByRole('button', { name: 'Columns' })).toBeHidden();

  const [scroll, inner] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${inner}px viewport`).toBeLessThanOrEqual(inner);
});
