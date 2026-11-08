import {
  coversEnvironment,
  type DomainEvent,
  deliveredEventOf,
  type EntriesPublishedBulkEvent,
  type Webhook,
  type WebhookSendRequest,
} from '@commerceworker/domain';
import type {
  AssetGate,
  AssetIngestQueue,
  AssetZipStarter,
  BlobStore,
  Cache,
  FunctionInvoker,
  RemoteFetcher,
  SearchIndex,
  WebhookSender,
} from '@commerceworker/ports';
import { assetBulkChunkRunner } from '../asset-bulk';
import { syncAssetGate } from '../asset-gate';
import { assetReindexChunkRunner, startAssetReindex } from '../asset-ingest';
import { type AssetSearchDeps, clearAssetSearch, indexAssetForSearch } from '../asset-search';
import { deleteAssetFiles } from '../assets';
import { type BulkChunkDeps, runBulkChunk } from '../bulk-jobs';
import { contentTypePurgeChunkRunner, finishContentTypeDeletion } from '../content-type-lifecycle';
import type { AppContext } from '../context';
import { entryFieldsChunkRunner } from '../entry-fields-bulk';
import { entryTrashChunkRunner } from '../entry-trash-bulk';
import { runEnvironmentPurge } from '../environment-purge';
import { invokeFunctionsForEvent } from '../functions';
import { importChunkRunner } from '../import-jobs';
import { deliverInviteEmail, type InviteMailDeps } from '../invites';
import { discardStagedJob } from '../job-staging';
import {
  extractTextByLocale,
  indexEntryEmbeddings,
  type RagDeps,
  removeEntryEmbeddings,
  runReindexJob,
} from '../rag';
import { isSnapshotJob } from '../snapshot-jobs';

/** Reverse-reference walk bound: embed chains deeper than this stay stale
 *  until their own next publish (cycle-safe either way via the visited set). */
export const MAX_INVALIDATION_DEPTH = 5;
/** Hard ceiling on entries invalidated per event (pathological fan-in guard). */
export const MAX_INVALIDATION_ENTRIES = 500;

export interface DispatchDeps {
  readonly sender: WebhookSender;
  /** Optional — when present, delivery cache tags are invalidated. */
  readonly cache?: Cache;
  /** Optional — when present, entries are embedded on publish (RAG). */
  readonly rag?: RagDeps;
  /** Optional — when present, matching user functions are invoked on each event. */
  readonly invoker?: FunctionInvoker;
  /** Optional observer for webhook delivery outcomes (host-side metrics). */
  readonly onWebhookDelivery?: (result: { delivered: boolean }) => void;
  /**
   * Schedules another attempt at one webhook after a failed delivery (the engine enqueues a
   * delayed `webhook.retry` message). Without it a failed delivery is recorded and not retried.
   */
  readonly scheduleWebhookRetry?: (retry: WebhookRetry) => Promise<void>;
  /**
   * Optional lexical index (the FTS5 SearchShard Durable Objects), kept fresh on
   * publish/unpublish. Independent of `rag` so lexical-at-scale works without
   * embeddings configured.
   */
  readonly searchIndex?: SearchIndex;
  /**
   * Object storage, needed only to run import chunks — their work is staged
   * there rather than being a list of entry ids. A consumer without it leaves
   * import chunks claimable rather than reporting an import that did not run.
   */
  readonly blob?: BlobStore;
  /**
   * The outbound fetcher a space export import's chunks copy asset files with (after the URL
   * screen). Without it those chunks are released for a consumer that has one.
   */
  readonly remoteFetcher?: RemoteFetcher;
  /**
   * The media origin's published-asset gate (KV on the edge). When present, every asset event
   * brings the asset's entry in line with what is published; without it the media Worker falls
   * back to a D1 replica on every miss.
   */
  readonly assetGate?: AssetGate;
  /**
   * The asset search indexes. When present, an asset publish or unpublish re-indexes it from what
   * is published now, and deletes (of an asset, of an environment) remove what was indexed.
   */
  readonly assetSearch?: AssetSearchDeps;
  /** The ingest queue, which `asset_reindex` bulk chunks feed; absent, those chunks wait. */
  readonly assetIngest?: AssetIngestQueue;
  /** Starts the Workflow that builds a requested zip; absent, a request fails at once. */
  readonly assetZip?: AssetZipStarter;
  /**
   * Tags already invalidated during this consumer invocation. A queue batch of
   * same-type publishes (a release, a burst of scheduled publishes) would
   * otherwise write the SAME `ct:` tag once per event — and a cache backend
   * like Workers KV rate-limits writes to a single key (~1/s), so the
   * redundant writes can 429 and re-drive the whole event. Hosts pass one Set
   * per batch; dispatch skips any tag already written under it.
   */
  readonly invalidatedTags?: Set<string>;
  /**
   * Email Sending and the token hasher, for `invite.email_due`. Absent (the deployment sends no
   * email), the event is dropped: the inviter shares the link they were shown.
   */
  readonly inviteMail?: InviteMailDeps;
  /**
   * Runs one phase of a space starter's background install (`starter_install` bulk chunks): the
   * engine binds `@commerceworker/seed`'s runner, which this layer can't import. Absent, those
   * chunks stay claimable for a consumer that has it.
   */
  readonly starterChunk?: BulkChunkDeps['starterChunk'];
}

