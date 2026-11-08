import {
  type Asset,
  AssetInUseError,
  type AssetMetadata,
  type AssetRights,
  type AssetUsage,
  type AssetVersion,
  applyAssetMetadata,
  archiveAsset as archiveAssetState,
  assertRightsAllowDelivery,
  ConflictError,
  clearAcceptedSuggestions,
  emptyAssetMetadata,
  extractReferences,
  InvalidStateError,
  isReservedSpaceId,
  type LocalizedValue,
  MAX_ASSET_USAGE_SHOWN,
  NotFoundError,
  publishAsset as publishAssetState,
  type ReferenceEdge,
  restoreAsset as restoreAssetState,
  type Scope,
  unpublishAsset as unpublishAssetState,
  ValidationError,
  validateAssetRights,
} from '@commerceworker/domain';
import {
  type AssetListQuery,
  type AssetPage,
  type AssetVersionRecord,
  type BlobStore,
  type ContentStoreTx,
  type PublishedAsset,
  type PublishedAssetPage,
  type PublishedAssetQuery,
  TransactionConflictError,
} from '@commerceworker/ports';
import { type AssetSearchDeps, removeAssetFromSearch } from './asset-search';
import type { AppContext } from './context';
import { runHook } from './hooks';

export interface CreateAssetInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly title?: LocalizedValue;
  readonly description?: LocalizedValue;
}

export interface CreatedAsset {
  readonly asset: Asset;
  /** Presigned upload target — the client PUTs the bytes here directly. */
  readonly upload: { url: string; headers: Record<string, string> };
}

/**
 * Reduces a client-supplied file name to a safe object-key segment: the final
 * path component only, with separators, traversal, and control characters
 * stripped. This prevents a crafted `fileName` (e.g. `../../otherspace/...`)
 * from escaping the scope's `spaceId/environmentId/id/` key prefix and reading
 * or overwriting another space's objects. Falls back to `file` when nothing
 * printable remains; the unique `id` in the prefix keeps keys collision-free.
 */
function safeObjectName(fileName: string): string {
  const last = fileName.split(/[/\\]/).pop() ?? '';
  let base = '';
  for (const ch of last) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) base += ch;
  }
  if (base === '' || base === '.' || base === '..') return 'file';
  return base.slice(0, 200);
}

/**
 * Where an asset's bytes live in blob storage: `space/environment/assetId/fileName` for its first
 * file (four segments, as every key was before versions), `space/environment/assetId/v<n>/
 * file-<attempt>/fileName` for the file of version `n` > 1 (six). Never five: that is where files
 * derived from a version live (`…/v<n>/text.md`, {@link assetDerivedPrefix}), which nothing may
 * serve. `attempt` is the replace start's own id, so two replaces of one version (two tabs, a
 * retry) never upload to one key: an upload URL stores once, and an R2 multipart completion is
 * unconditional, so a shared key would let one attempt refuse or overwrite the other's file.
 * Without it the segment is plain `file`, as keys minted before attempts were.
 */
export function assetObjectKey(
  scope: Scope,
  assetId: string,
  fileName: string,
  version = 1,
  attempt?: string,
): string {
  const base = `${scope.spaceId}/${scope.environmentId}/${assetId}`;
  const name = safeObjectName(fileName);
  return version > 1
    ? `${base}/v${version}/${attempt ? `file-${attempt}` : 'file'}/${name}`
    : `${base}/${name}`;
}

/** A replace attempt's id as it may stand in a key segment (an id from `ctx.ids`). */
const ATTEMPT = /^[A-Za-z0-9_-]{1,64}$/;

/** The attempt a version's key segment names (`file-<attempt>`), if any. */
export function assetKeyAttempt(key: string): string | undefined {
  const segment = key.split('/')[4] ?? '';
  return segment.startsWith('file-') ? segment.slice('file-'.length) : undefined;
}

/**
 * Creates a draft asset and returns a presigned upload URL. The client uploads
 * the bytes straight to blob storage (they never transit the API), then
 * publishes the asset to make it deliverable.
 */
export async function createAsset(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  input: CreateAssetInput,
  opts: { readonly createdBy?: string; readonly folderId?: string } = {},
): Promise<CreatedAsset> {
  const { asset, key, contentType } = await prepareUploadDraft(ctx, blob, scope, input, opts);
  const upload = await blob.getUploadUrl(key, contentType);
  await createUploadDraft(ctx, scope, asset);
  return { asset, upload };
}

/**
 * The draft an upload fills, before anything is written: the `asset:beforeCreate` hooks have
 * passed it (a refused asset leaves no signed URL in the caller's hands, nor a key reserved in the
 * bucket), its folder exists, and its key is minted from its new id. Shared by the single signed
 * PUT and multipart uploads, so both keys follow the same rules.
 */
export async function prepareUploadDraft(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  input: CreateAssetInput,
  opts: { readonly createdBy?: string; readonly folderId?: string } = {},
): Promise<{ readonly asset: Asset; readonly key: string; readonly contentType: string }> {
  const checked = await runHook(ctx, 'asset:beforeCreate', scope, input);
  if (opts.folderId) await getAssetFolderOrThrow(ctx, scope, opts.folderId);
  const id = ctx.ids.newId();
  const key = assetObjectKey(scope, id, checked.fileName);
  const url = await blob.getDownloadUrl(key);
  const asset: Asset = {
    id,
    status: 'draft',
    file: { url, fileName: checked.fileName, contentType: checked.contentType },
    title: checked.title ?? {},
    description: checked.description ?? {},
    metadata: emptyAssetMetadata,
    version: 1,
    r2Key: key,
    createdAt: ctx.clock.now().toISOString(),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
  };
  return { asset, key, contentType: checked.contentType };
}

/** Writes a prepared draft; a folder deleted since the check is reported as the check would. */
export async function createUploadDraft(ctx: AppContext, scope: Scope, asset: Asset) {
  try {
    await ctx.store.assets.create(scope, asset);
  } catch (err) {
    if (err instanceof TransactionConflictError && asset.folderId) {
      throw new NotFoundError('AssetFolder', asset.folderId);
    }
    throw err;
  }
}

export async function getAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  return asset;
}

