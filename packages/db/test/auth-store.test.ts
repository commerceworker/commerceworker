import { env } from 'cloudflare:workers';
import { type AuthFixture, describeAuthStoreContract } from '@commerceworker/test-kit/commerce';
import { d1AuthStore } from '../src/auth-store';
import { createDb } from '../src/index';
import {
  apiTokens,
  authFailures,
  recoveryCodes,
  sessions,
  signInChallenges,
  users,
} from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** The fixture as the only team this file's database holds. */
async function seed(f: AuthFixture) {
  const db = createDb(DB);
  for (const t of [signInChallenges, recoveryCodes, sessions, apiTokens, authFailures, users])
    await db.delete(t);
  for (const u of f.users ?? []) await db.insert(users).values({ ...u, createdAt: 0 });
  for (const s of f.sessions ?? []) await db.insert(sessions).values(s);
  for (const t of f.tokens ?? [])
    await db.insert(apiTokens).values({ ...t, createdBy: 'au', createdAt: 0 });
  for (const c of f.recoveryCodes ?? [])
    await db.insert(recoveryCodes).values({ ...c, createdAt: 0 });
}

describeAuthStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1AuthStore(DB);
});
