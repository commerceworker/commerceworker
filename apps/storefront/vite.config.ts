import { cloudflare } from '@cloudflare/vite-plugin';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import agents from 'agents/vite';
import { defineConfig } from 'vite';

/**
 * Core's DEV_PRINCIPAL_KEY (Node can't load core's source here; the web app's tests/dev-key.test.ts
 * keeps it equal).
 */
const DEV_PRINCIPAL_KEY = 'commerceworker-local-dev-principal-key';

/**
 * The device tests (`pnpm --filter @commerceworker/storefront e2e`) run the dev server offline: no
 * remote bindings, mock AI, and a database of their own under .wrangler/e2e so they never touch
 * the one `pnpm storefront:dev` uses.
 */
const e2e = process.env.COMMERCEWORKER_E2E === '1';

/** Where the storefront is served (`pnpm storefront:dev`, or the device tests' port). */
const PORT = e2e ? Number(process.env.E2E_PORT ?? 5391) : 5174;

export default defineConfig({
  plugins: [
    // TC39 decorators in the engine's agents (`@callable()`); Oxc doesn't transform them yet.
    ...agents(),
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // A fleet deploy builds against its rendered config (`scripts/fleet.ts render <id>`).
      configPath: process.env.COMMERCEWORKER_WRANGLER_CONFIG,
      ...(e2e ? { remoteBindings: false, persistState: { path: '.wrangler/e2e' } } : {}),
      // The ENGINE binding needs an engine to reach, so the storefront runs one in its own Vite
      // session, as the web app does: with its own local database and Durable Objects
      // (`.wrangler/state`), so a cart opened in `pnpm web:dev`'s engine is not here. It signs and
      // checks with the dev keys the web Worker uses in dev, and compresses waits the same way.
      auxiliaryWorkers: [
        {
          configPath: '../engine/wrangler.jsonc',
          config: () => ({
            vars: {
              TIME_SCALE: '1440',
              STOREFRONT_ORIGIN: `http://localhost:${PORT}`,
              OWN_HOSTS: 'localhost',
              AI_GATEWAY_ID: '',
              PRINCIPAL_KEY: DEV_PRINCIPAL_KEY,
              ...(e2e ? { AI_MODE: 'mock', EMAIL_FROM: 'shop@e2e.test' } : {}),
            },
            // The device tests' engine can send mail (miniflare takes it and sends nothing): shoppers can
            // sign in, which identity linking is on only where they can.
            ...(e2e ? { send_email: [{ name: 'EMAIL' }] } : {}),
          }),
          devOnly: true,
        },
        { configPath: '../catalog/wrangler.jsonc', devOnly: true },
      ],
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
