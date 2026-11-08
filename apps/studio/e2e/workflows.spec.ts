import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { api, MGMT, openCms, seedCms, useCmsScope } from './cms';
import { settle } from './settle';

/*
 * The workflow list and editor end to end: create from a template, edit, publish; then an axe
 * sweep of the editor page (the canvas, the palette and the inspector) and its keyboard wiring.
 * The editor edits from lg up; below it is review-only, so these run on the wide projects.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }, info) => {
  test.skip(
    info.project.name.startsWith('iphone') || info.project.name === 'ipad',
    'the workflow editor is review-only below lg',
  );
  await useCmsScope(page);
});

/** The sidebar as a rail, in pixels. */
const RAIL = 52;

/** The sidebar's width on screen: its panel, border included. */
const sidebarWidth = (page: Page) =>
  page
    .locator('[data-slot=sidebar-container]')
    .evaluate((panel) => Math.round(panel.getBoundingClientRect().width));

test('the editor collapses an open sidebar and fills the width on a wide screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  await openCms(page, '/workflows');
  // Open on the list, so the editor has to collapse it.
  await expect.poll(() => sidebarWidth(page)).toBe(256);
  await page.getByRole('button', { name: 'New workflow' }).click();
  const sheet = page.getByRole('dialog', { name: 'New workflow' });
  await sheet.getByRole('textbox', { name: 'Name' }).fill(`Wide ${Date.now()}`);
  await sheet.getByRole('combobox', { name: 'Template' }).selectOption('tpl-editorial-review');
  await sheet.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByRole('textbox', { name: 'Workflow name' })).toBeVisible({
    timeout: 15_000,
  });

  // The page follows the sidebar in, so wait for it to land rather than for the panel alone.
  const pageLeft = async () => (await page.locator('#main').boundingBox())?.x;
  await expect.poll(pageLeft).toBe(RAIL);
  await expect.poll(() => sidebarWidth(page)).toBe(RAIL);

  // The rail opens over the page, which stays where it was, and closes on Escape.
  await page.getByRole('button', { name: 'Sidebar', exact: true }).click();
  await expect.poll(() => sidebarWidth(page)).toBe(256);
  expect(await pageLeft()).toBe(RAIL);
  await page.keyboard.press('Escape');
  await expect.poll(() => sidebarWidth(page)).toBe(RAIL);

  const main = await page.locator('#main').boundingBox();
  const inspector = await page
    .getByRole('complementary', { name: 'Workflow settings' })
    .boundingBox();
  // The inspector sits flush with the page's right edge, past the 1400px reading width.
  expect(main && inspector && inspector.x + inspector.width).toBeCloseTo(
    (main?.x ?? 0) + (main?.width ?? 0),
    0,
  );
  const palette = await page.getByRole('complementary', { name: 'Palette' }).boundingBox();
  expect(palette?.x).toBe(main?.x);

  // The frame fits the window: the palette's long list scrolls inside it, the page doesn't.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    await page.evaluate(() => window.innerHeight),
  );

  // A short window squeezes the canvas rather than scrolling the page.
  await page.setViewportSize({ width: 1280, height: 480 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
    .toBe(0);
});

test('with Coworker open the inspector gives the canvas its width until a step is picked', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openCms(page, '/workflows');
  await page.getByRole('button', { name: 'New workflow' }).click();
  const sheet = page.getByRole('dialog', { name: 'New workflow' });
  await sheet.getByRole('textbox', { name: 'Name' }).fill(`Beside ${Date.now()}`);
  await sheet.getByRole('combobox', { name: 'Template' }).selectOption('tpl-editorial-review');
  await sheet.getByRole('button', { name: 'Create workflow' }).click();
  const settings = page.getByRole('complementary', { name: 'Workflow settings' });
  await expect(settings).toBeVisible({ timeout: 15_000 });

  const coworker = page.getByRole('button', { name: 'Coworker', exact: true });
  await coworker.click();
  await expect(settings).toBeHidden();
  const canvas = page.locator('.react-flow');
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(250);

  // A picked step keeps its inspector open beside Coworker.
  await coworker.click();
  await expect(settings).toBeVisible();
  // By keyboard: at this width the first step can sit outside the canvas's frame.
  await page.locator('.react-flow__node').first().focus();
  await page.keyboard.press('Enter');
  const step = page.getByRole('complementary', { name: 'Step settings' });
  await expect(step).toBeVisible();
  await coworker.click();
  await expect(coworker).toHaveAttribute('aria-pressed', 'true');
  await expect(step).toBeVisible();
});

