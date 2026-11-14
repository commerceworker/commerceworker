import { env } from 'cloudflare:workers';
import { describePasskeyStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createAdminPasskeys } from '../src/admin-passkeys';
import { authDbOf, passkeyChallenges, passkeys, users } from '../src/auth';

const DB = (env as unknown as { DB: D1Database }).DB;
describePasskeyStoreContract('Studio D1', async (fixture) => {
  const db = authDbOf(DB);
  await db.delete(passkeys).where(like(passkeys.id, 'pk_%'));
  await db.delete(passkeyChallenges).where(like(passkeyChallenges.id, 'pk_%'));
  await db.delete(users).where(like(users.id, 'pk_%'));
  for (const u of fixture.users ?? []) await db.insert(users).values({ ...u, createdAt: 0 });
  return createAdminPasskeys(DB);
});
