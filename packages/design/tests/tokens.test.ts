import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diagramColors, mermaidThemeJson } from '../src/mermaid';
import { DARK_OVERRIDES, FONTS, LIGHT, palette, starlightThemeCss } from '../src/tokens';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** Both admins and the storefront author the Ledger tokens; each is held to the same set. */
const ADMINS = [
  'apps/web/app/app.css',
  'apps/studio/app/app.css',
  'apps/storefront/app/app.css',
] as const;
const appCss = read('../../../apps/studio/app/app.css');

/** The custom properties one rule block in app.css declares, in source order. */
function declarations(selector: string, css = appCss): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`app.css has no ${selector} block`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

for (const admin of ADMINS) {
  const css = read(`../../../${admin}`);
  describe(`Ledger tokens match ${admin}`, () => {
    it('light: every `:root` token, value for value', () => {
      expect(LIGHT).toEqual(declarations(':root {', css));
    });

    it('dark: every `:root[data-theme="dark"]` override, value for value', () => {
      expect(DARK_OVERRIDES).toEqual(declarations(':root[data-theme="dark"] {', css));
    });

    it('faces: the `@theme` font stacks', () => {
      const theme = declarations('@theme {', css);
      expect({
        sans: theme['font-sans'],
        mono: theme['font-mono'],
      }).toEqual(FONTS);
    });

    it('resolves every reference in both schemes', () => {
      for (const scheme of ['light', 'dark'] as const) {
        for (const v of Object.values(palette(scheme))) expect(v).not.toMatch(/var\(/);
      }
    });
  });
}

describe('generated docs theme', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`docs/diagrams/themes/ledger-${scheme}.json is current (run \`pnpm sync:theme\`)`, () => {
      expect(read(`../../../docs/diagrams/themes/ledger-${scheme}.json`)).toBe(
        mermaidThemeJson(scheme),
      );
    });
  }

  it('apps/docs/src/styles/theme.css is current (run `pnpm sync:theme`)', () => {
    expect(read('../../../apps/docs/src/styles/theme.css')).toBe(starlightThemeCss());
  });
});

// WCAG contrast, from the tokens as the browser paints them: oklch to sRGB, an `x/N` fill
// composited over what is beneath it in sRGB, then relative luminance.
type Rgb = readonly [number, number, number];

