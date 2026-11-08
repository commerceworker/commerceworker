import type { ApiConfig } from '@commerceworker/platform/config';
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
    locales: ['en-US'],
    scale: 1,
  },
});

const json = (token: string, body?: unknown) => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

describe('@commerceworker/sdk-core against the live Delivery API (in-process)', () => {
  it('reads published content authored via the Management API', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai);
    const M = '/spaces/s1/environments/main';

    // Author + publish via the Management API (CMA key).
    await app.request(
      `${M}/content-types`,
      json('cma', {
        apiId: 'article',
        name: 'Article',
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: true,
            position: 0,
          },
        ],
      }),
    );
    await app.request(`${M}/content-types/article/published`, json('cma'));
    const created = await app.request(
      `${M}/entries`,
      json('cma', { contentTypeApiId: 'article', fields: { title: { 'en-US': 'SDK reads me' } } }),
    );
    const { entry } = (await created.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, json('cma'));

    // The SDK drives the real Delivery API via an injected fetch (CDA token).
    const client = createDeliveryClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });

    const got = await client.getEntry(entry.id);
    expect(got.contentType).toBe('article');
    expect((got.fields.title as Record<string, string>)['en-US']).toBe('SDK reads me');

    const list = await client.query().contentType('article').fetch();
    expect(list.total).toBe(1);
    expect(list.items[0]?.id).toBe(entry.id);
  });

  it('SDK with an invalid token surfaces a 401 DeliveryError', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai);
    const client = createDeliveryClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'bogus',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });
    await expect(client.getEntry('whatever')).rejects.toMatchObject({ status: 401 });
  });
});
