import { ValidationError } from '../errors';
import { type LocaleConfig, resolveLocalizedValue, withoutUndeliveredLocales } from '../locale';
import type { LocalizedValue, Scope } from '../types';
import {
  type AssetFile,
  type AssetKind,
  type AssetMetadata,
  type AssetPlaceholder,
  type AssetRights,
  assetKind,
  type FocalPoint,
} from './asset';

/**
 * The widths an image is offered at for `srcset`. Fixed, so every asset's variants are a short,
 * known list: the media Worker serves exactly these, and nobody can mint another size (each new
 * size would be another transform and another cache entry).
 */
export const ASSET_WIDTH_LADDER = [320, 640, 960, 1280, 1920, 2560] as const;

/** How a rendition fits the image into its box (the image service's provider-neutral names). */
export type RenditionFit = 'clip' | 'crop' | 'fill' | 'max' | 'scale';
/** A rendition's output encoding; `auto` negotiates AVIF or WebP from the reader's `Accept`. */
export type RenditionFormat = 'auto' | 'jpg' | 'png' | 'webp' | 'avif';

export const RENDITION_FITS: readonly RenditionFit[] = ['clip', 'crop', 'fill', 'max', 'scale'];
export const RENDITION_FORMATS: readonly RenditionFormat[] = ['auto', 'jpg', 'png', 'webp', 'avif'];

/** What a rendition does to the image. At least one of the fields is set. */
export interface AssetRenditionSpec {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: RenditionFit;
  readonly format?: RenditionFormat;
  /** 1..100, for lossy formats. */
  readonly quality?: number;
}

/**
 * A named image preset of a space (`thumbnail`, `hero`, `og`), served for every published image
 * in it at `…/r-<name>/…`. Presets belong to the space, not an environment: a front end asks for
 * `hero` wherever it reads from.
 */
