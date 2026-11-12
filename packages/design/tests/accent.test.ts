import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { palette } from '../src/tokens';
import { contrast, hueApart, hueOf, linearSrgb, srgb } from './color';

// The CommerceWorker accent (ROADMAP P9, docs/brand/messaging.md "Visual accent"): Arizona turquoise.
// Each claim DESIGN.md makes about it is a number here, in both themes: text on it, it as text, it
// on its own tint, its focus edge, and how far its hue sits from the link and status hues.

const ground = ['paper', 'card', 'muted', 'sidebar', 'sidebar-accent'] as const;

describe('the brand accent holds AA in both themes', () => {
  for (const scheme of ['light', 'dark'] as const) {
    const p = palette(scheme);
    const brand = srgb(p.brand);

    it(`${scheme}: text on an accent fill holds 4.5:1`, () => {
      expect(contrast(srgb(p['brand-foreground']), brand)).toBeGreaterThanOrEqual(4.5);
    });

    for (const on of ground) {
      it(`${scheme}: accent text on ${on} holds 4.5:1`, () => {
        expect(contrast(brand, srgb(p[on]))).toBeGreaterThanOrEqual(4.5);
      });
      // The focus ring is a UI component edge: 3:1 (WCAG 1.4.11), and WCAG 2.4.13's focus appearance.
      it(`${scheme}: the focus ring against ${on} holds 3:1`, () => {
        expect(contrast(srgb(p.ring), srgb(p[on]))).toBeGreaterThanOrEqual(3);
      });
    }

    it(`${scheme}: accent text on its subtle surface holds 4.5:1`, () => {
      expect(contrast(brand, srgb(p['brand-subtle']))).toBeGreaterThanOrEqual(4.5);
    });
    it(`${scheme}: body and muted text on the subtle surface hold 4.5:1`, () => {
      expect(contrast(srgb(p.foreground), srgb(p['brand-subtle']))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(srgb(p['muted-foreground']), srgb(p['brand-subtle']))).toBeGreaterThanOrEqual(
        4.5,
      );
    });
    it(`${scheme}: the subtle surface is a tint, not a fill: it sits within 1.5:1 of the page`, () => {
      // Dark lifts a step above the page, light dips a step under it; either way it must not shout.
      expect(contrast(srgb(p['brand-subtle']), srgb(p.paper))).toBeLessThan(1.5);
    });

    it(`${scheme}: the accent is inside sRGB, so no browser clips it to something else`, () => {
      for (const t of ['brand', 'brand-subtle', 'link'] as const)
        for (const c of linearSrgb(p[t])) {
          expect(c).toBeGreaterThan(-0.01);
          expect(c).toBeLessThan(1.01);
        }
    });
  }
});

describe('the brand accent is its own hue', () => {
  // 20 degrees is where the One Meaning Rule's node-category check draws the line (tokens.test.ts).
  const MIN_APART = 20;
  for (const scheme of ['light', 'dark'] as const) {
    const p = palette(scheme);
    const brand = hueOf(p.brand);

    it(`${scheme}: it is turquoise, about hue 195`, () => {
      expect(brand).not.toBeNull();
      expect(hueApart(brand!, 195)).toBeLessThanOrEqual(10);
    });

    it(`${scheme}: it sits ${MIN_APART} degrees or more from the link blue`, () => {
      expect(hueApart(brand!, hueOf(p.link)!)).toBeGreaterThanOrEqual(MIN_APART);
    });

    it(`${scheme}: it sits ${MIN_APART} degrees or more from every status hue and the AI violet`, () => {
      for (const t of ['ok', 'wait', 'bad', 'undo', 'ai'] as const)
        expect(hueApart(brand!, hueOf(p[t])!), `brand near ${t}`).toBeGreaterThanOrEqual(MIN_APART);
    });

    // Turquoise can't out-saturate the link inside sRGB at text contrast (it tops out near 0.09 at
    // L 0.5), so the two are kept apart by hue instead: well past the 20-degree floor above.
    it(`${scheme}: it sits 35 degrees or more from the link blue, so the two never read as one`, () => {
      expect(hueApart(brand!, hueOf(p.link)!)).toBeGreaterThanOrEqual(35);
    });
  }
});

// The flat assets can't read tokens: the favicons, the OG image and the Home Screen icons carry the
// accent as sRGB hex. They must be the tokens' own colours, and hold their bar on the chrome they sit
// in (the manifest's and `theme-color`'s white and #0a0a0a; a graphic needs 3:1, WCAG 1.4.11).
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const hex = (color: string) =>
  `#${srgb(color)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
const fromHex = (h: string) =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as unknown as ReturnType<
    typeof srgb
  >;

describe('the accent in flat assets', () => {
  const light = hex(palette('light').brand);
  const dark = hex(palette('dark').brand);

  it('the hex we ship is the token, light and dark', () => {
    expect([light, dark]).toEqual(['#007373', '#3bcfcf']);
  });

  for (const app of ['marketing', 'docs', 'studio'] as const) {
    it(`apps/${app}/public/favicon.svg is the accent in light and the lighter accent in dark`, () => {
      const svg = read(`../../../apps/${app}/public/favicon.svg`);
      expect(svg).toContain(`color="${light}"`);
      expect(svg).toContain(`svg{color:${dark}}`);
    });
  }

  it('the OG image draws its mark and wordmark in the light accent', () => {
    const svg = read('../../../apps/marketing/public/og-image.svg');
    expect(svg.match(new RegExp(light, 'g'))?.length).toBeGreaterThanOrEqual(4);
  });

  it('the favicon holds 3:1 on the browser chrome: white in light, #0a0a0a in dark', () => {
    expect(contrast(fromHex(light), fromHex('#ffffff'))).toBeGreaterThanOrEqual(3);
    expect(contrast(fromHex(dark), fromHex('#0a0a0a'))).toBeGreaterThanOrEqual(3);
  });

  it('the OG image text holds 4.5:1 on its white ground', () => {
    expect(contrast(fromHex(light), fromHex('#ffffff'))).toBeGreaterThanOrEqual(4.5);
  });
});
