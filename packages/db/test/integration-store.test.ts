import { env } from 'cloudflare:workers';
import {
  describeIntegrationStoreContract,
  type IntegrationFixture,
} from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { d1IntegrationStore } from '../src/integration-store';
import { integrations } from '../src/schema';

const DB = (env as unknown as { DB: D1Database }).DB;

async function seed(f: IntegrationFixture) {
  const db = createDb(DB);
  await db.delete(integrations).where(like(integrations.id, 'in_%'));
  for (const i of f.integrations ?? [])
    await db.insert(integrations).values({ createdAt: 0, ...i });
}

describeIntegrationStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1IntegrationStore(DB);
});