export interface AssetRendition extends AssetRenditionSpec {
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A space has at most this many renditions: each is a variant of every image it delivers. */
export const MAX_ASSET_RENDITIONS = 20;

const RENDITION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_RENDITION_SIDE = 4096;

/** Checks a rendition name: lowercase letters, digits and dashes, 1..40, as it appears in URLs. */
export function assetRenditionName(name: string): string {
  if (!RENDITION_NAME.test(name)) {
    throw new ValidationError([
      {
        field: 'name',
        message: 'Rendition names are 1 to 40 lowercase letters, digits and dashes',
      },
    ]);
  }
  return name;
}

/** Validates what a rendition does, keeping only the fields it sets. */
export function assetRenditionSpec(input: AssetRenditionSpec): AssetRenditionSpec {
  const issues: { field: string; message: string }[] = [];
  for (const side of ['width', 'height'] as const) {
    const v = input[side];
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > MAX_RENDITION_SIDE)) {
      issues.push({
        field: side,
        message: `${side} must be an integer in 1..${MAX_RENDITION_SIDE}`,
      });
    }
  }
  if (input.fit !== undefined && !RENDITION_FITS.includes(input.fit)) {
    issues.push({ field: 'fit', message: `fit must be one of ${RENDITION_FITS.join(', ')}` });
  }
  if (input.format !== undefined && !RENDITION_FORMATS.includes(input.format)) {
    issues.push({
      field: 'format',
      message: `format must be one of ${RENDITION_FORMATS.join(', ')}`,
    });
  }
  if (
    input.quality !== undefined &&
    (!Number.isInteger(input.quality) || input.quality < 1 || input.quality > 100)
  ) {
    issues.push({ field: 'quality', message: 'quality must be an integer in 1..100' });
  }
  if (input.width === undefined && input.height === undefined && input.format === undefined) {
    issues.push({ field: 'width', message: 'A rendition sets a width, a height or a format' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return {
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.fit !== undefined ? { fit: input.fit } : {}),
    ...(input.format !== undefined ? { format: input.format } : {}),
    ...(input.quality !== undefined ? { quality: input.quality } : {}),
  };
}

/** One servable form of an asset: the stored bytes, a ladder width, or a named rendition. */
export type AssetVariant =
  | { readonly kind: 'original' }
  | { readonly kind: 'width'; readonly width: number }
  | { readonly kind: 'rendition'; readonly name: string };

export const ORIGINAL: AssetVariant = { kind: 'original' };

/** The URL segment of a variant: `o`, `w640`, `r-hero`. */
export function variantSegment(variant: AssetVariant): string {
  switch (variant.kind) {
    case 'original':
      return 'o';
    case 'width':
      return `w${variant.width}`;
    default:
      return `r-${variant.name}`;
  }
}

/** The variant a URL segment names, or `null`: a width off the ladder is no variant at all. */
export function parseAssetVariant(segment: string): AssetVariant | null {
  if (segment === 'o') return ORIGINAL;
  const w = /^w([1-9][0-9]{2,3})$/.exec(segment);
  if (w) {
    const width = Number(w[1]);
    return (ASSET_WIDTH_LADDER as readonly number[]).includes(width)
      ? { kind: 'width', width }
      : null;
  }
  if (segment.startsWith('r-')) {
    const name = segment.slice(2);
    return RENDITION_NAME.test(name) ? { kind: 'rendition', name } : null;
  }
  return null;
}

const TRANSFORMABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

/** Raster types the image service can resize; anything else (SVG included) is served as stored. */
export function isTransformableImage(contentType: string): boolean {
  return TRANSFORMABLE.has((contentType.split(';')[0] ?? '').trim().toLowerCase());
}

/** Where one published asset file lives on the media origin. */
export interface AssetMediaAddress {
  readonly scope: Scope;
  readonly assetId: string;
  readonly version: number;
  /**
   * The unguessable segment: a keyed MAC over the scope, the asset and the version, made and
   * checked outside the domain (`MediaPathSigner`). Without it, editing a URL (another
   * environment's copy of the same asset id, another version) would reach files nobody was given.
   */
  readonly token: string;
  readonly variant: AssetVariant;
  readonly fileName: string;
}

/** A path token's shape: 16 bytes as unpadded base64url. */
const PATH_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/**
 * `/<space>/<env>/<assetId>/v<n>/<token>/<variant>/<fileName>`. The version makes the URL
 * immutable (a replaced file gets a new one), the token makes it unguessable, and the file name is
 * there for people and for downloads.
 */
export function assetMediaPath(a: AssetMediaAddress): string {
  const e = encodeURIComponent;
  return `/${e(a.scope.spaceId)}/${e(a.scope.environmentId)}/${e(a.assetId)}/v${a.version}/${a.token}/${variantSegment(a.variant)}/${e(a.fileName)}`;
}

/**
 * Reverses {@link assetMediaPath}; `null` for anything else (a malformed path is a 404). It checks
 * the token's shape only: whether it is the right one is the signer's to say.
 */
export function parseAssetMediaPath(pathname: string): AssetMediaAddress | null {
  const parts = pathname.split('/');
  if (parts.length !== 8 || parts[0] !== '') return null;
  const [, space, env, id, v, token, segment, name] = parts as [string, ...string[]];
  const version = /^v([1-9][0-9]{0,8})$/.exec(v ?? '');
  const variant = parseAssetVariant(segment ?? '');
  if (!version || !variant || !PATH_TOKEN.test(token ?? '')) return null;
  try {
    const decoded = [space, env, id, name].map((s) => decodeURIComponent(s ?? ''));
    if (decoded.some((s) => s === '' || s === '.' || s === '..')) return null;
    const [spaceId, environmentId, assetId, fileName] = decoded as [string, string, string, string];
    return {
      scope: { spaceId, environmentId },
      assetId,
      version: Number(version[1]),
      token: token as string,
      variant,
      fileName,
    };
  } catch {
    return null;
  }
}

/** A localized text as delivered: one locale's value when `?locale` was given, else the map. */
export type DeliveredText = string | LocalizedValue | null;

/**
 * What Delivery serves for an asset: one shape for the REST get and list, embeds in entries and
 * GraphQL. URLs are built at read time, so the stored file URL is never what a reader gets.
 */
export interface DeliveredAsset {
  readonly id: string;
  readonly title: DeliveredText;
  readonly description: DeliveredText;
  readonly altText: DeliveredText;
  readonly focalPoint: FocalPoint | null;
  readonly contentType: string;
  readonly size: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly kind: AssetKind;
  /** The original file (a hosted video's HLS manifest). */
  readonly url: string;
  /** The space's renditions of this image, by name. Empty for anything that isn't a raster. */
  readonly renditions: Readonly<Record<string, string>>;
  /** The width ladder, up to the image's own width, for `srcset`. */
  readonly srcset: readonly { readonly width: number; readonly url: string }[];
  /** A raster image's ThumbHash and dominant colour, once ingest has computed them; else `null`. */
  readonly placeholder: AssetPlaceholder | null;
  readonly video?: {
    readonly status: string;
    readonly hlsUrl?: string;
    readonly dashUrl?: string;
    readonly thumbnailUrl?: string;
    readonly durationSeconds?: number;
  };
  readonly rights?: { readonly credit?: string; readonly license?: string };
  /** The stored file description, kept for existing readers; its `url` is {@link url}. */
  readonly file: AssetFile;
}

/** What the projector reads from an asset (a published snapshot, or a draft for Preview). */
export interface DeliverableAsset {
  readonly id: string;
  readonly file: AssetFile;
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: Pick<AssetMetadata, 'altText' | 'focalPoint'>;
  readonly rights?: AssetRights;
}

export interface DeliveredAssetOptions {
  /**
   * The URL of one variant of this asset, or `undefined` when nothing can serve it. Absent (no
   * media origin configured): the stored file URL, and no variants.
   */
  readonly urlFor?: (variant: AssetVariant) => string | undefined;
  /** The names of the space's renditions. */
  readonly renditions: readonly string[];
  /** Flattens title, description and alt text to one locale, with the space's fallbacks. */
  readonly locale?: { readonly requested: string; readonly config: LocaleConfig };
  /**
   * Without `locale`: the space as Delivery sees it, so each all-locale map leaves out the locales
   * it doesn't deliver. Absent (Preview), every locale is served.
   */
  readonly delivered?: LocaleConfig;
}

/**
 * Projects an asset into what Delivery serves. Pure: the caller supplies the URL builder, the
 * space's rendition names and the locale settings.
 */
export function deliveredAsset(
  asset: DeliverableAsset,
  opts: DeliveredAssetOptions,
): DeliveredAsset {
  const text = (value: LocalizedValue): DeliveredText => {
    if (!opts.locale)
      return opts.delivered ? withoutUndeliveredLocales(value, opts.delivered) : value;
    const v = resolveLocalizedValue(value, opts.locale.config, opts.locale.requested);
    return typeof v === 'string' ? v : null;
  };
  const { file } = asset;
  const hosted = file.video;
  const url = hosted ? (hosted.hlsUrl ?? file.url) : (opts.urlFor?.(ORIGINAL) ?? file.url);
  const urlFor = !hosted && isTransformableImage(file.contentType) ? opts.urlFor : undefined;
  const renditions: Record<string, string> = {};
  const srcset: { width: number; url: string }[] = [];
  if (urlFor) {
    for (const name of opts.renditions) {
      const u = urlFor({ kind: 'rendition', name });
      if (u) renditions[name] = u;
    }
    for (const width of ASSET_WIDTH_LADDER) {
      // Never past the image's own width: the service doesn't upscale, so a larger step would
      // only repeat the original under another URL.
      if (file.width && width > file.width) break;
      const u = urlFor({ kind: 'width', width });
      if (u) srcset.push({ width, url: u });
    }
  }
  const credit = asset.rights?.credit;
  const license = asset.rights?.license;
  return {
    id: asset.id,
    title: text(asset.title),
    description: text(asset.description),
    altText: text(asset.metadata.altText),
    focalPoint: asset.metadata.focalPoint ?? null,
    contentType: file.contentType,
    size: file.size ?? null,
    width: file.width ?? null,
    height: file.height ?? null,
    kind: assetKind(file.contentType),
    url,
    renditions,
    srcset,
    placeholder: hosted ? null : (file.placeholder ?? null),
    ...(hosted
      ? {
          video: {
            status: hosted.status,
            ...(hosted.hlsUrl ? { hlsUrl: hosted.hlsUrl } : {}),
            ...(hosted.dashUrl ? { dashUrl: hosted.dashUrl } : {}),
            ...(hosted.thumbnailUrl ? { thumbnailUrl: hosted.thumbnailUrl } : {}),
            ...(hosted.durationSeconds !== undefined
              ? { durationSeconds: hosted.durationSeconds }
              : {}),
          },
        }
      : {}),
    ...(credit || license
      ? { rights: { ...(credit ? { credit } : {}), ...(license ? { license } : {}) } }
      : {}),
    file: { ...file, url },
  };
}

/**
 * The media origin's URL builder for one published asset version, given its path token. Width
 * steps ask for `fm=auto`, so a reader gets AVIF or WebP when it accepts them; renditions carry
 * their own format.
 */
export function publicAssetUrls(
  origin: string,
  scope: Scope,
  asset: {
    readonly id: string;
    readonly version: number;
    readonly fileName: string;
    readonly token: string;
  },
): (variant: AssetVariant) => string {
  const base = origin.replace(/\/$/, '');
  return (variant) => {
    const path = assetMediaPath({
      scope,
      assetId: asset.id,
      version: asset.version,
      token: asset.token,
      variant,
      fileName: asset.fileName,
    });
    return `${base}${path}${variant.kind === 'width' ? '?fm=auto' : ''}`;
  };
}

/** The variant a legacy transform request (`?w=` or `?rendition=`) maps to: the next ladder step
 *  up from the asked width (the largest when past it), the rendition, or the original. */
export function variantForTransform(q: {
  readonly width?: number;
  readonly rendition?: string;
}): AssetVariant {
  if (q.rendition) return { kind: 'rendition', name: assetRenditionName(q.rendition) };
  if (q.width !== undefined && Number.isFinite(q.width) && q.width > 0) {
    const width =
      ASSET_WIDTH_LADDER.find((w) => w >= (q.width as number)) ??
      ASSET_WIDTH_LADDER[ASSET_WIDTH_LADDER.length - 1];
    return { kind: 'width', width: width as number };
  }
  return ORIGINAL;
}
