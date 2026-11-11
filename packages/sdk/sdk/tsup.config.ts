import { defineConfig } from 'tsup';

/**
 * One published package: every workspace SDK bundled into dist/, one entry per subpath. Types come
 * from scripts/types.ts (TypeScript 7 has no compiler API for a dts bundler), so users never see
 * the private workspace packages either way. React, Vue and
 * React Native stay external: they are optional peers.
 */
const entries = [
  'index',
  'inline-edit',
  'redirects',
  'webhooks',
  'rich-text',
  'edge',
  'management',
  'catalog',
  'commerce',
  'commerce-webhooks',
  'react',
  'vue',
  'react-native',
  'codegen',
];
const external = ['react', 'react-dom', 'react/jsx-runtime', 'vue', 'react-native'];

export default defineConfig([
  {
    entry: Object.fromEntries(entries.map((e) => [e, `src/${e}.ts`])),
    format: ['esm', 'cjs'],
    noExternal: [/^@commerceworker\//],
    external,
    splitting: true,
    clean: true,
    target: 'es2022',
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    noExternal: [/^@commerceworker\//],
    platform: 'node',
    target: 'node24',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