/**
 * Handles a single relayed domain event: fans it out to subscribed webhooks
 * (signed + recorded) and invalidates the delivery cache for the affected entry
 * AND every entry that embeds it (via the reverse-reference graph), so embedded
 * copies refresh on the next read. Idempotent on the event id.
 */
export async function dispatchEvent(
  ctx: AppContext,
  deps: DispatchDeps,
  event: DomainEvent,
): Promise<void> {
  const scope = event.scope;

  // Background reindex job: run one bounded slice here on the consumer; the
  // remainder (if any) is re-enqueued as a continuation event via the outbox.
  // Runs lexical-only when a SearchIndex is bound without embeddings, so a
  // reindex request never silently no-ops. Nothing else applies to this event.
  if (event.type === 'search.reindex_requested') {
    const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
    if (deps.rag || searchIndex) {
      await runReindexJob(deps.rag, ctx, event, { searchIndex });
    }
    return;
  }

  // Bulk-job control event: claim and run one chunk. Not a state-change fact
  // — no webhooks/cache/RAG apply. (Normally routed to the dedicated bulk
  // topic; handled here too so a single-topic deployment still works.)
  if (event.type === 'bulk.chunk_due') {
    await runBulkChunk(ctx, event, {
      assetBulkChunk: assetBulkChunkRunner(ctx),
      entryTrashChunk: entryTrashChunkRunner(ctx, deps.blob ? { blob: deps.blob } : {}),
      entryFieldsChunk: entryFieldsChunkRunner(ctx),
      contentTypePurgeChunk: contentTypePurgeChunkRunner(ctx, deps.blob ? { blob: deps.blob } : {}),
      ...(deps.blob ? { importChunk: importChunkRunner(ctx, deps.blob, deps.remoteFetcher) } : {}),
      ...(deps.assetIngest
        ? { assetReindexChunk: assetReindexChunkRunner(ctx, deps.assetIngest) }
        : {}),
      ...(deps.starterChunk ? { starterChunk: deps.starterChunk } : {}),
    });
    return;
  }

  // An invitation's link is due by email. A control event, carrying no token: no webhooks apply.
  if (event.type === 'invite.email_due') {
    if (deps.inviteMail) await deliverInviteEmail(ctx, deps.inviteMail, event);
    return;
  }

  // A zip was asked for: start the Workflow that builds it (one instance per job, so a
  // redelivered event starts nothing more). A control event: no webhooks apply.
  if (event.type === 'asset_zip.requested') {
    if (deps.assetZip) {
      await deps.assetZip.start({ scope, jobId: event.jobId });
    } else {
      await ctx.store.assetZips.update(scope, event.jobId, {
        status: 'failed',
        error: 'Zip downloads are not available on this deployment',
      });
    }
    return;
  }

  // A deleted environment's next purge steps. A control event: no webhooks/cache/RAG apply.
  // (Normally routed to the bulk topic, so a long purge never delays entry events.)
  if (event.type === 'environment.purge_due') {
    await runEnvironmentPurge(
      ctx,
      {
        ...(deps.blob ? { blob: deps.blob } : {}),
        ...(deps.assetGate ? { assetGate: deps.assetGate } : {}),
        ...(deps.assetSearch ? { assetSearch: deps.assetSearch } : {}),
      },
      event,
    );
    return;
  }

  // A test event only ever travels inside a WebhookSendRequest (`deliverWebhookRequest`); should
  // one arrive on its own, it must not reach every "*" subscriber.
  if (event.type === 'webhook.test') return;

  // Coalesced bulk fact: the bulk-shaped fan-out replaces N per-entry events.
  if (event.type === 'entries.published_bulk') {
    await dispatchBulkPublished(ctx, deps, event);
    return;
  }

  // 1. Webhook fan-out. A failed delivery is retried for that webhook alone, later, so a down
  // receiver neither loses the event nor re-drives the rest of this dispatch.
  const webhooks = await ctx.store.webhooks.listByTopic(scope, event.type);
  for (const webhook of webhooks) {
    await deliverWebhook(ctx, deps, webhook, event, 1);
  }

  // A published entry's move reorders the type's lists, so their cached results go; no entry's
  // own content changed, so no entry tag does.
  if (deps.cache && event.type === 'entry.moved' && event.published) {
    const tag = contentTypeTag(scope, event.contentTypeApiId);
    if (!deps.invalidatedTags?.has(tag)) {
      await deps.cache.invalidateTags([tag]);
      deps.invalidatedTags?.add(tag);
    }
  }

  // 2. Cache invalidation for entry events: the entry itself plus every entry
  // that transitively embeds it (A embeds B embeds C → publishing C refreshes
  // A and B). One bounded reverse-closure query, one batched invalidation.
  if (deps.cache && (event.type === 'entry.published' || event.type === 'entry.unpublished')) {
    const embedders = await ctx.store.references.findReverseClosure(scope, [event.entryId], {
      maxDepth: MAX_INVALIDATION_DEPTH,
      maxEntries: MAX_INVALIDATION_ENTRIES,
    });
    const tags = [
      ...[event.entryId, ...embedders].map((id) => cacheTag(scope, id)),
      // Cached LIST results are tagged by content type, not by member id — a
      // new or withdrawn entry changes which rows a list returns even though
      // no cached member entry changed, so the type's tag must bump too.
      contentTypeTag(scope, event.contentTypeApiId),
    ];
    // Coalesce across the batch: re-writing a tag another event in this same
    // invocation already bumped adds no invalidation, only write pressure on
    // a single hot key.
    const fresh = deps.invalidatedTags ? tags.filter((t) => !deps.invalidatedTags?.has(t)) : tags;
    if (fresh.length > 0) {
      await deps.cache.invalidateTags(fresh);
      for (const t of fresh) deps.invalidatedTags?.add(t);
    }
  }

  // 2b. Asset events: delivery renders EMBED an asset's file/title/description
  // into every entry that links it, so an asset change must invalidate those
  // entries — nothing else would. The reference graph already stores asset
  // edges, so the same bounded reverse closure finds the embedders (including
  // transitively, e.g. page -> card -> asset).
  // Rights changes too: the delivered credit and license are embedded with the file.
  if (
    deps.cache &&
    (event.type === 'asset.published' ||
      event.type === 'asset.unpublished' ||
      event.type === 'asset.rights_changed')
  ) {
    const embedders = await ctx.store.references.findReverseClosure(scope, [event.assetId], {
      maxDepth: MAX_INVALIDATION_DEPTH,
      maxEntries: MAX_INVALIDATION_ENTRIES,
    });
    if (embedders.length > 0) {
      // Per-entry tags cover cached single-entry renders. Cached LISTS carry
      // no tag for a resolved member, so the embedders' content types are
      // needed too — one batched read, bounded by the closure cap.
      const snapshots = await ctx.store.entries.getPublishedMany(scope, embedders);
      const types = new Set(snapshots.map((e) => e.contentTypeApiId));
      const tags = [
        ...embedders.map((id) => cacheTag(scope, id)),
        ...[...types].map((t) => contentTypeTag(scope, t)),
      ];
      const fresh = deps.invalidatedTags ? tags.filter((t) => !deps.invalidatedTags?.has(t)) : tags;
      if (fresh.length > 0) {
        await deps.cache.invalidateTags(fresh);
        for (const t of fresh) deps.invalidatedTags?.add(t);
      }
    }
  }

  // 2c. The media origin's gate follows what is published now (written, or removed). It reads the
  // current snapshot rather than trusting the event, so a redelivered one converges.
  if (
    deps.assetGate &&
    (event.type === 'asset.published' ||
      event.type === 'asset.unpublished' ||
      event.type === 'asset.deleted' ||
      event.type === 'asset.rights_changed')
  ) {
    await syncAssetGate(ctx, deps.assetGate, scope, event.assetId);
  }

  // A replaced (or restored) file goes through ingest as an upload does: the same message the
  // api sends when a signed PUT completes, so the run id is the bytes' and R2's own notification
  // of the upload, whenever it arrives, starts no second run.
  if (deps.assetIngest && event.type === 'asset.file_replaced') {
    await deps.assetIngest.objectCreated(event.r2Key, event.etag);
  }

  // 2d. A rendition preset changed: delivered assets list the space's renditions, embedded in
  // cached entry renders of every environment, so each environment's scope epoch bumps. Locale
  // settings belong to the space too, and every cached render was made with them: a locale turned
  // off must leave every environment's cache at once.
  if (
    deps.cache &&
    (event.type === 'asset_renditions.changed' || event.type === 'space_locales.changed')
  ) {
    const tags = (await ctx.store.spaces.listEnvironments(scope.spaceId))
      .map((env) => epochTag({ spaceId: scope.spaceId, environmentId: env.id }))
      .filter((t) => !deps.invalidatedTags?.has(t));
    if (tags.length > 0) {
      await deps.cache.invalidateTags(tags);
      for (const t of tags) deps.invalidatedTags?.add(t);
    }
  }

  // A deleted asset's bytes: the row went with the request, the files go here, so a failed
  // removal comes back with the event. Idempotent, like every removal below.
  if (event.type === 'asset.deleted') {
    await deleteAssetFiles(
      ctx,
      {
        ...(deps.blob ? { blob: deps.blob } : {}),
        ...(deps.assetSearch ? { search: deps.assetSearch } : {}),
      },
      event,
    );
  }

  // 2e. Asset search reads the published snapshot of a published asset, so a publish or unpublish
  // re-indexes it (the asset may never have been ingested, too: an upload from before ingest).
  if (
    deps.assetSearch &&
    (event.type === 'asset.published' || event.type === 'asset.unpublished')
  ) {
    await indexAssetForSearch(ctx, deps.assetSearch, deps.blob, scope, event.assetId);
  }

  // A deleted environment: its rows are gone, so remove what was derived from them elsewhere.
  // Each removal is idempotent, so a redelivered event is harmless.
  if (event.type === 'environment.deleted') {
    const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
    for (const entryId of event.entryIds) {
      if (deps.rag) await removeEntryEmbeddings(deps.rag, scope, entryId);
      await searchIndex?.remove(scope, entryId);
    }
    // Asset search documents go in one call per shard; asset vectors, which go only by id, go
    // with the purge (it pages the assets before their rows are removed).
    await clearAssetSearch(deps.assetSearch, scope);
    if (deps.cache) await deps.cache.invalidateTag(epochTag(scope));
    // Its media stops at once: every gate entry goes (the engine then purges the environment's
    // cached media, now and once more later). The purge clears the gate again when it finishes.
    await deps.assetGate?.deleteScope(scope);
    // Its rows and files go with the purge (`environment.purge_due`), once, not per event.
  }

  // Terminal bulk-job fact: the unconditional scope-epoch bump — the
  // correctness backstop for any bump missed while the job ran. (Webhook
  // fan-out above already delivered the job summary to subscribers.)
  // A finished import job: discard what it still has staged (a chunk that failed for good keeps
  // its work), and the work of a chained job that didn't start (it only starts after a clean run).
  if (deps.blob && event.type === 'bulk.job_completed' && event.action === 'import') {
    const job = await ctx.store.bulkJobs.getJob(scope, event.jobId);
    const nextId = (job?.config as { next?: { id?: string } } | undefined)?.next?.id;
    if (job) {
      const nextStarted = nextId
        ? (await ctx.store.bulkJobs.getJob(scope, nextId)) !== null
        : false;
      await discardStagedJob(deps.blob, scope, job, { nextStarted });
    }
  }

  // A snapshot import's or clone's assets are written by its create phase, each never ingested in
  // its new environment: send them through ingest so the target's search has them. A redelivered
  // event finds the reindex still running (and gets it back) or nothing left to do.
  if (deps.assetIngest && event.type === 'bulk.job_completed' && event.action === 'import') {
    const job = await ctx.store.bulkJobs.getJob(scope, event.jobId);
    if (isSnapshotJob(job?.config) && job.config.phase === 'create') {
      await startAssetReindex(ctx, scope);
    }
  }

  if (deps.cache && event.type === 'bulk.job_completed') {
    await deps.cache.invalidateTag(epochTag(scope));
  }

  // A content type's delete, its entries gone: the type goes too. Redelivered, it finds the type
  // gone and does nothing; refused (a dependent added while the job ran), the type stays. Either
  // way the outcome is recorded on the job (`typeDeletion`), where REST, MCP and the admin read it.
  if (event.type === 'bulk.job_completed' && event.action === 'content_type_delete') {
    const kept = await finishContentTypeDeletion(ctx, scope, event.jobId);
    if (kept) console.warn('content type kept after its delete job', event.jobId, kept);
  }

  // A deleted content type leaves Delivery's GraphQL schema, routes and sitemap: cached lists of
  // its entries and every render under the scope go stale with it.
  if (deps.cache && event.type === 'content_type.deleted') {
    await deps.cache.invalidateTags([
      contentTypeTag(scope, event.contentTypeApiId),
      epochTag(scope),
    ]);
  }

  // 3. RAG: (re)embed on publish, drop vectors on unpublish.
  if (deps.rag) {
    if (event.type === 'entry.published') {
      await indexEntryEmbeddings(deps.rag, scope, {
        entryId: event.entryId,
        fields: event.fields,
        entryVersion: event.version,
      });
    } else if (event.type === 'entry.unpublished') {
      await removeEntryEmbeddings(deps.rag, scope, event.entryId);
    }
  }

  // 3b. External lexical index (when bound): mirror the publish lifecycle.
  const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
  if (searchIndex) {
    if (event.type === 'entry.published') {
      await searchIndex.index(scope, {
        entryId: event.entryId,
        contentTypeApiId: event.contentTypeApiId,
        textByLocale: extractTextByLocale(event.fields),
        entryVersion: event.version,
      });
    } else if (event.type === 'entry.unpublished') {
      await searchIndex.remove(scope, event.entryId);
    }
  }

  // 4. User-defined functions matching this event type.
  if (deps.invoker) {
    await invokeFunctionsForEvent(ctx, deps.invoker, event);
  }
}

