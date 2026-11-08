/**
 * The documents and messages ports in memory. The contract in ./document-store-contract.ts holds
 * them to the same behaviour as the D1 and R2 stores.
 */
import {
  type DocumentRecord,
  type DocumentStore,
  documentKey,
  type MessageRecord,
  type MessageStore,
  messageId,
} from '@commerceworker/ports/commerce';

const byKey =
  <T>(key: (t: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

export class InMemoryDocumentStore implements DocumentStore {
  private readonly bodies = new Map<string, string>();
  private readonly records = new Map<string, DocumentRecord>();

  async put(
    orderId: string,
    folder: string,
    name: string,
    body: string | Uint8Array,
    contentType = 'text/html; charset=utf-8',
    kind = folder,
  ) {
    const key = documentKey(orderId, folder, name);
    this.bodies.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body));
    if (!this.records.has(key)) this.records.set(key, { key, orderId, kind, contentType });
    return key;
  }

  async text(key: string) {
    return this.bodies.get(key);
  }

  async list(orderId: string) {
    return [...this.records.values()]
      .filter((r) => r.orderId === orderId)
      .sort(byKey((r) => r.key));
  }
}

export class InMemoryMessageStore implements MessageStore {
  private readonly rows = new Map<string, MessageRecord>();

  async send(
    orderId: string,
    stepKey: string,
    m: { recipient: string; subject: string; body: string },
  ) {
    const id = messageId(orderId, stepKey);
    if (!this.rows.has(id)) this.rows.set(id, { messageId: id, orderId, ...m });
    return { messageId: id, recipient: m.recipient, subject: m.subject };
  }

  async messages(orderId: string) {
    return [...this.rows.values()]
      .filter((r) => r.orderId === orderId)
      .sort(byKey((r) => r.messageId));
  }
}
