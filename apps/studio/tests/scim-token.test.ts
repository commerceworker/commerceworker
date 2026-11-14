import { sha256Hex } from '@commerceworker/security/credentials';
import { InMemoryAdminScimDirectory, InMemoryAdminSettings } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCIM_TOKEN_MS } from '~/lib/scim';

vi.mock('cloudflare:workers', () => ({ env: {} }));
let directory = new InMemoryAdminScimDirectory();
const settings = new InMemoryAdminSettings();
vi.mock('~/lib/wire.server', () => ({
  adminSettings: () => settings,
  adminScimDirectory: () => directory,
}));
const audit = vi.fn();
vi.mock('~/lib/audit.server', () => ({ audit, clientIp: () => '203.0.113.7' }));

const {
  scimAuthorized,
  scimTokenSet,
  createScimToken,
  revokeScimToken,
  setScimRoles,
  scimGroupsWithRoles,
} = await import('~/lib/scim.server');

const token = 'cw_scim_abc123';
const request = (bearer = token) =>
  new Request('https://app.test/scim/v2/Users', { headers: { authorization: `Bearer ${bearer}` } });

describe('the SCIM token', () => {
  it('works for a year after it was made, then stops', async () => {
    const made = 1_000_000_000_000;
    await settings.set({
      key: 'scim_token',
      value: await sha256Hex(token),
      updatedAt: made,
      updatedBy: 'admin',
    });
    expect(await scimAuthorized(request(), made + SCIM_TOKEN_MS - 1)).toBe(true);
    expect(await scimAuthorized(request(), made + SCIM_TOKEN_MS)).toBe(false);
    expect(await scimAuthorized(request('cw_scim_other'), made)).toBe(false);
    await settings.remove('scim_token');
    expect(await scimAuthorized(request(), made)).toBe(false);
  });
});

const by = {
  kind: 'user' as const,
  id: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin' as const,
};
beforeEach(async () => {
  await settings.remove('scim_token');
  await settings.remove('scim_roles');
  directory = new InMemoryAdminScimDirectory({
    people: [
      {
        id: 'admin',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'admin',
        createdAt: 1,
        disabledAt: null,
        scimExternalId: null,
      },
      {
        id: 'member',
        email: 'member@example.com',
        name: 'Member',
        createdAt: 2,
        disabledAt: null,
        scimExternalId: null,
      },
    ],
  });
  audit.mockReset();
});

it('stores only a token hash, exposes metadata only, rotates and revokes it', async () => {
  const first = await createScimToken(request(), by);
  const row = await settings.record('scim_token');
  expect(row?.value).toBe(await sha256Hex(first));
  expect(JSON.stringify(await scimTokenSet())).not.toContain(row?.value);
  expect(await scimTokenSet()).toEqual({ updatedAt: expect.any(Number), updatedBy: by.email });
  expect(await scimAuthorized(request(first))).toBe(true);
  const second = await createScimToken(request(), by);
  expect(await scimAuthorized(request(first))).toBe(false);
  expect(await scimAuthorized(request(second))).toBe(true);
  expect(audit).toHaveBeenLastCalledWith(expect.any(Request), 'scim.token_created', {
    actor: by,
    detail: { replaced: true },
  });
  await revokeScimToken(request(), by);
  expect(await scimTokenSet()).toBeNull();
  expect(await scimAuthorized(request(second))).toBe(false);
  expect(JSON.stringify(audit.mock.calls)).not.toContain(second);
});

it('saves a group map and derives member roles through the composed directory', async () => {
  await directory.addGroup({
    id: 'g',
    displayName: 'Group',
    externalId: null,
    createdAt: 1,
    updatedAt: 1,
  });
  await directory.addMembers('g', ['member']);
  await setScimRoles(request(), by, { g: 'admin' });
  expect(await directory.role('member')).toBe('admin');
  expect(await scimGroupsWithRoles()).toEqual([
    { id: 'g', displayName: 'Group', members: 1, role: 'admin' },
  ]);
  const count = audit.mock.calls.length;
  await setScimRoles(request(), by, { g: 'admin' });
  expect(audit).toHaveBeenCalledTimes(count);
  await setScimRoles(request(), by, {});
  expect(await directory.role('member')).toBe('member');
});
