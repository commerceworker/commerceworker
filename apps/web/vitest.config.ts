import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No filesystem module cache: the Workers pool shares one cache under node_modules/.vitest-cache,
    // and parallel workerd suites read files another suite is rewriting.
    fsModuleCache: false,
    projects: [
      {
        resolve: {
          tsconfigPaths: true,
          // As in a build (vite.config.ts): replies render without rehype-raw.
          alias: {
            'rehype-raw': fileURLToPath(new URL('./app/lib/rehype-raw-off.ts', import.meta.url)),
          },
        },
        test: {
          name: 'web',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**'],
          fsModuleCache: false,
          // It imports `cloudflare:workers`; inlined, the tests' vi.mock of that module applies to it.
          // Streamdown is inlined so the alias above reaches its `rehype-raw` import.
          server: { deps: { inline: ['@cloudflare/workers-oauth-provider', 'streamdown'] } },
        },
      },
      // Integration coverage for Cloudflare primitives: Workflows, KV, R2 and HTMLRewriter.
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './tests/integration/wrangler.jsonc' },
            remoteBindings: false,
          }),
        ],
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          fsModuleCache: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
