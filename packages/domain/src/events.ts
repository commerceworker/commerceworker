import type { EntryFields, Scope } from './types';

/**
 * Domain events. These are appended to the transactional outbox within the same
 * transaction as the state change, then relayed to the event bus / queue. Every
 * event carries a stable `id` so downstream handlers can be idempotent.
 */
export type DomainEvent =
  | EntryPublishedEvent
  | EntryUnpublishedEvent
  | EntryMovedEvent
  | ContentTypePublishedEvent
  | ContentTypeDeletedEvent
  | ReleasePublishedEvent
  | AssetPublishedEvent
  | AssetUnpublishedEvent
  | AssetDeletedEvent
  | AssetIngestedEvent
  | AssetFileReplacedEvent
  | AssetRightsChangedEvent
  | AssetExpiredEvent
  | AssetRenditionsChangedEvent
  | AssetCollectionChangedEvent
  | TaxonomyChangedEvent
  | AssetShareLinkChangedEvent
  | AssetZipRequestedEvent
  | SearchReindexRequestedEvent
  | BulkChunkDueEvent
  | EntriesPublishedBulkEvent
  | BulkJobCompletedEvent
  | WorkflowRunEndedEvent
  | WorkflowTaskOpenedEvent
  | WorkflowWebhookEvent
  | EnvironmentAliasChangedEvent
  | EnvironmentDeletedEvent
  | PromotionAwaitingApprovalEvent
  | EnvironmentPromotedEvent
  | EnvironmentPurgeDueEvent
  | InviteEmailDueEvent
  | RedirectsChangedEvent
  | MenusChangedEvent
  | SpaceLocalesChangedEvent
  | WebhookTestEvent;

export interface BaseEvent {
  readonly id: string;
  readonly scope: Scope;
  readonly occurredAt: string;
}

export interface EntryPublishedEvent extends BaseEvent {
  readonly type: 'entry.published';
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly version: number;
  readonly fields: EntryFields;
}

export interface EntryUnpublishedEvent extends BaseEvent {
  readonly type: 'entry.unpublished';
  readonly entryId: string;
  readonly contentTypeApiId: string;
}

/**
 * An entry moved in its content type's manual order (`order=sys.position`). Live, like a menu's
 * change: no version, no publish. When it is published, the Delivery lists ordered by position are
 * stale, so `published` decides the purge. A move that re-keyed its neighbours is still one event.
 */
export interface EntryMovedEvent extends BaseEvent {
  readonly type: 'entry.moved';
  readonly entryId: string;
  readonly contentTypeApiId: string;
  /** Its new key. */
  readonly position: string;
  /** Whether it is published, so what Delivery serves changed. */
  readonly published: boolean;
}

/**
 * An asset entered/left the published read model. Delivery renders EMBED asset
 * file/title/description into the entries that link them, so these events are
 * what let those renders be invalidated — without them a republished asset
 * stays stale in every entry and list that shows it until the cache TTL.
 */
export interface AssetPublishedEvent extends BaseEvent {
  readonly type: 'asset.published';
  readonly assetId: string;
  /**
   * The file version this publish took out of Delivery, when it put a newer one in its place (a
   * republish after the file was replaced or restored): that version's media URLs stop working.
   */
  readonly replacedVersion?: number;
}

export interface AssetUnpublishedEvent extends BaseEvent {
  readonly type: 'asset.unpublished';
  readonly assetId: string;
}

/**
 * An asset's file was replaced: `version` is current now and `previousVersion`'s file is kept in
 * its history. `restoredFrom` names the older version whose file was made current again, for a
 * restore. The published snapshot is untouched (Delivery serves the old file until a republish);
 * the engine starts ingest on the new file (`r2Key`, `etag` naming the bytes).
 */
export interface AssetFileReplacedEvent extends BaseEvent {
  readonly type: 'asset.file_replaced';
  readonly assetId: string;
  readonly version: number;
  readonly previousVersion: number;
  readonly r2Key: string;
  readonly etag?: string;
  readonly restoredFrom?: number;
}

/**
 * A published asset's rights changed, and with them what is delivered: the credit and license
 * Delivery shows, and the expiry the media origin caches up to. Sent only while it is published.
 */
export interface AssetRightsChangedEvent extends BaseEvent {
  readonly type: 'asset.rights_changed';
  readonly assetId: string;
}

