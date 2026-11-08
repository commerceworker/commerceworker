import { env } from 'cloudflare:workers';
import { describeDocumentStoreContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { d1DocumentStore, d1MessageStore } from '../src/document-store';
import { createDb } from '../src/index';
import { documents, messages } from '../src/schema';

const { DB, DOCS } = env as unknown as { DB: D1Database; DOCS: R2Bucket };
const clock = { now: () => new Date('2026-11-01T00:00:00Z') };

describeDocumentStoreContract('D1 and R2', async () => {
  const db = createDb(DB);
  await db.delete(documents).where(like(documents.orderId, 'dc_%'));
  await db.delete(messages).where(like(messages.orderId, 'dc_%'));
  return { documents: d1DocumentStore(DB, DOCS, clock), messages: d1MessageStore(DB, clock) };
});
