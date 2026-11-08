import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import {
  api,
  asFreshDeployment,
  askCoworker,
  createBlocksPage,
  createChanged,
  createDraft,
  MGMT,
  openCms,
  PROPOSAL_TARGET,
  resaveBlocksPage,
  SPACE,
  seedAsset,
  seedAssetFolder,
  seedCms,
  seedGuidedType,
  seedIngestFindings,
  seedLaidOutType,
  seedRuledType,
  stubLocales,
  uploadAssetBytes,
  useCmsScope,
  withoutAssistant,
} from './cms';
import { settle } from './settle';

/**
 * Accessibility sweep over the CMS screens, WCAG 2.1 A/AA (PRODUCT.md's bar). jsdom is not a
 * credible authority on computed accessibility (a Radix checkbox named by a wrapping label in
 * jsdom is unnamed in a real browser), so axe runs here, over every screen and the dialogs a
 * route sweep can't reach.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

async function scan(page: Page, testInfo: TestInfo, include: readonly string[] = []) {
  await settle(page);
  let builder = new AxeBuilder({ page }).withTags(WCAG);
  for (const selector of include) builder = builder.include(selector);
  const results = await builder.analyze();
  if (results.violations.length > 0) {
    await testInfo.attach('axe-violations.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.help}\n${v.nodes
        .map((n) => `    ${n.target.join(' ')}\n      ${n.html.slice(0, 160)}`)
        .join('\n')}`,
  );
  expect(summary, `accessibility violations:\n${summary.join('\n')}`).toEqual([]);
}

/** Every CMS screen, plus each settings section (each a different component tree). */
const ROUTES: readonly (readonly [name: string, path: string])[] = [
  ['overview', '/dashboard'],
  ['content types', '/content'],
  ['entries', '/content/article'],
  ['new entry', '/content/article/new'],
  ['import', '/content/article/import'],
  ['space export import', '/content/space-import'],
  ['approvals', '/approvals'],
  ['releases', '/releases'],
  ['workflows', '/workflows'],
  ['taxonomy', '/taxonomy'],
  ['settings: space access', '/settings/team'],
  ['settings: api keys', '/settings/api-keys'],
  ['settings: connected apps', '/settings/connected-apps'],
  ['settings: roles', '/settings/roles'],
  ['settings: webhooks', '/settings/webhooks'],
  ['settings: environments', '/settings/environments'],
  ['settings: redirects', '/settings/redirects'],
  ['settings: menus', '/settings/menus'],
  ['settings: trash', '/settings/trash'],
  ['settings: ai actions', '/settings/ai-actions'],
  ['settings: functions', '/settings/functions'],
  ['settings: extensions', '/settings/extensions'],
  ['settings: plugins', '/settings/plugins'],
  ['settings: audit log', '/settings/audit-log'],
];

for (const [name, path] of ROUTES) {
  test(`${name} has no accessibility violations`, async ({ page }, testInfo) => {
    await openCms(page, path);
    // Wait for the route's own content (these screens render after a fetch): a card, a table, a
    // tablist, or at least its h1 and a button.
    await expect(
      page
        .locator('main [data-slot="card"], main table, main [role="tablist"]')
        .or(page.getByRole('main').getByRole('button'))
        .first(),
    ).toBeVisible();
    // The inbox holds the seeded agent proposal: scan it once its diff has loaded and the decision
    // buttons are enabled, not while they are still dimmed and fading in.
    if (path === '/approvals') {
      await expect(page.getByRole('button', { name: 'Approve and apply' }).first()).toBeEnabled();
    }
    await scan(page, testInfo);
  });
}

