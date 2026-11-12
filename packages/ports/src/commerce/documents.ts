/**
 * An order's documents and messages. `DocumentStore` files a document (the body in a blob store,
 * its record beside the order) under `orders/<orderId>/<kind>/<name>`, so filing the same name
 * again replaces the body and keeps one record. `MessageStore` is the order's outbox of messages,
 * one per order and step (an order's confirmation email is its `confirmation` step, recording when it
 * went). `d1DocumentStore` / `d1MessageStore` (packages/db, D1 and R2) and the
 * in-memory stores (packages/test-kit) implement them, held to one contract.
 */

export interface DocumentRecord {
  readonly key: string;
  readonly orderId: string;
  readonly kind: string;
  readonly contentType: string;
}

/** The key a document is filed under. */
export const documentKey = (orderId: string, kind: string, name: string) =>
  `orders/${orderId}/${kind}/${name}`;

export interface DocumentStore {
  /**
   * Files a document under `orders/<orderId>/<folder>/<name>` and returns its key. Its recorded
   * kind is the folder unless `kind` says otherwise (an inbound email is kind `email` in `inbound`).
   */
  put(
    orderId: string,
    folder: string,
    name: string,
    body: string | Uint8Array,
    contentType?: string,
    kind?: string,
  ): Promise<string>;
  /** A document's text, or undefined when there is none at that key. */
  text(key: string): Promise<string | undefined>;
  /** The order's documents, by key. */
  list(orderId: string): Promise<DocumentRecord[]>;
}

export interface MessageRecord {
  readonly messageId: string;
  readonly orderId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  /**
   * When Email Sending took the message (ms), or null: a `commerce.notify` message is only queued
   * here, and an email confirmation is null until it has gone.
   */
  readonly sentAt: number | null;
  /** Why the last send didn't go, or null. */
  readonly error: string | null;
}

/** A message's id: `msg_<orderId>_<stepKey>`, anything but word characters and `-` as `_`. */
export const messageId = (orderId: string, stepKey: string) =>
  `msg_${orderId}_${stepKey}`.replace(/[^\w-]/g, '_');

export interface MessageStore {
  /** Queues a message once per order and step: a repeat keeps the first. */
  send(
    orderId: string,
    stepKey: string,
    message: { recipient: string; subject: string; body: string },
  ): Promise<{ messageId: string; recipient: string; subject: string }>;
  /** The order's messages, by id. */
  messages(orderId: string): Promise<MessageRecord[]>;
  /** One message by order and step, or undefined. */
  find(orderId: string, stepKey: string): Promise<MessageRecord | undefined>;
  /** Records that the message went out at `at`: the first time stands, and it clears the error. */
  markSent(messageId: string, at: number): Promise<void>;
  /** Records why a send didn't go; a message already sent keeps its sent state. */
  markFailed(messageId: string, error: string): Promise<void>;
}
