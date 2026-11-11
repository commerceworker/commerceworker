import { expect, test } from '@playwright/test';
import { open, tapTargets } from './helpers';

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** What a terminal does: registers as the CLI does (once per project: registration is rate-limited). */
let clientId = '';
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ playwright }, info) => {
  const request = await playwright.request.newContext({
    baseURL: info.project.use.baseURL as string,
  });
  const registered = await request.post('/oauth/register', {
    data: {
      client_name: 'Terminal e2e',
      grant_types: [GRANT, 'refresh_token'],
      redirect_uris: [],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(registered.status()).toBe(201);
  clientId = ((await registered.json()) as { client_id: string }).client_id;
  await request.dispose();
});

async function terminal(request: import('@playwright/test').APIRequestContext) {
  const started = await request.post('/oauth/device_authorization', {
    form: { client_id: clientId, scope: 'viewer' },
  });
  expect(started.status()).toBe(200);
  const device = (await started.json()) as { device_code: string; user_code: string };
  return { client_id: clientId, ...device };
}

test('approving a sign-in from a terminal: confirm the code, see who asks, then the token arrives', async ({
  page,
  request,
}, info) => {
  const t = await terminal(request);
  // The link the terminal prints brings the person here and does nothing else: the field is
  // empty, and they type the code their terminal shows.
  await open(page, `/oauth/device?user_code=${t.user_code}`);
  const field = page.getByLabel('Code');
  await expect(field).toHaveValue('');
  await expect(page.getByText(/it doesn’t carry the code/)).toBeVisible();
  await field.fill(t.user_code);
  await expect(page.getByText(new URL(page.url()).host, { exact: false }).first()).toBeVisible();
  // Not approved, not even looked up, until the person continues.
  const early = await request.post('/oauth/token', {
    form: { grant_type: GRANT, client_id: t.client_id, device_code: t.device_code },
  });
  expect((await early.json()).error).toBe('authorization_pending');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: /Terminal e2e/ })).toBeVisible();
  await expect(page.getByText('Unverified name')).toBeVisible();
  await expect(page.getByText(`${new URL(page.url()).origin}/api/v1`)).toBeVisible();
  await expect(page.getByText('Approve only a sign-in you started.')).toBeVisible();
  await expect(
    page.getByText(/Approve only if you just started this in your own terminal/),
  ).toBeVisible();
  await expect(page.getByText(/The request came from/)).toBeVisible();

  // Phones and iPads: nothing scrolls sideways, and the decision buttons are real touch targets.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  if (info.project.name !== 'desktop')
    for (const b of await tapTargets(page, 'button[name="intent"]'))
      expect(b.height, b.name).toBeGreaterThanOrEqual(44);

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toContainText('Terminal e2e can now act as');

  // The terminal's next poll (after its interval) gets tokens.
  await expect(async () => {
    const res = await request.post('/oauth/token', {
      form: { grant_type: GRANT, client_id: t.client_id, device_code: t.device_code },
    });
    const body = await res.json();
    expect(res.status(), JSON.stringify(body)).toBe(200);
    expect(body.access_token).toBeTruthy();
  }).toPass({ intervals: [5_500], timeout: 30_000 });
});

test('denying, and a code that is not one, leave the terminal without access', async ({
  page,
  request,
}) => {
  const t = await terminal(request);
  await open(page, '/oauth/device');
  await page.getByLabel('Code').fill('BCDF-2345');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/isn’t valid, or it has expired/)).toBeVisible();

  await page.getByLabel('Code').fill(t.user_code.toLowerCase().replace('-', ' '));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByRole('status')).toContainText('was not given access');
  await expect(async () => {
    const res = await request.post('/oauth/token', {
      form: { grant_type: GRANT, client_id: t.client_id, device_code: t.device_code },
    });
    expect((await res.json()).error).toBe('access_denied');
  }).toPass({ intervals: [5_500], timeout: 30_000 });
});