// With assets and a folder in it, so the scan sees cards, the tree's nesting, the list's rows and
// the bulk bar, not an empty library.
test('the asset library, its list view and its bulk bar have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const stamp = Date.now();
  const folderId = await seedAssetFolder(request, `A11y ${stamp}`);
  await seedAsset(request, `A11y ${stamp} filed`, { folderId });
  await seedAsset(request, `A11y ${stamp} root`, { publish: true });
  await seedAsset(request, `A11y ${stamp} archived`, { folderId, archive: true });
  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByRole('button', { name: `Open “A11y ${stamp} root”` })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Folders' })
      .getByRole('button', { name: `A11y ${stamp}`, exact: true }),
  ).toBeVisible();
  await scan(page, testInfo);

  await library.getByRole('radio', { name: 'List' }).click();
  await expect(library.getByRole('table')).toBeVisible();
  await scan(page, testInfo);

  await library.getByRole('checkbox', { name: `Select “A11y ${stamp} root”` }).check();
  await expect(page.getByRole('group', { name: 'Selected assets' })).toBeVisible();
  await scan(page, testInfo);

  // A search: the box, its summary and (when anything is indexed) the facet chips.
  await library.getByRole('searchbox', { name: 'Search assets' }).fill(`a11y ${stamp}`);
  await expect(library.getByText(new RegExp(`for “a11y ${stamp}”`))).toBeVisible();
  await scan(page, testInfo);

  // A delete confirm, which only an archived asset offers: the tinted destructive pill on the alert
  // dialog, in both themes (its red is tuned per theme to hold 4.5:1 on that tint).
  await library.getByRole('searchbox', { name: 'Search assets' }).fill('');
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: `A11y ${stamp}`, exact: true })
    .click();
  await library.getByRole('combobox', { name: 'Status' }).selectOption('archived');
  await library.getByRole('button', { name: `Delete “A11y ${stamp} archived”` }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete “A11y ${stamp} archived”?` });
  await expect(confirm.getByRole('button', { name: 'Delete asset' })).toBeVisible();
  await scan(page, testInfo);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await scan(page, testInfo);
  await page.emulateMedia({ colorScheme: 'light' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
});

// A collection open in place of the library, with members to reorder, its zip card, and its
// share dialog with a link listed: the sidebar's two lists, the ordered list's move buttons, the
// segmented expiry, the switch and the in-place revoke, in both themes.
test('an asset collection, its zip and its share dialog have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const name = `A11y set ${stamp}`;
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const id = await uploadAssetBytes(request, `a11y-${stamp}-${n}.txt`, Buffer.from(`${n}`));
    const pub = await api(request, 'POST', `${MGMT}/assets/${id}/published`);
    expect(pub.ok(), await pub.text()).toBe(true);
    ids.push(id);
  }
  const made = await api(request, 'POST', `${MGMT}/asset-collections`, {
    name,
    description: 'For the sweep',
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { id } = (await made.json()) as { id: string };
  const added = await api(request, 'POST', `${MGMT}/asset-collections/${id}/assets`, {
    assetIds: ids,
  });
  expect(added.ok(), await added.text()).toBe(true);

  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Collections' })
    .getByRole('button', { name: `${name}, 2 assets` })
    .click();
  const list = page.getByRole('list', { name: `Assets in “${name}”, in order` });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await scan(page, testInfo);

  await page.getByRole('button', { name: 'Download as zip' }).click();
  await expect(page.getByRole('region', { name: 'Zip download' })).toBeVisible();
  await scan(page, testInfo);

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Share “${name}”` });
  const form = dialog.getByRole('form', { name: 'New share link' });
  await form.getByRole('radio', { name: 'Custom' }).click();
  await expect(form.getByLabel('Expires at')).toBeVisible();
  await form.getByRole('radio', { name: '7 days' }).click();
  await form.getByRole('button', { name: 'Create link' }).click();
  await expect(
    dialog.getByRole('list', { name: 'Active links' }).getByRole('listitem'),
  ).toHaveCount(1);
  await scan(page, testInfo);
  await dialog.getByRole('button', { name: /Revoke the link/ }).click();
  await expect(page.getByRole('alertdialog', { name: /Revoke this link\?/ })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await scan(page, testInfo);
  await page.emulateMedia({ colorScheme: 'light' });
});

// The collection view at phone width: the collections select, rows whose actions wrap under
// the name, and the header's actions.
test('the audit log’s missed filter and backwards range have no accessibility violations', async ({
  page,
}, testInfo) => {
  await openCms(page, '/settings/audit-log');
  await page.getByLabel('Actor', { exact: true }).fill(`nobody-${Date.now()}`);
  await expect(page.getByText('No audit entries match these filters.')).toBeVisible();
  await page.getByLabel('From', { exact: true }).fill('2026-03-02');
  await page.getByLabel('To', { exact: true }).fill('2026-03-01');
  await expect(page.getByRole('alert').filter({ hasText: 'To is before From.' })).toBeVisible();
  await scan(page, testInfo);
});

