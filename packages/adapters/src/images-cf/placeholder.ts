import type { AssetPlaceholder } from '@commerceworker/domain';
import { convertIndexedToRgb, decode } from 'fast-png';
import { rgbaToThumbHash } from 'thumbhash';

/**
 * Placeholders from pixels, in pure JS so they run on workerd: the Images binding shrinks the
 * image to a thumbnail PNG (it has no raw-pixel output), `fast-png` decodes that, and `thumbhash`
 * encodes it. Nothing here touches the full-size image.
 */

/** The thumbnail's longest side. ThumbHash takes at most 100; its output is the same from ~32. */
export const PLACEHOLDER_SIDE = 32;

/** 8-bit RGBA pixels, row by row. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/**
 * A PNG's pixels as 8-bit RGBA, whatever its colour type (grey, grey and alpha, RGB, RGBA,
 * indexed) at 8 or 16 bits. `null` for bytes that aren't a PNG this can read (a sub-byte grey
 * depth, which the Images binding doesn't emit).
 */
export function rgbaFromPng(bytes: Uint8Array): RgbaImage | null {
  let png: ReturnType<typeof decode>;
  try {
    png = decode(bytes);
  } catch {
    return null;
  }
  const { width, height } = png;
  let data: ArrayLike<number> = png.data;
  let channels = png.channels;
  let shift = png.depth === 16 ? 8 : 0;
  if (png.palette) {
    data = convertIndexedToRgb(png);
    channels = png.palette[0]?.length ?? 3;
    shift = 0;
  } else if (png.depth !== 8 && png.depth !== 16) {
    return null;
  }
  const pixels = width * height;
  if (pixels === 0 || data.length < pixels * channels) return null;
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const at = i * channels;
    const px = (c: number) => ((data[at + c] as number) >> shift) & 0xff;
    const grey = channels <= 2;
    rgba[i * 4] = px(0);
    rgba[i * 4 + 1] = grey ? px(0) : px(1);
    rgba[i * 4 + 2] = grey ? px(0) : px(2);
    rgba[i * 4 + 3] = channels === 2 ? px(1) : channels === 4 ? px(3) : 255;
  }
  return { width, height, rgba };
}

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/**
 * The colour most of the image is: pixels binned at 4 bits a channel, the fullest bin's mean.
 * A mean of the whole image would be the grey between a red and a blue; this is one of them.
 * Pixels that are mostly transparent don't count, unless nothing else is there.
 */
export function dominantColor(rgba: Uint8Array): string {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const tally = (minAlpha: number) => {
    for (let i = 0; i + 3 < rgba.length; i += 4) {
      if ((rgba[i + 3] as number) < minAlpha) continue;
      const [r, g, b] = [rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
    }
  };
  tally(128);
  if (bins.size === 0) tally(0);
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const bin of bins.values()) if (bin.n > best.n) best = bin;
  if (best.n === 0) return '#000000';
  return `#${hex(best.r / best.n)}${hex(best.g / best.n)}${hex(best.b / best.n)}`;
}

/** The placeholder of a thumbnail no larger than 100 pixels a side. */
export function placeholderFromRgba(image: RgbaImage): AssetPlaceholder {
  const hash = rgbaToThumbHash(image.width, image.height, image.rgba);
  return {
    thumbhash: btoa(String.fromCharCode(...hash)),
    dominantColor: dominantColor(image.rgba),
  };
}