/** Concurrent webhook POSTs per bulk event (bounds subrequest burst). */
const BULK_WEBHOOK_CONCURRENCY = 5;

/** The per-entry topic a bulk chunk's entries are sent under. */
const perEntryTypeOf = (event: EntriesPublishedBulkEvent) =>
  event.action === 'publish' ? ('entry.published' as const) : ('entry.unpublished' as const);

/** A publish chunk's entries as they are published now (an unpublish chunk needs ids only). */
async function bulkSnapshots(ctx: AppContext, event: EntriesPublishedBulkEvent) {
  const snapshots =
    event.action === 'publish'
      ? await ctx.store.entries.getPublishedMany(event.scope, event.entryIds)
      : [];
  return new Map(snapshots.map((s) => [s.entryId, s]));
}

/**
 * Sends a bulk chunk's entries to one per-entry subscriber as synthesized `entry.published` /
 * `entry.unpublished` events, records one delivery line for the chunk with this attempt, and on
 * failure schedules a retry of the entries that failed only (the chunk event cut down to them).
 * Returns how many failed.
 */
async function deliverBulkPerEntry(
  ctx: AppContext,
  deps: Pick<DispatchDeps, 'sender' | 'onWebhookDelivery' | 'scheduleWebhookRetry'>,
  webhook: Webhook,
  event: EntriesPublishedBulkEvent,
  snapshotById: ReadonlyMap<string, { contentTypeApiId: string; version: number; fields: unknown }>,
  attempt: number,
  sent: SendOptions = {},
): Promise<number> {
  const { scope } = event;
  const isPublish = event.action === 'publish';
  // Publish sends only entries whose snapshot still exists — one re-unpublished
  // between chunk commit and dispatch (or before a retry) gets no degraded empty-fields payload
  // (its own unpublish event tells the receiver what happened instead).
  const entryIds = isPublish
    ? event.entryIds.filter((id) => snapshotById.has(id))
    : [...event.entryIds];
  if (entryIds.length === 0) return 0;
  const failedIds: string[] = [];
  let lastError: string | undefined;
  const sendOne = async (entryId: string) => {
    const snapshot = snapshotById.get(entryId);
    // Derived id from STABLE coordinates (jobId, chunkId, entryId) — a
    // chunk re-run or a retry mints no new id, so the receiver's dedupe key holds.
    const derivedId = `${event.jobId}:${event.chunkId}:${entryId}`;
    const perEntryEvent = (
      isPublish && snapshot
        ? {
            id: derivedId,
            type: 'entry.published',
            scope,
            occurredAt: event.occurredAt,
            entryId,
            contentTypeApiId: snapshot.contentTypeApiId,
            version: snapshot.version,
            fields: snapshot.fields,
          }
        : {
            id: derivedId,
            type: 'entry.unpublished',
            scope,
            occurredAt: event.occurredAt,
            entryId,
            contentTypeApiId: '',
          }
    ) as DomainEvent;
    const result = await deps.sender.send(webhook, perEntryEvent, sentAt(sent));
    deps.onWebhookDelivery?.({ delivered: result.delivered });
    if (!result.delivered) {
      failedIds.push(entryId);
      lastError = result.error ?? `HTTP ${result.statusCode}`;
    }
  };
  for (let at = 0; at < entryIds.length; at += BULK_WEBHOOK_CONCURRENCY) {
    await Promise.all(entryIds.slice(at, at + BULK_WEBHOOK_CONCURRENCY).map((id) => sendOne(id)));
  }
  await ctx.store.webhooks.recordDelivery(scope, {
    webhookId: webhook.id,
    eventId: event.id,
    status: failedIds.length === 0 ? 'success' : 'failed',
    attempts: attempt,
    error:
      failedIds.length === 0
        ? undefined
        : `${failedIds.length}/${entryIds.length} deliveries failed: ${lastError}`,
    eventType: event.type,
    ...(sent.resendOf !== undefined ? { resendOf: sent.resendOf } : {}),
  });
  if (failedIds.length > 0 && attempt < WEBHOOK_MAX_ATTEMPTS && deps.scheduleWebhookRetry) {
    await deps.scheduleWebhookRetry({
      webhookId: webhook.id,
      event: { ...event, entryIds: failedIds },
      attempt: attempt + 1,
      delaySeconds: webhookRetryDelay(attempt),
    });
  }
  return failedIds.length;
}

