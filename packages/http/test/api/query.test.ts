import type { ApiConfig } from '@commerceworker/platform/config';
import { createDeliveryClient } from '@commerceworker/sdk-core';
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

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';

type App = ReturnType<typeof createApp>;

/** Seeds an article type + corpus and returns the live app. */
async function seed(): Promise<App> {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);

  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
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
        {
          apiId: 'body',
          name: 'Body',
          type: 'Text',
          localized: false,
          required: false,
          position: 1,
        },
        {
          apiId: 'views',
          name: 'Views',
          type: 'Integer',
          localized: false,
          required: false,
          position: 2,
        },
      ],
    }),
  });
  await app.request(`${M}/content-types/article/published`, { method: 'POST', headers: cma });

  for (const r of [
    { title: 'Alpha', body: 'about cats', views: 10 },
    { title: 'Bravo', body: 'about dogs', views: 50 },
    { title: 'Charlie', body: 'about cats and dogs', views: 100 },
  ]) {
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        contentTypeApiId: 'article',
        fields: {
          title: { 'en-US': r.title },
          body: { 'en-US': r.body },
          views: { 'en-US': r.views },
        },
      }),
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });
  }
  return app;
}

const restTitles = async (app: App, qs: string) => {
  const res = await app.request(`${D}/entries?${qs}`, { headers: { Authorization: 'Bearer cda' } });
  const body = (await res.json()) as { items: { fields: { title: Record<string, string> } }[] };
  return body.items.map((i) => i.fields.title['en-US']);
};

describe('query language parity across REST, GraphQL and SDK', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });

  it('REST: orders by the manual order, an entry never moved by its id', async () => {
    // Production ids are UUIDv7, so this is creation order; this app's ids aren't time-ordered.
    const ids = async (qs: string) => {
      const res = await app.request(`${D}/entries?${qs}`, {
        headers: { Authorization: 'Bearer cda' },
      });
      return ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    };
    const all = await ids('content_type=article&order=sys.position');
    expect(all).toHaveLength(3);
    expect(all).toEqual([...all].sort());
    expect(await ids('content_type=article&order=-sys.position')).toEqual([...all].reverse());
    // With a filter it is sorted over the matches, by the same key.
    const cats = await ids('fields.body[match]=cats&order=sys.position');
    expect(cats).toHaveLength(2);
    expect(cats).toEqual([...cats].sort());
  });

  it('REST: field filter via field-level params', async () => {
    expect(await restTitles(app, 'fields.views[gt]=40&order=fields.views')).toEqual([
      'Bravo',
      'Charlie',
    ]);
    expect(await restTitles(app, 'fields.title=Alpha')).toEqual(['Alpha']);
    expect(await restTitles(app, 'fields.body[match]=cats&order=-fields.views')).toEqual([
      'Charlie',
      'Alpha',
    ]);
    expect(await restTitles(app, 'query=dogs&order=fields.views')).toEqual(['Bravo', 'Charlie']);
  });

  it('REST: select projects fields', async () => {
    const res = await app.request(`${D}/entries?fields.title=Alpha&select=fields.title`, {
      headers: { Authorization: 'Bearer cda' },
    });
    const body = (await res.json()) as { items: { fields: Record<string, unknown> }[] };
    expect(Object.keys(body.items[0]?.fields ?? {})).toEqual(['title']);
  });

  it('GraphQL: where + order args on a collection', async () => {
    // `where` keys (`fields.x[op]`) aren't valid GraphQL Names, so the JSON scalar
    // is supplied via variables rather than as an inline object literal.
    const res = await app.request(`${D}/graphql`, {
      method: 'POST',
      headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query ($where: JSON, $order: [String!]) {
          articleCollection(locale: "en-US", where: $where, order: $order) { title views }
        }`,
        variables: { where: { 'fields.views[gt]': 40 }, order: ['-fields.views'] },
      }),
    });
    const body = (await res.json()) as {
      data: { articleCollection: { title: string; views: number }[] };
      errors?: unknown[];
    };
    expect(body.errors).toBeUndefined();
    expect(body.data.articleCollection.map((a) => a.title)).toEqual(['Charlie', 'Bravo']);
  });

  it('SDK: query builder produces the same filtered result', async () => {
    const client = createDeliveryClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });
    const res = await client
      .query()
      .contentType('article')
      .where('views', 'gte', 50)
      .order('fields.views')
      .fetch();
    expect(res.items.map((i) => (i.fields.title as Record<string, string>)['en-US'])).toEqual([
      'Bravo',
      'Charlie',
    ]);
  });
});
