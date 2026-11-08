import { env } from 'cloudflare:workers';
import {
  describePasskeyStoreContract,
  type PasskeyFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1PasskeyStore } from '../src/passkey-store';
import { passkeyChallenges, passkeys, users } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

async function seed(f: PasskeyFixture) {
  const db = createDb(DB);
  await db.delete(passkeys).where(like(passkeys.id, 'pk_%'));
  await db.delete(passkeyChallenges).where(like(passkeyChallenges.id, 'pk_%'));
  await db.delete(users).where(like(users.id, 'pk_%'));
  for (const u of f.users ?? []) await db.insert(users).values({ ...u, createdAt: 0 });
}

describePasskeyStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1PasskeyStore(DB);
});