test('a hard load draws the full-width frame, and a missing workflow says so', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 1000 });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/spaces(\?.*)?$/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/workflows/missing', { waitUntil: 'load' });

  // Straight under main: nothing puts the loading frame in the page width.
  const frame = page.locator('#main > [aria-busy="true"]');
  await expect(frame).toBeVisible();
  const [main, drawn] = await Promise.all([
    page.locator('#main').boundingBox(),
    frame.boundingBox(),
  ]);
  expect(drawn?.width).toBe(main?.width);

  release();
  await expect(page.getByRole('heading', { name: 'Workflow not available' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('link', { name: 'Back to workflows' })).toBeVisible();
});

test('creates a workflow from a template, edits it and publishes it', async ({ page }) => {
  await openCms(page, '/workflows');
  await page.getByRole('button', { name: 'New workflow' }).click();
  const sheet = page.getByRole('dialog', { name: 'New workflow' });
  const name = `Review ${Date.now()}`;
  await sheet.getByRole('textbox', { name: 'Name' }).fill(name);
  await sheet.getByRole('combobox', { name: 'Template' }).selectOption('tpl-editorial-review');
  await sheet.getByRole('button', { name: 'Create workflow' }).click();

  const title = page.getByRole('textbox', { name: 'Workflow name' });
  await expect(title).toHaveValue(name, { timeout: 15_000 });
  await expect(page.getByText(/^Not published/)).toBeVisible();
  await expect(page.getByText('Ready to publish')).toBeVisible();

  await title.fill(`${name} (edited)`);
  await expect(page.getByText('Unsaved')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await expect(page.getByText('Unsaved')).toBeHidden();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: /as v1\?/ });
  await confirm.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Published v1' })).toBeVisible();
  await expect(page.getByText(/Published v1 · up to date/)).toBeVisible();

  await page.getByRole('link', { name: 'Workflows', exact: true }).first().click();
  const item = page.getByRole('listitem').filter({ hasText: `${name} (edited)` });
  await expect(item.getByText('Published v1')).toBeVisible();
});

test('refuses to publish a draft with errors and lists them', async ({ page, request }) => {
  const res = await api(request, 'POST', `${MGMT}/workflows`, {
    name: `Broken ${Date.now()}`,
    graph: {
      nodes: [
        {
          id: 'c',
          type: 'content.comment',
          label: 'Orphan comment',
          config: { body: 'Hi' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { workflow } = (await res.json()) as { workflow: { id: string } };
  await openCms(page, `/workflows/${workflow.id}`);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Can’t publish yet' });
  await expect(alert).toBeVisible();
  await expect(alert.getByText(/needs exactly one trigger/)).toBeVisible();
});

test('the workflow editor has no accessibility violations', async ({ page, request }, info) => {
  const res = await api(request, 'POST', `${MGMT}/workflows`, {
    name: `A11y ${Date.now()}`,
    graph: { nodes: [], edges: [] },
  });
  const { workflow } = (await res.json()) as { workflow: { id: string } };
  await openCms(page, `/workflows/${workflow.id}`);
  await expect(page.getByRole('navigation', { name: 'Steps' })).toBeVisible({ timeout: 15_000 });

  // Build from the keyboard: the palette adds a trigger, then a step wired in after it.
  await page.getByRole('button', { name: 'Add Submit for review' }).click();
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(page.getByRole('heading', { name: 'Comment' })).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  for (const state of ['step selected', 'nothing selected'] as const) {
    if (state === 'nothing selected') await page.keyboard.press('Escape');
    await settle(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    if (results.violations.length) {
      await info.attach(`axe-${state}.json`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: 'application/json',
      });
    }
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
      `${state}`,
    ).toEqual([]);
  }
});
