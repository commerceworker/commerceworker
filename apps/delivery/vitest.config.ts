import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The catalog's SearchApi is a stub Worker: "tee" matches uids 7, 70 and 71, nothing else matches.
const catalogStub = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class SearchApi extends WorkerEntrypoint {
  async search(channel, locale, q, limit, offset) {
    const all = q === 'tee' ? [7, 70, 71] : [];
    return { total: all.length, uids: all.slice(offset, offset + limit) };
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };
`;

export default defineConfig({
  test: {
    // No filesystem module cache: the Workers pool shares one cache under node_modules/.vitest-cache, and
    // parallel workerd suites read files another suite is rewriting ("no such file … readAll").
    fsModuleCache: false,
    projects: [
      // Unit tests for the content gateway's pure parts (visibility profiles, canonical cache URLs,
      // the rationed purge drain) and the catalog path's bundle budget.
      {
        test: {
          name: 'unit',
          include: ['test/*.test.ts'],
          environment: 'node',
          fsModuleCache: false,
        },
      },
      // The catalog-only entry (src/catalog/worker.ts, as wrangler.catalog.jsonc deploys it; no
      // content binding) with local R2 and KV. Workers Caching isn't emulated locally, so these
      // tests check what reaches the cache (canonical URLs, headers, 304s); production checks the rest.
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './test/catalog/wrangler.jsonc' },
            remoteBindings: false,
            miniflare: {
              workers: [
                {
                  name: 'commerceworker-catalog',
                  modules: true,
                  script: catalogStub,
                  compatibilityDate: '2026-10-01',
                },
              ],
            },
          }),
        ],
        test: {
          name: 'catalog',
          include: ['test/catalog/**/*.test.ts'],
          fsModuleCache: false,
        },
      },
      // The dispatcher (src/index.ts) with the catalog bound and content off.
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './test/dispatcher/wrangler.jsonc' },
            remoteBindings: false,
            miniflare: {
              workers: [
                {
                  name: 'commerceworker-catalog',
                  modules: true,
                  script: catalogStub,
                  compatibilityDate: '2026-10-01',
                },
              ],
            },
          }),
        ],
        test: {
          name: 'dispatcher',
          include: ['test/dispatcher/**/*.test.ts'],
          fsModuleCache: false,
          // The first request loads the whole content side (src/content.ts), which takes more than
          // vitest's 5 s default on a loaded CI runner.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
