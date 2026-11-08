import type { AssetPlaceholder, FocalPoint } from '@commerceworker/domain';
import type {
  ByteStream,
  ImageFit,
  ImageFormat,
  ImageInfo,
  ImageProbe,
  ImageTransformer,
  ImageTransformSpec,
} from '@commerceworker/ports';
import { PLACEHOLDER_SIDE, placeholderFromRgba, rgbaFromPng } from './placeholder';

export {
  dominantColor,
  PLACEHOLDER_SIDE,
  placeholderFromRgba,
  type RgbaImage,
  rgbaFromPng,
} from './placeholder';

/**
 * Cloudflare Images adapter.
 *
 * Two halves, matching the two Images surfaces:
 *  - {@link createCfImageTransformer} implements the `ImageTransformer` port by
 *    minting a *signed* transform URL. For blobs the Worker serves itself
 *    (`/media/<key>`), the URL points back at that route with transform
 *    params, and {@link transformImage} runs the Images binding over the R2
 *    bytes. For any other source (a public bucket domain), it builds the
 *    zone-level `/cdn-cgi/image/<options>/<source>` URL instead.
 *  - {@link transformImage} executes a transform with the Images binding.
 *
 * Bindings are typed structurally so the package imports no Cloudflare types.
 */

/** Cloudflare's `gravity` focal-point form for the Images binding. */
export interface CfGravity {
  readonly x: number;
  readonly y: number;
  readonly mode: 'remainder' | 'box-center';
}

/** Subset of the Images binding's `transform()` options this adapter sets. */
export interface CfImageTransform {
  width?: number;
  height?: number;
  fit?: 'scale-down' | 'contain' | 'pad' | 'squeeze' | 'cover' | 'crop';
  gravity?: CfGravity | 'auto';
}

export type CfOutputFormat = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif' | 'image/gif';

/** The Images binding's `info` answer: dimensions for raster images, none for SVG. */
export type CfImageInfo =
  | { format: string; fileSize: number; width: number; height: number }
  | { format: 'image/svg+xml' };

/** The subset of the Images binding (`env.IMAGES`) this adapter uses. */
export interface ImagesBindingLike {
  info(stream: ReadableStream<Uint8Array>): Promise<CfImageInfo>;
  input(stream: ReadableStream<Uint8Array>): {
    transform(t: CfImageTransform): ReturnType<ImagesBindingLike['input']>;
    output(o: { format: CfOutputFormat; quality?: number }): Promise<{
      response(): Response;
    }>;
  };
}

/** The signing half of the R2 blob adapter's media-URL signer (structural). */
export interface MediaSigner {
  sign(method: 'GET', key: string, params: URLSearchParams): Promise<string>;
}

/** Provider-neutral fit → Cloudflare fit. */
export const CF_FIT: Readonly<Record<ImageFit, NonNullable<CfImageTransform['fit']>>> = {
  clip: 'contain',
  crop: 'cover',
  fill: 'pad',
  max: 'scale-down',
  scale: 'squeeze',
};

const FIT_NAMES = Object.keys(CF_FIT) as ImageFit[];
const MEDIA_PREFIX = '/media/';

/** Serializes a transform into the media-route query params (`w,h,fit,fm,q,g`). */
export function transformParams(t: ImageTransformSpec, focalPoint?: FocalPoint): URLSearchParams {
  const p = new URLSearchParams();
  if (t.width) p.set('w', String(t.width));
  if (t.height) p.set('h', String(t.height));
  if (t.fit) p.set('fit', t.fit);
  if (t.format) p.set('fm', t.format);
  if (t.quality != null) p.set('q', String(t.quality));
  // Gravity only matters when the image is cropped (fit=crop → cover).
  if (focalPoint && t.fit === 'crop') {
    p.set('g', `${focalPoint.x}x${focalPoint.y}`);
  }
  return p;
}