/** Attempts at one webhook delivery before it is given up (logged as failed with this count). */
export const WEBHOOK_MAX_ATTEMPTS = 8;

/** Seconds before attempt `attempt + 1`: 30 s, 2 min, 8 min, 32 min, ~2 h, then 6 h. */
export function webhookRetryDelay(attempt: number): number {
  return Math.min(30 * 4 ** (attempt - 1), 6 * 3600);
}

/** Another attempt at delivering `event` to one webhook. */
export interface WebhookRetry {
  readonly webhookId: string;
  readonly event: DomainEvent;
  /** The attempt this will be (2 for the first retry). */
  readonly attempt: number;
  readonly delaySeconds: number;
}

/** How an administrator's resend is sent: signed at `timestamp`, sent and logged as a resend. */
interface SendOptions {
  readonly timestamp?: string;
  readonly resendOf?: number;
}

const sentAt = (sent: SendOptions) =>
  sent.timestamp !== undefined || sent.resendOf !== undefined
    ? {
        ...(sent.timestamp !== undefined ? { timestamp: sent.timestamp } : {}),
        ...(sent.resendOf !== undefined ? { resendOf: sent.resendOf } : {}),
      }
    : undefined;

async function deliverWebhook(
  ctx: AppContext,
  deps: Pick<DispatchDeps, 'sender' | 'onWebhookDelivery' | 'scheduleWebhookRetry'>,
  webhook: Webhook,
  event: DomainEvent,
  attempt: number,
  sent: SendOptions = {},
): Promise<boolean> {
  const result = await deps.sender.send(webhook, event, sentAt(sent));
  deps.onWebhookDelivery?.({ delivered: result.delivered });
  await ctx.store.webhooks.recordDelivery(event.scope, {
    webhookId: webhook.id,
    eventId: event.id,
    status: result.delivered ? 'success' : 'failed',
    statusCode: result.statusCode,
    attempts: attempt,
    error: result.error,
    eventType: event.type,
    ...(sent.resendOf !== undefined ? { resendOf: sent.resendOf } : {}),
  });
  if (!result.delivered && attempt < WEBHOOK_MAX_ATTEMPTS && deps.scheduleWebhookRetry) {
    await deps.scheduleWebhookRetry({
      webhookId: webhook.id,
      event,
      attempt: attempt + 1,
      delaySeconds: webhookRetryDelay(attempt),
    });
  }
  return result.delivered;
}