/**
 * A published asset's rights expired (`expiresAt`) and the engine's sweep unpublished it. Sent
 * with the `asset.unpublished` that takes it out of Delivery, in the same unit.
 */
export interface AssetExpiredEvent extends BaseEvent {
  readonly type: 'asset.expired';
  readonly assetId: string;
  readonly expiresAt: string;
}

/**
 * An asset's record was deleted. Its bytes outlive the row on purpose: the engine removes them
 * from blob storage (`r2Key`) and the video host (`videoId`) when it handles this event, so a
 * failed removal is retried with the event instead of being lost with the request.
 */
export interface AssetDeletedEvent extends BaseEvent {
  readonly type: 'asset.deleted';
  readonly assetId: string;
  readonly r2Key?: string;
  readonly videoId?: string;
}

/**
 * Ingest finished an asset's file (`version`): it is hashed, probed, enriched where empty and
 * indexed for search. `duplicateOf` names an older asset with the same bytes, when there is one.
 * `published`: whether the asset was published when ingest finished, so only then is Delivery's
 * cache purged (what Delivery serves, its search and its dimensions, can have changed).
 */
export interface AssetIngestedEvent extends BaseEvent {
  readonly type: 'asset.ingested';
  readonly assetId: string;
  readonly version: number;
  readonly published: boolean;
  readonly contentHash?: string;
  readonly duplicateOf?: string;
}

/**
 * A space's rendition preset was created, changed or deleted. `scope` is where the change was made;
 * presets belong to the whole space, so the engine purges what every environment of the space
 * delivers: the rendition's cached images on the media origin and the delivery responses that list
 * the space's renditions.
 */
export interface AssetRenditionsChangedEvent extends BaseEvent {
  readonly type: 'asset_renditions.changed';
  readonly name: string;
}

/**
 * A space's locale settings changed (a locale delivered or not, its text direction). Settings
 * belong to the whole space, so the engine purges what every environment of it delivers: a locale
 * just turned off must stop being served at once, from every cache.
 */
export interface SpaceLocalesChangedEvent extends BaseEvent {
  readonly type: 'space_locales.changed';
  /** The locales Delivery no longer serves, after the change. */
  readonly undelivered: readonly string[];
}

/**
 * A collection changed: created, renamed, deleted, or its members added, removed or reordered.
 * What Delivery lists for it, and every share page that shows it, is stale.
 */
export interface AssetCollectionChangedEvent extends BaseEvent {
  readonly type: 'asset_collection.changed';
  readonly collectionId: string;
}

/**
 * A tag or concept was created, changed (label, slug, description, localized labels, parent) or
 * deleted. Delivery's taxonomy reads are stale.
 */
export interface TaxonomyChangedEvent extends BaseEvent {
  readonly type: 'taxonomy.changed';
  readonly termKind: 'tag' | 'concept';
  readonly termId: string;
}

/**
 * An environment's redirects changed (written, deleted, imported or straightened). What Delivery
 * serves for them (`GET …/redirects`, `…/redirects/resolve`) is stale. A publish whose slug change
 * writes redirects does not announce this: its `entry.published` purges the same responses.
 */
export interface RedirectsChangedEvent extends BaseEvent {
  readonly type: 'redirects.changed';
  /** How many redirects the change wrote or removed. */
  readonly count: number;
}

/**
 * An environment's menus changed (one created, saved, reordered or deleted, or a snapshot's
 * written). What Delivery serves for them (`GET …/menus`, `…/menus/:handle`) is stale. A publish
 * that changes what a menu resolves to does not announce this: its `entry.published` (or
 * `entry.unpublished`) purges the same responses.
 */
export interface MenusChangedEvent extends BaseEvent {
  readonly type: 'menus.changed';
  /** The menu changed; absent when a snapshot wrote several. */
  readonly menuId?: string;
  readonly handle?: string;
}

/**
 * A share link was created or revoked. The engine writes (or removes) the media origin's entry for
 * it, and for a revocation purges its cached page.
 */
export interface AssetShareLinkChangedEvent extends BaseEvent {
  readonly type: 'asset_share.created' | 'asset_share.revoked';
  readonly linkId: string;
}

/** A zip download was asked for: the engine starts the Workflow that builds it (`jobId`). */
export interface AssetZipRequestedEvent extends BaseEvent {
  readonly type: 'asset_zip.requested';
  readonly jobId: string;
}

/**
 * An environment alias was created, repointed or removed. `scope.environmentId` is the ALIAS
 * name: everything delivered under it may now come from a different environment, so caches keyed
 * by the alias must be dropped.
 */
