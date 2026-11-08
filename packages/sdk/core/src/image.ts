/**
 * Image props from a delivered asset, for any framework's `<img>`. Every URL comes from the
 * payload as the server built it: a delivered URL carries a signature over its path (an edited
 * one is a `404`), and a Preview URL is signed and short-lived, so nothing here builds or extends
 * one. Without a media origin (local dev) an asset has no `srcset` and no renditions, and the
 * props degrade to the one `src`.
 */
import type { DeliveredAsset } from './index.js';

export interface ImagePropsOptions {
  /** The `sizes` attribute. Default: `(max-width: {width}px) 100vw, {width}px` with `width`, else `100vw`. */
  readonly sizes?: string;
  /** The width the image renders at, in CSS pixels: picks `src`, and scales `width`/`height` to it. */
  readonly width?: number;
  /** A rendition name; when the asset has it, `src` is that one URL and there's no `srcSet`. */
  readonly rendition?: string;
  /** The locale to take alt text from when it's keyed by locale (not needed after `?locale=`). */
  readonly locale?: string;
  /** Above the fold (the LCP image): load eagerly with `fetchPriority: 'high'`, not lazily. */
  readonly priority?: boolean;
}

/** `<img>` attributes, named as React and the DOM name them (`srcSet`, `fetchPriority`). */
export interface ImageProps {
  readonly src: string;
  readonly srcSet?: string;
  readonly sizes?: string;
  readonly width?: number;
  readonly height?: number;
  /** Empty when the asset has neither alt text nor a title: the image is then decorative. */
  readonly alt: string;
  readonly loading: 'lazy' | 'eager';
  readonly decoding: 'async';
  readonly fetchPriority?: 'high';
  readonly style: { readonly objectPosition?: string; readonly backgroundColor?: string };
}

type ImageAsset = Pick<
  DeliveredAsset,
  | 'kind'
  | 'url'
  | 'renditions'
  | 'srcset'
  | 'width'
  | 'height'
  | 'altText'
  | 'title'
  | 'focalPoint'
  | 'placeholder'
  | 'video'
>;

/**
 * The props to render an asset as an `<img>`: `src`, the width ladder as `srcSet` with `sizes`,
 * intrinsic `width`/`height` (so the layout doesn't shift), `alt`, lazy or eager loading, and a
 * `style` with the focal point as `objectPosition` and the dominant colour as `backgroundColor`
 * (a placeholder until the image paints). A hosted video gives its thumbnail; an asset with no
 * image to show (audio, documents, a video without a thumbnail) gives `undefined`.
 *
 * ```ts
 * const props = imageProps(asset, { sizes: '(min-width: 960px) 960px, 100vw' });
 * ```
 */
export function imageProps(
  asset: ImageAsset,
  opts: ImagePropsOptions = {},
): ImageProps | undefined {
  const common = {
    alt: altText(asset, opts.locale),
    loading: opts.priority ? ('eager' as const) : ('lazy' as const),
    decoding: 'async' as const,
    ...(opts.priority ? { fetchPriority: 'high' as const } : {}),
    style: style(asset),
  };
  const size = dimensions(asset, opts.width);

  if (asset.kind !== 'image') {
    // A hosted video's poster frame is the only still it has; `url` is its HLS manifest.
    const poster = safeUrl(asset.video?.thumbnailUrl);
    return poster ? { src: poster, ...size, ...common } : undefined;
  }

  if (opts.rendition !== undefined) {
    // Own keys only: a `rendition` of `constructor` or `__proto__` must not reach the prototype.
    const named = Object.hasOwn(asset.renditions, opts.rendition)
      ? safeUrl(asset.renditions[opts.rendition])
      : undefined;
    // A rendition's own size isn't in the payload (it may crop to another aspect), so it keeps
    // only the target `width`, never a `height` from the original's aspect ratio.
    if (named) return { src: named, ...(opts.width ? { width: opts.width } : {}), ...common };
  }

  // A step whose width isn't a positive integer, or whose URL has whitespace or ends in a comma,
  // would split or add a candidate in the `srcset` string: leave it out.
  const ladder = asset.srcset.filter(
    (s) =>
      Number.isInteger(s.width) &&
      s.width > 0 &&
      safeUrl(s.url) !== undefined &&
      !/\s|,$/.test(s.url),
  );
  // The ladder stops at the last step below the image's own width (a 1900px image tops out at
  // 1280), so the original, a payload URL too, is the candidate past it.
  const top = ladder[ladder.length - 1];
  const original = safeUrl(asset.url);
  if (top && original && !/\s|,$/.test(original) && asset.width && asset.width > top.width) {
    ladder.push({ width: asset.width, url: original });
  }
  const src = safeUrl(pickStep(ladder, opts.width) ?? asset.url);
  if (!src) return undefined;
  if (ladder.length === 0) return { src, ...size, ...common };
  return {
    src,
    srcSet: ladder.map((s) => `${s.url} ${s.width}w`).join(', '),
    sizes:
      opts.sizes ?? (opts.width ? `(max-width: ${opts.width}px) 100vw, ${opts.width}px` : '100vw'),
    ...size,
    ...common,
  };
}

/**
 * One locale's text from a delivered value: the string itself (a request with `?locale=`), else
 * the `locale` key of a per-locale map, else (no `locale` given) the map's first non-empty value.
 */
export function localizedText(
  value: string | Record<string, unknown> | null | undefined,
  locale?: string,
): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (!value) return undefined;
  if (locale !== undefined) {
    const v = value[locale];
    return typeof v === 'string' && v.trim() ? v : undefined;
  }
  for (const v of Object.values(value)) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

function altText(asset: ImageAsset, locale: string | undefined): string {
  return localizedText(asset.altText, locale) ?? localizedText(asset.title, locale) ?? '';
}

/** The smallest ladder step at or above `width`, the largest past it; none without a `width`. */
function pickStep(
  ladder: readonly { readonly width: number; readonly url: string }[],
  width: number | undefined,
): string | undefined {
  if (width === undefined || ladder.length === 0) return undefined;
  return (ladder.find((s) => s.width >= width) ?? ladder[ladder.length - 1])?.url;
}

/** Intrinsic `width`/`height`, scaled to the target `width` when one is given. */
function dimensions(
  asset: ImageAsset,
  target: number | undefined,
): { width?: number; height?: number } {
  const { width, height } = asset;
  if (!width || !height) return target ? { width: target } : {};
  if (!target) return { width, height };
  return { width: target, height: Math.round((target * height) / width) };
}

function style(asset: ImageAsset): ImageProps['style'] {
  const out: { objectPosition?: string; backgroundColor?: string } = {};
  const focal = asset.focalPoint;
  if (focal && Number.isFinite(focal.x) && Number.isFinite(focal.y)) {
    out.objectPosition = `${percent(focal.x)} ${percent(focal.y)}`;
  }
  // Only ever `#rrggbb`: style values reach markup unescaped by server renderers, so anything
  // else (a `;`, a `url(…)`) is dropped rather than passed through.
  const color = asset.placeholder?.dominantColor;
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) out.backgroundColor = color;
  return out;
}

function percent(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 10000) / 100}%`;
}

/** The URL when it's http(s) or relative (local dev's api-signed URLs are root-relative). */
function safeUrl(url: string | undefined): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  // Browsers drop tabs, newlines and leading spaces from a URL, so check what they'd parse.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
  const parsed = url.replace(/[\u0000-\u0020]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(parsed)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https' ? url : undefined;
}