/**
 * One retry of one webhook (the `webhook.retry` queue message's body): delivered again as it
 * would have been, recorded with its attempt number, and scheduled once more on failure until
 * {@link WEBHOOK_MAX_ATTEMPTS}. A webhook since deleted, deactivated or unsubscribed from the
 * event's type gets nothing.
 */
export async function redeliverWebhook(
  ctx: AppContext,
  deps: Pick<DispatchDeps, 'sender' | 'onWebhookDelivery' | 'scheduleWebhookRetry'>,
  retry: Pick<WebhookRetry, 'webhookId' | 'event' | 'attempt'>,
): Promise<{ delivered: boolean } | null> {
  // A bulk chunk's retry: a subscriber to the per-entry topic gets the entries that failed, one by
  // one, as dispatch sent them; a subscriber to the bulk topic gets the bulk event again.
  if (retry.event.type === 'entries.published_bulk') {
    const event = retry.event;
    const perEntry = await ctx.store.webhooks.listByTopic(event.scope, perEntryTypeOf(event));
    const webhook = perEntry.find((w) => w.id === retry.webhookId);
    if (webhook) {
      const snapshotById = await bulkSnapshots(ctx, event);
      const failed = await deliverBulkPerEntry(
        ctx,
        deps,
        webhook,
        event,
        snapshotById,
        retry.attempt,
      );
      return { delivered: failed === 0 };
    }
  }
  const current = await ctx.store.webhooks.listByTopic(retry.event.scope, retry.event.type);
  const webhook = current.find((w) => w.id === retry.webhookId);
  if (!webhook) return null;
  return { delivered: await deliverWebhook(ctx, deps, webhook, retry.event, retry.attempt) };
}