function srgb(color: string): Rgb {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (!m) throw new Error(`Not an opaque oklch colour: ${color}`);
  const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  return linear.map((x) => {
    const c = Math.min(1, Math.max(0, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  }) as unknown as Rgb;
}

const over = (top: Rgb, alpha: number, beneath: Rgb): Rgb =>
  top.map((v, i) => v * alpha + beneath[i]! * (1 - alpha)) as unknown as Rgb;

function contrast(x: Rgb, y: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The tints the shared Button's `destructive` variant paints, read from packages/ui. */
function destructiveTints() {
  const button = read('../../ui/src/button.tsx');
  const variant = /destructive:\s*'([^']+)'/.exec(button)?.[1];
  if (!variant) throw new Error('button.tsx has no destructive variant');
  const pct = (prefix: string) => {
    const m = new RegExp(`(?:^|\\s)${prefix}bg-destructive/(\\d+)(?:\\s|$)`).exec(variant);
    if (!m) throw new Error(`destructive variant has no ${prefix}bg-destructive/N`);
    return Number(m[1]) / 100;
  };
  return {
    light: { rest: pct(''), hover: pct('hover:') },
    dark: { rest: pct('dark:'), hover: pct('dark:hover:') },
  };
}

/** How much `muted` a `tile` lays over its ground (the InlineConfirm's surface). */
const tileMuted = (() => {
  const m = /@utility tile \{[^}]*var\(--muted\) (\d+)%/.exec(appCss);
  if (!m) throw new Error('app.css has no tile utility over muted');
  return Number(m[1]) / 100;
})();

describe('Ledger contrast (PRODUCT.md: text 4.5:1 in both themes)', () => {
  const tints = destructiveTints();
  for (const scheme of ['light', 'dark'] as const) {
    const p = palette(scheme);
    const red = srgb(p.destructive);
    // An inline confirm sits on the page or inside a card; in light both are white.
    for (const ground of ['paper', 'card'] as const) {
      const tile = over(srgb(p.muted), tileMuted, srgb(p[ground]));
      for (const state of ['rest', 'hover'] as const) {
        it(`${scheme}: the destructive button's words on its tint over a tile on ${ground}, ${state}`, () => {
          const fill = over(red, tints[scheme][state], tile);
          expect(contrast(red, fill)).toBeGreaterThanOrEqual(4.5);
        });
      }
      it(`${scheme}: destructive text (field errors) on ${ground}`, () => {
        expect(contrast(red, srgb(p[ground]))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

/** The tint a status stamp lays under its words, read from the admin's stamp. */
const stampTint = (() => {
  const m = /color-mix\(in oklch, \$\{color\} (\d+)%, transparent\)/.exec(
    read('../../../apps/studio/app/components/status.tsx'),
  );
  if (!m) throw new Error('status.tsx has no color-mix stamp tint');
  return Number(m[1]) / 100;
})();

/** The brand tint a checked option card (packages/ui field.tsx) paints, light and dark. */
const optionTint = (() => {
  const field = read('../../ui/src/field.tsx');
  const pct = (prefix: string) => {
    const m = new RegExp(`(?:^|\\s)${prefix}has-data-checked:bg-brand/(\\d+)(?:\\s|'|$)`).exec(
      field,
    );
    if (!m) throw new Error(`field.tsx has no ${prefix}has-data-checked:bg-brand/N`);
    return Number(m[1]) / 100;
  };
  return { light: pct(''), dark: pct('dark:') };
})();

describe('Ledger contrast: the brand accent (DESIGN.md Accent)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    const p = palette(scheme);
    const brand = srgb(p.brand);
    for (const ground of ['paper', 'card', 'muted', 'sidebar', 'sidebar-accent'] as const) {
      it(`${scheme}: brand words (the AI tone) hold 4.5:1 on ${ground}`, () => {
        expect(contrast(brand, srgb(p[ground]))).toBeGreaterThanOrEqual(4.5);
      });
      it(`${scheme}: the focus edge (ring) holds 3:1 on ${ground}`, () => {
        expect(contrast(srgb(p.ring), srgb(p[ground]))).toBeGreaterThanOrEqual(3);
      });
    }
    it(`${scheme}: words and checks on a brand fill hold 4.5:1`, () => {
      expect(contrast(srgb(p['brand-foreground']), brand)).toBeGreaterThanOrEqual(4.5);
    });
    // The AI stamp ("AI suggestion", an agent's run): brand words on the stamp's own brand tint.
    for (const ground of ['paper', 'card', 'muted', 'sidebar-accent'] as const) {
      it(`${scheme}: the AI stamp's words on its tint over ${ground} hold 4.5:1`, () => {
        const fill = over(brand, stampTint, srgb(p[ground]));
        expect(contrast(brand, fill)).toBeGreaterThanOrEqual(4.5);
      });
    }
    // The chosen option card: a field's words, body and muted, on its brand tint.
    for (const ground of ['paper', 'card', 'muted'] as const) {
      it(`${scheme}: words on the chosen option card over ${ground} hold 4.5:1`, () => {
        const fill = over(brand, optionTint[scheme], srgb(p[ground]));
        expect(contrast(srgb(p.foreground), fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(srgb(p['muted-foreground']), fill)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

// The diagrams' colours as the SVG paints them (hex, so read back through sRGB).
const fromHex = (h: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as unknown as Rgb;

describe('Diagram contrast (docs/diagrams)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    const c = diagramColors(scheme);
    const cr = (a: string, b: string) => contrast(fromHex(a), fromHex(b));
    it(`${scheme}: words hold 4.5:1 on a node, a focal node, a group, a note and the shaded block`, () => {
      for (const ground of [c.node, c.focal, c.group, c.note, c.band, c.page])
        expect(cr(c.words, ground)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${scheme}: node borders and lines hold 3:1 on the page and in a group`, () => {
      for (const ground of [c.page, c.group]) {
        expect(cr(c.nodeBorder, ground)).toBeGreaterThanOrEqual(3);
        expect(cr(c.line, ground)).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${scheme}: the accent edge holds 3:1 on its own tint, the page and a group`, () => {
      for (const ground of [c.focal, c.page, c.group])
        expect(cr(c.accent, ground)).toBeGreaterThanOrEqual(3);
    });
  }
});

// The One Meaning Rule: a workflow node's category colour never looks like a status.
describe('Node categories never take a status hue', () => {
  const hue = (c: string) => {
    const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(c);
    return m && Number(m[2]) > 0.03 ? Number(m[3]) : null;
  };
  const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: every chromatic cat-* sits 20° or more from ok, wait, bad and undo`, () => {
      const p = palette(scheme);
      const statuses = (['ok', 'wait', 'bad', 'undo'] as const)
        .map((t) => hue(p[t]))
        .filter((h): h is number => h !== null);
      for (const cat of ['cat-trigger', 'cat-commerce', 'cat-control', 'cat-ai'] as const) {
        const h = hue(p[cat]);
        if (h === null) continue;
        for (const s of statuses)
          expect(apart(h, s), `${cat} near a status hue`).toBeGreaterThanOrEqual(20);
      }
    });
  }
});

describe('the docs draw only with defined `--cw-*` names', () => {
  const docs = (rel: string) => read(`../../../apps/docs/src/${rel}`);
  // The content reference components and their stylesheet; the site's chrome draws with `--ol-*`.
  const sources = [
    docs('styles/content.css'),
    ...[
      'CardHeading',
      'EndpointIndex',
      'NodeCatalog',
      'NodeIcon',
      'Scopes',
      'WorkflowTemplates',
    ].map((c) => docs(`components/content/${c}.astro`)),
  ].join('\n');
  const defined = (css: string) =>
    new Set([...css.matchAll(/(--cw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const theme = defined(docs('styles/theme.css'));
  const local = defined(docs('styles/content.css'));

  it('every `var(--cw-*)` resolves to the generated theme or a content.css local', () => {
    const used = new Set([...sources.matchAll(/var\((--cw-[a-z0-9-]+)/g)].map((m) => m[1]));
    const missing = [...used].filter((n) => !theme.has(n) && !local.has(n));
    expect(missing).toEqual([]);
  });

  it('content.css never redefines a token the theme owns', () => {
    expect([...local].filter((n) => theme.has(n))).toEqual([]);
  });
});
