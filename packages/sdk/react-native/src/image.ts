import { assetUrl, type DeliveredAsset, imageProps } from '@commerceworker/sdk-core';

export interface ImageOptions {
  /** Layout width in density-independent pixels. */
  readonly width?: number;
  /** Device pixel ratio (e.g. `PixelRatio.get()`); multiplies `width`. Default 1. */
  readonly dpr?: number;
  /** A rendition name; wins over `width` when the asset has it. */
  readonly rendition?: string;
}

/**
 * The URL to load an image asset at: the named rendition, else the width step at or above
 * `width × dpr` (so a 3× screen gets a sharp image and a 1× screen doesn't download it), else the
 * original. Every one is a URL the server built, never one with parameters added here: a delivered
 * URL is immutable on the media origin, and a Preview URL is signed.
 */
export function imageUrl(
  asset: Pick<DeliveredAsset, 'url' | 'renditions' | 'srcset'>,
  o: ImageOptions = {},
): string {
  if (o.rendition !== undefined) {
    const named = assetUrl(asset, { rendition: o.rendition });
    if (named) return named;
  }
  if (o.width !== undefined) {
    return assetUrl(asset, { width: Math.ceil(o.width * (o.dpr ?? 1)) }) ?? asset.url;
  }
  return asset.url;
}

/** What `<Image source>` takes: one URI, with the layout size when it's known. */
export interface ImageSource {
  readonly uri: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * An `<Image source>` for a delivered asset: the URL {@link imageUrl} picks for `width × dpr`
 * (or the rendition), with `width` and, from the asset's aspect ratio, `height` (not for a
 * rendition, which may crop to another shape) in
 * density-independent pixels, so the image takes its size before it loads. A hosted video gives
 * its thumbnail; audio, documents and a video without a thumbnail give `undefined`. Without a
 * media origin (local dev) it's the original, the only URL there is.
 *
 * ```tsx
 * const source = imageSource(asset, { width: 320, dpr: PixelRatio.get() });
 * {source && <Image source={source} alt={imageProps(asset)?.alt ?? ''} />}
 * ```
 */
export function imageSource(
  asset: Parameters<typeof imageProps>[0],
  o: ImageOptions = {},
): ImageSource | undefined {
  const target = o.width === undefined ? undefined : Math.ceil(o.width * (o.dpr ?? 1));
  const props = imageProps(asset, { width: target, rendition: o.rendition });
  if (!props) return undefined;
  if (o.width === undefined) return { uri: props.src };
  // A rendition may crop to another aspect ratio, which the payload doesn't say: width only.
  const named = o.rendition !== undefined && props.src === asset.renditions[o.rendition];
  const { width, height } = asset;
  return {
    uri: props.src,
    width: o.width,
    ...(width && height && !named ? { height: Math.round((o.width * height) / width) } : {}),
  };
}
