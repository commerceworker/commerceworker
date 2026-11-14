import { expect, type FullConfig, webkit } from '@playwright/test';

/** As in the commerce harness, discover lazy dev dependencies before a test starts interacting. */
export default async function warm(config: FullConfig) {
  const browser = await webkit.launch();
  const page = await browser.newPage();
  const base = config.projects[0]!.use.baseURL!;
  for (const path of ['/content/entries', '/content/assets', '/content/settings', '/content']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() =>
          Boolean(
            (window as unknown as { __reactRouterDataRouter?: object }).__reactRouterDataRouter,
          ),
        );
        if (path === '/content') {
          await page.getByRole('button', { name: 'Content assistant', exact: true }).click();
          await expect(page.getByRole('complementary', { name: 'Coworker' })).toBeVisible();
        }
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }
  await browser.close();
}
