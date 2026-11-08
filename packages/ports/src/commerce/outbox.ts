/**
 * Outbound webhooks: the workspace's subscriptions and each delivery of each event. A delivery is
 * recorded once by its id (the subject, the step and the subscriber), before it is sent, so a
 * retried step re-sends only what hasn't arrived; each attempt is recorded on it. Sending and
 * signing are the engine's. `d1WebhookOutbox` (packages/db) and `InMemoryWebhookOutbox`
 * (packages/test-kit) implement it, held to one contract.
 */

export interface WebhookSubscription {
  readonly id: string;
  readonly url: string;
  /** Sealed with `DATA_KEY`. */
  readonly secret: string;
  /** The secret before a rotation, accepted until `previousExpiresAt`. */
  readonly previousSecret: string | null;
  readonly previousExpiresAt: number | null;
  /** The events it takes, as JSON (`["*"]` for every one). */
  readonly events: string;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly subscriptionId: string;
  /** The order (or cart) the event is about. */
  readonly subject: string;
  readonly event: string;
  readonly payload: string;
}

/** A subscription as the admin API shows it: never a secret. */
export interface SubscriptionView {
  readonly id: string;
  readonly url: string;
  /** The events it takes, as JSON. */
  readonly events: string;
  readonly active: boolean;
  readonly createdAt: number;
  /** Until when the secret before a rotation still signs, if one was rotated. */
  readonly previousExpiresAt: number | null;
}

/** A delivery as the admin API shows it. */
export interface DeliveryRecord {
  readonly id: string;
  readonly subscriptionId: string;
  /** The order (or cart) the event is about. */
  readonly orderId: string;
  readonly event: string;
  readonly payload: string;
  /** `pending`, `delivered` or `failed`. */
  readonly status: string;
  readonly attempts: number;
  readonly responseStatus: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

export interface WebhookOutbox {
  /** Up to `limit` subscriptions, newest first. */
  listSubscriptions(limit: number): Promise<SubscriptionView[]>;
  /** Adds a subscription, on, with its sealed secret. */
  addSubscription(s: {
    id: string;
    url: string;
    secret: string;
    events: string;
    createdAt: number;
  }): Promise<void>;
  /**
   * Gives a subscription a new sealed secret, its current one signing too until `previousUntil`.
   * One write, so two rotations at once can't leave the receiver a secret it never saw. Undefined
   * for an unknown id.
   */
  rotateSubscription(
    id: string,
    secret: string,
    previousUntil: number,
  ): Promise<SubscriptionView | undefined>;
  /** Removes a subscription: whether there was one. */
  deleteSubscription(id: string): Promise<boolean>;
  /** A subscription's latest deliveries, newest first. */
  deliveries(subscriptionId: string, limit: number): Promise<DeliveryRecord[]>;
  /** The subscriptions that are on. */
  subscriptions(): Promise<WebhookSubscription[]>;
  /** Records deliveries, each once by id. */
  record(deliveries: readonly WebhookDelivery[], now: number): Promise<void>;
  /**
   * Deliveries not yet delivered: these ids, and any to a plugin (`plugin:` subscriptions) under
   * `idPrefix` for the subject, which an earlier attempt of the step recorded.
   */
  undelivered(
    subject: string,
    ids: readonly string[],
    idPrefix: string,
  ): Promise<WebhookDelivery[]>;
  /** Records each attempt: delivered, or failed with the receiver's status and error. */
  attempted(
    results: readonly { id: string; ok: boolean; status: number | null; error: string | null }[],
    now: number,
  ): Promise<void>;
  /** Forgets a subject's deliveries (of one event, when given), sent or not. */
  forget(subject: string, event?: string): Promise<void>;
}
