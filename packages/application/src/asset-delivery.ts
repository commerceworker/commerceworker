import {
  ASSET_WIDTH_LADDER,
  type Asset,
  type AssetRendition,
  type AssetVariant,
  type DeliverableAsset,
  type DeliveredAsset,
  deliveredAsset,
  isTransformableImage,
  type LocaleConfig,
  NotFoundError,
  publicAssetUrls,
  type Scope,
  ValidationError,
  variantForTransform,
  variantSegment,
} from '@commerceworker/domain';
import type {
  AssetFilters,
  BlobStore,
  DeliveryReadResult,
  ImageTransformSpec,
  PublishedAsset,
  PublishedAssetQuery,
  SpaceConfig,
} from '@commerceworker/ports';
import { getPublishedAsset, READ_URL_TTL_SECONDS, withReadUrl } from './assets';
import type { AppContext } from './context';
import {
  assertDeliveredLocale,
  type DeliveryReads,
  deliveryReads,
  previewReads,
} from './delivery-reads';

export interface AssetReadOptions {
  /** Flattens title, description and alt text to this locale (with the space's fallbacks). */
  readonly locale?: string;
  /** The request's reads, when it has some already (see {@link DeliveryReads}). */
  readonly reads?: DeliveryReads;
}

/**
 * What projecting one scope's assets needs, read once per request: the space's renditions and,
 * for a locale-flattened read, its locale settings.
 */
export interface AssetProjectionContext {
  readonly renditions: readonly AssetRendition[];
  readonly locale?: { readonly requested: string; readonly config: LocaleConfig };
  /** Without a locale, on Delivery: the space's config, so all-locale text drops undelivered ones. */
  readonly delivered?: LocaleConfig;
}

export async function assetProjectionContext(
  ctx: AppContext,
  scope: Scope,
  opts: AssetReadOptions = {},
): Promise<AssetProjectionContext> {
  const reads = opts.reads ?? deliveryReads(ctx);
  const { renditions, config } = await reads.read(scope, {
    renditions: true,
    config: opts.locale !== undefined || !reads.everyLocale,
  });
  return projectionContextOf(scope, renditions ?? [], opts.locale, config, reads.everyLocale);
}

/**
 * The projection context from reads already made: the renditions and the space's config (a
 * missing space is a 404, as on every Delivery read). With `locale` the text is flattened to it;
 * without, Delivery's all-locale maps still leave out the locales the space doesn't deliver, so
 * the config is needed either way (Preview, `everyLocale`, needs it only for a locale).
 */
export function projectionContextOf(
  scope: Scope,
  renditions: readonly AssetRendition[],
  locale: string | undefined,
  config: SpaceConfig | null | undefined,
  everyLocale = false,
): AssetProjectionContext {
  if (locale === undefined) {
    if (everyLocale) return { renditions };
    if (!config) throw new NotFoundError('Space', scope.spaceId);
    return { renditions, delivered: localeConfigOf(config) };
  }
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  // Delivery serves no locale the space has turned off; Preview reads them all.
  if (!everyLocale) assertDeliveredLocale(config, locale);
  return {
    renditions,
    locale: { requested: locale, config: localeConfigOf(config) },
  };
}

const localeConfigOf = (config: SpaceConfig): LocaleConfig => ({
  defaultLocale: config.defaultLocale,
  locales: config.locales,
  ...(config.fallbacks ? { fallbacks: config.fallbacks } : {}),
  ...(config.localeSettings ? { localeSettings: config.localeSettings } : {}),
});

const deliverable = (s: PublishedAsset): DeliverableAsset => ({
  id: s.assetId,
  file: s.file,
  title: s.title,
  description: s.description,
  metadata: s.metadata,
  ...(s.rights ? { rights: s.rights } : {}),
});

/**
 * The media origin's URL builder for one published snapshot (its version, and that version's
 * path token), or `undefined` when no media origin is set up.
 */
function mediaUrlsOf(
  ctx: Pick<AppContext, 'mediaPublicUrl' | 'mediaPaths'>,
  scope: Scope,
  snapshot: PublishedAsset,
): ((variant: AssetVariant) => string) | undefined {
  if (!ctx.mediaPublicUrl || !ctx.mediaPaths) return undefined;
  const version = snapshot.version ?? 1;
  return publicAssetUrls(ctx.mediaPublicUrl, scope, {
    id: snapshot.assetId,
    version,
    fileName: snapshot.file.fileName,
    token: ctx.mediaPaths.token(scope, snapshot.assetId, version),
  });
}

