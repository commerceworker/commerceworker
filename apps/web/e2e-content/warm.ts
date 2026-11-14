import { devices, expect, type FullConfig, webkit } from '@playwright/test';

/** As in the commerce harness, discover lazy dev dependencies before a test starts interacting. */
export default async function warm(config: FullConfig) {
  const browser = await webkit.launch();
  const page = await browser.newPage({ ...devices['iPhone 15'] });
  const base = config.projects[0]!.use.baseURL!;

  // Seed first so warm-up loads the same populated screens as the tests.
  const space = await page.request.post(`${base}/content-api/spaces`, {
    data: { spaceId: 'unified', name: 'Unified admin', defaultLocale: 'en-US' },
  });
  expect([200, 201, 409], await space.text()).toContain(space.status());
  const type = await page.request.post(
    `${base}/content-api/spaces/unified/environments/main/content-types`,
    {
      data: {
        apiId: 'article',
        name: 'Article',
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: true,
            required: true,
            position: 0,
          },
        ],
      },
    },
  );
  expect([200, 201, 409], await type.text()).toContain(type.status());

  for (const path of ['/content/entries', '/content/assets', '/content/settings', '/content']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(`${base}${path}?space=unified&env=main&locale=en-US`, {
          waitUntil: 'domcontentloaded',
        });
        await page.waitForFunction(() =>
          Boolean(
            (window as unknown as { __reactRouterDataRouter?: object }).__reactRouterDataRouter,
          ),
        );
        if (path === '/content/entries') {
          await page.getByRole('link', { name: 'Article', exact: true }).last().click();
          await expect(
            page.getByRole('heading', { name: 'Article entries', exact: true }),
          ).toBeVisible();
          await page.getByRole('button', { name: 'Search content', exact: true }).click();
          await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
          await page.keyboard.press('Escape');
        }
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
