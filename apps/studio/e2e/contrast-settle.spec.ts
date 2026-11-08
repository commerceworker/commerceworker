import { expect, test } from '@playwright/test';
import { openCms, seedCms, useCmsScope } from './cms';

/**
 * A control that becomes enabled must be at full contrast the moment it is enabled.
 *
 * `disabled:opacity-50` on the shared Button, with a transition that animates opacity
 * (`transition-all`), means a button re-enabled after a fetch (the audit log's Refresh) spends
 * its first 100ms at roughly half opacity while already enabled: an axe sweep landing in that
 * window fails `color-contrast`, and only sometimes. The fetch is delayed so the enable happens
 * after the page settles, and the opacity is read in the frame the button turns enabled.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test('a re-enabled button is at full opacity at once (no fade through low contrast)', async ({
  page,
}) => {
  await useCmsScope(page);
  await page.route(
    (url) => url.pathname.startsWith('/spaces/') && url.pathname.endsWith('/audit-log'),
    async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    },
  );
  await openCms(page, '/settings/audit-log');
  const refresh = page.getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeDisabled();
  const opacity = await refresh.evaluate(
    (el: HTMLButtonElement) =>
      new Promise<string>((resolve) => {
        const check = () => {
          if (!el.disabled) resolve(getComputedStyle(el).opacity);
          else requestAnimationFrame(check);
        };
        check();
      }),
  );
  expect(opacity).toBe('1');
});