/**
 * One page of the asset library, filtered and sorted; pass `nextCursor` back for the next.
 * Archived assets are left out unless `filters.status` asks for them.
 */
export async function listAssets(
  ctx: AppContext,
  scope: Scope,
  query: AssetListQuery = {},
): Promise<AssetPage> {
  return ctx.store.assets.list(scope, query);
}

/**
 * Every asset in the scope, whatever its status, page by page: for work that must see the whole
 * library (an export, the files another environment still uses).
 */
export async function allAssets(ctx: AppContext, scope: Scope): Promise<Asset[]> {
  const out: Asset[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.store.assets.list(scope, {
      limit: 500,
      filters: { status: 'all' },
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * Publishes an asset — writes the denormalized snapshot served by Delivery. Refused while its
 * rights hold it back ({@link AssetRightsError}: under embargo, or expired). A republish after
 * the file was replaced delivers the new file; the event names the version it replaced, whose
 * media URLs stop working.
 */
export async function publishAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  return ctx.store.withTransaction(async (tx) => {
    const [asset, before] = await Promise.all([
      tx.assets.get(scope, id),
      tx.assets.getPublished(scope, id),
    ]);
    if (!asset) throw new NotFoundError('Asset', id);
    const now = ctx.clock.now();
    assertRightsAllowDelivery(id, asset.rights, now);
    const published = publishAssetState(asset);
    await tx.assets.save(scope, published);
    await tx.assets.putPublished(scope, publishedSnapshot(scope, published, now));
    const replaced = before ? (before.version ?? 1) : undefined;
    // Same transaction as the write: delivery renders embed this asset's
    // file/title/description into linking entries, so the invalidation event
    // must be enqueued iff the publish commits.
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset.published',
      scope,
      occurredAt: now.toISOString(),
      assetId: published.id,
      ...(replaced !== undefined && replaced !== (published.version ?? 1)
        ? { replacedVersion: replaced }
        : {}),
    });
    return published;
  });
}

export async function unpublishAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  return ctx.store.withTransaction(async (tx) => {
    const asset = await tx.assets.get(scope, id);
    if (!asset) throw new NotFoundError('Asset', id);
    const updated = unpublishAssetState(asset);
    await tx.assets.save(scope, updated);
    await tx.assets.removePublished(scope, id);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset.unpublished',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      assetId: id,
    });
    return updated;
  });
}

export async function getPublishedAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<PublishedAsset> {
  const snapshot = await ctx.store.assets.getPublished(scope, id);
  if (!snapshot) throw new NotFoundError('PublishedAsset', id);
  return snapshot;
}

export async function listPublishedAssets(
  ctx: AppContext,
  scope: Scope,
  query: PublishedAssetQuery = {},
): Promise<PublishedAssetPage> {
  return ctx.store.assets.listPublished(scope, query);
}

/**
 * The published snapshot of `asset`: what Delivery serves, and what the media origin's URLs are
 * built from (the file version and where its bytes are).
 */
export function publishedSnapshot(scope: Scope, asset: Asset, at: Date): PublishedAsset {
  return {
    assetId: asset.id,
    file: asset.file,
    title: asset.title,
    description: asset.description,
    metadata: asset.metadata,
    publishedAt: at.toISOString(),
    version: asset.version ?? 1,
    ...(asset.file.video ? {} : { r2Key: assetFileKey(scope, asset) }),
    ...(asset.rights ? { rights: asset.rights } : {}),
  };
}

/**
 * Where the bytes of an asset's file (its current one, or a snapshot's) are: its recorded key, or
 * its own key for that version (older rows). A recorded key can come from an imported snapshot,
 * and every read (signed URLs, the media gate, ingest) serves whatever this names, so one that
 * isn't a file key of this asset, or names a version past `version` (an upload not committed, which
 * nobody has reviewed), is ignored. An earlier version's key is allowed: a restore makes that file
 * current again without copying it.
 */
export function assetFileKey(
  scope: Scope,
  asset: {
    readonly id: string;
    readonly r2Key?: string;
    readonly version?: number;
    readonly file: { fileName: string };
  },
): string {
  const version = asset.version ?? 1;
  const recorded = asset.r2Key ? assetKeyVersion(asset.r2Key, asset.id) : null;
  return asset.r2Key && recorded !== null && recorded <= version
    ? asset.r2Key
    : assetObjectKey(scope, asset.id, asset.file.fileName, version);
}

/** Whether `key` has the shape {@link assetObjectKey} gives asset `assetId`, in any environment
 *  (an imported asset keeps its source's), outside the bucket's shared prefixes
 *  (`RESERVED_SPACE_IDS`, which no space can take). */
function isAssetObjectKey(key: string, assetId: string): boolean {
  return assetKeyVersion(key, assetId) !== null;
}

/**
 * The file version an asset file key holds (four segments: 1; `…/v<n>/file/<name>`: n, never 1),
 * or `null` when `key` is no file key of asset `assetId`: another asset's, a file derived from a
 * version (`…/v<n>/text.md`), anything under the bucket's shared prefixes, or a path with an empty,
 * `.` or `..` segment.
 */
export function assetKeyVersion(key: string, assetId: string): number | null {
  const parts = key.split('/');
  if (parts[2] !== assetId || !isAssetFileKey(key)) return null;
  return parts.length === 4 ? 1 : Number((parts[3] ?? '').slice(1));
}

/** Whether `key` has the shape of an asset file key ({@link assetObjectKey}), for any asset. */
export function isAssetFileKey(key: string): boolean {
  const parts = key.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (isReservedSpaceId(parts[0] ?? '')) return false;
  if (parts.length === 4) return true;
  // A version past the first, in its canonical spelling only (no `v01`, no `v1`): one file, one key.
  return (
    parts.length === 6 &&
    /^v[1-9][0-9]{0,8}$/.test(parts[3] ?? '') &&
    parts[3] !== 'v1' &&
    (parts[4] === 'file' ||
      ((parts[4] ?? '').startsWith('file-') && ATTEMPT.test((parts[4] ?? '').slice(5))))
  );
}

/**
 * The asset an object key belongs to, read from its shape: an asset file key ({@link
 * assetObjectKey}, any version) outside the bucket's shared namespaces, or `null` for anything else
 * (a derived file such as extracted text, a version body, a staged job). For an R2 notification,
 * which names only a key.
 */