// Windows High Contrast (forced colours) overrides the current item's fill, so the item takes a
// hairline outline (DESIGN.md, Brand): where you are never rests on weight alone. Checked in each nav that marks a current item, and that a
// hovered current row keeps its own fill when colours aren't forced.
test('the current item stays marked under forced colours, and hover never looks current', async ({
  page,
}) => {
  const outline = (locator: ReturnType<Page['locator']>) =>
    locator.evaluate((el) => getComputedStyle(el).outlineStyle);

  await page.emulateMedia({ forcedColors: 'active' });
  await openCms(page, '/settings/audit-log');
  const sidebar = page.locator('[data-sidebar="menu-button"][data-active]');
  const section = page
    .getByRole('navigation', { name: 'Settings sections' })
    .locator('[aria-current="page"]');
  await expect(sidebar).toHaveCount(1);
  await expect(section).toHaveCount(1);
  expect(await outline(sidebar)).toBe('solid');
  expect(await outline(section)).toBe('solid');

  await openCms(page, '/assets');
  const folder = page.getByRole('navigation', { name: 'Folders' }).locator('[aria-current="true"]');
  await expect(folder).toHaveCount(1);
  expect(await outline(folder)).toBe('solid');

  // Colours not forced: no outline, and the pointer on the current row leaves its fill alone,
  // while a row that isn't current takes a lighter one.
  await page.emulateMedia({ forcedColors: 'none' });
  await openCms(page, '/settings/audit-log');
  const fill = (locator: ReturnType<Page['locator']>) =>
    locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await outline(sidebar)).toBe('none');
  const current = await fill(sidebar);
  await sidebar.hover();
  expect(await fill(sidebar)).toBe(current);
  const other = page.locator('[data-sidebar="menu-button"]:not([data-active])').first();
  await other.hover();
  expect(await fill(other)).not.toBe(current);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

  test('the audit log has no accessibility violations', async ({ page }, testInfo) => {
    await openCms(page, '/settings/audit-log');
    await expect(page.getByLabel('Target ID')).toBeVisible();
    await scan(page, testInfo);
  });

  test('an entry’s Activity view has no accessibility violations', async ({
    page,
    request,
  }, testInfo) => {
    const id = await createDraft(request, `A11y activity ${Date.now()}`);
    await openCms(page, `/content/article/${id}`);
    const pane = page.getByRole('complementary', { name: 'Side pane' });
    await pane.getByRole('radio', { name: 'Activity' }).click();
    const list = pane.getByRole('list', { name: 'Activity, newest first' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    // At phone width the pane is under the form and the page never scrolls sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await scan(page, testInfo);
  });

  test('an asset collection has no accessibility violations', async ({
    page,
    request,
  }, testInfo) => {
    const stamp = Date.now();
    const id = await uploadAssetBytes(request, `a11y-phone-${stamp}.txt`, Buffer.from('x'));
    const name = `A11y phone ${stamp}`;
    const made = await api(request, 'POST', `${MGMT}/asset-collections`, { name });
    expect(made.ok(), await made.text()).toBe(true);
    const collection = (await made.json()) as { id: string };
    const added = await api(request, 'POST', `${MGMT}/asset-collections/${collection.id}/assets`, {
      assetIds: [id],
    });
    expect(added.ok(), await added.text()).toBe(true);
    await openCms(page, '/assets');
    await page
      .getByRole('navigation', { name: 'Collections' })
      .getByRole('combobox', { name: 'Collection' })
      .selectOption({ label: name });
    await expect(
      page.getByRole('list', { name: `Assets in “${name}”, in order` }).getByRole('listitem'),
    ).toHaveCount(1);
    // The whole page: the collection's surfaces and the shell's tab bar around them.
    await scan(page, testInfo);
  });

  // The phone shell itself: the top bar, the tab bar with Approvals' count pill (its name must
  // hold what it shows, "Approvals 1", for voice control), and the More sheet.
  test('the shell, its tab bar and More have no accessibility violations', async ({
    page,
  }, testInfo) => {
    // The global setup's agent proposal waits in Approvals (no spec decides it), so the tab shows
    // its count.
    await openCms(page, '/dashboard');
    const bar = page.locator('nav[aria-label="Main"]:visible');
    await expect(bar.getByRole('link', { name: /^Approvals, \d+ waiting$/ })).toBeVisible();
    await expect(bar.locator('[data-approvals-count]')).toBeVisible();
    await scan(page, testInfo);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await scan(page, testInfo);
    await page.emulateMedia({ colorScheme: 'light' });
    await bar.getByRole('button', { name: 'More' }).tap();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan(page, testInfo);
  });
});

// A role's content access: the built-in Editor (every type, read/write/publish), with Delete
// withheld and a read-only type added, so the scan always sees a ticked, an unticked and a disabled
// box with its reason, over the roles table.
test('a role’s content access sheet has no accessibility violations', async ({
  page,
}, testInfo) => {
  await openCms(page, '/settings/roles');
  await page.getByRole('button', { name: 'Content access for Editor', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('checkbox', { name: 'Delete Every type' }).click();
  await expect(sheet.getByRole('checkbox', { name: 'Delete Every type' })).not.toBeChecked();
  await sheet.getByRole('combobox', { name: 'Content type to add' }).selectOption('article');
  await sheet.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(sheet.getByRole('checkbox', { name: /^Unpublish / }).last()).toBeDisabled();
  await scan(page, testInfo);
});

// An unpublished asset's share dialog: the warning in place of the form, over the sheet.
test('the share dialog for an unpublished asset has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const name = `a11y-draft-${Date.now()}.txt`;
  await uploadAssetBytes(request, name, Buffer.from(name));
  await openCms(page, '/assets');
  await page
    .getByRole('region', { name: 'Asset library' })
    .getByRole('button', { name: `Open “${name}”` })
    .click();
  await page
    .getByRole('dialog', { name })
    .getByRole('button', { name: 'Share', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: `Share “${name}”` });
  await expect(dialog.getByText('Publish it to share it')).toBeVisible();
  await scan(page, testInfo);
});

// What ingest found, in sight: a possible duplicate, a failed ingest with its reason and Retry,
// and the copy's sheet asking before an edit is discarded.
test('the asset library with ingest badges has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const { copy, broken, folder } = await seedIngestFindings(request, stamp);
  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: folder, exact: true })
    .click();
  const library = page.getByRole('region', { name: 'Asset library' });
  const duplicateBadge = `Possible duplicate: open the asset “${copy}” duplicates`;
  await expect(library.getByRole('button', { name: duplicateBadge })).toBeVisible();
  await expect(library.getByRole('button', { name: `Retry processing “${broken}”` })).toBeVisible();
  await scan(page, testInfo);

  await library.getByRole('button', { name: `Open “${copy}”` }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Alt text (en-US)').fill('Not saved yet');
  await sheet.getByRole('button', { name: duplicateBadge }).click();
  await expect(sheet.getByRole('alertdialog')).toBeVisible();
  await scan(page, testInfo);
});

// An image's Details tab: the focal point control with its marker set, and the AI suggestion
// buttons, in both themes (the marker's ink ring and paper halo come from the theme's tokens).
test('an image’s Details tab, its focal point and its AI buttons have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const name = `a11y-focal-${Date.now()}.png`;
  // A 1×1 PNG: an image the sheet offers the focal point and the AI suggestions for.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const id = await uploadAssetBytes(request, name, png, 'image/png');
  const focal = await api(request, 'PATCH', `${MGMT}/assets/${id}/metadata`, {
    focalPoint: { x: 0.3, y: 0.6 },
  });
  expect(focal.ok(), await focal.text()).toBe(true);

  await openCms(page, '/assets');
  await page
    .getByRole('region', { name: 'Asset library' })
    .getByRole('button', { name: `Open “${name}”` })
    .click();
  const sheet = page.getByRole('dialog', { name });
  const control = sheet.getByRole('button', { name: 'Focal point: 30% across, 60% down' });
  await expect(control).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Generate alt text' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Suggest tags' })).toBeVisible();
  await scan(page, testInfo);

  // The keyboard moves it, and its name follows.
  await control.focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    sheet.getByRole('button', { name: 'Focal point: 31% across, 60% down' }),
  ).toBeFocused();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await scan(page, testInfo);
  await page.emulateMedia({ colorScheme: 'light' });
});

