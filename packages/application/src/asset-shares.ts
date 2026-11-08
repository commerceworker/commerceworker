import {
  type AssetShareLink,
  type AssetShareTargetType,
  ConflictError,
  isLocaleDelivered,
  type LocalizedValue,
  NotFoundError,
  type Scope,
  type StoredAssetShareLink,
  shareLinkExpiry,
  shareLinkPassword,
  shareLinkState,
  ValidationError,
} from '@commerceworker/domain';
import {
  type ContentStore,
  type PublishedAsset,
  type ShareLinkGateEntry,
  type SpaceConfig,
  TransactionConflictError,
} from '@commerceworker/ports';
import type { AppContext } from './context';

/**
 * Share links: an expiring, revocable link to one asset or a collection for someone without an
 * account. The link opens a read-only page on the media origin listing what the target publishes
 * now, and serves those files. Published only: a draft is never reachable through a link (an
 * unpublished asset can't be shared, and a collection's drafts are left off its page), so a link
 * never exposes more than Delivery already does, only for longer than a signed URL would.
 *
 * Creating and revoking commit with an event (for webhooks; a revocation also purges the link's
 * cached page). The media origin reads the link's row on every request ({@link openShareLink}).
 */

/** Most links one listing returns. */
export const MAX_SHARE_LINKS_LISTED = 200;

/** The URL a link opens: `<media origin>/s/<space>/<env>/<linkId>/<token>`. */
export function shareLinkUrl(
  ctx: Pick<AppContext, 'mediaPublicUrl' | 'mediaPaths'>,
  scope: Scope,
  linkId: string,
): string | undefined {
  if (!ctx.mediaPublicUrl || !ctx.mediaPaths) return undefined;
  const e = encodeURIComponent;
  const token = ctx.mediaPaths.linkToken(scope, linkId);
  return `${ctx.mediaPublicUrl.replace(/\/$/, '')}/s/${e(scope.spaceId)}/${e(scope.environmentId)}/${e(linkId)}/${token}`;
}

/** A stored link as the API shows it: whether it has a password, never the hash. */
function present(
  ctx: Pick<AppContext, 'mediaPublicUrl' | 'mediaPaths'>,
  scope: Scope,
  link: StoredAssetShareLink,
): AssetShareLink {
  const { passwordHash, ...rest } = link;
  const url = shareLinkUrl(ctx, scope, link.id);
  return { ...rest, hasPassword: Boolean(passwordHash), ...(url ? { url } : {}) };
}

export interface CreateShareLinkInput {
  readonly targetType: AssetShareTargetType;
  readonly targetId: string;
  /** ISO 8601, 5 minutes to 90 days from now. */
  readonly expiresAt: string;
  readonly allowDownload?: boolean;
  /** Asked for before the page opens. Hashed (PBKDF2); never stored or returned. */
  readonly password?: string;
}

/**
 * Creates a share link. An asset must be published (a link serves published files only); a
 * collection may hold drafts, which its page leaves off until they are published.
 */
export async function createAssetShareLink(
  ctx: AppContext,
  scope: Scope,
  input: CreateShareLinkInput,
  opts: { readonly createdBy?: string } = {},
): Promise<AssetShareLink> {
  const now = ctx.clock.now();
  const expiresAt = shareLinkExpiry(input.expiresAt, now);
  if (input.targetType === 'asset') {
    const asset = await ctx.store.assets.get(scope, input.targetId);
    if (!asset) throw new NotFoundError('Asset', input.targetId);
    if (asset.status !== 'published') {
      throw new ConflictError('Only a published asset can be shared: publish it first');
    }
  } else if (!(await ctx.store.assetCollections.get(scope, input.targetId))) {
    throw new NotFoundError('AssetCollection', input.targetId);
  }
  let passwordHash: string | undefined;
  if (input.password !== undefined) {
    if (!ctx.passwords) {
      throw new ValidationError([
        { field: 'password', message: 'Password-protected links are not available here' },
      ]);
    }
    passwordHash = await ctx.passwords.hash(shareLinkPassword(input.password));
  }
  const link: StoredAssetShareLink = {
    id: ctx.ids.newId(),
    targetType: input.targetType,
    targetId: input.targetId,
    expiresAt,
    allowDownload: input.allowDownload === true,
    ...(passwordHash ? { passwordHash } : {}),
    createdAt: now.toISOString(),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
  };
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.assetShareLinks.create(scope, link);
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset_share.created',
        scope,
        occurredAt: now.toISOString(),
        linkId: link.id,
      });
    });
  } catch (err) {
    // The target was deleted after the check.
    if (err instanceof TransactionConflictError) {
      throw new NotFoundError(
        input.targetType === 'asset' ? 'Asset' : 'AssetCollection',
        input.targetId,
      );
    }
    throw err;
  }
  return present(ctx, scope, link);
}

/** Links in the scope, newest first: active ones, or every one with `includeInactive`. */
export async function listAssetShareLinks(
  ctx: AppContext,
  scope: Scope,
  query: {
    readonly targetType?: AssetShareTargetType;
    readonly targetId?: string;
    readonly includeInactive?: boolean;
  } = {},
): Promise<AssetShareLink[]> {
  const links = await ctx.store.assetShareLinks.list(scope, {
    ...query,
    now: ctx.clock.now(),
    limit: MAX_SHARE_LINKS_LISTED,
  });
  return links.map((l) => present(ctx, scope, l));
}