export function parseAssetObjectKey(key: string): { scope: Scope; assetId: string } | null {
  const [spaceId, environmentId, assetId] = key.split('/');
  if (!spaceId || !environmentId || !assetId) return null;
  if (!isAssetObjectKey(key, assetId)) return null;
  return { scope: { spaceId, environmentId }, assetId };
}

/**
 * Where files derived from an asset's version live (its extracted text): `space/environment/
 * assetId/v<n>/`, under the asset's own prefix in its own environment, so they go with the asset
 * and the environment. Five segments deep, so never an asset file key (four), which is all the
 * media origin and the signed reads serve. `null` when the scope names a namespace the bucket
 * shares with other data, where nothing of the asset's may be written.
 */
export function assetDerivedPrefix(scope: Scope, assetId: string, version: number): string | null {
  const parts = [scope.spaceId, scope.environmentId, assetId];
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('/'))) return null;
  if (isReservedSpaceId(scope.spaceId)) return null;
  return `${parts.join('/')}/v${version}/`;
}

/** The extracted text of an asset's version (Markdown), or `null` where none may be kept. */
export function assetTextKey(scope: Scope, assetId: string, version: number): string | null {
  const prefix = assetDerivedPrefix(scope, assetId, version);
  return prefix ? `${prefix}text.md` : null;
}

/** How long a URL handed out by a Management or Preview read works (15 minutes, at least). */
export const READ_URL_TTL_SECONDS = 900;

/**
 * The asset with a short-lived signed read URL in place of the stored, non-expiring one, which
 * reads never hand out. A hosted video keeps its playback URL. `origin` points the URL at another
 * host that verifies the signature (Preview's media origin).
 */
export async function withReadUrl(
  blob: BlobStore,
  scope: Scope,
  asset: Asset,
  opts: { readonly origin?: string } = {},
): Promise<Asset> {
  if (asset.file.video) return asset;
  const url = await blob.getDownloadUrl(assetFileKey(scope, asset), {
    expiresInSeconds: READ_URL_TTL_SECONDS,
    ...(opts.origin ? { origin: opts.origin } : {}),
  });
  return { ...asset, file: { ...asset.file, url } };
}

/** A metadata patch — any subset of the editable "Aspects" of an asset. */
export type AssetMetadataPatch = Partial<AssetMetadata>;

/**
 * Updates an asset's editorial metadata (alt text, focal point, tags, custom
 * fields), validating the focal point in the domain. Re-publishing carries the
 * new metadata into the delivered snapshot; this only touches the draft.
 */
export async function setAssetMetadata(
  ctx: AppContext,
  scope: Scope,
  id: string,
  patch: AssetMetadataPatch,
): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  const { aiSuggestions: _previous, ...applied } = applyAssetMetadata(asset, patch);
  // What a person's save changed is theirs: those locales and tags stop being AI suggestions.
  const aiSuggestions = clearAcceptedSuggestions(asset.aiSuggestions, asset.metadata, patch);
  const updated: Asset = { ...applied, ...(aiSuggestions ? { aiSuggestions } : {}) };
  await ctx.store.assets.save(scope, updated);
  return updated;
}

/**
 * Lists the entries that reference an asset — its usage across the space. Reuses
 * the reverse-reference index that already tracks entry→asset links.
 */
export async function getAssetUsage(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ReferenceEdge[]> {
  return ctx.store.references.findReverse(scope, id);
}

/**
 * Every link that refuses an asset's deletion: {@link getAssetUsage}'s published ones, plus those
 * in any entry's current version, which the reference graph doesn't hold. A draft, an unpublished
 * entry or one in the trash needs the file as much as a live page does, and its bytes can't be
 * brought back. Draft links past {@link MAX_ASSET_USAGE_SHOWN} aren't counted.
 */
async function linksKeepingAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ReferenceEdge[]> {
  const [published, mentioning] = await Promise.all([
    getAssetUsage(ctx, scope, id),
    ctx.store.entries.idsMentioning(scope, id, MAX_ASSET_USAGE_SHOWN),
  ]);
  if (mentioning.length === 0) return published;
  const [entries, contentTypes] = await Promise.all([
    ctx.store.entries.getMany(scope, mentioning),
    ctx.store.contentTypes.list(scope),
  ]);
  const types = new Map(contentTypes.map((t) => [t.apiId, t]));
  const key = (edge: ReferenceEdge) => `${edge.fromEntryId}::${edge.fromField}`;
  const links = new Map(published.map((edge) => [key(edge), edge]));
  for (const { entry, fields } of entries) {
    const type = types.get(entry.contentTypeApiId);
    if (!type) continue;
    for (const edge of extractReferences(entry.id, fields, type)) {
      if (edge.toId === id) links.set(key(edge), edge);
    }
  }
  return [...links.values()];
}

/**
 * Archives an asset: it stops being delivered at once (the published snapshot goes, in the same
 * unit as the `asset.unpublished` event that purges delivery caches) and can't be published until
 * restored. Archiving an archived asset changes nothing, so a retried request is harmless.
 *
 * The snapshot is removed and the event sent whatever status the read saw: the unit's read is not
 * a lock, so a publish that commits between it and this commit would otherwise leave an archived
 * asset delivered. For an asset that was never published both are no-ops downstream.
 */
export async function archiveAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  return ctx.store.withTransaction(async (tx) => {
    const asset = await tx.assets.get(scope, id);
    if (!asset) throw new NotFoundError('Asset', id);
    if (asset.status === 'archived') return asset;
    const archived = archiveAssetState(asset, ctx.clock.now().toISOString());
    await tx.assets.save(scope, archived);
    await tx.assets.removePublished(scope, id);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'asset.unpublished',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      assetId: id,
    });
    return archived;
  });
}

/**
 * Restores an archived asset as a draft. Republishing is a separate, deliberate step, as for the
 * entry trash. Restoring one that isn't archived changes nothing.
 */
export async function restoreAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  if (asset.status !== 'archived') return asset;
  const restored = restoreAssetState(asset);
  await ctx.store.assets.save(scope, restored);
  return restored;
}

