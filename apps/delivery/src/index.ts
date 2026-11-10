/**
 * The delivery Worker: two public, read-only surfaces behind one default entrypoint, each with its
 * own cached entrypoint behind Workers Caching.
 *
 * - Content (`/delivery/*`, `/graphiql/*`; content.ts, cached `Delivery`): on when the content
 *   stack is bound (`DB`).
 * - Catalog (`/v1/<channel>/<locale>/…`; catalog/, cached `CatalogDelivery`): on when the catalog's
 *   published documents are bound (`PUBLISHED` and `CARDS`).
 *
 * Either may be off. A surface that isn't bound answers 404, and `/health` names only what is
 * bound. Each surface sets its own CORS and security headers (`PUBLIC` in content.ts and
 * `CATALOG_PUBLIC` in catalog/gateway.ts).
 *
 * Queues route on the batch's queue: the catalog's purge queue to the catalog, every other to
 * content, as before.
 */
import type { EdgeEnv } from '@commerceworker/platform/env';
import type { CatalogEnv } from './catalog/env';
import { catalogFetch, catalogQueue } from './catalog/gateway';
import { content } from './content';

export { CatalogDelivery } from './catalog/delivery';
export { Delivery } from './delivery';

type Env = EdgeEnv & Partial<CatalogEnv>;

/** The catalog is served when its documents and cards are bound; search and analytics are optional. */
const catalogOn = (env: Env): env is Env & CatalogEnv => !!env.PUBLISHED && !!env.CARDS;
const contentOn = (env: Env) => !!env.DB;

/** The catalog's purge queue, whatever the deployment's suffix: content queues never start so. */
const CATALOG_PURGE = 'commerceworker-catalog-purge';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const catalog = catalogOn(env);
    if (pathname === '/health' && catalog)
      return Response.json({
        ok: true,
        serves: ['catalog', ...(contentOn(env) ? ['content'] : [])],
      });
    if (pathname === '/health' && !contentOn(env)) return Response.json({ ok: true, serves: [] });
    // The catalog owns /v1/ and, with content off, every other request too: its gateway answers
    // preflights, refuses writes and 404s what it doesn't serve, as the catalog Worker did.
    if (catalog && (pathname.startsWith('/v1/') || !contentOn(env)))
      return catalogFetch(request, env, ctx);
    if (contentOn(env)) return content.fetch(request, env, ctx);
    return Response.json({ error: 'not found' }, { status: 404 });
  },

  async queue(batch, env, ctx) {
    if (catalogOn(env) && batch.queue.startsWith(CATALOG_PURGE)) return catalogQueue(batch, ctx);
    if (!contentOn(env)) throw new Error(`no consumer bound for queue ${batch.queue}`);
    return content.queue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
