import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * The commerce D1 adapters' contract tests run in workerd against a real (Miniflare) D1, so the
 * SQL they emit is exercised by the same SQLite build a deployment gets. Each test file starts from
 * freshly applied migrations (test/setup.ts).
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        miniflare: {
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: { DB: 'commerceworker-commerce-test' },
          r2Buckets: ['DOCS'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      // No filesystem module cache: parallel workerd suites share one (see apps/engine/vitest.config.ts).
      fsModuleCache: false,
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
    },
  };
});