/**
 * Deletes an archived asset for good. Its bytes can't be brought back, so archiving comes first:
 * that is the step `restoreAsset` undoes, and anything else is refused. Refused too with
 * {@link AssetInUseError} while any entry links to it (remove the links first); the store
 * re-checks at commit, so a published link made in between refuses it as well.
 *
 * The row, its published snapshot, its versions and its collection memberships go in one unit with
 * an `asset.deleted` event (and an `asset_collection.changed` per collection it was in);
 * the engine removes the bytes (blob storage, and the video host for a hosted video) when it
 * handles the event, so a failed removal is retried rather than lost. A published asset also
 * emits `asset.unpublished`, as it leaves Delivery.
 */
export async function deleteAsset(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await removeAsset(ctx, scope, id, (asset) => {
    if (asset.status !== 'archived') {
      throw new InvalidStateError('Archive the asset before deleting it');
    }
  });
}

/**
 * Removes a draft whose upload never landed, which has no bytes to lose and so no reason to be
 * archived first: the abandoned-upload sweep and an aborted upload. Refused like any delete while
 * an entry links to it.
 */
export async function deleteAbandonedAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<void> {
  await removeAsset(ctx, scope, id);
}

async function removeAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
  check?: (asset: Asset) => void,
): Promise<void> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  const usage = await linksKeepingAsset(ctx, scope, id);
  if (usage.length > 0) throw await assetInUse(ctx, scope, id, usage);
  check?.(asset);
  const now = ctx.clock.now().toISOString();
  const videoId = asset.file.video?.videoId;
  const [twins, collections] = await Promise.all([
    duplicatesOf(ctx, scope, asset),
    ctx.store.assetCollections.collectionsOf(scope, id, MAX_COLLECTIONS_ANNOUNCED),
  ]);
  try {
    await ctx.store.withTransaction(async (tx) => {
      // Its memberships go with the row (the store deletes them in the same batch); each
      // collection it leaves is announced, so what lists the collection is purged.
      await tx.assets.delete(scope, id);
      for (const collectionId of collections) {
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'asset_collection.changed',
          scope,
          occurredAt: now,
          collectionId,
        });
      }
      // Copies that named this asset as their original now name the oldest one left (which
      // becomes the original itself), never an asset that is gone.
      const [heir] = twins;
      for (const twin of twins) {
        await tx.assets.recordIngest(scope, twin.id, twin.version ?? 1, {
          duplicateOf: twin.id === heir?.id ? null : (heir?.id ?? null),
        });
      }
      if (asset.status === 'published') {
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'asset.unpublished',
          scope,
          occurredAt: now,
          assetId: id,
        });
      }
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset.deleted',
        scope,
        occurredAt: now,
        assetId: id,
        ...(videoId ? { videoId } : { r2Key: assetFileKey(scope, asset) }),
      });
    });
  } catch (err) {
    // A link was made after the check: report it like the check would have.
    if (err instanceof TransactionConflictError) {
      throw await assetInUse(ctx, scope, id, await linksKeepingAsset(ctx, scope, id));
    }
    throw err;
  }
}

/**
 * Most collections a deleted asset announces leaving. Past it, a share page of another collection
 * that held it lists it until the page's own max-age runs out (its file already 404s).
 */
const MAX_COLLECTIONS_ANNOUNCED = 100;

/** Most copies of one file re-pointed when their original is deleted. */
const MAX_DUPLICATES_REPOINTED = 50;

/** The assets that name `asset` as the original of their bytes, oldest first. */
async function duplicatesOf(ctx: AppContext, scope: Scope, asset: Asset): Promise<Asset[]> {
  if (!asset.contentHash) return [];
  const page = await ctx.store.assets.list(scope, {
    limit: MAX_DUPLICATES_REPOINTED,
    filters: { contentHash: asset.contentHash, status: 'all' },
    sort: { field: 'createdAt', direction: 'asc' },
  });
  return page.items.filter((a) => a.id !== asset.id && a.duplicateOf === asset.id);
}

/**
 * The refusal for an asset still linked from entries, each link named the way a person recognises
 * it (content type and display title in the default locale), so a client shows the list without a
 * read per entry. Only the links the error carries are looked up.
 */
async function assetInUse(
  ctx: AppContext,
  scope: Scope,
  id: string,
  edges: readonly ReferenceEdge[],
): Promise<AssetInUseError> {
  const shown = edges.slice(0, MAX_ASSET_USAGE_SHOWN);
  const [entries, types, config] = await Promise.all([
    ctx.store.entries.getMany(scope, [...new Set(shown.map((e) => e.fromEntryId))]),
    ctx.store.contentTypes.list(scope),
    ctx.store.spaces.getConfig(scope),
  ]);
  const byId = new Map(entries.map((e) => [e.entry.id, e]));
  const displayField = new Map(types.map((t) => [t.apiId, t.displayField]));
  const usage = shown.map((edge): AssetUsage => {
    const found = byId.get(edge.fromEntryId);
    if (!found) return edge;
    const field = displayField.get(found.entry.contentTypeApiId);
    const value = field ? found.fields[field]?.[config?.defaultLocale ?? ''] : undefined;
    return {
      ...edge,
      contentTypeApiId: found.entry.contentTypeApiId,
      ...(typeof value === 'string' && value ? { entryTitle: value } : {}),
    };
  });
  return new AssetInUseError(id, usage, edges.length);
}

/**
 * How long a draft waits for its upload before the sweep removes it: a day, far past the upload
 * URL's life (15 minutes), so no PUT through it can still land.
 */
export const ABANDONED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Most candidates one sweep looks at (each costs a blob `head` and, if gone, one unit). */
export const ABANDONED_UPLOAD_SWEEP_LIMIT = 50;
/** What an asset linked from an entry, whose upload never landed, says instead of going. */
export const UPLOAD_NEVER_COMPLETED = 'The upload never completed';

export interface AbandonedUploadSweep {
  /** Drafts with no bytes, deleted (their `asset.deleted` removes whatever is under the key). */
  readonly removed: number;
  /** Bytes that did land, whose notice was lost: their size is recorded, for ingest to pick up. */
  readonly landed: number;
  /** Drafts with no bytes that an entry links to: marked as failed uploads, not deleted. */
  readonly linked: number;
  /** Candidates a store or blob error left for the next sweep. */
  readonly failed: number;
}

