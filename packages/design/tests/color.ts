/**
 * WCAG 2.2 contrast, from the tokens as the browser paints them: oklch to sRGB, an `x/N` fill
 * composited over what is beneath it in sRGB, then relative luminance. Pure, so the tests that
 * hold Ledger's colours to AA share one implementation.
 */

export type Rgb = readonly [number, number, number];

/** The unclamped linear-light sRGB of an opaque `oklch(L C h)`: a channel outside 0..1 is out of gamut. */
export function linearSrgb(color: string): readonly [number, number, number] {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (!m) throw new Error(`Not an opaque oklch colour: ${color}`);
  const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
}

export function srgb(color: string): Rgb {
  return linearSrgb(color).map((x) => {
    const c = Math.min(1, Math.max(0, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  }) as unknown as Rgb;
}

/** The OKLCH hue in degrees of an opaque `oklch(L C h)`, or null when it has no chroma to speak of. */
export function hueOf(color: string): number | null {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  return m && Number(m[2]) > 0.03 ? Number(m[3]) : null;
}

/** The shorter way round the hue wheel between two hues, in degrees. */
export const hueApart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

export const over = (top: Rgb, alpha: number, beneath: Rgb): Rgb =>
  top.map((v, i) => v * alpha + beneath[i]! * (1 - alpha)) as unknown as Rgb;

export function contrast(x: Rgb, y: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}
