import { env } from 'cloudflare:workers';
import {
  describeConfirmationStoreContract,
  describeIdentityStoreContract,
  type IdentityFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1ConfirmationStore } from '../src/confirmation-store';
import { d1IdentityStore } from '../src/identity-store';
import { createDb } from '../src/index';
import { actionConfirmations, apiTokens, sessions, users } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

/** The fixture as the only team: `anyone` means one of its people. */
async function seed(f: IdentityFixture) {
  const db = createDb(DB);
  await db.delete(sessions);
  await db.delete(apiTokens);
  await db.delete(users);
  for (const u of f.users ?? []) await db.insert(users).values({ ...u, createdAt: 0 });
  for (const t of f.tokens ?? [])
    await db.insert(apiTokens).values({
      ...t,
      name: t.id,
      prefix: t.id,
      tokenHash: t.id,
      createdBy: 'id',
      createdAt: 0,
    });
  for (const s of f.sessions ?? []) await db.insert(sessions).values(s);
}

describeIdentityStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1IdentityStore(DB);
});

describeConfirmationStoreContract('D1', async () => {
  await createDb(DB).delete(actionConfirmations).where(like(actionConfirmations.id, 'cfm_c_%'));
  return d1ConfirmationStore(DB);
});
