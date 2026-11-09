import { createContentType, publishContentType, SYSTEM_CALLER } from '@commerceworker/application';
import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { createDeliveryClient } from '@commerceworker/sdk-core';
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
const cda = { Authorization: 'Bearer cda' };
const D = '/delivery/s1/main';
const scope = { spaceId: 's1', environmentId: 'main' };

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** An app with published `page` and `article` types that have URL patterns, and a draft `event`. */
async function setup() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  const define = async (apiId: string, urlPattern: string, publish = true) => {
    await createContentType(wired.ctx, SYSTEM_CALLER, scope, {
      apiId,
      name: apiId,
      displayField: 'title',
      urlPattern,
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'slug',
          name: 'Slug',
          type: 'Slug',
          localized: false,
          required: true,
          position: 1,
        },
      ],
    });
    if (publish) await publishContentType(wired.ctx, scope, apiId);
  };
  await define('page', '/{slug}');
  await define('article', '/blog/{slug}');
  await define('event', '/events/{slug}', false);
  return app;
}

describe('site routes over Delivery', () => {
  it('lists the published types’ URL patterns, by content type', async () => {
    const app = await setup();
    const res = await app.request(`${D}/routes`, { headers: cda });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      items: [
        { contentType: 'article', urlPattern: '/blog/{slug}' },
        { contentType: 'page', urlPattern: '/{slug}' },
      ],
      total: 2,
    });
  });

  it('shows a key limited to some content types only their routes', async () => {
    const app = await setup();
    const role = await json<{ id: string }>(
      await app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: 'Pages only',
          scopes: ['delivery:read'],
          contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
        }),
      }),
    );
    const { token } = await json<{ token: string }>(
      await app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cda', roleId: role.id }),
      }),
    );
    const res = await app.request(`${D}/routes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await json(res)).toEqual({
      items: [{ contentType: 'page', urlPattern: '/{slug}' }],
      total: 1,
    });
  });

  it('needs a delivery key', async () => {
    const app = await setup();
    expect((await app.request(`${D}/routes`)).status).toBe(401);
    expect(
      (await app.request(`${D}/routes`, { headers: { Authorization: 'Bearer x' } })).status,
    ).toBe(401);
  });

  it('is what the SDK’s routes() returns', async () => {
    const app = await setup();
    const client = createDeliveryClient({
      baseUrl: 'http://localhost',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });
    expect(await client.routes()).toEqual([
      { contentType: 'article', urlPattern: '/blog/{slug}' },
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });
});