// The asset sheet, tab by tab: a version list with an older version to restore (and its in-place
// confirm), usage, renditions, and the rights form with its status and a field the API refused.
test('the asset sheet’s tabs have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const stamp = Date.now();
  const name = `a11y-versions-${stamp}.txt`;
  const id = await uploadAssetBytes(request, name, Buffer.from(`one ${stamp}`));
  const replace = await api(request, 'POST', `${MGMT}/assets/${id}/file`, {
    fileName: `a11y-versions-${stamp}-2.txt`,
    contentType: 'text/plain',
  });
  expect(replace.ok(), await replace.text()).toBe(true);
  const { upload, commit } = (await replace.json()) as {
    upload: { url: string; headers: Record<string, string> };
    commit: unknown;
  };
  const put = await request.fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    data: Buffer.from(`two ${stamp}`),
  });
  expect(put.ok(), await put.text()).toBe(true);
  const committed = await api(request, 'POST', `${MGMT}/assets/${id}/file/commit`, commit);
  expect(committed.ok(), await committed.text()).toBe(true);
  const rights = await api(request, 'PUT', `${MGMT}/assets/${id}/rights`, {
    license: 'CC BY 4.0',
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  expect(rights.ok(), await rights.text()).toBe(true);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByText('Expires soon').first()).toBeVisible();
  await library.getByRole('button', { name: `Open “${name}”` }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Alt text (en-US)')).toBeVisible();
  await scan(page, testInfo);

  await sheet.getByRole('tab', { name: 'Versions' }).click();
  await expect(
    sheet.getByRole('list', { name: 'File versions' }).getByRole('listitem'),
  ).toHaveCount(2);
  await scan(page, testInfo);
  await sheet.getByRole('button', { name: 'Restore version 1' }).click();
  await expect(sheet.getByRole('alertdialog')).toBeVisible();
  await scan(page, testInfo);
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  await sheet.getByRole('tab', { name: 'Usage' }).click();
  await expect(sheet.getByText('Not referenced by any entry.')).toBeVisible();
  await scan(page, testInfo);

  await sheet.getByRole('tab', { name: 'Renditions' }).click();
  await expect(sheet.getByText(/Renditions are made from images/)).toBeVisible();
  await scan(page, testInfo);

  await sheet.getByRole('tab', { name: 'Rights' }).click();
  await expect(sheet.getByText(/Expires in 3 days/)).toBeVisible();
  await scan(page, testInfo);
  // An embargo after the expiry: refused beside the field.
  await sheet.getByLabel('Embargo until').fill('2099-01-01T09:00');
  await sheet.getByRole('button', { name: 'Save rights' }).click();
  await expect(sheet.getByLabel('Expires at')).toHaveAttribute('aria-invalid', 'true');
  await scan(page, testInfo);
});

// The page a link opens when it no longer works: public, so it is reachable before sign-in is on.
test('an invitation link that no longer works has no accessibility violations', async ({
  page,
}, testInfo) => {
  await page.goto(`/invite/cwi_${'A'.repeat(43)}`);
  await expect(page.getByRole('alert')).toContainText('isn’t valid');
  await scan(page, testInfo);
});

test('the content type dialog has no accessibility violations', async ({ page }, testInfo) => {
  await openCms(page, '/content');
  await page
    .getByRole('button', { name: /New content type|\+ New/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page, testInfo);
});

test('the content type dialog’s guidance panels have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  await seedGuidedType(request);
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Edit “Guided”' }).click();
  // Open on the field that has guidance; opened by hand on one that has none.
  await expect(page.getByRole('group', { name: 'Guidance for Title' })).toBeVisible();
  await page.getByRole('button', { name: 'Guidance for Subtitle' }).click();
  await expect(page.getByRole('group', { name: 'Guidance for Subtitle' })).toBeVisible();
  await scan(page, testInfo);
});

test('an entry with help, a placeholder and an options select has no accessibility violations', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  await seedGuidedType(request);
  await openCms(page, '/content/guided/new');
  await expect(page.getByText('Lead with the neighbourhood.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Status')).toBeVisible();
  await scan(page, info);
});

test('the content type dialog’s rules panel has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  await seedRuledType(request);
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Edit “Ruled”' }).click();
  // Open on a field that has rules; one added by hand on a field that has none.
  await expect(page.getByRole('group', { name: 'Rules for Sold to' })).toBeVisible();
  await page.getByRole('button', { name: 'Rules for Title' }).click();
  await page.getByRole('button', { name: 'Add rule to Title' }).click();
  await expect(page.getByLabel('Field read by Title rule 1')).toBeVisible();
  await scan(page, testInfo);
});

test('an entry with a field its rules make read-only has no accessibility violations', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  await seedRuledType(request);
  await openCms(page, '/content/ruled/new');
  await page.getByLabel('Status').fill('sold', { timeout: 15_000 });
  // Read-only, not disabled: still in the tab order, so the sweep sees it as a reader does.
  await expect(page.getByLabel('Reference')).not.toBeEditable();
  await expect(page.getByLabel('Reference')).toBeEnabled();
  await expect(page.getByLabel('Sold to')).toBeVisible();
  await scan(page, info);
});

