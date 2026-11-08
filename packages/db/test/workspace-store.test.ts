import { env } from 'cloudflare:workers';
import {
  describeWorkspaceStoreContract,
  type WorkspaceFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { apiTokens, users, workspaceSettings } from '../src/schema';
import { d1WorkspaceStore } from '../src/workspace-store';

const DB = (env as unknown as { DB: D1Database }).DB;
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

/** The fixture as the only team, so "another admin" means one of its members. */
async function seed(f: WorkspaceFixture) {
  const db = createDb(DB);
  await db.delete(apiTokens);
  await db.delete(users);
  await db.delete(workspaceSettings).where(like(workspaceSettings.key, 'ws_%'));
  for (const { twoFactorAt, ...m } of f.members ?? [])
    await db.insert(users).values({ createdAt: 0, ...m, totpEnabledAt: twoFactorAt ?? null });
  // What the fixture leaves out, as the in-memory store defaults it.
  for (const t of f.tokens ?? [])
    await db.insert(apiTokens).values({
      name: t.id,
      prefix: t.id,
      tokenHash: t.id,
      createdAt: 0,
      ...t,
      revokedAt: t.revokedAt ?? null,
    });
}

describeWorkspaceStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1WorkspaceStore(DB, clock);
});
