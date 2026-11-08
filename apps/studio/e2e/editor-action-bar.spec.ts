import { expect, test } from '@playwright/test';
import { createDraft, EDITOR_READY, openCms, seedCms, useCmsScope } from './cms';
import { fakeSafeArea } from './helpers';

/*
 * The entry editor's action bar on a phone: below md it is fixed above the tab bar, so Save draft
 * and Publish stay in reach while the form scrolls. Layout is what jsdom can't judge, so it is
 * measured here in WebKit on an iPhone.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

test('Save draft and Publish sit above the tab bar, take a 44px tap and stay in view on scroll', async ({
  page,
  request,
}) => {
  const id = await createDraft(request, `Bar ${Date.now()}`);
  await openCms(page, `/content/article/${id}`);
  await fakeSafeArea(page);
  const bar = page.locator('[data-page-bar]');
  const save = bar.getByRole('button', { name: 'Save draft' });
  const publish = bar.getByRole('button', { name: 'Publish', exact: true });
  await expect(save).toBeVisible(EDITOR_READY);
  await expect(publish).toBeVisible();
  const tabs = page.locator('nav[aria-label="Main"]:visible');

  const measure = async () => {
    const tab = (await tabs.boundingBox())!;
    const boxOf = async (button: typeof save) => {
      const box = (await button.boundingBox())!;
      return { x: box.x, y: box.y, bottom: box.y + box.height, height: box.height };
    };
    return { tab, save: await boxOf(save), publish: await boxOf(publish) };
  };

  const check = async (when: string) => {
    const { tab, save: s, publish: p } = await measure();
    const viewport = page.viewportSize()!;
    for (const [name, b] of [
      ['Save draft', s],
      ['Publish', p],
    ] as const) {
      expect(b!.bottom, `${name} ${when} ends above the tab bar (${tab.y})`).toBeLessThanOrEqual(
        tab.y,
      );
      expect(b!.y, `${name} ${when} is inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(b!.bottom, `${name} ${when} is inside the viewport`).toBeLessThanOrEqual(
        viewport.height,
      );
    }
  };

  await check('at rest');

  // The tap area is the button or the larger invisible target around it.
  for (const button of [save, publish]) {
    const tap = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const n = (v: string) => Number.parseFloat(v) || 0;
      const grows = after.content !== 'none' && after.position === 'absolute';
      return grows ? r.height - n(after.top) - n(after.bottom) : r.height;
    });
    expect(tap, 'the action buttons take a 44px tap').toBeGreaterThanOrEqual(44);
  }

  // Scrolled to the end of the page, the bar has not moved off the screen.
  const before = await measure();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await check('after scrolling');
  const after = await measure();
  expect(after.save.y, 'the bar is fixed, not scrolled away').toBe(before.save.y);
  expect(after.publish.y).toBe(before.publish.y);
});
