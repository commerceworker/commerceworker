import { env } from 'cloudflare:workers';
import type { AdminScimDirectoryFixture } from '@commerceworker/test-kit';
import {
  ADMIN_SCIM_FIXTURE,
  describeAdminScimDirectoryContract,
} from '@commerceworker/test-kit/admin-scim-directory-contract';
import { expect, it } from 'vitest';
import { createAdminScimDirectory } from '../src/admin-scim-directory';
import { authDbOf, scimGroupMembers, scimGroups, users } from '../src/auth';

const DB = (env as unknown as { DB: D1Database }).DB;
async function make(f: AdminScimDirectoryFixture) {
  await DB.batch(
    ['DELETE FROM scim_group_members', 'DELETE FROM scim_groups', 'DELETE FROM users'].map((q) =>
      DB.prepare(q),
    ),
  );
  const db = authDbOf(DB);
  for (const { role, password, linked, ...p } of f.people ?? [])
    await db.insert(users).values({
      ...p,
      role: role ?? 'member',
      passwordHash: password ? 'hash' : null,
      externalSub: linked ? `subject:${p.id}` : null,
    });
  for (const g of f.groups ?? []) await db.insert(scimGroups).values(g);
  for (const m of f.members ?? []) await db.insert(scimGroupMembers).values(m);
  return createAdminScimDirectory(DB);
}
describeAdminScimDirectoryContract('D1', make);

it('rolls back membership removal when deleting its group fails', async () => {
  const store = await make(ADMIN_SCIM_FIXTURE);
  await store.addGroup({
    id: 'sg_atomic',
    displayName: 'Atomic',
    externalId: null,
    createdAt: 1,
    updatedAt: 1,
  });
  await store.addMembers('sg_atomic', ['sd_ada']);
  await DB.prepare(`CREATE TRIGGER reject_scim_group_delete BEFORE DELETE ON scim_groups
    WHEN OLD.id = 'sg_atomic' BEGIN SELECT RAISE(ABORT, 'injected group failure'); END`).run();
  try {
    await expect(store.deleteGroup('sg_atomic')).rejects.toThrow();
    expect(await store.group('sg_atomic')).toBeDefined();
    expect(await store.members('sg_atomic')).toEqual(['sd_ada']);
  } finally {
    await DB.prepare('DROP TRIGGER reject_scim_group_delete').run();
  }
});