test('the first-space notice and its dialog have no accessibility violations', async ({
  page,
}, testInfo) => {
  await asFreshDeployment(page, () => false);
  await openCms(page, '/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first space' })).toBeVisible();
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Create a space' }).click();
  await expect(page.getByRole('dialog', { name: 'New space' })).toBeVisible();
  await scan(page, testInfo);
});

test('setup’s first-space step has no accessibility violations', async ({ page }, testInfo) => {
  await asFreshDeployment(page, () => false);
  await openCms(page, '/setup/space');
  await expect(page.getByRole('heading', { name: 'Your first space', level: 1 })).toBeVisible();
  await expect(page.getByText('What will your first space hold?')).toBeVisible();
  await scan(page, testInfo);
});

// The enterprise starter is off under the device tests (DEMO_STARTERS), so the browser is told it
// is offered, the create goes through as an empty space, and the install's progress is stubbed:
// what is scanned is the dialog's starter list and its progress view, running and failed.
test('the enterprise starter and its install progress have no accessibility violations', async ({
  page,
}, testInfo) => {
  const stamp = Date.now().toString(36);
  const id = `enterprise-${stamp}`;
  await asFreshDeployment(page, (spaceId) => spaceId === id);
  await page.route(
    (url) => url.pathname === '/starters',
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 'sample',
              title: 'Start with sample content',
              description: 'Sample content.',
              background: false,
            },
            { id: 'empty', title: 'Start empty', description: 'Nothing in it.', background: false },
            {
              id: 'enterprise',
              title: 'Enterprise demo (Aldermoor)',
              description: 'A global professional-services firm in 13 locales.',
              background: true,
            },
          ],
        },
      }),
  );
  await page.route(
    (url) => url.pathname === '/spaces',
    async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = { ...(route.request().postDataJSON() as object), starter: 'empty' };
      const res = await route.fetch({ postData: JSON.stringify(body) });
      const created = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        response: res,
        json: {
          ...created,
          starter: 'enterprise',
          installing: { install: 'ins-a11y', jobId: 'job-a11y', steps: 25 },
        },
      });
    },
  );
  let failed = false;
  await page.route(
    (url) => url.pathname.endsWith('/starter-installs/ins-a11y'),
    (route) =>
      route.fulfill({
        json: {
          install: 'ins-a11y',
          starter: 'enterprise',
          jobId: 'job-a11y',
          steps: 25,
          ...(failed
            ? {
                step: 12,
                phase: 'newsroom',
                title: 'Newsroom',
                status: 'failed',
                failures: [{ id: 'c00000', error: 'Chunk failed after 5 attempts' }],
              }
            : {
                step: 7,
                phase: 'people-2',
                title: 'People: EMEIA and Asia-Pacific',
                status: 'running',
              }),
        },
      }),
  );

  await openCms(page, '/dashboard');
  await page.getByRole('button', { name: 'Create a space' }).click();
  const dialog = page.getByRole('dialog', { name: 'New space' });
  await dialog.getByRole('radio', { name: /Enterprise demo/ }).check();
  await scan(page, testInfo);

  await dialog.getByLabel('Name').fill(`Enterprise ${stamp}`);
  await expect(dialog.getByLabel('Space ID')).toHaveValue(id);
  await dialog.getByRole('button', { name: 'Create space' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'step 7 of 25' })).toBeVisible();
  await scan(page, testInfo);

  failed = true;
  await expect(dialog.getByText('The rest of the content wasn’t installed')).toBeVisible({
    timeout: 10_000,
  });
  await scan(page, testInfo);
});

test('the webhook dialog has no accessibility violations', async ({ page }, testInfo) => {
  await openCms(page, '/settings/webhooks');
  await page.getByPlaceholder('https://example.com/hooks/cms').fill('https://example.com/a11y');
  await page.getByPlaceholder('Signing secret').fill('a11y-secret');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  const more = page
    .getByRole('button', { name: 'More actions for https://example.com/a11y' })
    .first();
  await more.waitFor();
  await more.click();
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page, testInfo);
});

