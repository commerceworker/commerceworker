import { env } from 'cloudflare:workers';
import {
  describeScimDirectoryContract,
  SCIM_FIXTURE,
  type ScimDirectoryFixture,
} from '@commerceworker/test-kit/commerce';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from '../src/index';
import { apiTokens, scimGroupMembers, scimGroups, users } from '../src/schema';
import { d1ScimDirectory } from '../src/scim-directory';

const DB = (env as unknown as { DB: D1Database }).DB;

/** The fixture as the only people and groups this file's database holds. */
async function seed(f: ScimDirectoryFixture) {
  const db = createDb(DB);
  await db.delete(scimGroupMembers);
  await db.delete(scimGroups);
  await db.delete(apiTokens);
  await db.delete(users);
  for (const { role, password, linked, ...p } of f.people ?? [])
    await db.insert(users).values({
      ...p,
      role: role ?? 'viewer',
      passwordHash: password ? 'pbkdf2$x' : null,
      externalSub: linked ? `sub-${p.id}` : null,
    });
  for (const g of f.groups ?? []) await db.insert(scimGroups).values(g);
  for (const m of f.members ?? []) await db.insert(scimGroupMembers).values(m);
}

describeScimDirectoryContract('D1', async (fixture) => {
  await seed(fixture);
  return d1ScimDirectory(DB);
});

it('ties the tokens made under an old address to the person when SCIM changes it', async () => {
  await seed(SCIM_FIXTURE);
  const db = createDb(DB);
  const token = (id: string, createdBy: string) =>
    db.insert(apiTokens).values({
      id,
      name: id,
      prefix: id,
      tokenHash: id,
      role: 'operator',
      createdBy,
      createdById: null,
      createdAt: 0,
    });
  await token('sc_t_mine', 'sc_ann@example.com');
  await token('sc_t_theirs', 'sc_boss@example.com');
  await d1ScimDirectory(DB).updatePerson('sc_ann', { email: 'ann@new.example' });
  const maker = async (id: string) =>
    (await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get())?.createdById;
  expect(await maker('sc_t_mine')).toBe('sc_ann');
  expect(await maker('sc_t_theirs')).toBeNull();
});
