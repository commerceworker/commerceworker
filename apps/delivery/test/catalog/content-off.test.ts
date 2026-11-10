import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// test/catalog/wrangler.jsonc binds the catalog and none of the content stack (no DB, KV_CACHE,
// MEDIA_BUCKET, AI, VECTORIZE, LIVE_HUB, SEARCH, rate limit or content queue): one Worker, content off.
const get = (path: string, init?: RequestInit) =>
  (exports as unknown as { default: Fetcher }).default.fetch(
    `https://catalog.example${path}`,
    init,
  );

describe('the delivery Worker with content off', () => {
  it('serves a catalog read', async () => {
    expect((await get('/v1/web/en/categories')).status).toBe(404); // nothing published yet: a miss, not a crash
    const r = await get('/v1/web/en/products/none');
    expect(r.status).toBe(404);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers 404 to the content routes, with the catalog headers', async () => {
    for (const path of ['/delivery/space/env/entries', '/graphiql/space/env']) {
      const r = await get(path);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not found' });
    }
  });

  it('reports only what is bound', async () => {
    expect(await (await get('/health')).json()).toEqual({ ok: true, serves: ['catalog'] });
  });

  it('refuses a write and answers a preflight on any path', async () => {
    expect((await get('/v1/web/en/products/tee', { method: 'POST' })).status).toBe(405);
    expect((await get('/delivery/x', { method: 'OPTIONS' })).status).toBe(204);
  });
});
