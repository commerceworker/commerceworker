import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  api,
  createDraft,
  EDITOR_READY,
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
 * Dialogs on a phone: from the bottom, every way out and every action in reach, at the height an
 * on-screen keyboard leaves. Layout is what jsdom can't judge, so it is measured here in WebKit.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** Wholly inside the viewport, and the top thing at its centre: a finger reaches it. */
async function expectReachable(page: Page, control: Locator) {
  const box = await control.boundingBox();
  const size = page.viewportSize();
  expect(box).not.toBeNull();
  if (!box || !size) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(hit).toBe(true);
}

/** The target a finger gets: the control, or its `hit-area` box where that is bigger. */
const targetHeight = (control: Locator) =>
  control.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    const inset = Number.parseFloat(after.inset) || 0;
    return el.getBoundingClientRect().height - 2 * inset;
  });

async function openGenerate(page: Page, request: Parameters<typeof createDraft>[0]) {
  const id = await createDraft(request, `Phone modal ${Date.now()}`);
  await openCms(page, `/content/article/${id}`);
  await page.getByRole('button', { name: 'More entry actions' }).click(EDITOR_READY);
  await page.getByRole('menuitem', { name: 'Generate with AI' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a form dialog comes from the bottom of a phone, its targets a finger wide', async ({
  page,
  request,
}) => {
  await withoutAssistant(page);
  const dialog = await openGenerate(page, request);
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box ? Math.round(box.y + box.height) : 0;
    })
    .toBe(page.viewportSize()?.height);

  const close = dialog.getByRole('button', { name: 'Close' });
  expect(await targetHeight(close)).toBeGreaterThanOrEqual(44);
  expect(await targetHeight(dialog.getByRole('button', { name: 'Cancel' }))).toBeGreaterThanOrEqual(
    44,
  );
});

test('at keyboard height the way out and the action stay in reach', async ({ page, request }) => {
  await withoutAssistant(page);
  const dialog = await openGenerate(page, request);
  await page.setViewportSize({ width: 390, height: 370 });
  await dialog.getByRole('textbox', { name: 'Prompt' }).fill('A launch post');
  await settle(page);

  await expectReachable(page, dialog.getByRole('button', { name: 'Close' }));
  await expect(dialog.getByRole('button', { name: 'Generate draft' })).toBeEnabled();
  await expectReachable(page, dialog.getByRole('button', { name: 'Generate draft' }));
  await expectReachable(page, dialog.getByRole('button', { name: 'Cancel' }));
});

test('the palette keeps its search box still as the results shrink', async ({ page }) => {
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Search' }).first().click();
  const input = page.getByRole('combobox', { name: 'Command palette search' });
  await expect(input).toBeVisible();
  await expect(page.getByRole('option').first()).toBeVisible();
  await settle(page);
  const before = await input.boundingBox();
  await input.fill('nothing is called this');
  await expect(page.getByRole('option')).toHaveCount(0);
  const after = await input.boundingBox();
  expect(after?.y).toBe(before?.y);
});

test('a long sheet keeps its way out and its action in reach, however far it scrolls', async ({
  page,
  request,
}) => {
  const name = `Phone sheet ${Date.now()}`;
  const folderId = await seedAssetFolder(request, name);
  await seedAsset(request, name, { folderId });
  await openCms(page, '/assets');
  await page.getByRole('combobox', { name: 'Folder' }).selectOption({ label: name });
  await page.getByRole('button', { name: `Open “${name}”` }).click();
  const sheet = page.getByRole('dialog');
  const close = sheet.getByRole('button', { name: 'Close' });
  const save = sheet.getByRole('button', { name: 'Save metadata' });
  await expect(save).toBeVisible();
  await settle(page);

  await expectReachable(page, close);
  await expectReachable(page, save);
  // The body is what moves: the scroller's end, and the two still where a finger left them.
  await sheet.locator('[data-slot="sheet-body"]').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expectReachable(page, close);
  await expectReachable(page, save);
  expect(await targetHeight(close)).toBeGreaterThanOrEqual(44);
});

test('at keyboard height a focused field clears the pinned footer', async ({ page, request }) => {
  await withoutAssistant(page);
  const apiId = `phone${Date.now()}`;
  const created = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId,
    name: `Phone ${apiId}`,
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  expect(created.ok(), await created.text()).toBe(true);
  await openCms(page, '/content');
  await page.getByRole('button', { name: `More actions for “Phone ${apiId}”` }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog');
  const typed = dialog.getByRole('textbox', { name: /to confirm/ });
  await expect(typed).toBeVisible();
  await page.setViewportSize({ width: 390, height: 370 });
  await typed.focus();
  await settle(page);

  const footer = dialog.locator('[data-slot="dialog-footer"]');
  await expect
    .poll(async () => {
      const [field, foot] = [await typed.boundingBox(), await footer.boundingBox()];
      return field && foot ? field.y + field.height <= foot.y : false;
    })
    .toBe(true);
  await expectReachable(page, typed);
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();
});

test('a publish review comes from the bottom of a phone, in thumb reach', async ({
  page,
  request,
}) => {
  await withoutAssistant(page);
  const title = `Phone publish ${Date.now()}`;
  const id = await createDraft(request, title);
  await openCms(page, `/content/article/${id}`);
  await page.getByRole('button', { name: 'Publish', exact: true }).click(EDITOR_READY);
  const review = page.getByRole('alertdialog');
  await expect
    .poll(async () => {
      const box = await review.boundingBox();
      return box ? Math.round(box.y + box.height) : 0;
    })
    .toBe(page.viewportSize()?.height);
  await expectReachable(page, review.getByRole('button', { name: 'Publish entry' }));
  await review.getByRole('button', { name: 'Keep as draft' }).click();
  await expect(review).toBeHidden();
});

test('a destructive alert stays centred on a phone', async ({ page, request }) => {
  const name = `Phone alert ${Date.now()}`;
  const folderId = await seedAssetFolder(request, name);
  await seedAsset(request, name, { folderId, archive: true });
  await openCms(page, '/assets');
  await page.getByRole('combobox', { name: 'Folder' }).selectOption({ label: name });
  await page.getByRole('combobox', { name: 'Status' }).selectOption('archived');
  await page.getByRole('button', { name: `Delete “${name}”` }).click();
  const alert = page.getByRole('alertdialog');
  await expect(alert).toBeVisible();
  await settle(page);
  const box = await alert.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box).not.toBeNull();
  if (box) expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThan(2);
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
});

test('with no room between them, the header and footer scroll with the body', async ({ page }) => {
  await openCms(page, '/settings/roles');
  await page.getByRole('button', { name: 'Access' }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'Save access' })).toBeAttached();
  await settle(page);
  const header = sheet.locator('[data-slot="sheet-header"]');
  await expect(header).toHaveCSS('position', 'sticky');

  // A phone on its side with the keyboard up.
  await page.setViewportSize({ width: 700, height: 200 });
  await expect(header).toHaveCSS('position', 'static');
  const body = sheet.locator('[data-slot="sheet-body"]');
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expectReachable(page, sheet.getByRole('button', { name: 'Cancel' }));
  await page.setViewportSize({ width: 390, height: 659 });
  await expect(header).toHaveCSS('position', 'sticky');
});