test('the webhook deliveries sheet, with a row, has no accessibility violations', async ({
  page,
}, testInfo) => {
  await openCms(page, '/settings/webhooks');
  const url = `https://example.com/a11y-log-${Date.now()}`;
  await page.getByPlaceholder('https://example.com/hooks/cms').fill(url);
  await page.getByPlaceholder('Signing secret').fill('a11y-secret');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.getByRole('button', { name: `Send test to ${url}` }).click();
  const log = page.getByRole('dialog', { name: 'Deliveries' });
  await expect(log.getByRole('button', { name: /^Resend delivery #\d+$/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await scan(page, testInfo);
});

test('the redirect and import dialogs have no accessibility violations', async ({
  page,
}, testInfo) => {
  await openCms(page, '/settings/redirects');
  await page.getByRole('button', { name: 'New redirect' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New redirect' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('From').fill('/a11y-old');
  await dialog.getByLabel('To').fill('/a11y-new');
  await scan(page, testInfo);
  await dialog.getByRole('button', { name: 'Add redirect' }).click();
  await expect(page.getByRole('switch', { name: 'Enabled: /a11y-old' })).toBeVisible();
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('dialog', { name: 'Import redirects' })).toBeVisible();
  await scan(page, testInfo);
});

test('the trash with rows ticked, its bulk bar and an entry bulk job have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const titles = [`A11y trash ${stamp} 1`, `A11y trash ${stamp} 2`];
  for (const title of titles) {
    const res = await api(request, 'POST', `${MGMT}/entries`, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title } },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const { entry } = (await res.json()) as { entry: { id: string } };
    const trashed = await api(request, 'DELETE', `${MGMT}/entries/${entry.id}`);
    expect(trashed.ok(), await trashed.text()).toBe(true);
  }
  await openCms(page, '/content/article');
  await page.getByRole('button', { name: 'View trash' }).click();
  const row = (title: string) => page.getByRole('row', { name: new RegExp(title) });
  // One restored as a job, so its card shows; then the other ticked beside it.
  await row(titles[0] as string)
    .getByRole('checkbox')
    .check();
  const bar = page.getByRole('group', { name: 'Selected entries' });
  await bar.getByRole('button', { name: 'Restore selected' }).click();
  const job = page.getByRole('region', { name: 'Bulk job' });
  await expect(job.getByRole('status')).toHaveText('Restored 1 entry', { timeout: 120_000 });
  await row(titles[1] as string)
    .getByRole('checkbox')
    .check();
  await expect(bar.getByRole('button', { name: 'Delete permanently…' })).toBeVisible();
  await scan(page, testInfo);
});

test('the menu editor and its dialogs have no accessibility violations', async ({
  page,
}, testInfo) => {
  await openCms(page, '/settings/menus');
  await page.getByRole('button', { name: 'New menu' }).first().click();
  const created = page.getByRole('dialog', { name: 'New menu' });
  await expect(created).toBeVisible();
  await created.getByLabel('Name').fill(`A11y ${Date.now()}`);
  await scan(page, testInfo);
  await created.getByRole('button', { name: 'Create menu' }).click();
  await page.getByRole('button', { name: 'Add item' }).click();
  const item = page.getByRole('dialog', { name: 'New item' });
  await expect(item).toBeVisible();
  await item.getByLabel('URL').fill('/a11y');
  await item.getByLabel('Label').fill('A11y one');
  await scan(page, testInfo);
  await item.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('button', { name: 'Move “A11y one” up' })).toBeVisible();
  await scan(page, testInfo);
});

test('the entries list’s views menu, column picker and save dialog have no accessibility violations', async ({
  page,
}, testInfo) => {
  await openCms(page, '/content/article?columns=sys.status,sys.updatedAt');
  await expect(page.getByRole('button', { name: 'Views' })).toBeVisible();
  await scan(page, testInfo);
  // Menus aren't scanned while open: a Radix menu is modal and hides the page behind it, which axe
  // reports (as for every menu in the admin). The dialog it opens is scanned.
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Save as new view…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save view' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Name' }).fill(`A11y ${Date.now()}`);
  await scan(page, testInfo);
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Updated' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader', { name: 'Updated' })).toHaveCount(0);
  await scan(page, testInfo);
});

test('permission checkboxes are named in a real browser', async ({ page }) => {
  await openCms(page, '/settings/connected-apps');
  for (const label of [
    'Read published content',
    'Read drafts',
    'Search content',
    'Create and edit content',
    'Publish content',
    'Change content types',
    'Administer the space',
  ]) {
    await expect(page.getByRole('checkbox', { name: label })).toBeVisible();
  }
});

test('plugin capability checkboxes are named in a real browser', async ({ page }) => {
  await openCms(page, '/settings/plugins');
  await page.getByRole('button', { name: 'Install plugin' }).click();
  await page.getByLabel(/manifest/i).setInputFiles({
    name: 'plugin.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        id: 'com.example.a11y',
        name: 'Consent probe',
        version: '1.0.0',
        capabilities: ['content:read', 'content:write', 'network:request'],
        allowedHosts: ['api.example.com'],
        hooks: ['entry:beforeSave'],
        entrypoint: 'index.js',
      }),
    ),
  });
  for (const label of ['Read content', 'Create and edit content', 'Call external services']) {
    await expect(page.getByRole('checkbox', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('checkbox', { name: 'Call external services' })).toBeEnabled();
});