/**
 * An administrator's test or resend (a `WebhookSendRequest`, which the engine takes off the
 * events queue): one attempt at one webhook, whatever its topics and whether it is paused, recorded
 * in its log and never retried (they can ask again). A resend reads its event back from the outbox
 * now and sends it with the same id, signed at the time it is sent; a bulk chunk goes to a
 * per-entry subscriber entry by entry, from the entries' published snapshots as they are now, as a
 * retry does. An event swept since, one from an environment the webhook no longer covers, or a
 * chunk with no entry still published, is logged as a failed attempt rather than dropped. A webhook deleted since, or no longer visible where it was asked
 * for, gets nothing (`null`). A redelivered request sends again; the event id is the same, so a
 * receiver that dedupes on it sees one.
 */
export async function deliverWebhookRequest(
  ctx: AppContext,
  deps: Pick<DispatchDeps, 'sender' | 'onWebhookDelivery'>,
  request: WebhookSendRequest,
): Promise<{ delivered: boolean } | null> {
  const webhook = await ctx.store.webhooks.get(request.scope, request.webhookId);
  if (!webhook) return null;
  const once = { sender: deps.sender, onWebhookDelivery: deps.onWebhookDelivery };
  if (request.test) {
    return { delivered: await deliverWebhook(ctx, once, webhook, request.test, 1) };
  }
  if (!request.resend) return null;
  const { deliveryId, eventId } = request.resend;
  const stored = await ctx.store.outbox.get(request.scope, eventId);
  const event = stored ? deliveredEventOf(stored) : null;
  const refused = async (error: string) => {
    await ctx.store.webhooks.recordDelivery(event?.scope ?? request.scope, {
      webhookId: webhook.id,
      eventId,
      status: 'failed',
      attempts: 1,
      error,
      ...(event ? { eventType: event.type } : {}),
      resendOf: deliveryId,
    });
    return { delivered: false };
  };
  if (!event) return refused('The event is past the event retention; nothing was sent');
  // Rescoped since (to another environment): it no longer receives this event's environment.
  if (!coversEnvironment(webhook, event.scope.environmentId)) {
    return refused(
      `The webhook no longer receives events from "${event.scope.environmentId}"; nothing was sent`,
    );
  }
  const sent = { timestamp: ctx.clock.now().toISOString(), resendOf: deliveryId };
  if (
    event.type === 'entries.published_bulk' &&
    webhook.topics.some((t) => t === '*' || t === perEntryTypeOf(event))
  ) {
    const snapshots = await bulkSnapshots(ctx, event);
    if (event.action === 'publish' && !event.entryIds.some((id) => snapshots.has(id))) {
      return refused('No entry in the chunk is still published; nothing was sent');
    }
    const failed = await deliverBulkPerEntry(ctx, once, webhook, event, snapshots, 1, sent);
    return { delivered: failed === 0 };
  }
  return { delivered: await deliverWebhook(ctx, once, webhook, event, 1, sent) };
}

