import {
  ConflictError,
  type ContentType,
  type Entry,
  extractReferences,
  InvalidStateError,
  NotFoundError,
  publish,
  type ReferenceEdge,
  type Scope,
  stampChanged,
  stampPublished,
  unpublish,
  ValidationError,
} from '@commerceworker/domain';
import type { ContentStoreTx, EntryWithFields, PublishedEntry } from '@commerceworker/ports';
import { type AppContext, actorOf } from './context';
import { runHook } from './hooks';
import {
  loadPublishGuard,
  type PublishGrant,
  type PublishGuard,
  trustedGuard,
} from './publish-gate';
import { slugRedirectWrites } from './redirects';

/**
 * Holds a write to the version its caller saw. A confirm card, a page's button and an API client
 * that read the entry first pass the `currentVersion` they read; when the entry has moved on since
 * (someone saved a new draft), the write is refused rather than acting on content they never saw.
 */
export interface ExpectedVersion {
  readonly expectedVersion?: number;
}

/** What a publish of one entry takes. */
export interface PublishOptions extends ExpectedVersion {
  /**
   * Lets the publish pass a workflow's publish gate. Only the workflow node executors (and the
   * snapshot import) can mint one (`publish-gate.ts`); a value from request input is ignored.
   */
  readonly grant?: PublishGrant;
}

/** Refuses with `ConflictError` (409) when `entry` is no longer at the version the caller saw. */
export function assertExpectedVersion(entry: Entry, opts: ExpectedVersion = {}): void {
  const expected = opts.expectedVersion;
  if (expected === undefined || entry.currentVersion === expected) return;
  throw new ConflictError(
    `Entry "${entry.id}" is at version ${entry.currentVersion}, not ${expected}: it changed after it was read. Read it again.`,
    { currentVersion: entry.currentVersion, expectedVersion: expected },
  );
}

/**
 * Publishes one entry inside an existing transaction. Writes the denormalized
 * published snapshot (the Delivery read model), materializes reference edges,
 * and appends an `entry.published` event to the outbox. Factored out of
 * {@link publishEntry} so a release can publish many entries in one transaction.
 *
 * Refuses an entry a gated workflow covers ({@link PublishOptions.grant}). A caller publishing
 * several entries passes the `guard` it already loaded, so the gates are read once.
 */
export async function publishEntryTx(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  id: string,
  opts: PublishOptions = {},
  guard?: PublishGuard,
): Promise<Entry> {
  const found = await tx.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  assertExpectedVersion(found.entry, opts);
  // A read, before anything in the unit writes.
  // A guard this module didn't build (any object of the right shape) is ignored.
  const gate =
    trustedGuard(guard) ?? (await loadPublishGuard(tx.workflowGraphs, scope, opts.grant));
  gate.assert(id, found.entry.contentTypeApiId);

  // Inside the transaction on purpose: a veto here rolls back everything the
  // publish would have written, including the outbox row.
  await runHook(ctx, 'entry:beforePublish', scope, {
    entryId: id,
    contentTypeApiId: found.entry.contentTypeApiId,
    version: found.entry.currentVersion,
  });

  const now = ctx.clock.now().toISOString();
  const published = stampPublished(found.entry, publish(found.entry), actorOf(ctx), now);

  // Materialize reference edges from the entry's link fields and verify each
  // linked entry exists in this environment (referential integrity).
  const contentType = await tx.contentTypes.get(scope, published.contentTypeApiId);
  if (!contentType) throw new NotFoundError('ContentType', published.contentTypeApiId);
  const edges = extractReferences(published.id, found.fields, contentType);
  await assertReferentialIntegrity(tx, scope, edges);
  // A slug its type's URL pattern names, changed since the live version: old path → new path.
  const redirect = await slugRedirectWrites(
    ctx,
    tx,
    scope,
    [{ entryId: id, contentType, fields: found.fields }],
    found.entry.publishedVersion !== null ? new Set([id]) : new Set(),
  );

  await tx.entries.saveAggregate(scope, published);

  // Capture the entry's taxonomy associations in the published snapshot so the
  // Delivery API can serve and filter on them without a second lookup. Read
  // via `tx` so the snapshot can't capture metadata from outside this
  // transaction's view.
  const metadata = (await tx.taxonomy.getEntryMetadata(scope, id)) ?? undefined;

  const snapshot: PublishedEntry = {
    entryId: published.id,
    contentTypeApiId: published.contentTypeApiId,
    version: published.currentVersion,
    fields: found.fields,
    publishedAt: now,
    ...(published.firstPublishedAt ? { firstPublishedAt: published.firstPublishedAt } : {}),
    metadata,
  };
  await tx.entries.putPublished(scope, snapshot);
  await tx.references.replaceForEntry(scope, published.id, edges);
  await redirect();

  await tx.outbox.append({
    id: ctx.ids.newId(),
    type: 'entry.published',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
    entryId: published.id,
    contentTypeApiId: published.contentTypeApiId,
    version: published.currentVersion,
    fields: found.fields,
  });

  return published;
}

