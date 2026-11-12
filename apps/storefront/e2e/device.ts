import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** What the account's device specs share: a client per project, and the checks every page keeps. */

/**
 * Each device project is a client of its own. The sign-in budgets are per client address (and the
 * local rate limiter counts across the whole run), and with no `cf-connecting-ip` every project is
 * the same client, 'unknown': five projects' link and code requests in a minute then spend one
 * budget and answer 429 in whichever test runs last. Cloudflare sets the header in production;
 * here each project sends its own, which the Worker reads as it does there.
 */
const CLIENT = Object.fromEntries(
  ['iphone', 'iphone-landscape', 'ipad', 'ipad-landscape', 'desktop'].map((p, i) => [
    p,
    `198.51.100.${i + 1}`,
  ]),
);

/** The headers a device project's context sends: its own client address (call from `beforeEach`). */
export const clientHeaders = (project: string) => ({ 'cf-connecting-ip': CLIENT[project]! });

/**
 * Waits for app.css to apply: the dev server adds it with script, so a page just navigated to is
 * unstyled for a moment, and a measure taken then is of the wrong page. Every account page's main is a capped column.
 */
export const styled = (page: Page) =>
  page.waitForFunction(() => {
    const main = document.querySelector('main');
    return !!main && getComputedStyle(main).maxWidth !== 'none';
  });

/** The page is no wider than the screen. */
export async function fits(page: Page) {
  await styled(page);
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}

/** Every button and field on the page is at least 44px tall, and every field is 16px. */
export async function touchable(page: Page) {
  await styled(page);
  const small: string[] = [];
  for (const el of await page
    .locator('main input:not([type="hidden"]), main button, main a')
    .all()) {
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    if (box && box.height < 43.5)
      small.push(`${await el.evaluate((n) => n.outerHTML.slice(0, 80))}: ${box.height}`);
  }
  expect(small, 'controls shorter than 44px').toEqual([]);
  const sizes = await page
    .locator('main input:not([type="hidden"])')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
  for (const size of sizes) expect(size).toBe('16px');
}

/** What a page must send: never cached, never referred, never framed, and padded for the notch. */
export async function isPrivate(page: Page, res: { headers(): Record<string, string> }) {
  await styled(page);
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(res.headers()['referrer-policy']).toBe('same-origin');
  expect(res.headers()['x-frame-options']).toBe('DENY');
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  expect(
    await page
      .locator('main')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft)),
  ).toBeGreaterThanOrEqual(16);
}

export async function noViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
