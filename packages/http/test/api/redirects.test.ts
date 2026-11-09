import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { describe, expect, it } from 'vitest';
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
    locales: ['en-US', 'de'],
    scale: 1,
  },
});

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function makeApp() {
  const wired = wire(config);
  return createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
}
type App = ReturnType<typeof makeApp>;

const send = (app: App, method: string, path: string, body?: unknown, headers = admin) =>
  app.request(`${M}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

interface Written {
  redirect: { id: string; source: string; enabled: boolean; destination: string };
  chains: { id: string; destination: string }[];
}

describe('redirects over HTTP', () => {
  it('creates, reads, searches, updates and deletes', async () => {
    const app = makeApp();
    const created = await send(app, 'POST', '/redirects', {
      source: '/old/',
      destination: '/new',
      note: 'Spring',
    });
    expect(created.status).toBe(201);
    const { redirect } = await json<Written>(created);
    expect(redirect.source).toBe('/old');
    expect((await send(app, 'GET', `/redirects/${redirect.id}`)).status).toBe(200);
    const found = await json<{ items: { id: string }[] }>(
      await send(app, 'GET', '/redirects?q=spring'),
    );
    expect(found.items.map((r) => r.id)).toEqual([redirect.id]);
    const patched = await json<Written>(
      await send(app, 'PATCH', `/redirects/${redirect.id}`, { enabled: false }),
    );
    expect(patched.redirect).toMatchObject({ enabled: false, destination: '/new' });
    expect((await send(app, 'DELETE', `/redirects/${redirect.id}`)).status).toBe(204);
    expect((await send(app, 'GET', `/redirects/${redirect.id}`)).status).toBe(404);
  });

  it('refuses a loop and a bad destination with 422, naming the field', async () => {
    const app = makeApp();
    await send(app, 'POST', '/redirects', { source: '/a', destination: '/b' });
    const loop = await send(app, 'POST', '/redirects', { source: '/b', destination: '/a' });
    expect(loop.status).toBe(422);
    const bad = await send(app, 'POST', '/redirects', {
      source: '/x',
      destination: 'javascript:alert(1)',
    });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain('destination');
    expect(
      (await send(app, 'POST', '/redirects', { source: '/x', destination: '/y', status: 303 }))
        .status,
    ).toBe(422);
  });

  it('imports CSV, reports and collapses chains, resolves and exports', async () => {
    const app = makeApp();
    const report = await json<{ created: number; chains: unknown[] }>(
      await send(app, 'POST', '/redirects/import', {
        format: 'csv',
        data: 'source,destination\n/a,/b\n/b,/c\n/blog/[slug],/posts/[slug]\n',
      }),
    );
    expect(report.created).toBe(3);
    expect(report.chains).toHaveLength(1);
    const analysis = await json<{ chains: unknown[]; loops: unknown[]; count: number }>(
      await send(app, 'GET', '/redirects/analysis'),
    );
    expect(analysis).toMatchObject({ count: 3, loops: [] });
    expect(await json(await send(app, 'POST', '/redirects/collapse-chains'))).toEqual({
      updated: 1,
    });
    const match = await json<{ location: string; status: number }>(
      await send(app, 'GET', '/redirects/resolve?path=%2Fblog%2Fhi%3Fx%3D1'),
    );
    expect(match).toMatchObject({ location: '/posts/hi?x=1', status: 301 });
    expect((await send(app, 'GET', '/redirects/resolve?path=/none')).status).toBe(404);
    const csv = await send(app, 'GET', '/redirects/export');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('/a,/c,301,,true,');
    const refused = await send(app, 'POST', '/redirects/import', {
      format: 'json',
      data: [
        { source: '/ok', destination: '/fine' },
        { source: 'nope', destination: '/x' },
      ],
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain('rows[1].source');
  });

  it('holds the scopes: reading needs preview:read, writing content:manage', async () => {
    const app = makeApp();
    expect((await send(app, 'GET', '/redirects', undefined, cpa)).status).toBe(200);
    expect(
      (await send(app, 'POST', '/redirects', { source: '/a', destination: '/b' }, cpa)).status,
    ).toBe(403);
  });

  it('serves the enabled set and one path’s match on Delivery', async () => {
    const app = makeApp();
    await send(app, 'POST', '/redirects', { source: '/a', destination: '/b', status: 308 });
    await send(app, 'POST', '/redirects', { source: '/off', destination: '/x', enabled: false });
    await send(app, 'POST', '/redirects', { source: '/a', destination: '/de/b', locale: 'de' });
    const list = await json<{ items: Record<string, unknown>[]; total: number }>(
      await app.request(`${D}/redirects`, { headers: cda }),
    );
    expect(list.total).toBe(2);
    expect(list.items.map((r) => r.source)).toEqual(['/a', '/a']);
    // Only what a front end needs: no note, origin or timestamps.
    expect(Object.keys(list.items[0] ?? {}).sort()).toEqual(
      ['destination', 'id', 'locale', 'source', 'status'].filter((k) =>
        k === 'locale' ? 'locale' in (list.items[0] ?? {}) : true,
      ),
    );
    const de = await json<{ location: string; status: number }>(
      await app.request(`${D}/redirects/resolve?path=/a&locale=de`, { headers: cda }),
    );
    expect(de).toMatchObject({ location: '/de/b', status: 301 });
    const any = await json<{ location: string; status: number }>(
      await app.request(`${D}/redirects/resolve?path=/a`, { headers: cda }),
    );
    expect(any).toMatchObject({ location: '/b', status: 308 });
    expect((await app.request(`${D}/redirects/resolve?path=/off`, { headers: cda })).status).toBe(
      404,
    );
    expect((await app.request(`${D}/redirects`)).status).toBe(401);
  });

  it('accepts a URL pattern on a content type, and refuses one naming no Slug field', async () => {
    const app = makeApp();
    const fields = [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
      { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: false, position: 1 },
    ];
    const ok = await send(app, 'POST', '/content-types', {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields,
      urlPattern: '/blog/{slug}',
    });
    expect(ok.status).toBe(201);
    expect(await json(ok)).toMatchObject({ urlPattern: '/blog/{slug}' });
    const bad = await send(app, 'POST', '/content-types', {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields,
      urlPattern: '/{title}',
    });
    expect(bad.status).toBe(422);
  });
});