/**
 * A published asset as Delivery serves it. Pure over what {@link assetProjectionContext} read:
 * its URLs are on the media origin (`ctx.mediaPublicUrl`), at the published file's version, with
 * that version's path token.
 */
export function projectPublishedAsset(
  ctx: Pick<AppContext, 'mediaPublicUrl' | 'mediaPaths'>,
  scope: Scope,
  snapshot: PublishedAsset,
  pc: AssetProjectionContext,
): DeliveredAsset {
  const urlFor = mediaUrlsOf(ctx, scope, snapshot);
  return deliveredAsset(deliverable(snapshot), {
    ...(urlFor ? { urlFor } : {}),
    renditions: pc.renditions.map((r) => r.name),
    ...(pc.locale ? { locale: pc.locale } : {}),
    ...(pc.delivered ? { delivered: pc.delivered } : {}),
  });
}

/** One published asset, projected (Delivery's `GET /assets/:id`, GraphQL's `asset`). */
export async function getDeliveredAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: AssetReadOptions = {},
): Promise<DeliveredAsset> {
  // The snapshot, the renditions and the locales it needs: one round trip.
  const reads = opts.reads ?? deliveryReads(ctx);
  const r = await reads.read(scope, { assetId: id, renditions: true, ...localeParts(opts, reads) });
  if (!r.asset) throw new NotFoundError('PublishedAsset', id);
  return projectPublishedAsset(ctx, scope, r.asset, ownContextOf(scope, r, opts, reads));
}

/**
 * What a single-asset or asset-page read asks for to project its text: with `?locale=`, the space
 * config (to flatten and to refuse an undelivered locale); without, on Delivery, only the per-locale
 * settings, which ride the asset statement itself (`assetLocales`) instead of costing one more.
 */
const localeParts = (opts: AssetReadOptions, reads: DeliveryReads) =>
  opts.locale !== undefined ? { config: true } : reads.everyLocale ? {} : { assetLocales: true };

function ownContextOf(
  scope: Scope,
  r: DeliveryReadResult,
  opts: AssetReadOptions,
  reads: DeliveryReads,
): AssetProjectionContext {
  const renditions = r.renditions ?? [];
  if (opts.locale !== undefined || reads.everyLocale) {
    return projectionContextOf(scope, renditions, opts.locale, r.config, reads.everyLocale);
  }
  const settings = r.assetLocales;
  if (!settings || Object.keys(settings).length === 0) return { renditions };
  // The settings alone decide: the default locale is never turned off (`assertLocaleSettings`), so
  // a locale is undelivered exactly when its settings say `delivered: false`.
  return { renditions, delivered: { defaultLocale: '', locales: [], localeSettings: settings } };
}

export interface DeliveredAssetPage {
  readonly items: DeliveredAsset[];
  readonly nextCursor?: string;
}