/**
 * Cleans up after presigned uploads that never completed: drafts created more than
 * {@link ABANDONED_UPLOAD_TTL_MS} ago that ingest never saw, across every space and environment,
 * oldest first, at most `limit`. Each one leaves the candidate set whatever happens to it, so a
 * sweep never chews on the same rows twice:
 *
 * - bytes under its key (the upload landed, but R2's notification and the api's notice were both
 *   lost, or the file predates ingest): its size is recorded, and the reindex job ingests it;
 * - no bytes, linked from an entry: it stays, its ingest marked `error` so the library shows why
 *   (deleting it would break the link);
 * - no bytes, unlinked: {@link deleteAbandonedAsset}, whose `asset.deleted` event removes anything under the
 *   asset's prefix in the engine (retried there, not here).
 *
 * A store without `head` can't tell the first case from the others, so nothing is swept.
 * Rerunning is harmless: a removed draft is gone, the others no longer match.
 */
export async function sweepAbandonedUploads(
  ctx: AppContext,
  blob: BlobStore,
  opts: { readonly ttlMs?: number; readonly limit?: number } = {},
): Promise<AbandonedUploadSweep> {
  const counts = { removed: 0, landed: 0, linked: 0, failed: 0 };
  if (!blob.head) return counts;
  const before = new Date(ctx.clock.now().getTime() - (opts.ttlMs ?? ABANDONED_UPLOAD_TTL_MS));
  const candidates = await ctx.store.assets.listAwaitingUpload(
    before,
    opts.limit ?? ABANDONED_UPLOAD_SWEEP_LIMIT,
  );
  for (const { scope, asset } of candidates) {
    if (asset.file.video) continue;
    const version = asset.version ?? 1;
    const neverCompleted = () =>
      ctx.store.assets.recordIngest(scope, asset.id, version, {
        status: 'error',
        error: UPLOAD_NEVER_COMPLETED,
        onlyFrom: [null],
      });
    try {
      const object = await blob.head(assetFileKey(scope, asset));
      if (object) {
        await ctx.store.assets.recordIngest(scope, asset.id, version, { size: object.size });
        counts.landed += 1;
        continue;
      }
      if ((await getAssetUsage(ctx, scope, asset.id)).length > 0) {
        await neverCompleted();
        counts.linked += 1;
        continue;
      }
      await deleteAbandonedAsset(ctx, scope, asset.id);
      counts.removed += 1;
    } catch (err) {
      if (err instanceof NotFoundError) continue; // deleted meanwhile
      if (err instanceof AssetInUseError) {
        // Linked after the check: the store refused the delete at commit.
        await neverCompleted();
        counts.linked += 1;
        continue;
      }
      // Left for the next sweep; the engine logs the count.
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * Every environment of the deployment but `scope`'s. A clone keeps its source's asset ids and file
 * keys, even in another space, so whether a file is still in use is a deployment-wide question.
 */
export async function otherEnvironments(ctx: AppContext, scope: Scope): Promise<Scope[]> {
  const others: Scope[] = [];
  for (const { spaceId } of await ctx.store.spaces.list()) {
    for (const env of await ctx.store.spaces.listEnvironments(spaceId)) {
      if (spaceId === scope.spaceId && env.id === scope.environmentId) continue;
      others.push({ spaceId, environmentId: env.id });
    }
  }
  return others;
}

/**
 * Removes a deleted asset's bytes (the engine runs it for `asset.deleted`). Everything under the
 * asset's key prefix goes, so older versions' files go with the current one; but nothing goes
 * while another environment, in any space, still has an asset with this id, because an environment
 * import keeps asset ids and a clone shares their files, across spaces too. Idempotent: a
 * redelivered event finds nothing.
 */
export async function deleteAssetFiles(
  ctx: AppContext,
  deps: { readonly blob?: BlobStore; readonly search?: AssetSearchDeps },
  event: {
    readonly scope: Scope;
    readonly assetId: string;
    readonly r2Key?: string;
    readonly videoId?: string;
  },
): Promise<void> {
  const { scope, assetId } = event;
  // What ingest derived belongs to this environment's asset alone (another environment's copy
  // has its own), so it goes whatever the other environments hold: its search document, its
  // vector, and its extracted text (`space/environment/assetId/v<n>/…`, five segments deep).
  await removeAssetFromSearch(deps.search, scope, assetId);
  const derived = assetDerivedPrefix(scope, assetId, 0);
  const ownPrefix = derived ? derived.slice(0, -'v0/'.length) : null;
  if (ownPrefix && deps.blob?.deletePrefix) {
    // Every version's files stay for now (another environment may share them); what was derived
    // from them goes.
    await deps.blob.deletePrefix(ownPrefix, isAssetFileKey);
  }
  for (const other of await otherEnvironments(ctx, scope)) {
    if (await ctx.store.assets.get(other, assetId)) return;
  }
  if (event.videoId) await ctx.video?.delete(event.videoId);
  if (event.r2Key && deps.blob) {
    // `space/environment/assetId/…`: the prefix of the environment the bytes were uploaded in,
    // which for an imported asset is its source's. The key can come from an imported snapshot, so
    // it is checked rather than trusted: this space, this asset, and never a prefix the bucket
    // shares with other data. A forged key under `versions/` would otherwise reach other spaces'
    // archived version bodies (`versions/space/environment/entryId/…`).
    if (!isAssetObjectKey(event.r2Key, assetId)) return;
    const [space, environment] = event.r2Key.split('/');
    if (space !== scope.spaceId) return;
    if (deps.blob.deletePrefix) {
      // Every version's files: those uploaded where the current one was, and (for an imported
      // asset whose file was replaced here) those uploaded in this environment.
      await deps.blob.deletePrefix(`${space}/${environment}/${assetId}/`, () => false);
      if (ownPrefix && ownPrefix !== `${space}/${environment}/${assetId}/`) {
        await deps.blob.deletePrefix(ownPrefix, () => false);
      }
    } else {
      await deps.blob.delete(event.r2Key);
    }
  }
}

/** Most assets one move takes. The ids ride as one JSON parameter, so this bounds the request,
 *  not D1's parameter cap. */
export const MAX_ASSET_MOVE = 500;

/**
 * Files assets in a folder (`folderId: null` takes them out to the root). One statement whatever
 * the count; ids that aren't assets here are skipped. A folder deleted meanwhile refuses the move.
 */
export async function moveAssets(
  ctx: AppContext,
  scope: Scope,
  input: { readonly ids: readonly string[]; readonly folderId: string | null },
): Promise<{ readonly moved: number }> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0 || ids.length > MAX_ASSET_MOVE) {
    throw new ValidationError([
      { field: 'ids', message: `Move between 1 and ${MAX_ASSET_MOVE} assets at a time` },
    ]);
  }
  if (input.folderId !== null) await getAssetFolderOrThrow(ctx, scope, input.folderId);
  const found = await ctx.store.assets.getMany(scope, ids);
  try {
    await ctx.store.withTransaction((tx) => tx.assets.moveToFolder(scope, ids, input.folderId));
  } catch (err) {
    if (err instanceof TransactionConflictError && input.folderId !== null) {
      throw new NotFoundError('AssetFolder', input.folderId);
    }
    throw err;
  }
  return { moved: found.length };
}

async function getAssetFolderOrThrow(ctx: AppContext, scope: Scope, id: string) {
  const folder = await ctx.store.assetFolders.get(scope, id);
  if (!folder) throw new NotFoundError('AssetFolder', id);
  return folder;
}

// ---- versions -------------------------------------------------------------------------------

/** What the client sends back to commit a replacement it uploaded (`replaceAssetFile` gave it). */
export interface CommitAssetFileInput {
  readonly version: number;
  readonly fileName: string;
  readonly contentType: string;
  /** The replace start's id, in the upload's key (absent: a start made before attempts). */
  readonly attempt?: string;
}

export interface AssetFileReplacement {
  readonly asset: Asset;
  /** Presigned upload target for the new file — the client PUTs the bytes here directly. */
  readonly upload: { url: string; headers: Record<string, string> };
  /** Pass back to `commitAssetFile` once the bytes are uploaded. */
  readonly commit: CommitAssetFileInput;
}

/** A replacement's target, before anything is written: checked as a new upload is. */
export interface PreparedReplacement {
  readonly asset: Asset;
  readonly key: string;
  readonly commit: CommitAssetFileInput;
}

/**
 * Checks a replacement and names the next version's key for this attempt
 * (`…/v<n+1>/file-<attempt>/<name>`, {@link assetObjectKey}): the asset is no hosted video, and the
 * `asset:beforeCreate` hooks pass the file (a replacement is a new upload). Shared by the single
 * signed PUT ({@link replaceAssetFile}) and a multipart replacement; not a use-case of its own.
 */
export async function prepareReplacement(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: { readonly fileName: string; readonly contentType: string },
): Promise<PreparedReplacement> {
  const asset = await getAsset(ctx, scope, id);
  assertNotHostedVideo(asset);
  // The same policy as a new upload's (allowed types, names): a replacement is one too.
  const checked = await runHook(ctx, 'asset:beforeCreate', scope, {
    fileName: input.fileName,
    contentType: input.contentType,
  });
  const version = (asset.version ?? 1) + 1;
  const attempt = ctx.ids.newId();
  return {
    asset,
    key: assetObjectKey(scope, id, checked.fileName, version, attempt),
    commit: { version, fileName: checked.fileName, contentType: checked.contentType, attempt },
  };
}

/**
 * Starts replacing an asset's file: returns a presigned upload for the next version's key, this
 * attempt's own (`…/v<n+1>/file-<attempt>/<name>`). Nothing changes until the upload is committed
 * ({@link commitAssetFile}); an upload never committed is never served (the media origin and the
 * signed reads serve only a committed version's key) and goes with the asset. Replaces started
 * side by side each upload to their own key, and the first to commit wins (the others' commits are
 * a `ConflictError`). A hosted video is replaced through its video host, not here. Past one signed
 * PUT (100 MiB), replace in parts ({@link startMultipartAssetFileReplacement}).
 */
export async function replaceAssetFile(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  id: string,
  input: { readonly fileName: string; readonly contentType: string },
): Promise<AssetFileReplacement> {
  const { asset, key, commit } = await prepareReplacement(ctx, scope, id, input);
  const upload = await blob.getUploadUrl(key, commit.contentType);
  return { asset, upload, commit };
}

/**
 * Makes an uploaded replacement the asset's file, in one unit: the version goes up, the file it
 * had is kept in its history, and `asset.file_replaced` is appended (the engine starts ingest on
 * the new file). The bytes must be in storage. A published asset keeps delivering the file it was
 * published with until it is published again. Committing what is already committed returns the
 * asset as it is; a replace or restore that committed first is a `ConflictError`.
 */
export async function commitAssetFile(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  id: string,
  input: CommitAssetFileInput,
  opts: { readonly by?: string } = {},
): Promise<Asset> {
  const asset = await getAsset(ctx, scope, id);
  assertNotHostedVideo(asset);
  // The name must be the one the upload was signed for, as it stands: the key keeps only a name's
  // last segment, so `x/<name>` would find the same bytes and store a name the space's
  // asset:beforeCreate policy never saw.
  if (input.fileName !== safeObjectName(input.fileName)) {
    throw new ValidationError([
      { field: 'fileName', message: 'Send the fileName from the replace’s commit object' },
    ]);
  }
  if (input.attempt !== undefined && !ATTEMPT.test(input.attempt)) {
    throw new ValidationError([
      { field: 'attempt', message: 'Send the attempt from the replace’s commit object' },
    ]);
  }
  const current = asset.version ?? 1;
  const key = assetObjectKey(scope, id, input.fileName, input.version, input.attempt);
  // A retried commit (the response was lost) finds its own work done: its own key, not another
  // attempt's at the same version.
  if (input.version === current && assetFileKey(scope, asset) === key) return asset;
  return commitStoredReplacement(ctx, blob, scope, asset, input, opts);
}

/**
 * Commits the bytes stored at the key `input` names as the asset's next version (the unit
 * {@link commitAssetFile} and a completed multipart replacement share; not a use-case of its own:
 * `asset` must be the one its caller just read). `inUnit` adds writes to the same unit (the
 * multipart upload's row, forgotten as its file becomes current).
 */
export async function commitStoredReplacement(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  asset: Asset,
  input: CommitAssetFileInput,
  opts: {
    readonly by?: string;
    readonly inUnit?: (tx: ContentStoreTx) => Promise<void>;
  } = {},
): Promise<Asset> {
  const current = asset.version ?? 1;
  if (input.version !== current + 1) throw replacedMeanwhile(asset.id, current);
  if (!blob.head) {
    throw new ValidationError([
      {
        field: 'version',
        message: 'This storage cannot confirm uploads; files cannot be replaced',
      },
    ]);
  }
  const key = assetObjectKey(scope, asset.id, input.fileName, input.version, input.attempt);
  const stored = await blob.head(key);
  if (!stored) {
    throw new ValidationError([
      {
        field: 'version',
        message: `No file has been uploaded for version ${input.version}; PUT it to the upload URL first`,
      },
    ]);
  }
  const next: Asset = {
    ...withoutIngest(asset),
    version: input.version,
    r2Key: key,
    file: {
      url: await blob.getDownloadUrl(key),
      fileName: input.fileName,
      contentType: stored.contentType ?? input.contentType,
      size: stored.size,
    },
  };
  return commitReplacement(ctx, scope, asset, next, {
    ...(stored.etag ? { etag: stored.etag } : {}),
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.inUnit ? { inUnit: opts.inUnit } : {}),
  });
}