/** Cloudflare `/cdn-cgi/image/` option string for the same transform. */
export function cdnCgiOptions(t: ImageTransformSpec, focalPoint?: FocalPoint): string {
  const o: string[] = [];
  if (t.width) o.push(`width=${t.width}`);
  if (t.height) o.push(`height=${t.height}`);
  if (t.fit) o.push(`fit=${CF_FIT[t.fit]}`);
  o.push(`format=${t.format === 'jpg' ? 'jpeg' : (t.format ?? 'auto')}`);
  if (t.quality != null) o.push(`quality=${t.quality}`);
  if (focalPoint && t.fit === 'crop') o.push(`gravity=${focalPoint.x}x${focalPoint.y}`);
  return o.join(',');
}

export interface CfImageTransformerOptions {
  readonly signer: MediaSigner;
  /**
   * Origin of a Cloudflare zone with Image Transformations enabled, used for
   * sources the Worker does not serve itself. Absent → such sources are
   * returned untransformed (there is nothing that could transform them).
   */
  readonly zoneOrigin?: string;
  /** Injected for tests; seconds since the epoch. */
  readonly now?: () => number;
}

/**
 * `ImageTransformer` backed by Cloudflare Images. Default output format is
 * `auto` (AVIF/WebP negotiated per request) — the Cloudflare-native behaviour
 * a caller gets without asking for a specific format.
 */
export function createCfImageTransformer(opts: CfImageTransformerOptions): ImageTransformer {
  return {
    async transformUrl(sourceUrl, transform, focalPoint, urlOpts) {
      const spec: ImageTransformSpec = { ...transform, format: transform.format ?? 'auto' };
      const parsed = new URL(sourceUrl, 'http://relative.invalid');
      const at = parsed.pathname.indexOf(MEDIA_PREFIX);
      if (at >= 0) {
        const key = parsed.pathname
          .slice(at + MEDIA_PREFIX.length)
          .split('/')
          .map(decodeURIComponent)
          .join('/');
        const params = transformParams(spec, focalPoint);
        // A short-lived source keeps its expiry (a transform must not outlive the URL it came
        // from); otherwise the caller's lifetime, if any.
        const exp =
          parsed.searchParams.get('exp') ??
          (urlOpts?.expiresInSeconds
            ? String((opts.now?.() ?? Math.floor(Date.now() / 1000)) + urlOpts.expiresInSeconds)
            : null);
        if (exp) params.set('exp', exp);
        params.set('sig', await opts.signer.sign('GET', key, params));
        const prefix = sourceUrl.startsWith('/') ? '' : parsed.origin;
        return `${prefix}${parsed.pathname}?${params.toString()}`;
      }
      if (!opts.zoneOrigin) return sourceUrl;
      return `${opts.zoneOrigin.replace(/\/$/, '')}/cdn-cgi/image/${cdnCgiOptions(spec, focalPoint)}/${sourceUrl}`;
    },
  };
}

/** Parsed, clamped transform from media-route params; `null` when there is none. */
export function parseTransformParams(params: URLSearchParams): {
  transform: CfImageTransform;
  format?: ImageFormat;
  quality?: number;
} | null {
  const int = (v: string | null, max: number) => {
    const n = Number(v);
    return v !== null && Number.isInteger(n) && n > 0 && n <= max ? n : undefined;
  };
  const width = int(params.get('w'), 10000);
  const height = int(params.get('h'), 10000);
  const fitName = params.get('fit') as ImageFit | null;
  const fit = fitName && FIT_NAMES.includes(fitName) ? CF_FIT[fitName] : undefined;
  const fm = params.get('fm') as ImageFormat | null;
  const format =
    fm && ['auto', 'jpg', 'png', 'webp', 'avif'].includes(fm) ? (fm as ImageFormat) : undefined;
  const quality = int(params.get('q'), 100);
  let gravity: CfGravity | undefined;
  const g = params.get('g')?.match(/^(0(?:\.\d+)?|1(?:\.0+)?)x(0(?:\.\d+)?|1(?:\.0+)?)$/);
  if (g) gravity = { x: Number(g[1]), y: Number(g[2]), mode: 'box-center' };
  const transform: CfImageTransform = {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(fit ? { fit } : {}),
    ...(gravity ? { gravity } : {}),
  };
  if (Object.keys(transform).length === 0 && !format && quality === undefined) return null;
  return { transform, ...(format ? { format } : {}), ...(quality ? { quality } : {}) };
}

const PASSTHROUGH_FORMATS: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
];

