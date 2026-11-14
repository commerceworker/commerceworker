import { expect, type Page, test } from '@playwright/test';

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __reactRouterDataRouter?: object }).__reactRouterDataRouter),
  );
}

test.beforeAll(async ({ request }) => {
  const space = await request.post('/content-api/spaces', {
    data: { spaceId: 'unified', name: 'Unified admin', defaultLocale: 'en-US' },
  });
  expect([200, 201, 409], await space.text()).toContain(space.status());
  const type = await request.post('/content-api/spaces/unified/environments/main/content-types', {
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
  });
  expect([200, 201, 409], await type.text()).toContain(type.status());
});

test('content screens share the commerce shell and keep navigation in their namespace', async ({
  page,
}) => {
  await open(page, '/content/entries?space=unified&env=main&locale=en-US');
  await expect(page.getByRole('heading', { name: 'Content', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Article', exact: true }).last().click();
  await expect(page).toHaveURL(/\/content\/entries\/article(?:\?|$)/);
  await expect(page.getByRole('heading', { name: 'Article entries', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Search content', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await open(page, '/content/assets?space=unified');
  await expect(page.getByRole('heading', { name: 'Assets', exact: true })).toBeVisible();
  await open(page, '/content/settings');
  await expect(page).toHaveURL(/\/content\/settings\/team/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (test.info().project.name === 'iphone') {
    await expect(page.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Entries', exact: true }).last()).toBeVisible();
  } else {
    await expect(page.getByRole('link', { name: 'Orders', exact: true }).first()).toBeVisible();
  }
});

test('the content assistant uses its own proxied socket and remains separate from commerce', async ({
  page,
}) => {
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await open(page, '/content?space=unified&env=main&locale=en-US');
  if (test.info().project.name === 'desktop') await page.keyboard.press('Meta+j');
  else await page.getByRole('button', { name: 'Content assistant', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Coworker' })).toBeVisible();
  await expect
    .poll(() => sockets.some((url) => url.includes('/content-api/agents/assistant-agent/local')))
    .toBe(true);
  const panel = page.getByRole('complementary', { name: 'Coworker' });
  await panel.getByRole('textbox', { name: 'Message Coworker' }).fill('List content types');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('.is-assistant').last()).toContainText('1 result.');
  const connections = sockets.filter((url) =>
    url.includes('/content-api/agents/assistant-agent/local'),
  ).length;
  await panel.getByRole('button', { name: /^Close Coworker/ }).click();
  await page.getByRole('button', { name: 'Content assistant', exact: true }).click();
  await expect(panel.locator('.is-assistant').last()).toContainText('1 result.');
  expect(
    sockets.filter((url) => url.includes('/content-api/agents/assistant-agent/local')),
  ).toHaveLength(connections);
});
