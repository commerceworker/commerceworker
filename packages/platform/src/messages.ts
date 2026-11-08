import type { AssetIngestMessage, ObjectCreatedMessage } from '@commerceworker/adapters/queue-cf';
import type { DomainEvent, Scope } from '@commerceworker/domain';

export type { AssetIngestMessage, ObjectCreatedMessage };

/** Minimal runtime shape check for a queued DomainEvent (defensive, not exhaustive). */
export function isDomainEvent(body: unknown): body is DomainEvent {
  if (typeof body !== 'object' || body === null) return false;
  const e = body as Record<string, unknown>;
  const scope = e.scope as Record<string, unknown> | undefined;
  return (
    typeof e.id === 'string' &&
    typeof e.type === 'string' &&
    typeof e.occurredAt === 'string' &&
    typeof scope?.spaceId === 'string' &&
    typeof scope?.environmentId === 'string'
  );
}

/** One on-publish agent job on the `commerceworker-agents` queue (consumed one at a time). */
export interface AgentJobMessage {
  readonly kind: 'agent.publish_run';
  readonly scope: Scope;
  readonly entryId: string;
}

export function isAgentJob(body: unknown): body is AgentJobMessage {
  if (typeof body !== 'object' || body === null) return false;
  const j = body as Record<string, unknown>;
  const scope = j.scope as Record<string, unknown> | undefined;
  return (
    j.kind === 'agent.publish_run' &&
    typeof j.entryId === 'string' &&
    typeof scope?.spaceId === 'string' &&
    typeof scope?.environmentId === 'string'
  );
}

/**
 * One message on a purge queue: cache tags whose responses are stale. Produced by the engine after
 * a publish-side event; `commerceworker-purge` is consumed by the delivery Worker and
 * `commerceworker-media-purge` by the media Worker (each rationed).
 */
export interface PurgeMessage {
  readonly tags: readonly string[];
}

/** Cache tag for everything delivered from one space:environment (delivery responses carry it). */
export const deliveryScopeTag = (spaceId: string, environmentId: string) =>
  `cw:${spaceId}:${environmentId}`;

/** Cache tag on every media response for one asset, all versions and variants. */
export const mediaAssetTag = (spaceId: string, environmentId: string, assetId: string) =>
  `cwa:${spaceId}:${environmentId}:${assetId}`;

/** Cache tag on every media response made by one rendition preset of a space (any environment). */
export const mediaRenditionTag = (spaceId: string, name: string) => `cwr:${spaceId}:${name}`;

/** Cache tag on a share page of one link (purged when the link is revoked). */
export const mediaShareLinkTag = (spaceId: string, environmentId: string, linkId: string) =>
  `cws:${spaceId}:${environmentId}:${linkId}`;

/** Cache tag on every share page that lists one collection (purged when what it lists changes). */
export const mediaCollectionTag = (spaceId: string, environmentId: string, collectionId: string) =>
  `cwc:${spaceId}:${environmentId}:${collectionId}`;

/** Cache tag on every media response of one space:environment (purged when it is deleted). */
export const mediaEnvironmentTag = (spaceId: string, environmentId: string) =>
  `cwe:${spaceId}:${environmentId}`;

/**
 * Another attempt at one webhook delivery, on the events queue with a delay (the backoff). Not a
 * domain event: the engine's events consumer recognises it by `kind` and re-sends to that webhook
 * alone (`redeliverWebhook`), so a down receiver neither loses the event nor re-drives the rest
 * of its dispatch.
 */
export interface WebhookRetryMessage {
  readonly kind: 'webhook.retry';
  readonly webhookId: string;
  readonly event: DomainEvent;
  /** The attempt this message is (2 for the first retry). */
  readonly attempt: number;
}

export function isWebhookRetryMessage(value: unknown): value is WebhookRetryMessage {
  const m = value as Partial<WebhookRetryMessage> | null;
  return (
    !!m &&
    m.kind === 'webhook.retry' &&
    typeof m.webhookId === 'string' &&
    typeof m.attempt === 'number' &&
    typeof m.event === 'object' &&
    m.event !== null
  );
}

/** The R2 actions that leave a new object behind. */
const CREATING_ACTIONS = new Set(['PutObject', 'CopyObject', 'CompleteMultipartUpload']);

export function isObjectCreated(body: unknown): body is ObjectCreatedMessage {
  const m = body as Partial<ObjectCreatedMessage> | null;
  return (
    !!m &&
    typeof m.action === 'string' &&
    CREATING_ACTIONS.has(m.action) &&
    typeof m.object === 'object' &&
    m.object !== null &&
    typeof m.object.key === 'string'
  );
}

export function isAssetIngestMessage(body: unknown): body is AssetIngestMessage {
  const m = body as Partial<AssetIngestMessage> | null;
  return (
    !!m &&
    m.kind === 'asset.ingest' &&
    typeof m.assetId === 'string' &&
    typeof m.version === 'number' &&
    typeof m.scope?.spaceId === 'string' &&
    typeof m.scope?.environmentId === 'string' &&
    (m.rerun === undefined || typeof m.rerun === 'string')
  );
}
