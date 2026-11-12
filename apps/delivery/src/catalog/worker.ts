/**
 * The catalog-only Worker entry: what the fleet deploys (`wrangler.catalog.jsonc`). It serves
 * `/health`, the catalog's `/v1/*` routes, preflights and refusals as the catalog's public read API
 * always has, and drains the catalog's purge queue. It imports nothing of the content stack, so the
 * deployed script is the catalog's alone (`test/catalog-bundle.test.ts` bundles this file and holds
 * its size). A deployment with content on runs `src/index.ts`, which dispatches to both sides.
 */

import type { CatalogEnv } from './env';
import { catalogFetch, catalogQueue } from './gateway';

export { CatalogDelivery } from './delivery';
export { CatalogRead } from './read';

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true });
    return catalogFetch(request, env, ctx);
  },

  async queue(batch, _env, ctx) {
    await catalogQueue(batch, ctx);
  },
} satisfies ExportedHandler<CatalogEnv>;
