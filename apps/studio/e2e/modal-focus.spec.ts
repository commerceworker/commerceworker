import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import {
  api,
  createDraft,
  MGMT,
  openCms,
  seedAsset,
  seedAssetFolder,
  seedCms,
  useCmsScope,
  withoutAssistant,
} from './cms';
import { settle } from './settle';

/*
 * Closing a modal hands focus back to what opened it, however it was opened. WebKit is why this
 * runs in a real browser: a pressed button doesn't take focus there, so `document.activeElement`
 * alone can't say what asked. Runs in Chromium (`cms`) and WebKit (`desktop`).
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
  await withoutAssistant(page);
});

type Way = 'pointer' | 'keyboard';

async function press(page: Page, control: Locator, way: Way) {
  if (way === 'pointer') return control.click();
  await control.focus();
  await page.keyboard.press('Enter');
}

/** Opens `surface` from `opener` and closes it the same way; focus must be back on `opener`. */
async function roundTrip(page: Page, way: Way, opener: Locator, surface: Locator, out: Locator) {
  await press(page, opener, way);
  await expect(surface).toBeVisible();
  // Radix hands Escape from layer to layer a render after one opens: pressed in that frame, faster
  // than a hand, it would reach the layer underneath as well.
  await settle(page);
  if (way === 'pointer') await out.click();
  else await page.keyboard.press('Escape');
  await expect(surface).toBeHidden();
  await expect(opener).toBeFocused();
}

/** A new asset's card, in a folder of its own: other specs' assets can't push it off the page. */
async function assetCard(page: Page, request: APIRequestContext, way: Way) {
  const title = `Focus ${way} ${Date.now()}`;
  const folderId = await seedAssetFolder(request, title);
  await seedAsset(request, title, { folderId });
  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: title, exact: true })
    .click();
  return page
    .getByRole('region', { name: 'Asset library' })
    .getByRole('button', { name: `Open “${title}”` });
}