/**
 * Fan-out for one coalesced `entries.published_bulk` chunk event.
 *
 * - Cache: ONE scope-epoch bump instead of up to `entryIds.length × 500`
 *   per-entry tag writes — a bulk chunk has changed enough of the scope that
 *   precise invalidation is worse than a scope-wide lazy refresh. Every
 *   delivery envelope carries the epoch tag, so readers re-render on next
 *   read. (Physically forced too: per-entry closure walks and KV writes at
 *   bulk scale would blow the per-invocation subrequest budget.)
 * - Webhooks: receivers keep the per-entry payload contract — each entry is
 *   sent as a synthesized `entry.published`/`entry.unpublished` event with
 *   the deterministic derived id `${event.id}:${entryId}`, so redelivered
 *   chunks dedupe receiver-side. One delivery record per webhook summarizes
 *   the batch.
 * - RAG/search: batch-read snapshots once, then index per entry.
 */
async function dispatchBulkPublished(
  ctx: AppContext,
  deps: DispatchDeps,
  event: EntriesPublishedBulkEvent,
): Promise<void> {
  const scope = event.scope;
  const isPublish = event.action === 'publish';
  const perEntryType = perEntryTypeOf(event);

  // Snapshots for webhook payloads + indexing (publish only; unpublished
  // entries have left the read model and need ids only).
  const snapshotById = await bulkSnapshots(ctx, event);
  const snapshots = [...snapshotById.values()];

  // 1. Webhooks: subscribers to the per-entry topics get synthesized
  // per-entry events; subscribers to the bulk topic get the bulk event. Either way a failure is
  // retried for that webhook alone, later: the entries that failed, or the bulk event.
  const perEntryWebhooks = await ctx.store.webhooks.listByTopic(scope, perEntryType);
  for (const webhook of perEntryWebhooks) {
    await deliverBulkPerEntry(ctx, deps, webhook, event, snapshotById, 1);
  }
  const bulkWebhooks = (await ctx.store.webhooks.listByTopic(scope, event.type)).filter(
    (w: Webhook) => !perEntryWebhooks.some((p) => p.id === w.id),
  );
  for (const webhook of bulkWebhooks) {
    await deliverWebhook(ctx, deps, webhook, event, 1);
  }

  // 2. Cache: one epoch bump for the whole chunk.
  if (deps.cache) {
    await deps.cache.invalidateTag(epochTag(scope));
  }

  // 3. RAG + lexical index, from the batch-read snapshots.
  if (deps.rag) {
    if (isPublish) {
      for (const s of snapshots) {
        await indexEntryEmbeddings(deps.rag, scope, {
          entryId: s.entryId,
          fields: s.fields,
          entryVersion: s.version,
        });
      }
    } else {
      for (const id of event.entryIds) {
        await removeEntryEmbeddings(deps.rag, scope, id);
      }
    }
  }
  const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
  if (searchIndex) {
    if (isPublish) {
      for (const s of snapshots) {
        // refresh: false — bulk writes defer to the engine's refresh cycle.
        await searchIndex.index(
          scope,
          {
            entryId: s.entryId,
            contentTypeApiId: s.contentTypeApiId,
            textByLocale: extractTextByLocale(s.fields),
            entryVersion: s.version,
          },
          { refresh: false },
        );
      }
    } else {
      for (const id of event.entryIds) {
        await searchIndex.remove(scope, id);
      }
    }
  }

  // 4. User functions see the bulk event itself (one invocation per function,
  // not one per entry).
  if (deps.invoker) {
    await invokeFunctionsForEvent(ctx, deps.invoker, event);
  }
}

/** Cache tag for a delivered entry, scoped to its space + environment. */
export function cacheTag(
  scope: { spaceId: string; environmentId: string },
  entryId: string,
): string {
  return `entry:${scope.spaceId}:${scope.environmentId}:${entryId}`;
}

/**
 * Scope-wide epoch tag. Every delivery cache envelope carries it, so bumping
 * this ONE version key lazily evicts the whole scope — the bulk-operation
 * invalidation path (one KV write instead of one per affected entry).
 */
export function epochTag(scope: { spaceId: string; environmentId: string }): string {
  return `epoch:${scope.spaceId}:${scope.environmentId}`;
}

/**
 * Cache tag for every cached LIST result over a content type. Lists can't be
 * tagged by member id alone: publishing a NEW entry changes which rows a list
 * returns without touching any entry already in it, so a per-entry tag set
 * would never evict it. Bumped on every publish/unpublish of the type.
 */
export function contentTypeTag(
  scope: { spaceId: string; environmentId: string },
  contentTypeApiId: string,
): string {
  return `ct:${scope.spaceId}:${scope.environmentId}:${contentTypeApiId}`;
}
