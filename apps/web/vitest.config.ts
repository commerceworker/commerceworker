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
          fsModuleCache: false,
          // It imports `cloudflare:workers`; inlined, the tests' vi.mock of that module applies to it.
          // Streamdown is inlined so the alias above reaches its `rehype-raw` import.
          server: { deps: { inline: ['@cloudflare/workers-oauth-provider', 'streamdown'] } },
        },
      },
      // The nightly OAuth grant export (workers/kv-backup.ts) as a real Workflow, with local KV and R2.
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './workerd/wrangler.jsonc' },
            remoteBindings: false,
          }),
        ],
        test: {
          name: 'kv-backup',
          include: ['workerd/**/*.test.ts'],
          fsModuleCache: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