for (const way of ['pointer', 'keyboard'] as const) {
  test.describe(`by ${way}`, () => {
    test('New release goes back to its button', async ({ page }) => {
      await openCms(page, '/releases');
      const dialog = page.getByRole('dialog', { name: 'New release' });
      await roundTrip(
        page,
        way,
        page.getByRole('button', { name: 'New release' }),
        dialog,
        dialog.getByRole('button', { name: 'Close' }),
      );
    });

    test('the palette goes back to Search', async ({ page }) => {
      await openCms(page, '/content');
      const search = page.getByRole('button', { name: 'Search' }).first();
      await press(page, search, way);
      const palette = page.getByRole('dialog');
      await expect(palette).toBeVisible();
      if (way === 'pointer') await page.mouse.click(8, 500);
      else await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      await expect(search).toBeFocused();
    });

    test('the asset sheet goes back to its card, and Share over it to Share', async ({
      page,
      request,
    }) => {
      const card = await assetCard(page, request, way);
      await press(page, card, way);
      const sheet = page.getByRole('dialog').first();
      const share = sheet.getByRole('button', { name: 'Share' });
      await expect(share).toBeVisible();

      const dialog = page.getByRole('dialog', { name: /^Share/ });
      await roundTrip(page, way, share, dialog, dialog.getByRole('button', { name: 'Close' }));
      await expect(sheet).toBeVisible();

      if (way === 'pointer') await sheet.getByRole('button', { name: 'Close' }).last().click();
      else await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(card).toBeFocused();
    });

    test('an alert over a dialog goes back into the dialog', async ({ page, request }) => {
      const title = `Focus revoke ${way} ${Date.now()}`;
      const folderId = await seedAssetFolder(request, title);
      await seedAsset(request, title, { folderId, publish: true });
      await openCms(page, '/assets');
      await page
        .getByRole('navigation', { name: 'Folders' })
        .getByRole('button', { name: title, exact: true })
        .click();
      await page.getByRole('button', { name: `Open “${title}”` }).click();
      await page.getByRole('dialog').first().getByRole('button', { name: 'Share' }).click();
      const share = page.getByRole('dialog', { name: /^Share/ });
      await share.getByRole('button', { name: 'Create link' }).click();
      const alert = page.getByRole('alertdialog', { name: /Revoke this link/ });
      await roundTrip(
        page,
        way,
        share.getByRole('button', { name: /Revoke the link/ }),
        alert,
        alert.getByRole('button', { name: 'Cancel' }),
      );
      await expect(share).toBeVisible();
    });

    test('Generate, from the ⋯ menu, goes back to ⋯', async ({ page, request }) => {
      const id = await createDraft(request, `Focus generate ${Date.now()}`);
      await openCms(page, `/content/article/${id}`);
      const more = page.getByRole('button', { name: 'More entry actions' });
      await press(page, more, way);
      await press(page, page.getByRole('menuitem', { name: 'Generate with AI' }), way);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      if (way === 'pointer') await dialog.getByRole('button', { name: 'Close' }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(more).toBeFocused();
    });

    test("the editor's PublishConfirm goes back to Publish", async ({ page, request }) => {
      const id = await createDraft(request, `Focus publish ${Date.now()}`);
      await openCms(page, `/content/article/${id}`);
      const dialog = page.getByRole('alertdialog');
      await roundTrip(
        page,
        way,
        page.getByRole('button', { name: 'Publish', exact: true }),
        dialog,
        dialog.getByRole('button', { name: 'Keep as draft' }),
      );
    });

    test('once published, focus stays on the action bar, not the page', async ({
      page,
      request,
    }) => {
      const id = await createDraft(request, `Focus published ${Date.now()}`);
      await openCms(page, `/content/article/${id}`);
      await press(page, page.getByRole('button', { name: 'Publish', exact: true }), way);
      const dialog = page.getByRole('alertdialog');
      await press(page, dialog.getByRole('button', { name: 'Publish entry' }), way);
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Published', exact: true })).toBeDisabled();
      await expect(page.locator('[data-page-bar] button:focus')).toHaveCount(1);
    });
  });
}

test('a long sheet with nothing to tab to scrolls by keyboard', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 320 });
  await openCms(page, '/content');
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await settle(page);
  const body = sheet.locator('[data-slot="sheet-body"]');
  const scrolled = () => body.evaluate((el) => el.scrollTop);
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // The scroller holds the keyboard, named as the sheet is, and shows that it does.
  await expect(body).toBeFocused();
  await expect(body).toHaveAccessibleName('Keyboard shortcuts');
  await page.keyboard.press('PageDown');
  await expect.poll(scrolled).toBeGreaterThan(0);
  const after = await scrolled();
  await page.keyboard.press('ArrowDown');
  await expect.poll(scrolled).toBeGreaterThan(after);
  // Safari's Tab skips buttons unless the person has asked it not to.
  if (testInfo.project.name === 'cms') {
    await page.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(body).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('a diff with nothing to tab to scrolls by keyboard too', async ({ page, request }) => {
  const title = `Focus diff ${Date.now()}`;
  const id = await createDraft(request, title, 'Live body');
  const published = await api(request, 'POST', `${MGMT}/entries/${id}/published`);
  expect(published.ok(), await published.text()).toBe(true);
  const edited = await api(request, 'PUT', `${MGMT}/entries/${id}`, {
    fields: { title: { 'en-US': title }, body: { 'en-US': 'Long line\n'.repeat(200) } },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  await page.setViewportSize({ width: 1000, height: 320 });
  await openCms(page, '/content/article');
  await page.getByRole('button', { name: `More actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Diff vs published' }).click();
  const sheet = page.getByRole('dialog', { name: 'Diff vs published' });
  const body = sheet.locator('[data-slot="sheet-body"]');
  await expect(sheet.getByText('Long line').first()).toBeVisible();
  await settle(page);
  // A tab stop of its own, or something inside to hold the keyboard: either way, keys scroll it.
  await page.keyboard.press('Tab');
  await expect.poll(() => body.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('PageDown');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

/** Two archived assets in a folder of their own, the folder open; returns their names. */
async function twoAssets(page: Page, request: APIRequestContext, tag: string) {
  const stamp = Date.now();
  const folder = `${tag} ${stamp}`;
  const folderId = await seedAssetFolder(request, folder);
  const names = [`${tag} one ${stamp}`, `${tag} two ${stamp}`] as const;
  for (const name of names) await seedAsset(request, name, { folderId, archive: true });
  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: folder, exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Status' }).selectOption('archived');
  await expect(page.getByRole('button', { name: `Delete “${names[1]}”` })).toBeVisible();
  return names;
}

test('after a delete, focus lands on what stood beside the row, not the page', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const titles = [`Focus gone ${stamp}`, `Focus stays ${stamp}`] as const;
  for (const title of titles) {
    const made = await api(request, 'POST', `${MGMT}/releases`, { title });
    expect(made.ok(), await made.text()).toBe(true);
  }
  // Slower than the dialog's exit, as a real network is.
  await page.route('**/releases/*', async (route) => {
    if (route.request().method() === 'DELETE') await new Promise((r) => setTimeout(r, 500));
    await route.fallback();
  });
  await openCms(page, '/releases');
  await page.getByRole('button', { name: `Delete “${titles[0]}”` }).click();
  const ask = page.getByRole('alertdialog');
  await ask.getByRole('button', { name: 'Delete release' }).click();
  // It holds through the wait, so what it closes onto is the list without the row.
  await expect(ask.getByRole('status')).toBeVisible();
  await expect(ask).toBeHidden();
  await expect(page.getByRole('button', { name: `Delete “${titles[0]}”` })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = document.activeElement;
        return Boolean(a?.matches('button, a[href]') && a.closest('main'));
      }),
    )
    .toBe(true);
});

test('a double press on the confirm sends one delete', async ({ page, request }) => {
  const [gone] = await twoAssets(page, request, 'Focus double');
  const deletes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && r.url().includes('/assets/')) deletes.push(r.url());
  });
  await page.getByRole('button', { name: `Delete “${gone}”` }).click();
  const ask = page.getByRole('alertdialog');
  await settle(page);
  await ask.getByRole('button', { name: 'Delete asset' }).dblclick();
  await expect(page.getByRole('button', { name: `Open “${gone}”` })).toHaveCount(0);
  expect(deletes).toHaveLength(1);
});