/**
 * Makes an earlier version's file current again, as a new version that points at the same bytes
 * (nothing is copied): the history stays a straight line, and the URLs of the version being
 * restored are never reused. What ingest found about that file (its hash) comes with it; ingest
 * runs on the new version for the rest. Restoring the current version is refused.
 */
export async function restoreAssetVersion(
  ctx: AppContext,
  blob: BlobStore | undefined,
  scope: Scope,
  id: string,
  version: number,
  opts: { readonly by?: string } = {},
): Promise<Asset> {
  const asset = await getAsset(ctx, scope, id);
  assertNotHostedVideo(asset);
  const current = asset.version ?? 1;
  if (version === current) {
    throw new ValidationError([
      { field: 'version', message: `Version ${version} is already the current file` },
    ]);
  }
  const old = await ctx.store.assets.getVersion(scope, id, version);
  if (!old) throw new NotFoundError('AssetVersion', `${id}@v${version}`);
  const key = assetFileKey(scope, { id, file: old.file, version, ...optionalKey(old.r2Key) });
  const stored = blob?.head ? await blob.head(key) : undefined;
  if (stored === null) {
    throw new ValidationError([
      { field: 'version', message: `Version ${version}'s file is no longer in storage` },
    ]);
  }
  const next: Asset = {
    ...withoutIngest(asset),
    version: current + 1,
    r2Key: key,
    file: old.file,
    ...(old.contentHash ? { contentHash: old.contentHash } : {}),
  };
  return commitReplacement(ctx, scope, asset, next, {
    restoredFrom: version,
    ...(stored?.etag ? { etag: stored.etag } : {}),
    ...(opts.by ? { by: opts.by } : {}),
  });
}

