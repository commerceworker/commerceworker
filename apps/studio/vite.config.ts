import { cloudflare } from '@cloudflare/vite-plugin';
import { DEV_ASSISTANT_PRINCIPAL_KEY } from '@commerceworker/security/assistant-key';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import agents from 'agents/vite';
import { defineConfig } from 'vite';

/**
 * The device tests (`pnpm --filter @commerceworker/studio e2e`) run the dev server offline: no remote
 * bindings, and a database of their own under .wrangler/e2e so they never touch the one
 * `pnpm dev` uses.
 */
const e2e = process.env.COMMERCEWORKER_E2E === '1';

/**
 * A fresh deployment's first run (`pnpm dev:first-run`): a database of its own under
 * .wrangler/first-run, nothing seeded, and the admin closed until set up, as a deployment is
 * (`awaitingSetup`), so /setup → /setup/two-factor → /setup/space can be walked locally.
 */
const firstRun = !e2e && process.env.COMMERCEWORKER_FIRST_RUN === '1';
// Its setup code is public and fixed: a build carrying it would let anyone become the first admin.
if (firstRun && process.argv.includes('build'))
  throw new Error('COMMERCEWORKER_FIRST_RUN is for local development (pnpm dev), never a build.');

/** The first run's setup code: local only, never a deployment's (they come from provisioning). */
const FIRST_RUN_SETUP_CODE = 'local-first-run';
if (firstRun)
  console.log(
    `\n  First run: every page goes to /setup until it is done. Setup code: ${FIRST_RUN_SETUP_CODE}\n`,
  );

/**
 * The dev server's port: PORT, else 5173. Fixed (strictPort), never "the next free one", because
 * the local stack's OAuth issuer, the MCP smoke scripts and the docs all name this origin; a busy
 * port fails fast instead of moving the admin somewhere they don't point.
 */
const port = Number(process.env.PORT) || 5173;

/**
 * Local-only settings for the auxiliary Workers: dev secrets (never a deployment's), mocked
 * models, hash embeddings, KV-backed vectors that every Worker shares (Vectorize has no local
 * emulator), and fakes allowed. The principal key matches the web Worker's own dev key
 * (DEV_PRINCIPAL_KEY).
 */
const LOCAL_STACK_VARS = {
  REQUIRE_SECURE_SECRETS: 'false',
  ADMIN_TOKEN: 'dev-admin-token',
  // The seeded space's dev keys (space-1): Management, Delivery and Preview.
  CMA_KEY: 'dev-cma-key',
  CDA_KEY: 'dev-cda-key',
  CPA_KEY: 'dev-cpa-key',
  MCP_TOKEN: 'dev-mcp-token',
  TOKEN_PEPPER: 'dev-pepper',
  MEDIA_SIGNING_SECRET: 'dev-media-signing-secret',
  PRINCIPAL_KEY: 'commerceworker-local-dev-principal-key',
  // The engine's assistant key: derived from the dev PRINCIPAL_KEY, as CI derives a deployment's.
  ASSISTANT_PRINCIPAL_KEY: DEV_ASSISTANT_PRINCIPAL_KEY,
  AI_MODE: 'mock',
  AI_GATEWAY_ID: '',
  EMBEDDINGS_PROVIDER: 'local',
  VECTOR_STORE: 'kv',
  ALLOW_FAKE_ADAPTERS: 'all',
  // Local dev always runs on the demo dataset (@commerceworker/seed), loaded on the api's first
  // request. The device tests keep their fresh, empty database: they create what they need.
  // Config validation refuses SEED_DEV wherever secure secrets are required.
  SEED_DEV: e2e || firstRun ? 'false' : 'true',
  // SEED_SCALE=10 pnpm dev seeds ~10× the demo corpus (with COMMERCEWORKER_STATE so it doesn't
  // land in the everyday database).
  SEED_SCALE: process.env.SEED_SCALE ?? '1',
  // The enterprise starter (installed in the background by the engine) is offered locally; the
  // device tests keep to the starters every deployment has.
  DEMO_STARTERS: e2e ? 'false' : 'true',
  // OAuth for MCP clients, served on the admin origin like a deployment's (OAUTH_ISSUER).
  OAUTH_ISSUER: `http://localhost:${port}`,
};

export default defineConfig({
  server: { port, strictPort: true },
  // Fingerprinted build output goes under /_static/, not Vite's default /assets/: /assets is the
  // admin's asset library (and /assets/:id its pages), so the two must never share a prefix that
  // public/_headers caches as immutable and the setup gate lets through.
  build: { assetsDir: '_static' },
  plugins: [
    // TC39 decorators (`@callable()` on the engine's AssistantAgent, run here as an auxiliary
    // Worker), which Vite's Oxc transform doesn't lower yet.
    ...agents(),
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // A fleet deploy builds against its rendered config.
      configPath: process.env.COMMERCEWORKER_STUDIO_WRANGLER_CONFIG,
      // Offline by default: models are mocked and vectors live in KV locally, so no binding needs
      // the remote resource, and a remote one would ask for a login and bill an account.
      // COMMERCEWORKER_REMOTE=1 pnpm dev opts in (never under the e2e harness).
      remoteBindings: !e2e && process.env.COMMERCEWORKER_REMOTE === '1',
      ...(e2e ? { persistState: { path: '.wrangler/e2e' } } : {}),
      ...(firstRun
        ? {
            persistState: { path: '.wrangler/first-run' },
            config: () => ({
              vars: { FIRST_RUN: 'true', SETUP_TOKEN: FIRST_RUN_SETUP_CODE },
            }),
          }
        : {}),
      // A separate local database (e.g. COMMERCEWORKER_STATE=.wrangler/scale for a large seed).
      ...(!e2e && !firstRun && process.env.COMMERCEWORKER_STATE
        ? { persistState: { path: process.env.COMMERCEWORKER_STATE } }
        : {}),
      // `pnpm dev` runs the whole stack in one session: this web Worker plus the api, engine
      // (queues, cron, Durable Objects, Workflows), media (its purge queue; MEDIA_PUBLIC_URL is
      // unset locally, so delivered assets keep the api's signed URLs) and delivery Workers, all on
      // one local D1.
      // Unless a fleet config is being built, which deploys each Worker on its own.
      ...(process.env.COMMERCEWORKER_STUDIO_WRANGLER_CONFIG
        ? {}
        : {
            auxiliaryWorkers: ['../api', '../pipeline', '../media', '../delivery'].map((dir) => ({
              configPath: `${dir}/wrangler.jsonc`,
              config: () => ({ vars: LOCAL_STACK_VARS }),
            })),
          }),
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  // The CMS screens' heavy client dependencies, pre-bundled up front: discovered mid-session they
  // trigger a re-optimization that can leave two copies of React in the page (dev only). The
  // assistant panel's are among them: it loads lazily, on whichever page is open when it does.
  optimizeDeps: {
    include: [
      '@ai-sdk/react',
      '@cloudflare/ai-chat/react',
      '@tanstack/react-query',
      '@tiptap/core',
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@xyflow/react',
      'agents/react',
      'ai',
      'recharts',
      'streamdown',
      'use-stick-to-bottom',
    ],
  },
});
