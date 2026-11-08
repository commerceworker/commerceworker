import { expect, type Page, test } from '@playwright/test';
import { fakeSafeArea, isPhone, isTouch, open, PAGES, tapTargets } from './helpers';

// With nobody added yet, local development is open: every page renders as an admin.

for (const path of PAGES) {
  test(`${path} renders in the shell and doesn't scroll sideways`, async ({ page }) => {
    await open(page, path);
    await expect(page.locator('h1').first()).toBeAttached();
    const [scroll, width] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ]);
    expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
  });
}

test('/ goes to the overview', async ({ page }) => {
  await open(page, '/');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('a CMS screen is the real screen, not a placeholder', async ({ page }) => {
  await open(page, '/releases');
  // The screen's own h1, with or without a space yet (a fresh database says so beneath it).
  await expect(page.getByRole('heading', { level: 1, name: 'Releases' })).toBeVisible();
  await expect(page.getByText('This screen is being ported')).toHaveCount(0);
});

test('the old /media address goes to Assets, query and all', async ({ page }) => {
  await open(page, '/media?view=list');
  await expect(page).toHaveURL(/\/assets\?view=list$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Assets' })).toBeVisible();
});

/** The sidebar's drawn width, in CSS px. */
const sidebarWidth = (page: Page) =>
  page
    .locator('[data-slot="sidebar-container"]')
    .evaluate((el) => Math.round(el.getBoundingClientRect().width));

test('wider screens get the sidebar, grouped, with the deployment pages for admins', async ({
  page,
}, info) => {
  test.skip(isPhone(info), 'phones have the tab bar');
  await open(page, '/content');
  const side = page.getByRole('navigation', { name: 'Main' }).first();
  // Settings is its own section groups, Workspace last; the deployment's pages follow for admins.
  // The seeded agent proposal waits in Approvals: its name carries the count, and the eye gets a
  // pill on the full sidebar or a dot on the rail.
  await expect(side.getByRole('link', { name: /^Approvals, \d+ waiting$/ })).toBeAttached();
  await expect(
    side.locator(
      (await sidebarWidth(page)) > 100 ? '[data-approvals-count]' : '[data-approvals-dot]',
    ),
  ).toBeVisible();
  for (const name of [
    'Overview',
    'Content',
    'Releases',
    'Workflows',
    'Assets',
    'Access',
    'Workspace',
    'People and sign-in',
  ])
    await expect(side.getByRole('link', { name, exact: true })).toBeAttached();
  // One audit log in the nav (Settings › Workspace); the deployment's opens from People and sign-in.
  await expect(side.getByRole('link', { name: 'Audit log', exact: true })).toHaveCount(0);
  await expect(side.getByRole('link', { name: 'Content', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await open(page, '/settings/environments');
  await expect(side.getByRole('link', { name: 'Workspace', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Each Settings section marks its own group and no other, drawn and announced alike, on a
  // group's later sections as well as its first.
  for (const [path, group] of [
    ['/settings/team', 'Access'],
    ['/settings/api-keys', 'Access'],
    ['/settings/webhooks', 'Automation'],
    ['/settings/plugins', 'Extensions'],
    ['/settings/audit-log', 'Workspace'],
  ] as const) {
    await open(page, path);
    await expect(side.locator('[aria-current="page"]'), path).toHaveText(group);
    await expect(side.locator('[data-active]'), path).toHaveText(group);
  }
});

test('the sidebar collapses to a rail, and stays as it was left', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the full sidebar is lg and up');
  await open(page, '/content');
  expect(await sidebarWidth(page)).toBe(256);
  const toggle = page.getByRole('button', { name: 'Sidebar', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect.poll(() => sidebarWidth(page)).toBe(52);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // As a rail, Approvals' count is a dot at its icon.
  const rail = page.locator('[data-slot="sidebar"]');
  await expect(rail.locator('[data-approvals-dot]')).toBeVisible();
  await expect(rail.locator('[data-approvals-count]')).toBeHidden();
  // A rail keeps every page by name for screen readers.
  await expect(
    page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Assets' }),
  ).toBeAttached();
  await open(page, '/content');
  expect(await sidebarWidth(page), 'collapsed before paint after a reload').toBe(52);
  await page.locator('main h1').click();
  await page.keyboard.press('Meta+Backslash');
  await expect.poll(() => sidebarWidth(page)).toBe(256);
});

test('an iPad upright has the rail beside the page, opening over it', async ({ page }, info) => {
  test.skip(info.project.name !== 'ipad', 'iPad upright');
  await open(page, '/content');
  expect(await sidebarWidth(page)).toBe(52);
  const main = await page.locator('main').boundingBox();
  await page.getByRole('button', { name: 'Sidebar', exact: true }).tap();
  await expect.poll(() => sidebarWidth(page)).toBe(256);
  expect((await page.locator('main').boundingBox())!.x, 'the page stays where it was').toBe(
    main!.x,
  );
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Assets' })
    .tap();
  await expect(page).toHaveURL(/\/assets$/);
  await expect.poll(() => sidebarWidth(page)).toBe(52);
});

test('phones get the tab bar, clear of the status bar and home indicator', async ({
  page,
}, info) => {
  test.skip(!isPhone(info), 'phones only');
  await open(page, '/dashboard');
  await fakeSafeArea(page);
  const bar = page.locator('nav[aria-label="Main"]:visible');
  for (const name of ['Overview', 'Content', 'Approvals', 'Releases'])
    await expect(bar.getByRole('link', { name })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'More' })).toBeVisible();
  // The seeded agent proposal waits in Approvals: a pill on its tab, the count in its name.
  await expect(bar.getByRole('link', { name: /^Approvals, \d+ waiting$/ })).toBeVisible();
  await expect(bar.locator('[data-approvals-count]')).toBeVisible();
  const tab = await bar.getByRole('link', { name: 'Content' }).boundingBox();
  expect(tab!.y + tab!.height, 'a tab sits above the 34px home indicator').toBeLessThanOrEqual(
    page.viewportSize()!.height - 34,
  );
  const mark = await page.getByRole('link', { name: 'CommerceWorker overview' }).boundingBox();
  expect(mark!.y, 'the top bar sits below the 47px status bar').toBeGreaterThanOrEqual(47);
});

test('More holds the other pages and closes on navigation', async ({ page }, info) => {
  test.skip(!isPhone(info), 'phones only');
  await open(page, '/dashboard');
  await page.getByRole('button', { name: 'More' }).tap();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('link', { name: 'Assets' }).tap();
  await expect(page).toHaveURL(/\/assets$/);
  await expect(sheet).toBeHidden();
  // The route announcer says where the navigation landed.
  await expect(page.locator('p[aria-live="polite"][aria-atomic="true"]')).toHaveText(/Assets/);
});

test('controls take a 44px tap on touch screens', async ({ page }, info) => {
  test.skip(!isTouch(info), 'touch screens only');
  await open(page, '/dashboard');
  const targets = await tapTargets(
    page,
    'header a, header button, nav[aria-label="Main"] a, nav[aria-label="Main"] button',
  );
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.filter((t) => t.height < 44)).toEqual([]);
});

test('tabs take a 44px tap on touch screens and keep their density on desktop', async ({
  page,
}, info) => {
  await open(page, '/taxonomy');
  // The screen loads its space on the client: wait for the tabs, then measure them.
  await expect(page.getByRole('tab')).toHaveCount(2);
  const tabs = await tapTargets(page, '[data-slot="tabs-trigger"]');
  expect(tabs.map((t) => t.name)).toEqual(['Concepts', 'Tags']);
  if (isTouch(info)) expect(tabs.filter((t) => t.height < 44)).toEqual([]);
  else expect(tabs.filter((t) => t.height >= 44)).toEqual([]);
});

test('Account offers the Home Screen on an iPhone or iPad, until dismissed', async ({
  page,
}, info) => {
  const hint = page.getByRole('complementary', { name: 'Add to Home Screen' });
  await open(page, '/account');
  if (info.project.name === 'desktop') {
    await expect(hint).toHaveCount(0);
    return;
  }
  await expect(hint).toBeVisible();
  await hint.getByRole('button', { name: 'Not now' }).click();
  await expect(hint).toHaveCount(0);
});

test('the theme follows the system until the reader picks one', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the account menu is the sidebar’s, lg and up');
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  // Nothing chosen yet: dark before first paint on a dark system, and it follows a change.
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, '/dashboard');
  expect(await theme()).toBe('dark');
  await page.getByRole('button', { name: /account menu/ }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Match system' })).toBeChecked();
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(theme).toBe('light');

  // Choosing Light holds it, whatever the system does, across a reload.
  await page.getByRole('button', { name: /account menu/ }).click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, '/dashboard');
  expect(await theme()).toBe('light');
});

test('G then a letter goes to a page, and ? lists the shortcuts', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a hardware keyboard');
  await open(page, '/dashboard');
  await page.locator('main h1').click();
  await page.keyboard.press('g');
  await page.keyboard.press('r');
  await expect(page).toHaveURL(/\/releases$/);
  await page.locator('main h1').click();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('the assistant opens beside the page from lg, as a sheet below, and never breaks it', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page, '/content');
  const toggle = page.getByRole('button', { name: 'Coworker', exact: true });
  await expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Meta+J Control+J');
  await toggle.click();
  const panel = page.getByRole('complementary', { name: 'Coworker' });
  await expect(panel.getByRole('heading', { name: 'Coworker', level: 2 })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Whether or not the agent answers here, the panel opens on its prompt or says it can't reach it.
  // The first open starts the person's Durable Object cold, which under a parallel run can take
  // longer than the default 5 s.
  await expect(
    panel
      .getByRole('textbox', { name: 'Message Coworker' })
      .or(panel.getByText(/Can’t reach Coworker/))
      .first(),
  ).toBeVisible({ timeout: 15_000 });
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  if (wide) {
    // A column: the page narrows beside it, and nothing is covered.
    await expect.poll(() => panel.evaluate((el) => el.getBoundingClientRect().width)).toBe(400);
    const [main, aside] = await Promise.all([
      page.locator('#main').evaluate((el) => el.getBoundingClientRect().right),
      panel.evaluate((el) => el.getBoundingClientRect().left),
    ]);
    expect(main).toBeLessThanOrEqual(aside + 1);
  } else {
    // A sheet over the page: Escape closes it and hands focus back to the page.
    await panel.getByRole('button', { name: /Close Coworker/ }).focus();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#main')).toBeFocused();
  }
  const [scroll, width] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
  expect(errors).toEqual([]);
  if (isTouch(info)) return;
  // ⌘J (Ctrl+J) closes it from anywhere, and opens it again.
  await page.locator('main h1').click();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ControlOrMeta+j');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('the sidebar is a rail beside the assistant’s column below xl', async ({ page }, info) => {
  test.skip(info.project.name !== 'ipad-landscape', 'lg to xl');
  await open(page, '/content');
  expect(await sidebarWidth(page)).toBeGreaterThan(200);
  await page.getByRole('button', { name: 'Coworker', exact: true }).click();
  await expect.poll(() => sidebarWidth(page)).toBeLessThan(80);
});
