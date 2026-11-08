import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs the media Worker itself in workerd: its gateway, the cached `Media` entrypoint (reached
// through ctx.exports, as in production), KV for the gate, R2 for the bytes, and a D1 with every
// migration applied for the replica fallback. The Images binding is a fake the tests install
// (test/fixtures/images.ts): Miniflare's own needs a network-backed image service.
export default defineConfig(async () => ({
  test: {
    // No filesystem module cache: the Workers pool shares one cache under node_modules/.vitest-cache, and
    // parallel workerd suites read files another suite is rewriting ("no such file … readAll").
    fsModuleCache: false,
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
  plugins: [
    cloudflareTest({
      main: './test/fixtures/worker.ts',
      miniflare: {
        // Production's date (wrangler.jsonc).
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'commerceworker-media-test' },
        kvNamespaces: ['KV_CACHE'],
        r2Buckets: ['MEDIA_BUCKET'],
        bindings: {
          MEDIA_SIGNING_SECRET: 'media-test-signing-secret-0123456789abcdef',
          TEST_MIGRATIONS: await readD1Migrations('../../packages/store/migrations'),
        },
      },
    }),
  ],
}));
