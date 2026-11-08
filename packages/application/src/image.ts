import type { Scope } from '@commerceworker/domain';
import { type Asset, type FocalPoint, ValidationError } from '@commerceworker/domain';
import type { BlobStore, ImageFit, ImageFormat, ImageTransformSpec } from '@commerceworker/ports';
import { getAsset, getPublishedAsset, READ_URL_TTL_SECONDS, withReadUrl } from './assets';
import type { AppContext } from './context';

export type { ImageFit, ImageFormat } from '@commerceworker/ports';

/**
 * A requested image transformation. Provider-neutral: the bound
 * `ImageTransformer` (Cloudflare Images on edge) maps it onto its own
 * parameters; without one, the query-param URL convention applies.
 */
export type ImageTransform = ImageTransformSpec;

const FITS: readonly ImageFit[] = ['clip', 'crop', 'fill', 'max', 'scale'];
const FORMATS: readonly ImageFormat[] = ['auto', 'jpg', 'png', 'webp', 'avif'];

function validate(transform: ImageTransform): void {
  const issues = [];
  for (const dim of ['width', 'height'] as const) {
    const v = transform[dim];
    if (v != null && (!Number.isInteger(v) || v <= 0 || v > 10000)) {
      issues.push({ field: dim, message: `${dim} must be an integer in 1..10000` });
    }
  }
  if (transform.quality != null && (transform.quality < 1 || transform.quality > 100)) {
    issues.push({ field: 'quality', message: 'quality must be between 1 and 100' });
  }
  if (transform.fit && !FITS.includes(transform.fit)) {
    issues.push({ field: 'fit', message: `fit must be one of ${FITS.join(', ')}` });
  }
  if (transform.format && !FORMATS.includes(transform.format)) {
    issues.push({ field: 'format', message: `format must be one of ${FORMATS.join(', ')}` });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * Builds a transform URL from a source image URL by appending query params
 * (`w`, `h`, `fit`, `fm`, `q`). When the fit is `crop` and a focal point is known, the crop is
 * anchored to that point. Pure — no validation, no I/O.
 */
export function buildImageUrl(
  baseUrl: string,
  transform: ImageTransform,
  focalPoint?: FocalPoint,
): string {
  const params: [string, string][] = [];
  if (transform.width) params.push(['w', String(transform.width)]);
  if (transform.height) params.push(['h', String(transform.height)]);
  if (transform.fit) params.push(['fit', transform.fit]);
  if (transform.format) params.push(['fm', transform.format]);
  if (transform.quality != null) params.push(['q', String(transform.quality)]);
  if (transform.fit === 'crop' && focalPoint) {
    params.push(['crop', 'focalpoint']);
    params.push(['fp-x', String(focalPoint.x)]);
    params.push(['fp-y', String(focalPoint.y)]);
  }
  if (params.length === 0) return baseUrl;
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${query}`;
}

/**
 * Parses an {@link ImageTransform} from query params (`w`, `h`, `fit`, `fm`,
 * `q`). Unknown/blank params are ignored; values are validated downstream.
 */
export function parseImageTransform(q: Record<string, string | undefined>): ImageTransform {
  const num = (v: string | undefined) => (v ? Number(v) : undefined);
  return {
    width: num(q.w),
    height: num(q.h),
    fit: q.fit as ImageFit | undefined,
    format: q.fm as ImageFormat | undefined,
    quality: num(q.q),
  };
}

/** The bound image service when there is one, else the query-param convention. */
function resolveUrl(
  ctx: AppContext,
  sourceUrl: string,
  transform: ImageTransform,
  focalPoint?: FocalPoint,
  opts?: { readonly expiresInSeconds?: number },
): Promise<string> {
  if (ctx.images) return ctx.images.transformUrl(sourceUrl, transform, focalPoint, opts);
  return Promise.resolve(buildImageUrl(sourceUrl, transform, focalPoint));
}

export interface TransformedImage {
  readonly url: string;
  readonly transform: ImageTransform;
}

/**
 * Resolves a transform URL for an asset's draft, honoring its stored focal point for smart
 * cropping. Validates the transform and that the asset is an image. Built, as every Management read
 * is, from a fresh short-lived signed read URL for the current version's key ({@link withReadUrl}),
 * never the stored URL (non-expiring, and an older version's after a replace), so the transform
 * serves the current file and expires with that URL.
 */
export async function transformAssetUrl(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  id: string,
  transform: ImageTransform,
): Promise<TransformedImage> {
  validate(transform);
  const asset: Asset = await getAsset(ctx, scope, id);
  if (!asset.file.contentType.startsWith('image/')) {
    throw new ValidationError([{ field: 'asset', message: 'Asset is not an image' }]);
  }
  const signed = await withReadUrl(blob, scope, asset);
  return {
    url: await resolveUrl(ctx, signed.file.url, transform, asset.metadata.focalPoint, {
      expiresInSeconds: READ_URL_TTL_SECONDS,
    }),
    transform,
  };
}

/**
 * Like {@link transformAssetUrl} but resolves the published snapshot — the
 * delivery-surface variant, so transforms work against shipped content.
 */
export async function transformPublishedAssetUrl(
  ctx: AppContext,
  scope: Scope,
  id: string,
  transform: ImageTransform,
): Promise<TransformedImage> {
  validate(transform);
  const snapshot = await getPublishedAsset(ctx, scope, id);
  if (!snapshot.file.contentType.startsWith('image/')) {
    throw new ValidationError([{ field: 'asset', message: 'Asset is not an image' }]);
  }
  return {
    url: await resolveUrl(ctx, snapshot.file.url, transform, snapshot.metadata.focalPoint),
    transform,
  };
}