export interface EnvironmentAliasChangedEvent extends BaseEvent {
  readonly type: 'environment_alias.changed';
  /** The new target, or null when the alias was removed. */
  readonly targetEnvironmentId: string | null;
}

/**
 * An environment was deleted (`scope` is the deleted environment). It no longer resolves; the
 * engine removes what was derived from its rows elsewhere: each published entry's search documents
 * and vectors, and the environment's delivery cache. Large environments emit several, `entryIds`
 * split across them. The rows themselves go in bounded steps (`environment.purge_due`).
 */
export interface EnvironmentDeletedEvent extends BaseEvent {
  readonly type: 'environment.deleted';
  readonly entryIds: readonly string[];
}

/**
 * A deleted environment still has rows to remove (`scope` is that environment). A control event,
 * like `bulk.chunk_due`: the engine deletes the next bounded step and appends another until none
 * are left, then removes its files. Redelivery is harmless; each step deletes whatever remains.
 */
export interface EnvironmentPurgeDueEvent extends BaseEvent {
  readonly type: 'environment.purge_due';
  /**
   * The asset search index (vectors, which can only be removed by id) is cleared before the rows
   * go, a page of assets per event: `assetCursor` is where the next page starts, and
   * `assetIndexCleared` says that phase is done. An event without either starts it (again).
   */
  readonly assetCursor?: string;
  readonly assetIndexCleared?: boolean;
}

/**
 * A promotion is waiting for a person's approval (`scope` is the target environment). For
 * notifying approvers by webhook.
 */
export interface PromotionAwaitingApprovalEvent extends BaseEvent {
  readonly type: 'promotion.awaiting_approval';
  readonly promotionId: string;
  readonly source: string;
  readonly requestedBy: string;
  readonly reasons: readonly string[];
}

/** A promotion was applied (`scope` is the target environment). */
export interface EnvironmentPromotedEvent extends BaseEvent {
  readonly type: 'environment.promoted';
  readonly promotionId: string;
  readonly source: string;
  readonly contentTypes: number;
  readonly entries: number;
}

export interface ContentTypePublishedEvent extends BaseEvent {
  readonly type: 'content_type.published';
  readonly contentTypeApiId: string;
  readonly version: number;
}

/**
 * A content type was deleted (it had no entries left, the trash included): Delivery's GraphQL
 * schema, routes and sitemap no longer have it.
 */
export interface ContentTypeDeletedEvent extends BaseEvent {
  readonly type: 'content_type.deleted';
  readonly contentTypeApiId: string;
  /** The version it was deleted at. */
  readonly version: number;
}

/** Emitted when a release ships. Per-member entry events are emitted separately
 *  in the same transaction, so this is a summary for webhooks/audit. */
export interface ReleasePublishedEvent extends BaseEvent {
  readonly type: 'release.published';
  readonly releaseId: string;
  readonly entryIds: readonly string[];
}

/**
 * A request to (re)embed every published entry in the scope — a background job,
 * not a state-change fact. Enqueued via the outbox so the expensive work runs on
 * the worker/queue consumer instead of the triggering request.
 */
export interface SearchReindexRequestedEvent extends BaseEvent {
  readonly type: 'search.reindex_requested';
  /** Limit the reindex to one content type, or all when omitted. */
  readonly contentTypeApiId?: string;
  /**
   * Continuation cursor: reindex only entries with `entryId` strictly greater
   * (keyset paging — stable under concurrent publishes/unpublishes). Set only
   * on self-enqueued follow-up slices: the consumer processes a bounded slice
   * per invocation and re-enqueues the remainder, so one queue message never
   * has to fit an entire reindex inside a single invocation's limits.
   */
  readonly afterEntryId?: string;
  /** Entries already processed by earlier slices (bounds the job total). */
  readonly entriesSoFar?: number;
}

/**
 * A bulk-job chunk is ready to run. A control event, not a state-change fact:
 * consumers CAS-claim the chunk so a redelivered event is a no-op. Routed to
 * the dedicated bulk topic so chunk processing never starves entry delivery.
 */
export interface BulkChunkDueEvent extends BaseEvent {
  readonly type: 'bulk.chunk_due';
  readonly jobId: string;
  readonly chunkId: string;
}

