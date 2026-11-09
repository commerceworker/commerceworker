import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
});

const get = (path: string, token = 'cma') =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } });

describe('GET /guides', () => {
  it('lists pages with outlines', async () => {
    const res = await get('/guides');
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: { path: string; title: string; headings: unknown[] }[];
    };
    expect(items.find((p) => p.path === 'api-reference')?.headings.length).toBeGreaterThan(1);
  });

  it('takes any valid token, not one particular scope', async () => {
    // The docs are the same for every space. Gating them on content:manage
    // would keep them from the delivery-only agent most likely to need them.
    for (const token of ['cma', 'cda', 'cpa']) {
      expect((await get('/guides', token)).status).toBe(200);
    }
  });

  it('still requires a token', async () => {
    // Not because the content is secret, but because a deployment should not
    // start serving a public docs site by side effect.
    expect((await app.request('/guides')).status).toBe(401);
  });

  it('leaves /docs to the OpenAPI UI', async () => {
    // `/docs` was already taken; these are the product's guides, not the
    // generated API reference, and shadowing it would break the spec browser.
    expect((await app.request('/docs')).status).toBe(200);
  });
});

describe('GET /guides/:path', () => {
  it('returns the page body', async () => {
    const { body } = (await (await get('/guides/architecture')).json()) as { body: string };
    expect(body).toContain('#');
    expect(body.length).toBeGreaterThan(1000);
  });

  it('returns one section when asked', async () => {
    const whole = (await (await get('/guides/architecture')).json()) as { body: string };
    const listed = (await (await get('/guides')).json()) as {
      items: { path: string; headings: { depth: number; slug: string }[] }[];
    };
    const slug = listed.items
      .find((p) => p.path === 'architecture')
      ?.headings.find((h) => h.depth === 2)?.slug as string;
    const part = (await (await get(`/guides/architecture?section=${slug}`)).json()) as {
      body: string;
    };
    expect(part.body.length).toBeLessThan(whole.body.length);
  });

  it('404s for a page or section that does not exist', async () => {
    expect((await get('/guides/no-such-page')).status).toBe(404);
    expect((await get('/guides/architecture?section=no-such-section')).status).toBe(404);
  });
});

describe('GET /guides/search', () => {
  it('finds a term and says where it is', async () => {
    const { items } = (await (await get('/guides/search?q=UUIDv7')).json()) as {
      items: { path: string; line: number }[];
    };
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.line).toBeGreaterThan(0);
  });

  it('is not shadowed by the page route', async () => {
    // `/guides/search` and `/guides/:path` collide; if the wildcard won, this
    // would 404 looking for a page called "search".
    expect((await get('/guides/search?q=outbox')).status).toBe(200);
  });

  it('honours a limit', async () => {
    const { items } = (await (await get('/guides/search?q=the&limit=3')).json()) as {
      items: unknown[];
    };
    expect(items.length).toBe(3);
  });

  it('returns nothing for an empty query', async () => {
    const { items } = (await (await get('/guides/search?q=')).json()) as { items: unknown[] };
    expect(items).toEqual([]);
  });
});
