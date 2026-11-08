/**
 * The Mermaid themes for the repo's diagrams (docs/diagrams), from the Ledger tokens. Diagrams draw
 * in the workflow canvas's language: `node` boxes on `paper`, `edge` lines and borders, `sheet`
 * groups, `ink` words, and one accent, `brand`, on the focal nodes only. Mermaid derives shades
 * from its theme variables with a parser that has no `oklch()`, so every colour is written as hex.
 * Written to docs/diagrams/themes/ledger-{light,dark}.json by `pnpm sync:theme`.
 */
import { FONTS, palette, type Scheme } from './tokens';

type Oklch = { l: number; c: number; h: number };

function parse(color: string): Oklch {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (!m) throw new Error(`Not an opaque oklch colour: ${color}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

/** `color-mix(in oklch, a pct%, b)`: an achromatic side has no hue, so the mix takes the other's. */
export function mixOklch(a: string, pct: number, b: string): string {
  const [x, y, t] = [parse(a), parse(b), pct / 100];
  const h = x.c === 0 ? y.h : y.c === 0 ? x.h : x.h * t + y.h * (1 - t);
  const n = (v: number) => Number(v.toFixed(4));
  return `oklch(${n(x.l * t + y.l * (1 - t))} ${n(x.c * t + y.c * (1 - t))} ${n(h)})`;
}

/** An opaque oklch colour as sRGB hex, clamped to the gamut. */
export function oklchToHex(color: string): string {
  const { l: L, c: C, h: deg } = parse(color);
  const h = (deg * Math.PI) / 180;
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((x) => {
      const v = Math.min(1, Math.max(0, x));
      const e = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      return Math.round(e * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

/** How much `brand` tints a focal node, and the shaded block of a sequence diagram. */
const FOCAL_TINT: Record<Scheme, number> = { light: 8, dark: 28 };
const BAND_TINT: Record<Scheme, number> = { light: 8, dark: 22 };

/** The colours a diagram paints, as hex, for the contrast tests and the theme. */
export function diagramColors(scheme: Scheme) {
  const p = palette(scheme);
  const hex = oklchToHex;
  return {
    page: hex(p.paper),
    words: hex(p.ink),
    node: hex(p.node),
    nodeBorder: hex(p.edge),
    line: hex(p.edge),
    group: hex(p.sheet),
    groupBorder: hex(p['node-border']),
    note: hex(p.muted),
    accent: hex(p.brand),
    focal: hex(mixOklch(p.brand, FOCAL_TINT[scheme], p.node)),
    band: hex(mixOklch(p.brand, BAND_TINT[scheme], p.paper)),
  };
}

/** A mermaid-cli config (`-c`): the `base` theme on Ledger, plus the accent as theme CSS. */
export function mermaidTheme(scheme: Scheme) {
  const c = diagramColors(scheme);
  const font = FONTS.sans;
  return {
    theme: 'base',
    fontFamily: font,
    themeVariables: {
      darkMode: scheme === 'dark',
      background: c.page,
      fontFamily: font,
      fontSize: '16px',
      primaryColor: c.node,
      primaryTextColor: c.words,
      primaryBorderColor: c.nodeBorder,
      secondaryColor: c.group,
      secondaryTextColor: c.words,
      secondaryBorderColor: c.nodeBorder,
      tertiaryColor: c.group,
      tertiaryTextColor: c.words,
      tertiaryBorderColor: c.nodeBorder,
      mainBkg: c.node,
      nodeBorder: c.nodeBorder,
      nodeTextColor: c.words,
      textColor: c.words,
      titleColor: c.words,
      lineColor: c.line,
      defaultLinkColor: c.line,
      edgeLabelBackground: c.page,
      clusterBkg: c.group,
      clusterBorder: c.groupBorder,
      noteBkgColor: c.note,
      noteTextColor: c.words,
      noteBorderColor: c.groupBorder,
      actorBkg: c.node,
      actorBorder: c.nodeBorder,
      actorTextColor: c.words,
      actorLineColor: c.groupBorder,
      signalColor: c.line,
      signalTextColor: c.words,
      labelBoxBkgColor: c.node,
      labelBoxBorderColor: c.nodeBorder,
      labelTextColor: c.words,
      loopTextColor: c.words,
      activationBkgColor: c.group,
      activationBorderColor: c.nodeBorder,
      sequenceNumberColor: c.page,
    },
    // Mermaid 12 paints sequence notes a fixed yellow whatever `noteBkgColor` says; the accent
    // rides on the `focal` class and on `rect` blocks, which theme variables can't reach.
    themeCSS: [
      `g[data-et="note"] rect, .note { fill: ${c.note} !important; stroke: ${c.groupBorder} !important; }`,
      `.node.focal rect, .node.focal path, .node.focal polygon, .node.focal circle { fill: ${c.focal} !important; stroke: ${c.accent} !important; }`,
      `rect.rect { fill: ${c.band} !important; }`,
    ].join(' '),
    flowchart: { curve: 'linear', htmlLabels: true, padding: 14 },
    sequence: { useMaxWidth: true },
  };
}

/** The theme file's contents, as `pnpm sync:theme` writes it. */
export const mermaidThemeJson = (scheme: Scheme) =>
  `${JSON.stringify(mermaidTheme(scheme), null, 2)}\n`;