export async function getAssetShareLink(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<AssetShareLink> {
  const link = await ctx.store.assetShareLinks.get(scope, id);
  if (!link) throw new NotFoundError('AssetShareLink', id);
  return present(ctx, scope, link);
}

/**
 * Revokes a link: it stops opening as soon as the media origin's replica has the row (it reads the
 * link on every request), and its cached page is purged. Revoking one already revoked changes nothing and sends no event.
 */
export async function revokeAssetShareLink(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<AssetShareLink> {
  const link = await ctx.store.assetShareLinks.get(scope, id);
  if (!link) throw new NotFoundError('AssetShareLink', id);
  if (link.revokedAt) return present(ctx, scope, link);
  const now = ctx.clock.now();
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.assetShareLinks.revoke(scope, id, now);
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'asset_share.revoked',
        scope,
        occurredAt: now.toISOString(),
        linkId: id,
      });
    });
  } catch (err) {
    // Revoked by someone else meanwhile: theirs stands (and sent the event).
    if (!(err instanceof TransactionConflictError)) throw err;
    return present(ctx, scope, (await ctx.store.assetShareLinks.get(scope, id)) ?? link);
  }
  return present(ctx, scope, { ...link, revokedAt: now.toISOString() });
}

/** What the media origin uses of an active link, or `null` for one that opens nothing now. */
export function shareLinkGateEntry(
  link: StoredAssetShareLink,
  nowMs: number,
): ShareLinkGateEntry | null {
  if (shareLinkState(link, nowMs) !== 'active') return null;
  return {
    targetType: link.targetType,
    targetId: link.targetId,
    expiresAt: link.expiresAt,
    allowDownload: link.allowDownload,
    ...(link.passwordHash ? { passwordHash: link.passwordHash } : {}),
  };
}

/**
 * The link a share URL names, as the media origin may use it now: its entry while active, `gone`
 * once expired or revoked (410), or `null` when there is no such link (404). Read from the store
 * (a D1 replica on the media Worker) on every request, so a revocation needs nothing but the row:
 * no cache or engine step stands between a revoke and the link closing.
 */
export async function openShareLink(
  store: Pick<ContentStore, 'assetShareLinks'>,
  scope: Scope,
  linkId: string,
  nowMs: number,
): Promise<ShareLinkGateEntry | 'gone' | null> {
  const link = await store.assetShareLinks.get(scope, linkId);
  if (!link) return null;
  return shareLinkGateEntry(link, nowMs) ?? 'gone';
}

/** Most files a share page lists (a collection's cap). */
export const MAX_SHARED_FILES = 1000;

/** What a share page shows: a title, and the target's published files in order. */
export interface SharedAssets {
  readonly title: string;
  readonly description?: string;
  readonly items: readonly PublishedAsset[];
  /** The space's locales, for {@link sharedText}; null when the space is gone. */
  readonly locales: SpaceConfig | null;
}

type ShareReadStore = Pick<ContentStore, 'assets' | 'assetCollections'>;

/**
 * The one text a share page shows for a localized value (it has no locale to pick by): the
 * default locale's, else the first the space delivers, in the space's order. A locale the space
 * doesn't deliver is never shown, as on Delivery. Without the space's config, the first non-empty.
 */
export function sharedText(
  value: LocalizedValue | undefined,
  locales: Pick<SpaceConfig, 'defaultLocale' | 'locales' | 'localeSettings'> | null,
): string {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '');
  if (!value) return '';
  if (!locales) {
    for (const v of Object.values(value)) if (text(v)) return text(v);
    return '';
  }
  const order = [
    locales.defaultLocale,
    ...locales.locales.filter((l) => l !== locales.defaultLocale),
  ];
  for (const l of order) {
    if (isLocaleDelivered(locales, l) && text(value[l])) return text(value[l]);
  }
  return '';
}

/**
 * The published files a link's target holds now: the asset (if still published) or the
 * collection's published members, in its order. `null` when the target is gone. Read only, for the
 * media origin (through a replica).
 */
export async function sharedAssets(
  store: ShareReadStore & { readonly spaces: Pick<ContentStore['spaces'], 'getConfig'> },
  scope: Scope,
  entry: Pick<ShareLinkGateEntry, 'targetType' | 'targetId'>,
): Promise<SharedAssets | null> {
  if (entry.targetType === 'asset') {
    const [snapshot, locales] = await Promise.all([
      store.assets.getPublished(scope, entry.targetId),
      store.spaces.getConfig(scope),
    ]);
    if (!snapshot) return null;
    return {
      title: sharedText(snapshot.title, locales) || snapshot.file.fileName,
      items: [snapshot],
      locales,
    };
  }
  const [collection, locales] = await Promise.all([
    store.assetCollections.get(scope, entry.targetId),
    store.spaces.getConfig(scope),
  ]);
  if (!collection) return null;
  const items: PublishedAsset[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.assetCollections.listPublishedItems(scope, entry.targetId, {
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = items.length < MAX_SHARED_FILES ? page.nextCursor : undefined;
  } while (cursor);
  return {
    title: collection.name,
    ...(collection.description ? { description: collection.description } : {}),
    items: items.slice(0, MAX_SHARED_FILES),
    locales,
  };
}

/**
 * One file a link serves: the asset's published snapshot, when the asset is the link's target or
 * a member of its collection, and published. `null` otherwise. Read only.
 */
export async function sharedAssetFile(
  store: ShareReadStore,
  scope: Scope,
  entry: Pick<ShareLinkGateEntry, 'targetType' | 'targetId'>,
  assetId: string,
): Promise<PublishedAsset | null> {
  if (entry.targetType === 'asset') {
    return assetId === entry.targetId ? store.assets.getPublished(scope, assetId) : null;
  }
  if (!(await store.assetCollections.hasItem(scope, entry.targetId, assetId))) return null;
  return store.assets.getPublished(scope, assetId);
}