test('the plugin settings sheet has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  // Every kind of field a manifest may declare, so each control is scanned in a real browser.
  const installed = await api(request, 'POST', `/spaces/${SPACE}/plugins`, {
    manifest: {
      id: 'com.example.settings',
      name: 'Settings probe',
      version: '1.0.0',
      capabilities: [],
      allowedHosts: [],
      hooks: ['entry:beforeSave'],
      entrypoint: 'index.js',
      settings: [
        { key: 'apiKey', label: 'API key', type: 'string', secret: true, required: true },
        { key: 'site', label: 'Site name', type: 'string', description: 'Shown in titles.' },
        { key: 'maxLength', label: 'Max length', type: 'number', default: 120 },
        { key: 'strict', label: 'Strict mode', type: 'boolean' },
        { key: 'tone', label: 'Tone', type: 'select', options: ['formal', 'casual'] },
      ],
    },
    bundle: 'export class Plugin {}',
    approvedCapabilities: [],
  });
  expect([201, 409], await installed.text()).toContain(installed.status());

  await openCms(page, '/settings/plugins');
  await page.getByRole('button', { name: 'More actions for “Settings probe”' }).click();
  await page.getByRole('menuitem', { name: 'Settings probe settings' }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings probe settings' });
  await expect(sheet.getByLabel('Max length')).toBeVisible();
  await expect(sheet.getByRole('switch', { name: 'Strict mode' })).toBeVisible();
  await scan(page, testInfo);

  // A required secret left unset is refused beside it, and focus lands on it.
  await sheet.getByLabel('Site name').fill('Acme');
  await sheet.getByRole('button', { name: 'Save settings' }).click();
  await expect(sheet.getByText('API key is required')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Set API key' })).toBeFocused();
  await scan(page, testInfo);
});

test('repeater controls are named per item in a real browser', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  await openCms(page, '/content/article/new');
  await expect(page.getByRole('button', { name: 'Add callout' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Add callout' }).click();
  await page.getByRole('button', { name: 'Add callout' }).click();
  await expect(page.getByRole('button', { name: 'Remove Callout 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Callout 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Callout 1 up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Callout 2 down' })).toBeDisabled();
  await expect(page.getByLabel('Heading').first()).toBeVisible();
});

test('the import wizard has no accessibility violations', async ({ page }, testInfo) => {
  await openCms(page, '/content/article/import');
  await page.getByLabel('File').setInputFiles({
    name: 'entries.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('headline,body\nHello,World\n'),
  });
  await expect(page.getByText(/2 columns/)).toBeVisible();
  await scan(page, testInfo);
});

test('an agent proposal in the approvals diff table has no accessibility violations', async ({
  page,
}, testInfo) => {
  // The global setup (warm.ts) seeded one pending proposal for this entry: the plain /approvals
  // sweep sees it too, so the diff table is always scanned.
  const title = PROPOSAL_TARGET;
  await openCms(page, '/approvals');
  const proposal = page.getByRole('listitem', { name: `Proposal for ${title}` });
  await expect(proposal.getByRole('table', { name: `Changes proposed to ${title}` })).toBeVisible();
  await expect(proposal.getByText('Agent proposed body')).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Approve and apply' })).toBeEnabled();
  await scan(page, testInfo);
});

test('the publish confirmation has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  await withoutAssistant(page);
  const title = `Confirm ${Date.now()}`;
  await createChanged(request, title);
  await openCms(page, '/content/article');
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: `Publish “${title}”` })
    .click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('1 field changed')).toBeVisible();
  await scan(page, testInfo);
});

test('a publish card with its review open has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const title = `Card ${Date.now()}`;
  await createChanged(request, title);
  await openCms(page, '/content/article');
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: `Publish “${title}”` })
    .click();
  const card = page
    .getByRole('complementary', { name: 'Coworker' })
    .getByRole('region', { name: 'Publish this entry' })
    .filter({ hasText: title });
  await card.getByRole('button', { name: 'Review changes' }).click();
  await expect(card.getByText('Edited body')).toBeVisible();
  await scan(page, testInfo);
  // The conversation is shared with every other test: a card left waiting would be in theirs.
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
});

test('a block patch card, ready and refused, has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const title = `Blocks card ${Date.now()}`;
  const { id } = await createBlocksPage(request, title);
  await openCms(page, `/content/landing/${id}`);
  const panel = await askCoworker(page, 'Move the first block to the end');
  // The conversation is shared with tests running beside this one: this entry's card only.
  const card = panel.getByRole('region', { name: 'Change blocks' }).filter({ hasText: title });
  await expect(card.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  await card.getByRole('button', { name: 'Review changes' }).click();
  await expect(card.getByRole('list', { name: 'Changes' })).toBeVisible();
  await scan(page, testInfo);

  // Saved again under it, the card reads the draft again and refuses the stale move.
  await resaveBlocksPage(request, id, title);
  await openCms(page, `/content/landing/${id}`);
  const stale = page
    .getByRole('complementary', { name: 'Coworker' })
    .getByRole('region', { name: 'Change blocks' })
    .filter({ hasText: title });
  await expect(stale.getByText('The entry changed after this was proposed')).toBeVisible();
  await expect(stale.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await scan(page, testInfo);
  // The conversation is shared with every other test: a card left waiting would be in theirs.
  await stale.getByRole('button', { name: 'Not now' }).click();
  await expect(stale).toHaveCount(0);
});

test('an entry’s authorship and the Mine filter have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await createDraft(request, `Authorship ${Date.now()}`);
  await openCms(page, `/content/article/${id}`);
  const pane = page.getByRole('complementary', { name: 'Side pane' });
  await pane.getByRole('radio', { name: 'Details' }).click();
  await expect(pane.getByText('Last edited by')).toBeVisible();
  await scan(page, testInfo);
  await openCms(page, '/content/article');
  await page.getByRole('button', { name: 'Mine' }).click();
  await expect(page.getByRole('button', { name: 'Mine' })).toHaveAttribute('aria-pressed', 'true');
  await scan(page, testInfo);
});

test('an entry written right to left has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const id = await createDraft(request, `RTL ${Date.now()}`);
  // The space as if it had an Arabic locale, written right to left and not yet delivered: the
  // config is stubbed in the browser, so nothing is written to the shared server.
  await stubLocales(page, { ar: { delivered: false, direction: 'rtl' } });
  await openCms(page, `/content/article/${id}`);
  await page.getByRole('button', { name: 'ar Not delivered' }).click();
  const title = page.getByRole('textbox', { name: /Title/ });
  await expect(title).toBeVisible();
  // On the input holding the words: the label and the field's chrome keep the admin's direction.
  await expect(title).toHaveAttribute('dir', 'rtl');
  await expect(title).toHaveAttribute('lang', 'ar');
  await expect(
    page.getByText('Title', { exact: true }).locator('xpath=ancestor::*[@dir]'),
  ).toHaveCount(0);
  await scan(page, testInfo);
});

