import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

// Each subpath of @commerceworker/sdk re-exports one workspace SDK module, unchanged.
const SOURCES: Record<string, () => Promise<Record<string, unknown>>> = {
  '.': () => import('@commerceworker/sdk-core'),
  './inline-edit': () => import('@commerceworker/sdk-core/inline-edit'),
  './redirects': () => import('@commerceworker/sdk-core/redirects'),
  './webhooks': () => import('@commerceworker/sdk-core/webhooks'),
  './rich-text': () => import('@commerceworker/sdk-rich-text'),
  './edge': () => import('@commerceworker/sdk-edge'),
  './management': () => import('@commerceworker/sdk-management'),
  './react': () => import('@commerceworker/sdk-web'),
  './vue': () => import('@commerceworker/sdk-vue'),
  './react-native': () => import('@commerceworker/sdk-react-native'),
  './codegen': () => import('@commerceworker/sdk-codegen'),
};

const FACADES: Record<string, () => Promise<Record<string, unknown>>> = {
  '.': () => import('../src/index'),
  './inline-edit': () => import('../src/inline-edit'),
  './redirects': () => import('../src/redirects'),
  './webhooks': () => import('../src/webhooks'),
  './rich-text': () => import('../src/rich-text'),
  './edge': () => import('../src/edge'),
  './management': () => import('../src/management'),
  './react': () => import('../src/react'),
  './vue': () => import('../src/vue'),
  './react-native': () => import('../src/react-native'),
  './codegen': () => import('../src/codegen'),
};

describe('@commerceworker/sdk', () => {
  it('publishes exactly the subpaths it re-exports', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(SOURCES).sort());
    expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual(Object.keys(SOURCES).sort());
  });

  for (const [sub, source] of Object.entries(SOURCES)) {
    it(`${sub} exposes everything its workspace module exports`, async () => {
      const [want, got] = await Promise.all([source(), FACADES[sub]?.()]);
      expect(Object.keys(want).length).toBeGreaterThan(0);
      expect(Object.keys(got ?? {}).sort()).toEqual(Object.keys(want).sort());
      for (const key of Object.keys(want)) expect(got?.[key]).toBe(want[key]);
    });
  }
});