/** A page of published assets, projected (Delivery's `GET /assets`). */
export async function listDeliveredAssets(
  ctx: AppContext,
  scope: Scope,
  query: PublishedAssetQuery = {},
  opts: AssetReadOptions = {},
): Promise<DeliveredAssetPage> {
  // The page, the renditions and the locales it needs: one round trip.
  const reads = opts.reads ?? deliveryReads(ctx);
  const r = await reads.read(scope, {
    assetPage: query,
    renditions: true,
    ...localeParts(opts, reads),
  });
  const page = r.assetPage ?? { items: [] };
  const pc = ownContextOf(scope, r, opts, reads);
  return {
    items: page.items.map((s) => projectPublishedAsset(ctx, scope, s, pc)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * Where the deprecated `GET /assets/:id/transform` sends a reader: the ladder step for `?w=`,
 * the named rendition, or the original, on the media origin. Only an image the service can
 * resize has variants; an unknown rendition is a 404, like its URL.
 */
export async function assetTransformTarget(
  ctx: AppContext,
  scope: Scope,
  id: string,
  q: { readonly width?: number; readonly rendition?: string },
): Promise<string> {
  const snapshot = await getPublishedAsset(ctx, scope, id);
  const urlFor = mediaUrlsOf(ctx, scope, snapshot);
  if (!urlFor) throw new ValidationError([{ field: 'asset', message: 'No media origin is set' }]);
  const variant = variantForTransform(q);
  if (variant.kind !== 'original' && !isTransformableImage(snapshot.file.contentType)) {
    throw new ValidationError([{ field: 'asset', message: 'Asset is not a resizable image' }]);
  }
  if (variant.kind === 'rendition' && !(await ctx.store.assetRenditions.get(scope, variant.name))) {
    throw new NotFoundError('AssetRendition', variant.name);
  }
  return urlFor(variant);
}

/** The image transform a variant is (the media Worker applies the same to published files). */
export function variantTransform(
  variant: AssetVariant,
  renditions: readonly AssetRendition[],
): ImageTransformSpec | null {
  if (variant.kind === 'original') return null;
  if (variant.kind === 'width') return { width: variant.width, fit: 'max', format: 'auto' };
  const r = renditions.find((x) => x.name === variant.name);
  if (!r) return null;
  return {
    ...(r.width !== undefined ? { width: r.width } : {}),
    ...(r.height !== undefined ? { height: r.height } : {}),
    ...(r.fit !== undefined ? { fit: r.fit } : {}),
    ...(r.format !== undefined ? { format: r.format } : {}),
    ...(r.quality !== undefined ? { quality: r.quality } : {}),
  };
}

/**
 * A draft as Preview serves it: Delivery's shape, with every URL a short-lived signed one (the
 * original from the blob store, variants from the image service, all expiring together). On the
 * media origin when one is set, which verifies the same signatures.
 */
async function projectDraft(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  asset: Asset,
  pc: AssetProjectionContext,
): Promise<DeliveredAsset> {
  const signed = await withReadUrl(blob, scope, asset, {
    ...(ctx.mediaPublicUrl ? { origin: ctx.mediaPublicUrl } : {}),
  });
  const urls = new Map<string, string>();
  if (!asset.file.video && ctx.images && isTransformableImage(asset.file.contentType)) {
    const variants: AssetVariant[] = pc.renditions.map((r) => ({
      kind: 'rendition',
      name: r.name,
    }));
    // The same steps the projector offers: up to the image's own width.
    for (const w of ASSET_WIDTH_LADDER) {
      if (asset.file.width && w > asset.file.width) break;
      variants.push({ kind: 'width', width: w });
    }
    const images = ctx.images;
    await Promise.all(
      variants.map(async (v) => {
        const transform = variantTransform(v, pc.renditions);
        if (!transform) return;
        urls.set(
          variantSegment(v),
          await images.transformUrl(signed.file.url, transform, asset.metadata.focalPoint, {
            expiresInSeconds: READ_URL_TTL_SECONDS,
          }),
        );
      }),
    );
  }
  return deliveredAsset(
    {
      id: asset.id,
      file: signed.file,
      title: asset.title,
      description: asset.description,
      metadata: asset.metadata,
      ...(asset.rights ? { rights: asset.rights } : {}),
    },
    {
      urlFor: (v) => (v.kind === 'original' ? signed.file.url : urls.get(variantSegment(v))),
      renditions: pc.renditions.map((r) => r.name),
      ...(pc.locale ? { locale: pc.locale } : {}),
    },
  );
}

/** One asset as it is now, draft or published, projected for Preview. Archived ones are gone. */
export async function getPreviewAsset(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  id: string,
  opts: AssetReadOptions = {},
): Promise<DeliveredAsset> {
  const [asset, pc] = await Promise.all([
    ctx.store.assets.get(scope, id),
    // Preview reads every locale, delivered or not: editors preview what they write.
    assetProjectionContext(ctx, scope, { ...opts, reads: opts.reads ?? previewReads(ctx) }),
  ]);
  if (!asset || asset.status === 'archived') throw new NotFoundError('Asset', id);
  return projectDraft(ctx, blob, scope, asset, pc);
}

/** A page of the library as it is now (no archived assets), projected for Preview. */
export async function listPreviewAssets(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  query: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly filters?: Pick<AssetFilters, 'kind' | 'tag' | 'folderId'>;
  } = {},
  opts: AssetReadOptions = {},
): Promise<DeliveredAssetPage> {
  const [page, pc] = await Promise.all([
    ctx.store.assets.list(scope, {
      ...(query.limit ? { limit: query.limit } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      filters: { ...query.filters },
      sort: { field: 'createdAt', direction: 'asc' },
    }),
    assetProjectionContext(ctx, scope, { ...opts, reads: opts.reads ?? previewReads(ctx) }),
  ]);
  return {
    items: await Promise.all(page.items.map((a) => projectDraft(ctx, blob, scope, a, pc))),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}