test('Settings → Locales has no accessibility violations', async ({ page }, testInfo) => {
  await stubLocales(page, { ar: { delivered: true, direction: 'rtl' } });
  await openCms(page, '/settings/locales');
  await expect(page.getByRole('switch', { name: 'Deliver ar' })).toBeEnabled();
  await scan(page, testInfo);
  // The question asked in place before Delivery stops serving a locale.
  await page.getByRole('switch', { name: 'Deliver ar' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Stop delivering ar?' })).toBeVisible();
  await scan(page, testInfo);
});

test('a blocks field’s editor has no accessibility violations', async ({ page, request }, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  const leaf = (apiId: string, name: string) => ({
    apiId,
    name,
    type: 'Symbol',
    localized: false,
    required: true,
    position: 0,
  });
  const type = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'promo',
    name: 'Promo',
    displayField: 'title',
    fields: [
      leaf('title', 'Title'),
      {
        apiId: 'blocks',
        name: 'Blocks',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [
            { apiId: 'hero', name: 'Hero', fields: [leaf('heading', 'Heading')] },
            { apiId: 'cta', name: 'Call to action', fields: [leaf('label', 'Label')] },
          ],
        },
      },
    ],
  });
  expect([200, 201], await type.text()).toContain(type.status());
  await api(request, 'POST', `${MGMT}/content-types/promo/published`);

  await openCms(page, '/content/promo/new');
  const add = page.getByRole('button', { name: 'Add block to Blocks' });
  await expect(add).toBeVisible({ timeout: 15_000 });
  await add.click();
  // Not scanned while open: a Radix menu is modal, so it marks the page behind it aria-hidden, and
  // axe reports the hidden page's focusable controls (every menu in the admin does the same).
  await expect(page.getByRole('menuitem', { name: 'Call to action' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Hero' }).click();
  await add.click();
  await page.getByRole('menuitem', { name: 'Call to action' }).click();
  await expect(page.getByRole('button', { name: 'Remove Hero block 1' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Move Call to action block 2 down' }),
  ).toBeDisabled();
  await scan(page, info);
});

// The taxonomy screen's tag table (slug, published count) and the term editor sheet with its
// localized-label fields.
test('the taxonomy tag table and its term editor have no accessibility violations', async ({
  page,
}, testInfo) => {
  const stamp = Date.now().toString(36);
  const created = await api(page.request, 'POST', `${MGMT}/taxonomy/tags`, {
    name: `A11y ${stamp}`,
    description: 'Checked by axe',
  });
  expect(created.ok()).toBe(true);
  await openCms(page, '/taxonomy');
  await page.getByRole('tab', { name: 'Tags' }).click();
  const table = page.getByRole('list', { name: 'Tags' });
  await expect(table.getByText(`a11y-${stamp}`)).toBeVisible();
  await scan(page, testInfo);
  await table.getByRole('button', { name: `Edit “A11y ${stamp}”` }).click();
  const sheet = page.getByRole('dialog', { name: `Edit “A11y ${stamp}”` });
  await expect(sheet.getByLabel('Slug')).toHaveValue(`a11y-${stamp}`);
  await scan(page, testInfo, ['[role="dialog"]']);
});

test('a singleton’s entry, opened by its type, has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const apiId = `a11ySettings${Date.now()}`;
  const made = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId,
    name: 'A11y settings',
    displayField: 'title',
    singleton: true,
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
  });
  expect(made.status()).toBe(201);
  await api(request, 'POST', `${MGMT}/content-types/${apiId}/published`);
  await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: apiId,
    fields: { title: { 'en-US': 'Site' } },
  });
  await openCms(page, `/content/${apiId}/entry`);
  await expect(page).toHaveURL(new RegExp(`/content/${apiId}/[0-9a-f-]{36}$`));
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await scan(page, testInfo);
});

test('a content type’s clone and delete dialogs have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const apiId = `a11yDoomed${Date.now()}`;
  await api(request, 'POST', `${MGMT}/content-types`, {
    apiId,
    name: `A11y doomed ${apiId}`,
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
  });
  await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: apiId,
    fields: { title: { 'en-US': 'x' } },
  });
  await openCms(page, '/content');
  const more = page.getByRole('button', { name: `More actions for “A11y doomed ${apiId}”` });
  // The open menu, scanned on its own: a modal Radix menu hides the page behind it with
  // aria-hidden (focus is trapped in the menu), which axe would report outside it.
  await more.click();
  await scan(page, testInfo, ['[role="menu"]']);
  await page.getByRole('menuitem', { name: 'Clone…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await more.click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox', { name: /Delete its 1 entry too/ })).toBeVisible();
  await scan(page, testInfo);
});

test('the content type dialog’s settings and layout have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  await seedLaidOutType(request);
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Edit “Happening”' }).click();
  await page.getByRole('button', { name: /^Settings for Day/ }).click();
  await expect(page.getByLabel('Format for Day')).toBeVisible();
  await page.getByRole('button', { name: /^Settings for Note/ }).click();
  await expect(page.getByLabel('Pattern for Note')).toBeVisible();
  await expect(page.getByLabel('Name of tab 1')).toBeVisible();
  await expect(page.getByLabel('Tab for Day')).toBeVisible();
  await scan(page, testInfo);
});

test('an entry form in tabs with a named group has no accessibility violations', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  await seedLaidOutType(request);
  await openCms(page, '/content/happening/new');
  await page.getByRole('tab', { name: 'When' }).click({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Timing' })).toBeVisible();
  await scan(page, info);
});
