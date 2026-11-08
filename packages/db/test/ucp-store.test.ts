import { env } from 'cloudflare:workers';
import { describeUcpStoreContract, type UcpFixture } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { createDb } from '../src/index';
import { ucpIdempotency, ucpPlatforms } from '../src/schema';
import { d1UcpStore } from '../src/ucp-store';

const DB = (env as unknown as { DB: D1Database }).DB;

async function seed(f: UcpFixture) {
  const db = createDb(DB);
  await db.delete(ucpIdempotency).where(like(ucpIdempotency.ownerId, 'ucs_%'));
  await db.delete(ucpPlatforms).where(like(ucpPlatforms.id, 'ucs_%'));
  for (const p of f.platforms ?? [])
    await db.insert(ucpPlatforms).values({
      name: p.id,
      profileUrl: `https://${p.id}.example/.well-known/ucp`,
      keyPrefix: p.id,
      keyHash: p.id,
      createdAt: 0,
      ...p,
    });
}

describeUcpStoreContract('D1', async (fixture) => {
  await seed(fixture);
  return d1UcpStore(DB);
});
