/**
 * CatalogRead: what other Workers of the deployment bind to read the catalog (the engine's
 * `CATALOG_EDGE`, for UCP catalog search). A service binding to `CatalogDelivery` would also expose
 * its `purge` method and its `/_idx/` index blobs; this entrypoint has only `fetch`, answers only
 * the public routes, and forwards each by its canonical URL (the gateway's own rule), so a caller
 * can neither purge nor create a cache entry the public API would not.
 *
 * Its cache is off, as the gateway's: the entry it forwards to is the cached one.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { CatalogDelivery } from './delivery';
import { canonical, parse } from './routes';

type Exports = { CatalogDelivery: Service<CatalogDelivery> };

export class CatalogRead extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return Response.json(
        { error: 'read only' },
        { status: 405, headers: { allow: 'GET, HEAD' } },
      );
    const parsed = parse(new URL(request.url));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const headers = new Headers();
    const inm = request.headers.get('if-none-match');
    if (inm) headers.set('if-none-match', inm);
    const exports = (this.ctx as unknown as { exports: Exports }).exports;
    return exports.CatalogDelivery.fetch(new Request(canonical(parsed.route), { headers }));
  }
}
