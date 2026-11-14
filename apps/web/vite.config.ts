import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { DEV_ASSISTANT_PRINCIPAL_KEY } from '@commerceworker/security/assistant-key';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import agents from 'agents/vite';
import { defineConfig, type Plugin } from 'vite';
import { buildSandboxBundle } from '../../packages/plugin-sdk/src/testing';

/**
 * Core's DEV_PRINCIPAL_KEY and DEV_DATA_KEY (Node can't load core's source here;
 * tests/dev-key.test.ts keeps them equal).
 */
const DEV_PRINCIPAL_KEY = 'commerceworker-local-dev-principal-key';
const DEV_DATA_KEY = 'commerceworker-local-dev-data-key';

/**
 * Plugins to run in dev (`COMMERCEWORKER_DEV_PLUGINS=example pnpm web:dev`), each as one more auxiliary
 * Worker bound to the web app and the engine as PLUGIN_<ID>, as a deployment's registry would
 * (apply its migrations first). `<id>:sandboxed` runs one sandboxed instead: its bundle is built
 * here and handed to the engine (PLUGIN_BUNDLES, and PLUGIN_DEV_BUNDLES since dev's DOCS bucket
 * doesn't have it), and its storage migrates itself. See docs/plugins.md.
 */
const devEntries = (process.env.COMMERCEWORKER_DEV_PLUGINS ?? '')
  .split(',')
  .filter(Boolean)
  .map((e) => ({ id: e.split(':')[0]!, sandboxed: e.split(':')[1] === 'sandboxed' }));
const devPlugins = devEntries.filter((e) => !e.sandboxed).map((e) => e.id);
const devSandboxed = devEntries.filter((e) => e.sandboxed).map((e) => e.id);
const pluginServices = devPlugins.map((p) => ({
  binding: `PLUGIN_${p.toUpperCase().replaceAll('-', '_')}`,
  service: `commerceworker-plugin-${p}`,
}));
/**
 * A publisher dev trusts for runtime installs (`COMMERCEWORKER_DEV_PUBLISHER=<name>:<public key>`, from
 * `pnpm plugin:pack keygen`), as a deployment's registry lists them in `pluginInstalls`.
 */
const devPublisher = process.env.COMMERCEWORKER_DEV_PUBLISHER?.split(':');
const publisherVars: Record<string, string> =
  devPublisher?.length === 2
    ? { PLUGIN_PUBLISHERS: JSON.stringify({ [devPublisher[0]!]: devPublisher[1] }) }
    : {};
const withPlugins = (services: { binding: string; service: string }[] = []) => [
  ...services,
  ...pluginServices,
];

/**
 * The device tests (`pnpm --filter @commerceworker/web e2e`) run the dev server offline: no remote
 * bindings, mock AI, and a database of their own under .wrangler/e2e so they never touch the one
 * `pnpm web:dev` uses.
 */
const e2e = process.env.COMMERCEWORKER_E2E === '1';
const content = process.env.COMMERCEWORKER_CONTENT === '1';

const contentServices = [{ binding: 'CONTENT_API', service: 'commerceworker-api' }];
const contentVars = {
  REQUIRE_SECURE_SECRETS: 'false',
  AI_MODE: 'mock',
  ADMIN_TOKEN: 'dev-admin-token',
  CMA_KEY: 'dev-cma-key',
  CDA_KEY: 'dev-cda-key',
  CPA_KEY: 'dev-cpa-key',
  MCP_TOKEN: 'dev-mcp-token',
  TOKEN_PEPPER: 'dev-pepper',
  MEDIA_SIGNING_SECRET: 'dev-media-signing-secret',
  PRINCIPAL_KEY: DEV_PRINCIPAL_KEY,
  ASSISTANT_PRINCIPAL_KEY: DEV_ASSISTANT_PRINCIPAL_KEY,
  EMBEDDINGS_PROVIDER: 'local',
  VECTOR_STORE: 'kv',
  ALLOW_FAKE_ADAPTERS: 'all',
  SEED_DEV: e2e ? 'false' : 'true',
};

/**
 * In a build, Streamdown's `rehype-raw` import resolves to a no-op (`app/lib/rehype-raw-off.ts`),
 * which keeps parse5 out of the assistant panel. Build only: the dev server pre-bundles Streamdown
 * without asking this hook, so raw HTML in a reply still parses in dev.
 */
const withoutRehypeRaw = (): Plugin => ({
  name: 'commerceworker:without-rehype-raw',
  enforce: 'pre',
  apply: 'build',
  resolveId: (id) =>
    id === 'rehype-raw'
      ? fileURLToPath(new URL('./app/lib/rehype-raw-off.ts', import.meta.url))
      : null,
});