/**
 * Picks the output type. `auto` negotiates from `Accept` (AVIF, then WebP);
 * no format keeps the source type when the encoder supports it.
 */
export function negotiateFormat(
  format: ImageFormat | undefined,
  accept: string | null,
  sourceType: string,
): CfOutputFormat {
  switch (format) {
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'auto': {
      const a = accept ?? '';
      if (a.includes('image/avif')) return 'image/avif';
      if (a.includes('image/webp')) return 'image/webp';
      return sourceType === 'image/png' ? 'image/png' : 'image/jpeg';
    }
    default:
      return PASSTHROUGH_FORMATS.includes(sourceType)
        ? (sourceType as CfOutputFormat)
        : 'image/jpeg';
  }
}

/** Source types the Images binding can decode (SVG is served as-is). */
export function isTransformableImage(contentType: string): boolean {
  return PASSTHROUGH_FORMATS.includes(contentType);
}

/**
 * Runs a media-route transform through the Images binding. Returns `null` when
 * the params ask for nothing or the source is not a transformable raster, so
 * the caller serves the original bytes.
 */
export async function transformImage(
  images: ImagesBindingLike,
  body: ReadableStream<Uint8Array>,
  sourceType: string,
  params: URLSearchParams,
  accept: string | null,
): Promise<Response | null> {
  const parsed = parseTransformParams(params);
  if (!parsed || !isTransformableImage(sourceType)) return null;
  const format = negotiateFormat(parsed.format, accept, sourceType);
  let handle = images.input(body);
  if (Object.keys(parsed.transform).length > 0) handle = handle.transform(parsed.transform);
  const result = await handle.output({
    format,
    ...(parsed.quality ? { quality: parsed.quality } : {}),
  });
  const res = result.response();
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
  headers.set('x-content-type-options', 'nosniff');
  if (parsed.format === 'auto') headers.set('vary', 'Accept');
  return new Response(res.body, { status: res.status, headers });
}

/** How the binding refuses input it can't decode: an answer ("not an image"), not an outage. */
const NOT_AN_IMAGE = /unsupported|invalid|decode|not.*image/i;

/**
 * The ImageProbe port over the Images binding. `info` (not billed) reads the format and dimensions
 * of an image from its bytes; `placeholder` has the binding shrink it to a
 * {@link PLACEHOLDER_SIDE}-pixel PNG (one transformation, billed as such) and computes the
 * ThumbHash and dominant colour from that here. Bytes that aren't an image it reads, and SVG (no
 * intrinsic size), are `null`; a failure of the service itself throws, so a durable caller
 * retries.
 */
export function createCfImageProbe(
  images: Pick<ImagesBindingLike, 'info'> & Partial<Pick<ImagesBindingLike, 'input'>>,
): ImageProbe {
  const probe: ImageProbe = {
    async info(body: ByteStream): Promise<ImageInfo | null> {
      let info: CfImageInfo;
      try {
        info = await images.info(toReadable(body));
      } catch (err) {
        if (NOT_AN_IMAGE.test(String(err))) return null;
        throw err;
      }
      if (!('width' in info)) return null;
      return {
        width: info.width,
        height: info.height,
        format: info.format,
        ...(info.fileSize ? { size: info.fileSize } : {}),
      };
    },
  };
  const { input } = images;
  if (!input) return probe;
  return {
    ...probe,
    async placeholder(body: ByteStream): Promise<AssetPlaceholder | null> {
      let png: Uint8Array;
      try {
        const out = await input
          .call(images, toReadable(body))
          .transform({ width: PLACEHOLDER_SIDE, height: PLACEHOLDER_SIDE, fit: 'scale-down' })
          .output({ format: 'image/png' });
        png = new Uint8Array(await out.response().arrayBuffer());
      } catch (err) {
        if (NOT_AN_IMAGE.test(String(err))) return null;
        throw err;
      }
      const pixels = rgbaFromPng(png);
      // ThumbHash takes at most 100 a side; a binding that ignored the resize gets no placeholder.
      if (!pixels || pixels.width > 100 || pixels.height > 100) return null;
      return placeholderFromRgba(pixels);
    },
  };
}

/** A web stream from the port's async-iterable bytes (passed through when it already is one). */
function toReadable(body: ByteStream): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  const it = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}
