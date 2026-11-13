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
  /** The id Email Sending returned when it took the message, or null (an event names it). */
  readonly providerId: string | null;
  /** The newest status an Email Sending event reported, or null: none has arrived. */
  readonly deliveryStatus: MessageDelivery | null;
  readonly deliveryAt: number | null;
  /** The reason it reported (an SMTP response), or null. */
  readonly deliveryDetail: string | null;
}

/**
 * What Email Sending's events report about a message, in the order that matters: a later status
 * replaces an earlier one and an earlier never replaces a later (events arrive out of order, and
 * more than once). A complaint follows a delivery, so it outranks it; the three failures are peers,
 * and the first stands.
 */
export const MESSAGE_DELIVERY = [
  'deferred',
  'delivered',
  'bounced',
  'failed',
  'rejected',
  'complained',
] as const;
export type MessageDelivery = (typeof MESSAGE_DELIVERY)[number];

const DELIVERY_RANK: Record<MessageDelivery, number> = {
  deferred: 0,
  delivered: 1,
  bounced: 2,
  failed: 2,
  rejected: 2,
  complained: 3,
};

/** Whether `incoming` replaces `current` (null: nothing yet). */
export const replacesDelivery = (current: MessageDelivery | null, incoming: MessageDelivery) =>
  current === null || DELIVERY_RANK[incoming] > DELIVERY_RANK[current];

/** The statuses `incoming` replaces: for a store that applies the rule in its own query. */
export const deliveredBefore = (incoming: MessageDelivery) =>
  MESSAGE_DELIVERY.filter((s) => DELIVERY_RANK[s] < DELIVERY_RANK[incoming]);

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
  /**
   * Records that the message went out at `at`: the first time stands, and it clears the error.
   * `providerId` is what the binding returned, which the message's events carry.
   */
  markSent(messageId: string, at: number, providerId?: string): Promise<void>;
  /** Records why a send didn't go; a message already sent keeps its sent state. */
  markFailed(messageId: string, error: string): Promise<void>;
  /**
   * Records an Email Sending event for the message it sent as `providerId`, unless it is older than
   * one already recorded (`replacesDelivery`). Returns false when no message has that id.
   */
  recordDelivery(
    providerId: string,
    status: MessageDelivery,
    at: number,
    detail?: string,
  ): Promise<boolean>;
}
