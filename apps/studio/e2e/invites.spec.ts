import { type APIRequestContext, expect, test } from '@playwright/test';
import { SPACE } from './cms';

/**
 * Invitations end to end, after the `auth` project turned sign-in on. The invitations are made
 * with the deployment's MCP token (a member's invitation needs no person; the Team page's dialog
 * is covered in jsdom), so this spec never touches the first admin's two-factor state, which the
 * `oauth` project sets up beside it. Two people's paths through `/invite/<token>`: someone new
 * creates their account from the link, then, invited again, signs in with their password and
 * accepts. The second is the one a client-side redirect to `/invite` once broke: the token waits
 * in a cookie scoped to `/invite`, which only a document load sends.
 */

const MCP = { Authorization: 'Bearer dev-mcp-token' };

/** One MCP tool call over HTTP, answered as JSON or as one server-sent event. */
async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post('/mcp', {
    headers: { ...MCP, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.ok(), `${name}: ${res.status()}`).toBe(true);
  const text = await res.text();
  const json = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '');
  const result = JSON.parse(json).result as { content: { text: string }[]; isError?: boolean };
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const invite = (request: APIRequestContext, email: string) =>
  tool(request, 'invite_create', {
    email,
    grants: [{ space: SPACE, role: 'editor' }],
  }) as Promise<{ invite: { id: string }; token: string; url?: string }>;

test('someone new joins from a link; then, invited again, signs in with a password and accepts', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  // The e2e space (the CMS projects made it while sign-in was open; make sure).
  await request.post('/spaces', {
    headers: { Authorization: 'Bearer dev-admin-token' },
    data: { spaceId: SPACE, name: 'E2E', defaultLocale: 'en-US' },
  });
  const email = `joiner-${Date.now()}@example.com`;
  const password = 'a long and memorable passphrase';

  // ── Someone new ──
  const first = await invite(request, email);
  const newcomer = await browser.newContext();
  const page = await newcomer.newPage();
  await page.goto(`/invite/${first.token}`);
  // The token left the address for its cookie at once.
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole('heading', { name: 'Join CommerceWorker' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByLabel('Name').fill('Joiner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account and join' }).click();
  await expect(page).toHaveURL(/\/account\?welcome=1$/);
  await expect(page.getByText('Welcome to CommerceWorker.')).toBeVisible();
  // The link worked once.
  await page.goto(`/invite/${first.token}`);
  await expect(page.getByRole('alert')).toContainText('isn’t valid');
  await newcomer.close();

  // ── The same person, invited again, with an account: sign in with the password, then accept ──
  const second = await invite(request, email);
  const returning = await browser.newContext();
  const again = await returning.newPage();
  await again.goto(`/invite/${second.token}`);
  await again.getByRole('link', { name: 'Sign in to accept' }).click();
  await expect(again).toHaveURL(/\/login\?next=%2Finvite$/);
  await again.getByLabel('Email').fill(email);
  await again.getByLabel('Password').fill(password);
  await again.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Back on the invitation as a whole page, so its cookie came along: Accept, not "not valid".
  await expect(again).toHaveURL(/\/invite$/);
  await again.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(again).toHaveURL(/\/(\?joined=1|dashboard)/);
  await returning.close();

  const { items } = (await tool(request, 'invites_list', { status: 'accepted' })) as {
    items: { id: string }[];
  };
  expect(items.map((i) => i.id)).toEqual(
    expect.arrayContaining([first.invite.id, second.invite.id]),
  );
});
