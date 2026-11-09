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
    locales: ['en-US'],
    scale: 1,
  },
});
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

describe('Delivery delta cursor (?since)', () => {
  it('returns only entries published after the cursor', async () => {
    const { ctx, rag, blob, ai } = wire(config);
    const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId: 'post',
        name: 'Post',
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
    });
    await app.request(`${M}/content-types/post/published`, { method: 'POST', headers: cma });

    const publish = async (title: string) => {
      const r = await app.request(`${M}/entries`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify({ contentTypeApiId: 'post', fields: { title: { 'en-US': title } } }),
      });
      const { entry } = (await r.json()) as { entry: { id: string } };
      await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });
      return entry.id;
    };
    await publish('first');
    await publish('second');

    const client = createDeliveryClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });

    // Full pull, capture the cursor (last publishedAt).
    const all = await client.listEntries({ contentType: 'post' });
    expect(all.items.length).toBe(2);
    const cursor = all.items[all.items.length - 1]?.publishedAt as string;

    // A later publish.
    await publish('third');

    // Delta pull since the cursor → only the new entry.
    const delta = await client.listEntries({ contentType: 'post', since: cursor });
    expect(delta.items).toHaveLength(1);
    expect((delta.items[0]!.fields.title as Record<string, string>)['en-US']).toBe('third');
  });
});
