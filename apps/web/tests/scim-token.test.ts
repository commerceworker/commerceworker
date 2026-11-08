import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '~/lib/credentials';
import { SCIM_TOKEN_MS } from '~/lib/scim';

vi.mock('cloudflare:workers', () => ({ env: {} }));
/** The `scim_token` setting, as the workspace port reads it. */
let row: { value: string; updatedAt: number; updatedBy: string } | undefined;
vi.mock('~/lib/wire.server', () => ({
  workspaceStore: () => ({ settingRecord: async () => row }),
}));
vi.mock('~/lib/audit.server', () => ({ audit: vi.fn(), clientIp: () => '203.0.113.7' }));

const { scimAuthorized } = await import('~/lib/scim.server');

const token = 'cmw_scim_abc123';
const request = (bearer = token) =>
  new Request('https://app.test/scim/v2/Users', { headers: { authorization: `Bearer ${bearer}` } });

describe('the SCIM token', () => {
  it('works for a year after it was made, then stops', async () => {
    const made = 1_000_000_000_000;
    row = { value: await sha256Hex(token), updatedAt: made, updatedBy: 'ada@example.com' };
    expect(await scimAuthorized(request(), made + SCIM_TOKEN_MS - 1)).toBe(true);
    expect(await scimAuthorized(request(), made + SCIM_TOKEN_MS)).toBe(false);
    expect(await scimAuthorized(request('cmw_scim_other'), made)).toBe(false);
    row = undefined;
    expect(await scimAuthorized(request(), made)).toBe(false);
  });
});