/** Withdraws one entry's published version inside an existing transaction. */
export async function unpublishEntryTx(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  id: string,
  opts: ExpectedVersion = {},
): Promise<Entry> {
  const found = await tx.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  assertExpectedVersion(found.entry, opts);
  if (found.entry.publishedVersion === null) {
    throw new InvalidStateError('Entry is not published');
  }
  const updated = stampChanged(unpublish(found.entry), actorOf(ctx));
  await tx.entries.saveAggregate(scope, updated);
  await tx.entries.removePublished(scope, id);
  await tx.references.removeForEntry(scope, id);
  await tx.outbox.append({
    id: ctx.ids.newId(),
    type: 'entry.unpublished',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
    entryId: id,
    contentTypeApiId: updated.contentTypeApiId,
  });
  return updated;
}

/** Per-item outcome split of a batched publish/unpublish. */
export interface BatchPublishResult {
  readonly published: Entry[];
  /** Items already in the target state, counted as no-op successes (only
   *  populated under {@link BatchPublishOptions.idempotent}). */
  readonly unchanged: string[];
  /** Items that failed validation; the rest of the batch still committed. */
  readonly failures: { id: string; error: string }[];
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Publishes many entries inside one transaction with a bounded statement
 * count: batch reads (entries, reference targets, taxonomy) + one multi-row
 * write per table + one outbox row per entry — ~10 statements per chunk
 * instead of ~8 per entry. Per-item validation failures (missing entry,
 * invalid state, dangling links) are partitioned into `failures` without
 * aborting the transaction, so one bad item never sinks its chunk.
 *
 * Every published entry in the chunk shares one `publishedAt` instant — the
 * same behavior as a release publish; the delivery keyset cursor breaks ties
 * by entryId.
 */
export interface BatchPublishOptions {
  /**
   * Emit one `entry.published`/`entry.unpublished` outbox event per item
   * (default). Bulk jobs pass false — they append ONE coalesced
   * `entries.published_bulk` event for the chunk instead, so a 100k-entry job
   * produces ~500 events rather than 100k.
   */
  readonly emitPerEntryEvents?: boolean;
  /**
   * Treat items already in the target state as no-op successes (`unchanged`)
   * instead of failures. Bulk-job chunks pass true: an at-least-once re-run
   * of a committed unpublish chunk must not record its items as failures in
   * the compliance report. (Publish is naturally idempotent domain-side.)
   */
  readonly idempotent?: boolean;
}

export async function publishEntriesTx(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  ids: readonly string[],
  opts: BatchPublishOptions = {},
): Promise<BatchPublishResult> {
  const uniqueIds = [...new Set(ids)];
  const failures: { id: string; error: string }[] = [];

  const found = await tx.entries.getMany(scope, uniqueIds);
  const byId = new Map(found.map((f) => [f.entry.id, f]));
  // The scope's publish gates, read once for the chunk. No grant: no batch path runs from a
  // workflow, so a gated entry is a per-item failure like any other.
  const gate = await loadPublishGuard(tx.workflowGraphs, scope);

  // Load each distinct content type once for the whole chunk.
  const typeIds = [...new Set(found.map((f) => f.entry.contentTypeApiId))];
  const types = new Map<string, ContentType>();
  for (const apiId of typeIds) {
    const contentType = await tx.contentTypes.get(scope, apiId);
    if (contentType) types.set(apiId, contentType);
  }

  // Every published entry in the chunk shares one instant (see above).
  const publishedAt = ctx.clock.now().toISOString();
  const actor = actorOf(ctx);
  // Validate per item: existence, state machine, reference extraction.
  const candidates: { item: EntryWithFields; published: Entry; edges: ReferenceEdge[] }[] = [];
  for (const id of uniqueIds) {
    const item = byId.get(id);
    if (!item) {
      failures.push({ id, error: errorMessage(new NotFoundError('Entry', id)) });
      continue;
    }
    try {
      gate.assert(id, item.entry.contentTypeApiId);
      // Same order as publishEntryTx: the state machine runs before the
      // content-type check, so an archived entry with a missing type reports
      // the same error on either path.
      const published = stampPublished(item.entry, publish(item.entry), actor, publishedAt);
      const contentType = types.get(item.entry.contentTypeApiId);
      if (!contentType) {
        failures.push({
          id,
          error: errorMessage(new NotFoundError('ContentType', item.entry.contentTypeApiId)),
        });
        continue;
      }
      const edges = extractReferences(published.id, item.fields, contentType);
      candidates.push({ item, published, edges });
    } catch (e) {
      failures.push({ id, error: errorMessage(e) });
    }
  }

  // Referential integrity, batched: one existence read per target repo for
  // the chunk's whole edge set (a target inside this same batch counts — it
  // exists as a draft, exactly as the single-item path sees it).
  const entryTargets = new Set<string>();
  const assetTargets = new Set<string>();
  for (const c of candidates) {
    for (const edge of c.edges) {
      if (edge.toType === 'Entry') entryTargets.add(edge.toId);
      else if (edge.toType === 'Asset') assetTargets.add(edge.toId);
    }
  }
  const existingEntries = new Set(
    (await tx.entries.getMany(scope, [...entryTargets])).map((f) => f.entry.id),
  );
  const existingAssets = new Set(
    (await tx.assets.getMany(scope, [...assetTargets])).map((a) => a.id),
  );
  const publishable: typeof candidates = [];
  for (const c of candidates) {
    const issues = c.edges.flatMap((edge) => {
      if (edge.toType === 'Entry' && !existingEntries.has(edge.toId)) {
        return [{ field: edge.fromField, message: `Linked entry "${edge.toId}" does not exist` }];
      }
      if (edge.toType === 'Asset' && !existingAssets.has(edge.toId)) {
        return [{ field: edge.fromField, message: `Linked asset "${edge.toId}" does not exist` }];
      }
      return [];
    });
    if (issues.length > 0) {
      failures.push({ id: c.published.id, error: errorMessage(new ValidationError(issues)) });
    } else {
      publishable.push(c);
    }
  }

  if (publishable.length === 0) return { published: [], unchanged: [], failures };

  const okIds = publishable.map((c) => c.published.id);
  const metadataByEntry = new Map(
    (await tx.taxonomy.getEntryMetadataMany(scope, okIds)).map((m) => [m.entryId, m.metadata]),
  );

  const redirect = await slugRedirectWrites(
    ctx,
    tx,
    scope,
    publishable.map((c) => ({
      entryId: c.published.id,
      contentType: types.get(c.published.contentTypeApiId) as ContentType,
      fields: c.item.fields,
    })),
    new Set(
      publishable.filter((c) => c.item.entry.publishedVersion !== null).map((c) => c.published.id),
    ),
  );

  await tx.entries.saveAggregateMany(
    scope,
    publishable.map((c) => c.published),
  );
  await tx.entries.putPublishedMany(
    scope,
    publishable.map((c) => ({
      entryId: c.published.id,
      contentTypeApiId: c.published.contentTypeApiId,
      version: c.published.currentVersion,
      fields: c.item.fields,
      publishedAt,
      ...(c.published.firstPublishedAt ? { firstPublishedAt: c.published.firstPublishedAt } : {}),
      metadata: metadataByEntry.get(c.published.id),
    })),
  );
  await tx.references.replaceForEntries(
    scope,
    publishable.map((c) => ({ fromEntryId: c.published.id, edges: c.edges })),
  );
  await redirect();
  if (opts.emitPerEntryEvents !== false) {
    await tx.outbox.appendMany(
      publishable.map((c) => ({
        id: ctx.ids.newId(),
        type: 'entry.published' as const,
        scope,
        occurredAt: publishedAt,
        entryId: c.published.id,
        contentTypeApiId: c.published.contentTypeApiId,
        version: c.published.currentVersion,
        fields: c.item.fields,
      })),
    );
  }

  return { published: publishable.map((c) => c.published), unchanged: [], failures };
}

/**
 * Withdraws many entries' published versions inside one transaction — the
 * batched counterpart of {@link unpublishEntryTx}, with the same per-item
 * failure partitioning as {@link publishEntriesTx}.
 */
export async function unpublishEntriesTx(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  ids: readonly string[],
  opts: BatchPublishOptions = {},
): Promise<BatchPublishResult> {
  const uniqueIds = [...new Set(ids)];
  const failures: { id: string; error: string }[] = [];
  const found = await tx.entries.getMany(scope, uniqueIds);
  const byId = new Map(found.map((f) => [f.entry.id, f]));

  const unpublishable: Entry[] = [];
  const unchanged: string[] = [];
  for (const id of uniqueIds) {
    const item = byId.get(id);
    if (!item) {
      failures.push({ id, error: errorMessage(new NotFoundError('Entry', id)) });
      continue;
    }
    if (item.entry.publishedVersion === null) {
      // Under `idempotent` (bulk re-runs) an already-unpublished entry is a
      // no-op success, not a failure — the first run's commit did the work.
      if (opts.idempotent) unchanged.push(id);
      else failures.push({ id, error: 'Entry is not published' });
      continue;
    }
    try {
      unpublishable.push(stampChanged(unpublish(item.entry), actorOf(ctx)));
    } catch (e) {
      failures.push({ id, error: errorMessage(e) });
    }
  }

  if (unpublishable.length === 0) return { published: [], unchanged, failures };

  const occurredAt = ctx.clock.now().toISOString();
  await tx.entries.saveAggregateMany(scope, unpublishable);
  await tx.entries.removePublishedMany(
    scope,
    unpublishable.map((e) => e.id),
  );
  // Empty edge sets: replaceForEntries deletes without re-inserting.
  await tx.references.replaceForEntries(
    scope,
    unpublishable.map((e) => ({ fromEntryId: e.id, edges: [] })),
  );
  if (opts.emitPerEntryEvents !== false) {
    await tx.outbox.appendMany(
      unpublishable.map((e) => ({
        id: ctx.ids.newId(),
        type: 'entry.unpublished' as const,
        scope,
        occurredAt,
        entryId: e.id,
        contentTypeApiId: e.contentTypeApiId,
      })),
    );
  }

  return { published: unpublishable, unchanged, failures };
}

/**
 * Publishes an entry at its current version. Within one transaction it writes
 * the denormalized published snapshot (the Delivery read model) and appends an
 * `entry.published` event to the outbox, guaranteeing the event is enqueued iff
 * the publish commits. Refused with `PublishGatedError` (409 `publish_gated`)
 * when a gated workflow covers the entry, unless a run of it is publishing.
 */
export async function publishEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: PublishOptions = {},
): Promise<Entry> {
  return ctx.store.withTransaction((tx) => publishEntryTx(ctx, tx, scope, id, opts));
}

/** Withdraws an entry's published version and removes it from the read model. */
export async function unpublishEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: ExpectedVersion = {},
): Promise<Entry> {
  return ctx.store.withTransaction((tx) => unpublishEntryTx(ctx, tx, scope, id, opts));
}

/**
 * Verifies that every entry-targeted reference points at an entry that exists
 * in this environment. Missing targets are reported as validation issues so an
 * entry can't be published with dangling links. (Asset targets are checked once
 * assets land in P3b.)
 */
async function assertReferentialIntegrity(
  tx: ContentStoreTx,
  scope: Scope,
  edges: readonly ReferenceEdge[],
): Promise<void> {
  const issues = [];
  for (const edge of edges) {
    if (edge.toType === 'Entry') {
      if (!(await tx.entries.get(scope, edge.toId))) {
        issues.push({
          field: edge.fromField,
          message: `Linked entry "${edge.toId}" does not exist`,
        });
      }
    } else if (edge.toType === 'Asset') {
      if (!(await tx.assets.get(scope, edge.toId))) {
        issues.push({
          field: edge.fromField,
          message: `Linked asset "${edge.toId}" does not exist`,
        });
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}
