import type { DomainEvent, EventType, WebhookTestEvent } from '../events';
import type { Scope } from '../types';

/**
 * A webhook subscription. When a domain event matching one of `topics` is
 * relayed, the worker signs and POSTs the event to `url`. Signing/transport is
 * infrastructure; this type and `matchesTopic` are the pure parts.
 */
export interface Webhook {
  readonly id: string;
  readonly url: string;
  /** Event types this webhook is interested in. "*" matches everything. */
  readonly topics: readonly (EventType | '*')[];
  /** Shared secret used to HMAC-sign payloads. */
  readonly secret: string;
  readonly active: boolean;
  /** Extra static headers to send with each delivery. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The one environment whose events it receives, or `null` for every environment in the space.
   * A scoped hook is visible (listed, editable) only under its environment; a space-wide one
   * under every environment.
   */
  readonly environmentId: string | null;
}

/** Outcome of a single delivery attempt, recorded for observability. */
export interface WebhookDelivery {
  readonly webhookId: string;
  readonly eventId: string;
  readonly status: 'success' | 'failed';
  readonly statusCode?: number;
  readonly attempts: number;
  readonly error?: string;
  /** The event's type (absent on records written before it was kept). */
  readonly eventType?: EventType;
  /** The delivery this attempt resent, when an administrator asked for it again. */
  readonly resendOf?: number;
}

/** True if the webhook is space-wide or scoped to `environmentId`. */
export function coversEnvironment(webhook: Webhook, environmentId: string): boolean {
  return webhook.environmentId === null || webhook.environmentId === environmentId;
}

/** True if the webhook subscribes to the given event type. */
export function matchesTopic(webhook: Webhook, type: EventType): boolean {
  return webhook.active && webhook.topics.some((t) => t === '*' || t === type);
}

/**
 * One delivery an administrator asked for, to one webhook: a test (`test`, the event it sends) or
 * a resend of a logged delivery (`resend`, whose event the engine reads back from the outbox when
 * it sends, so the request stays small whatever the event's size). It rides the outbox to the
 * engine like an event but is not one: it has `kind` and no `type`, so a consumer that takes only
 * domain events (`isDomainEvent`, as every engine before it did) drops it as malformed rather than
 * fanning it out by topic. `id` is the outbox row's; for a test it is also the test event's id.
 */
export interface WebhookSendRequest {
  readonly kind: 'webhook.send';
  readonly id: string;
  /** Where the administrator asked, where the webhook is visible. */
  readonly scope: Scope;
  readonly occurredAt: string;
  readonly webhookId: string;
  readonly test?: WebhookTestEvent;
  readonly resend?: { readonly deliveryId: number; readonly eventId: string };
}

/** What the outbox carries: domain events, and administrators' webhook send requests. */
export type OutboxEntry = DomainEvent | WebhookSendRequest;

export function isWebhookSendRequest(value: unknown): value is WebhookSendRequest {
  const m = value as Partial<WebhookSendRequest> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    m.kind === 'webhook.send' &&
    typeof m.id === 'string' &&
    typeof m.webhookId === 'string' &&
    typeof m.scope?.spaceId === 'string' &&
    typeof m.scope?.environmentId === 'string' &&
    (m.test !== undefined || m.resend !== undefined)
  );
}

/** The event an outbox entry delivers to a webhook: itself, a test request's event, or none. */
export function deliveredEventOf(entry: OutboxEntry): DomainEvent | null {
  if (!isWebhookSendRequest(entry)) return entry;
  return entry.test ?? null;
}