export default defineConfig(async () => {
  const bundles = await Promise.all(
    devSandboxed.map(async (id) => ({
      id,
      ...(await buildSandboxBundle(
        `../../plugins/${id}/src/index.ts`,
        `../../plugins/${id}/migrations`,
      )),
    })),
  );
  const sandboxVars: Record<string, string> = bundles.length
    ? {
        PLUGIN_BUNDLES: JSON.stringify(Object.fromEntries(bundles.map((b) => [b.id, b.sha]))),
        PLUGIN_DEV_BUNDLES: JSON.stringify(Object.fromEntries(bundles.map((b) => [b.id, b.body]))),
        // The engine reads PLUGIN_DEV_BUNDLES only with this set (local dev only).
        DEV_SANDBOX: 'true',
      }
    : {};
  return {
    plugins: [
      withoutRehypeRaw(),
      // TC39 decorators in the engine's OrderAgent (`@callable()`); Oxc doesn't transform them yet.
      ...agents(),
      cloudflare({
        viteEnvironment: { name: 'ssr' },
        // A fleet deploy builds against its rendered config (`scripts/fleet.ts render <id>`).
        configPath: process.env.COMMERCEWORKER_WRANGLER_CONFIG,
        ...(e2e
          ? {
              remoteBindings: false,
              persistState: { path: process.env.COMMERCEWORKER_STATE ?? '.wrangler/e2e' },
            }
          : {}),
        // The storefront runs beside it (`pnpm storefront:dev`) on its own port.
        config: (c) => ({
          vars: { STOREFRONT_ORIGIN: 'http://localhost:5174' },
          ...(devPlugins.length || content
            ? { services: [...withPlugins(c.services), ...(content ? contentServices : [])] }
            : {}),
          ...(content
            ? {
                d1_databases: [
                  ...(c.d1_databases ?? []),
                  {
                    binding: 'CONTENT_DB',
                    database_name: 'commerceworker-content',
                    database_id: '00000000-0000-0000-0000-000000000001',
                    migrations_dir: '../../packages/store/migrations',
                  },
                ],
              }
            : {}),
        }),
        // In dev, run the engine Worker in the same session so the ENGINE service binding, its
        // OrderAgent Durable Objects and Workflows all work locally. It deploys on its own. Dev
        // compresses waits so scenarios finish in minutes (production runs in real time), calls
        // Workers AI directly rather than through production's AI Gateway and its rate limit, and
        // checks the principal header with, and encrypts secrets under, the dev keys the web Worker
        // uses in dev.
        auxiliaryWorkers: [
          {
            configPath: '../engine/wrangler.jsonc',
            config: (c) => ({
              vars: {
                TIME_SCALE: '1440',
                STOREFRONT_ORIGIN: 'http://localhost:5174',
                OWN_HOSTS: 'localhost',
                AI_GATEWAY_ID: '',
                PRINCIPAL_KEY: DEV_PRINCIPAL_KEY,
                DATA_KEY: DEV_DATA_KEY,
                SIMULATE_FAILURES: 'true',
                ...(e2e ? { AI_MODE: 'mock' } : {}),
                ...sandboxVars,
                ...publisherVars,
              },
              ...(devPlugins.length ? { services: withPlugins(c.services) } : {}),
            }),
            devOnly: true,
          },
          // The product catalog, so the Catalog page, /api/v1/catalog and the engine's CATALOG
          // binding work locally. It deploys on its own.
          { configPath: '../catalog/wrangler.jsonc', devOnly: true },
          ...(content
            ? ['api', 'pipeline', 'media', 'delivery'].map((app) => ({
                configPath: `../${app}/wrangler.jsonc`,
                config: (c: {
                  services?: { binding: string; service: string; entrypoint?: string }[];
                  d1_databases?: {
                    binding: string;
                    database_name: string;
                    database_id?: string;
                    migrations_dir?: string;
                  }[];
                }) => {
                  // Config arrays are merged with defaults: mutate the local binding rather than append a duplicate DB.
                  const db = c.d1_databases?.find((db) => db.binding === 'DB');
                  if (db) db.database_id = '00000000-0000-0000-0000-000000000001';
                  return {
                    vars: contentVars,
                    ...(app === 'pipeline'
                      ? {
                          services: [
                            ...(c.services ?? []),
                            {
                              binding: 'CONTENT_IDENTITY',
                              service: 'commerceworker-web',
                            },
                          ],
                        }
                      : {}),
                  };
                },
                devOnly: true,
              }))
            : []),
          ...devPlugins.map((p) => ({
            configPath: `../../plugins/${p}/wrangler.jsonc`,
            // Its own key, as scripts/fleet.ts derives it: never the principal key.
            config: {
              vars: {
                PLUGIN_KEY: createHmac('sha256', DEV_PRINCIPAL_KEY)
                  .update(`commerceworker-plugin:${p}`)
                  .digest('hex'),
              },
            },
            devOnly: true,
          })),
        ],
      }),
      tailwindcss(),
      reactRouter(),
    ],
    resolve: {
      tsconfigPaths: true,
    },
    // Discover the shared content screens' heavy browser dependencies before the first navigation.
    optimizeDeps: {
      include: [
        '@ai-sdk/react',
        '@cloudflare/ai-chat/react',
        '@xyflow/react',
        'agents/react',
        'ai',
        'recharts',
        'streamdown',
        'shiki',
        'zod',
        'class-variance-authority',
        ...[
          '@tanstack/react-query',
          '@tiptap/core',
          '@tiptap/react',
          '@tiptap/starter-kit',
          'use-stick-to-bottom',
          'radix-ui',
        ].map((dependency) => `@commerceworker/content-admin > ${dependency}`),
      ],
    },
  };
});