/** The replace or restore unit: history row, the new current file, and the event. */
async function commitReplacement(
  ctx: AppContext,
  scope: Scope,
  asset: Asset,
  next: Asset,
  opts: {
    readonly etag?: string;
    readonly restoredFrom?: number;
    readonly by?: string;
    readonly inUnit?: (tx: ContentStoreTx) => Promise<void>;
  },
): Promise<Asset> {
  const now = ctx.clock.now().toISOString();
  const previous: AssetVersionRecord = {
    version: asset.version ?? 1,
    file: asset.file,
    ...(asset.file.video ? {} : { r2Key: assetFileKey(scope, asset) }),
    ...(asset.contentHash ? { contentHash: asset.contentHash } : {}),
    replacedAt: now,
    ...(opts.by ? { replacedBy: opts.by } : {}),
  };
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.assets.replaceFile(scope, next, previous);
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset.file_replaced',
        scope,
        occurredAt: now,
        assetId: asset.id,
        version: next.version ?? 1,
        previousVersion: previous.version,
        r2Key: next.r2Key ?? assetFileKey(scope, next),
        ...(opts.etag ? { etag: opts.etag } : {}),
        ...(opts.restoredFrom !== undefined ? { restoredFrom: opts.restoredFrom } : {}),
      });
      await opts.inUnit?.(tx);
    });
  } catch (err) {
    if (err instanceof TransactionConflictError) {
      const now = await ctx.store.assets.get(scope, asset.id);
      throw replacedMeanwhile(asset.id, now?.version ?? previous.version);
    }
    throw err;
  }
  return next;
}

const replacedMeanwhile = (id: string, version: number) =>
  new ConflictError(
    `Asset "${id}"'s file was replaced meanwhile (it is on version ${version} now); replace it again`,
    { version },
  );

function assertNotHostedVideo(asset: Asset): void {
  if (asset.file.video) {
    throw new ValidationError([
      {
        field: 'id',
        message: "A hosted video's file is kept by its video host, not replaced here",
      },
    ]);
  }
}

/** The asset without what ingest found about its file (none of it holds for another file). */
function withoutIngest(asset: Asset): Asset {
  const {
    contentHash: _hash,
    ingestStatus: _status,
    ingestError: _error,
    duplicateOf: _duplicate,
    ...rest
  } = asset;
  return rest;
}

const optionalKey = (r2Key: string | undefined) => (r2Key ? { r2Key } : {});

/**
 * Every file the asset has had, newest first: the current one, and each earlier one with when it
 * became the asset's and who made it so. `published` marks the one Delivery serves. With `blob`,
 * each carries a short-lived signed read URL, never a stored one.
 */