/**
 * Coalesced publish/unpublish fact for one committed bulk chunk — entry ids
 * only, no field payloads (downstream consumers batch-read what they need).
 * Replaces N per-entry events for bulk operations so 100k entries produce
 * ~500 events instead of 100,000.
 */
export interface EntriesPublishedBulkEvent extends BaseEvent {
  readonly type: 'entries.published_bulk';
  readonly jobId: string;
  /** Chunk this event coalesces — with jobId + entryId it forms the STABLE
   *  derived id for synthesized per-entry webhooks, so receiver-side dedupe
   *  survives chunk re-runs (which mint a fresh event id). */
  readonly chunkId: string;
  readonly action: 'publish' | 'unpublish';
  readonly entryIds: readonly string[];
}

/** Terminal bulk-job fact: totals for webhooks/audit, and the unconditional
 *  scope-epoch cache bump that backstops any debounced bump along the way. */
export interface BulkJobCompletedEvent extends BaseEvent {
  readonly type: 'bulk.job_completed';
  readonly jobId: string;
  /**
   * Which kind of job finished. An import creates drafts; it publishes nothing. An asset reindex
   * sent assets through ingest again. Trash, restore and purge moved entries into, out of, or
   * permanently out of the trash. A content type delete removed a type's entries; the type itself
   * goes on this event. A field edit saved new drafts of one type's entries. A starter install
   * ran one phase of a space starter's background install (`config.install` names the install).
   */
  readonly action:
    | 'publish'
    | 'unpublish'
    | 'trash'
    | 'restore'
    | 'purge'
    | 'import'
    | 'asset_reindex'
    | 'asset_move'
    | 'asset_tag'
    | 'asset_publish'
    | 'asset_unpublish'
    | 'asset_archive'
    | 'content_type_delete'
    | 'set_fields'
    | 'starter_install';
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
}

/** The outcomes a workflow run ends with, each its own webhook topic. */
export type WorkflowRunEndType =
  | 'workflow_run.completed'
  | 'workflow_run.declined'
  | 'workflow_run.cancelled'
  | 'workflow_run.failed'
  | 'workflow_run.rolled_back';

/**
 * A workflow run ended. Appended in the same transaction as the run row's terminal status, so
 * subscribers hear about every ending exactly once.
 */
export interface WorkflowRunEndedEvent extends BaseEvent {
  readonly type: WorkflowRunEndType;
  readonly runId: string;
  readonly workflowId: string;
  readonly version: number;
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly reason: string | null;
}

/** A run opened an approval, event wait or agent review (the inbox and notifications use it). */
export interface WorkflowTaskOpenedEvent extends BaseEvent {
  readonly type: 'workflow.task_opened';
  readonly taskId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly kind: 'approval' | 'event' | 'review';
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly title: string;
  readonly assignee: string | null;
  readonly requiredScope: string | null;
  readonly deadline: string;
}

/**
 * The body a `content.webhook` node posts. Never appended to the outbox: the node sends it
 * directly, with `id` derived from the node's effect key so a retried step is the same delivery.
 */
export interface WorkflowWebhookEvent extends BaseEvent {
  readonly type: 'workflow.webhook';
  readonly runId: string;
  readonly nodeId: string;
  readonly entryId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * An invitation's link is due to be emailed (the engine sends it when the deployment has Email
 * Sending; otherwise it is dropped and the inviter shares the link they were shown). A control
 * event: no webhooks apply, and it carries no token and no address. The engine reads the
 * invitation, skips it unless it is still pending at `version` (a resend or revoke since makes it
 * stale), and mints the emailed link's own token. `scope` is the deployment (`*`, `main`):
 * invitations belong to no one space. `origin` is the admin's, where the link opens.
 */
export interface InviteEmailDueEvent extends BaseEvent {
  readonly type: 'invite.email_due';
  readonly inviteId: string;
  readonly version: number;
  readonly origin: string;
}

/**
 * The body of a test delivery an administrator asked for, to one webhook (`webhookId`) whatever its
 * topics, recorded in its delivery log like any other. Never appended to the outbox as an event: it
 * rides there inside a `WebhookSendRequest`, which no topic fan-out, function or live subscriber
 * sees. Sent once, never retried.
 */
export interface WebhookTestEvent extends BaseEvent {
  readonly type: 'webhook.test';
  readonly webhookId: string;
  /** A fixed sentence, so a receiver can tell a test from real traffic in its own logs. */
  readonly message: string;
}

export type EventType = DomainEvent['type'];
