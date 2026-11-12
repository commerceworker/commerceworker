/**
 * The documents and messages ports (@commerceworker/ports/commerce) on D1 and R2. Moved here from
 * the engine's connectors. A document's body goes to R2 first and its record to D1 after, so a
 * record never points at a missing body; a message is inserted only if absent. The contract in
 * @commerceworker/test-kit/commerce holds these and the in-memory stores to the same behaviour.
 */
import type { Clock } from '@commerceworker/ports';
import {
  type DocumentStore,
  documentKey,
  type MessageStore,
  messageId,
  type ObjectReader,
} from '@commerceworker/ports/commerce';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createDb } from './index';
import { documents, messages } from './schema';

/** Bodies are written to `bucket`; `reader` (the bucket itself by default) is where `text` reads them. */
export function d1DocumentStore(
  d1: D1Database,
  bucket: R2Bucket,
  clock: Clock,
  reader: ObjectReader = bucket,
): DocumentStore {
  const d = createDb(d1);
  return {
    async put(
      orderId,
      folder,
      name,
      body,
      contentType = 'text/html; charset=utf-8',
      kind = folder,
    ) {
      const key = documentKey(orderId, folder, name);
      await bucket.put(key, body, { httpMetadata: { contentType } });
      await d
        .insert(documents)
        .values({
          id: key,
          orderId,
          kind,
          r2Key: key,
          contentType,
          createdAt: clock.now().getTime(),
        })
        .onConflictDoNothing();
      return key;
    },

    async text(key) {
      return (await reader.get(key))?.text();
    },

    async list(orderId) {
      return d
        .select({
          key: documents.id,
          orderId: documents.orderId,
          kind: documents.kind,
          contentType: documents.contentType,
        })
        .from(documents)
        .where(eq(documents.orderId, orderId))
        .orderBy(asc(documents.id));
    },
  };
}

export function d1MessageStore(d1: D1Database, clock: Clock): MessageStore {
  const d = createDb(d1);
  const record = {
    messageId: messages.id,
    orderId: messages.orderId,
    recipient: messages.recipient,
    subject: messages.subject,
    body: messages.body,
    sentAt: messages.sentAt,
    error: messages.error,
  };
  return {
    async send(orderId, stepKey, m) {
      const id = messageId(orderId, stepKey);
      await d
        .insert(messages)
        .values({ id, orderId, ...m, createdAt: clock.now().getTime() })
        .onConflictDoNothing();
      return { messageId: id, recipient: m.recipient, subject: m.subject };
    },

    async messages(orderId) {
      return d
        .select(record)
        .from(messages)
        .where(eq(messages.orderId, orderId))
        .orderBy(asc(messages.id));
    },

    async find(orderId, stepKey) {
      const [row] = await d
        .select(record)
        .from(messages)
        .where(eq(messages.id, messageId(orderId, stepKey)));
      return row;
    },

    async markSent(id, at) {
      await d
        .update(messages)
        .set({ sentAt: at, error: null })
        .where(and(eq(messages.id, id), isNull(messages.sentAt)));
    },

    async markFailed(id, error) {
      await d
        .update(messages)
        .set({ error: error.slice(0, 500) })
        .where(and(eq(messages.id, id), isNull(messages.sentAt)));
    },
  };
}