export async function listAssetVersions(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: { readonly blob?: BlobStore } = {},
): Promise<AssetVersion[]> {
  const [asset, earlier, published] = await Promise.all([
    ctx.store.assets.get(scope, id),
    ctx.store.assets.listVersions(scope, id),
    ctx.store.assets.getPublished(scope, id),
  ]);
  if (!asset) throw new NotFoundError('Asset', id);
  const current = asset.version ?? 1;
  const all = [
    {
      version: current,
      file: asset.file,
      ...(asset.file.video ? {} : { r2Key: assetFileKey(scope, asset) }),
      ...(asset.contentHash ? { contentHash: asset.contentHash } : {}),
    },
    ...earlier.map((v) => ({
      version: v.version,
      file: v.file,
      ...(v.file.video ? {} : { r2Key: assetFileKey(scope, { id, ...v }) }),
      ...(v.contentHash ? { contentHash: v.contentHash } : {}),
    })),
  ];
  // Version k became the asset's file when version k-1 was replaced; the first, when it was made.
  const replaced = new Map(earlier.map((v) => [v.version, v]));
  const items = all.map((v): AssetVersion => {
    const madeBy = replaced.get(v.version - 1);
    const createdAt = v.version === 1 ? asset.createdAt : madeBy?.replacedAt;
    const createdBy = v.version === 1 ? asset.createdBy : madeBy?.replacedBy;
    // A restore points at the bytes of the version it brought back: the earliest with its key.
    const origin = all
      .filter((o) => o.version < v.version && o.r2Key && o.r2Key === v.r2Key)
      .sort((a, b) => a.version - b.version)[0];
    return {
      ...v,
      ...(createdAt ? { createdAt } : {}),
      ...(createdBy ? { createdBy } : {}),
      current: v.version === current,
      published: published !== null && (published.version ?? 1) === v.version,
      ...(origin ? { restoredFrom: origin.version } : {}),
    };
  });
  const blob = opts.blob;
  if (!blob) return items;
  return Promise.all(
    items.map(async (v) =>
      v.file.video || !v.r2Key
        ? v
        : {
            ...v,
            file: {
              ...v.file,
              url: await blob.getDownloadUrl(v.r2Key, { expiresInSeconds: READ_URL_TTL_SECONDS }),
            },
          },
    ),
  );
}

// ---- rights and expiry ------------------------------------------------------------------------

/**
 * Sets an asset's usage rights (`null` clears them), validated ({@link validateAssetRights}).
 * Rights decide whether the asset may be delivered, so on a published asset they take effect at
 * once, without a republish: the snapshot's credit, license and expiry change in the same unit, and
 * `asset.rights_changed` brings the media gate and the caches in line. An embargo can't be put on
 * an asset that is already delivered (unpublish it first); an expiry already past takes it out of
 * Delivery on the expiry sweep's next run.
 */
export async function setAssetRights(
  ctx: AppContext,
  scope: Scope,
  id: string,
  rights: AssetRights | null,
): Promise<Asset> {
  const validated = rights ? validateAssetRights(rights) : undefined;
  const now = ctx.clock.now();
  return ctx.store.withTransaction(async (tx) => {
    const [asset, published] = await Promise.all([
      tx.assets.get(scope, id),
      tx.assets.getPublished(scope, id),
    ]);
    if (!asset) throw new NotFoundError('Asset', id);
    if (
      published &&
      validated?.embargoUntil &&
      Date.parse(validated.embargoUntil) > now.getTime()
    ) {
      throw new ValidationError([
        {
          field: 'rights.embargoUntil',
          message: 'The asset is already published: unpublish it before putting it under embargo',
        },
      ]);
    }
    const { rights: _old, ...rest } = asset;
    const updated: Asset = validated ? { ...rest, rights: validated } : rest;
    await tx.assets.save(scope, updated);
    if (published) {
      const { rights: _was, ...snapshot } = published;
      await tx.assets.putPublished(
        scope,
        validated ? { ...snapshot, rights: validated } : snapshot,
      );
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset.rights_changed',
        scope,
        occurredAt: now.toISOString(),
        assetId: id,
      });
    }
    return updated;
  });
}

/**
 * Takes a published asset whose rights expired out of Delivery: back to a draft, its snapshot
 * removed, and `asset.unpublished` with `asset.expired` appended, in one unit. Re-checked at commit:
 * an asset republished or given a later expiry meanwhile stays published (`false`), as does one
 * whose snapshot doesn't expire by `at`.
 */
export async function expireAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
  at: Date,
): Promise<boolean> {
  try {
    return await ctx.store.withTransaction(async (tx) => {
      const [asset, snapshot] = await Promise.all([
        tx.assets.get(scope, id),
        tx.assets.getPublished(scope, id),
      ]);
      const expiresAt = snapshot?.rights?.expiresAt;
      if (!snapshot || !expiresAt || !(Date.parse(expiresAt) <= at.getTime())) return false;
      await tx.assets.removeExpiredPublished(scope, id, at);
      if (asset?.status === 'published') await tx.assets.save(scope, { ...asset, status: 'draft' });
      const occurredAt = ctx.clock.now().toISOString();
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset.unpublished',
        scope,
        occurredAt,
        assetId: id,
      });
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset.expired',
        scope,
        occurredAt,
        assetId: id,
        expiresAt,
      });
      return true;
    });
  } catch (err) {
    // Republished, or its expiry moved, after the read: it is no longer due.
    if (err instanceof TransactionConflictError) return false;
    throw err;
  }
}

/** Most expired assets one sweep takes out of Delivery; the rest wait a minute. */
export const ASSET_EXPIRY_BATCH = 100;

export interface AssetExpiryResult {
  readonly expired: number;
  readonly failed: number;
  /** Why each failure failed, for the engine's log. */
  readonly errors: readonly {
    readonly scope: Scope;
    readonly assetId: string;
    readonly error: string;
  }[];
}

/**
 * The expiry sweep (the engine's cron, every minute): every published asset whose rights have
 * expired, across all scopes, is unpublished ({@link expireAsset}). One failure is counted and the
 * rest go on; the failed asset comes back on the next run. Idempotent: an asset already taken out
 * is no longer found.
 */
export async function runDueAssetExpiries(
  ctx: AppContext,
  opts: { readonly limit?: number } = {},
): Promise<AssetExpiryResult> {
  const now = ctx.clock.now();
  const due = await ctx.store.assets.findExpiredPublished(now, opts.limit ?? ASSET_EXPIRY_BATCH);
  let expired = 0;
  const errors: { scope: Scope; assetId: string; error: string }[] = [];
  for (const { scope, assetId } of due) {
    try {
      if (await expireAsset(ctx, scope, assetId, now)) expired += 1;
    } catch (err) {
      errors.push({ scope, assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { expired, failed: errors.length, errors };
}
