import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The catalog Worker in workerd, with local R2, KV, Durable Objects and CommerceWorker's D1 (its
// migrations applied in tests/setup.ts, for the `products` rows the catalog keeps).
export default defineConfig(async () => {
  const migrations = await readD1Migrations('../../packages/db/migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        remoteBindings: false,
        // Small feed chunks, so a test feed spans several Workflow steps.
        // Listing indexes build only when a test runs the indexer's alarm: one firing on its own
        // as a test file ends is cut off mid-RPC, which vitest reports as an unhandled error.
        miniflare: {
          bindings: {
            FEED_CHUNK: '300',
            LISTING_DELAY_MS: '3600000',
            GAP_REBUILD_DELAY_MS: '3600000',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      // No filesystem module cache: the Workers pool shares one cache under node_modules/.vitest-cache, and
      // parallel workerd suites read files another suite is rewriting ("no such file … readAll").
      fsModuleCache: false,
      include: ['tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 60_000,
    },
  };
});
