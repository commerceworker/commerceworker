import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { createDeliveryClient } from '@commerceworker/sdk-core';
import { createManagementClient } from '@commerceworker/sdk-management';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

// Richer queries on every read surface: startsWith, between, component paths and `where` groups
// on Delivery, Preview and GraphQL, and a field's distinct values on Management.

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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';
const P = '/preview/s1/main';
const def = (apiId: string, type: string, position: number, extra = {}) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
  ...extra,
});

type App = ReturnType<typeof createApp>;

async function seed(): Promise<App> {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: admin, body: JSON.stringify(body) });
  await post(`${M}/content-types`, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      def('title', 'Symbol', 0),
      def('views', 'Integer', 1),
      def('seo', 'Component', 2, {
        fields: [def('title', 'Symbol', 0), def('rank', 'Integer', 1)],
      }),
      def('tags', 'Array', 3, { items: { type: 'Symbol' } }),
      def('secret', 'Symbol', 4),
      def('body', 'RichText', 5),
    ],
  });
  await post(`${M}/content-types/page/published`, {});
  for (const [title, views, seo, tags] of [
    ['Apple', 10, 'Buy apples', ['fruit', 'red']],
    ['Apricot', 30, 'Apricots', ['fruit']],
    ['Banana', 50, 'Bananas', ['fruit', 'yellow']],
    ['Carrot', 70, 'Carrots', ['vegetable']],
  ] as const) {
    const res = await post(`${M}/entries`, {
      contentTypeApiId: 'page',
      fields: {
        title: { 'en-US': title },
        views: { 'en-US': views },
        seo: { 'en-US': { title: seo, rank: views / 10 } },
        tags: { 'en-US': tags },
      },
    });
    const { entry } = (await res.json()) as { entry: { id: string } };
    await post(`${M}/entries/${entry.id}/published`, {});
  }
  return app;
}

const get = (app: App, path: string, token: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } });

const titles = async (app: App, path: string, token: string) => {
  const res = await get(app, path, token);
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { items: { fields: { title: Record<string, string> } }[] };
  return body.items.map((i) => i.fields.title['en-US']).sort();
};

describe('richer queries over HTTP', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });

  it('Delivery and Preview: startsWith, between and a component path', async () => {
    for (const [base, token] of [
      [`${D}/entries?content_type=page`, 'cda'],
      [`${P}/entries?content_type=page`, 'cpa'],
    ] as const) {
      expect(await titles(app, `${base}&fields.title[startsWith]=ap`, token)).toEqual([
        'Apple',
        'Apricot',
      ]);
      expect(await titles(app, `${base}&fields.views[between]=30,50`, token)).toEqual([
        'Apricot',
        'Banana',
      ]);
      expect(await titles(app, `${base}&fields.seo.title[match]=carrot`, token)).toEqual([
        'Carrot',
      ]);
    }
  });

  it('Delivery and Preview: a where parameter with OR and AND groups', async () => {
    const where = encodeURIComponent(
      JSON.stringify({
        or: [
          { field: 'fields.tags', value: 'vegetable' },
          {
            and: [
              { field: 'fields.seo.rank', op: 'lte', value: 3 },
              { field: 'fields.title', op: 'startsWith', value: 'Apr' },
            ],
          },
        ],
      }),
    );
    expect(await titles(app, `${D}/entries?content_type=page&where=${where}`, 'cda')).toEqual([
      'Apricot',
      'Carrot',
    ]);
    expect(await titles(app, `${P}/entries?content_type=page&where=${where}`, 'cpa')).toEqual([
      'Apricot',
      'Carrot',
    ]);
  });

  it('refuses a malformed where with 422 and the problem named', async () => {
    const where = encodeURIComponent(JSON.stringify({ or: [{ field: 'title', op: 'nope' }] }));
    const res = await get(app, `${D}/entries?where=${where}`, 'cda');
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('where.or[0]');
    const notJson = await get(app, `${P}/entries?where=%7Bor`, 'cpa');
    expect(notJson.status).toBe(422);
  });

  it('GraphQL: and/or keys in where are groups', async () => {
    const res = await app.request(`${D}/graphql`, {
      method: 'POST',
      headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query ($where: JSON) { pageCollection(where: $where) { title } }',
        variables: {
          where: {
            'fields.views[gte]': 30,
            or: [
              { field: 'title', op: 'startsWith', value: 'B' },
              { field: 'seo.title', op: 'eq', value: 'Carrots' },
            ],
          },
        },
      }),
    });
    const body = (await res.json()) as { data: { pageCollection: { title: string }[] } };
    expect(body.data.pageCollection.map((p) => p.title).sort()).toEqual(['Banana', 'Carrot']);
  });
});

describe('richer queries through the SDKs', () => {
  it('the query builder and contentTypes.fieldValues reach the same answers', async () => {
    const app = await seed();
    const fetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(String(url), init)) as typeof globalThis.fetch;
    const cda = createDeliveryClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch,
    });
    const res = await cda
      .query()
      .contentType('page')
      .where('views', 'between', [20, 80])
      .or(
        { field: 'title', op: 'startsWith', value: 'Ap' },
        { field: 'seo.title', value: 'Carrots' },
      )
      .fetch();
    expect(
      res.items.map((i) => (i.fields.title as Record<string, string>)['en-US']).sort(),
    ).toEqual(['Apricot', 'Carrot']);
    const cma = createManagementClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cma',
      fetch,
    });
    const page = await cma.contentTypes.fieldValues('page', 'tags', { limit: 1 });
    expect(page.items).toEqual([{ value: 'fruit', count: 3 }]);
    expect(page.nextCursor).toBeTruthy();
  });
});

describe('distinct field values over HTTP', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });
  const values = `${M}/content-types/page/fields`;

  it('lists each value with its count and pages with the cursor', async () => {
    const first = await get(app, `${values}/tags/values?limit=2`, 'cma');
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: { value: string; count: number }[];
      nextCursor?: string;
    };
    expect(page.items).toEqual([
      { value: 'fruit', count: 3 },
      { value: 'red', count: 1 },
    ]);
    const rest = await get(
      app,
      `${values}/tags/values?limit=2&cursor=${page.nextCursor as string}`,
      'cma',
    );
    expect(((await rest.json()) as { items: unknown[] }).items).toEqual([
      { value: 'vegetable', count: 1 },
      { value: 'yellow', count: 1 },
    ]);
    const numbers = await get(app, `${values}/views/values`, 'cma');
    expect(
      ((await numbers.json()) as { items: { value: unknown }[] }).items.map((i) => i.value),
    ).toEqual([10, 30, 50, 70]);
  });

  it('refuses a structured field (422), an unknown type (404) and a forged cursor (422)', async () => {
    expect((await get(app, `${values}/body/values`, 'cma')).status).toBe(422);
    expect((await get(app, `${values}/nope/values`, 'cma')).status).toBe(422);
    expect((await get(app, `${M}/content-types/nope/fields/title/values`, 'cma')).status).toBe(404);
    expect((await get(app, `${values}/title/values?cursor=xyz`, 'cma')).status).toBe(422);
  });

  it('refuses a field the key may not read (403)', async () => {
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Reader',
        scopes: ['preview:read'],
        contentGrants: [{ contentTypeApiId: 'page', actions: ['read'], deniedFields: ['secret'] }],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    expect((await get(app, `${values}/secret/values`, token)).status).toBe(403);
    expect((await get(app, `${values}/title/values`, token)).status).toBe(200);
  });
});

/** A key of `kind` bound to a role with these grants. */
async function roleKey(
  app: App,
  kind: 'cda' | 'cma',
  scopes: string[],
  contentGrants: unknown[],
): Promise<string> {
  const roleRes = await app.request('/spaces/s1/roles', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: `Role ${kind}`, scopes, contentGrants }),
  });
  const role = (await roleRes.json()) as { id: string };
  const keyRes = await app.request('/spaces/s1/api-keys', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ kind, roleId: role.id }),
  });
  return ((await keyRes.json()) as { token: string }).token;
}

const graphql = async (app: App, token: string, where: unknown) => {
  const res = await app.request(`${D}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query ($where: JSON) { pageCollection(where: $where) { title } }',
      variables: { where },
    }),
  });
  return (await res.json()) as {
    data?: { pageCollection: { title: string }[] } | null;
    errors?: { message: string }[];
  };
};

describe('what the API accepted before keeps working', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });

  it('an empty match still means "has a value", on Delivery, Preview and GraphQL', async () => {
    const all = ['Apple', 'Apricot', 'Banana', 'Carrot'];
    expect(await titles(app, `${D}/entries?content_type=page&fields.title[match]=`, 'cda')).toEqual(
      all,
    );
    expect(await titles(app, `${P}/entries?content_type=page&fields.title[match]=`, 'cpa')).toEqual(
      all,
    );
    // A field no entry holds matches nothing, as before.
    expect(
      await titles(app, `${D}/entries?content_type=page&fields.secret[match]=`, 'cda'),
    ).toEqual([]);
    const body = await graphql(app, 'cda', { 'fields.title[match]': '' });
    expect(body.errors).toBeUndefined();
    expect(body.data?.pageCollection.map((p) => p.title).sort()).toEqual(all);
  });

  it('an in list longer than 100 values still answers', async () => {
    const res = await get(app, `${D}/entries?content_type=page&fields.title=Banana`, 'cda');
    const [banana] = ((await res.json()) as { items: { id: string }[] }).items;
    const ids = [...Array.from({ length: 150 }, (_, i) => `nobody-${i}`), banana?.id].join(',');
    expect(await titles(app, `${D}/entries?content_type=page&sys.id[in]=${ids}`, 'cda')).toEqual([
      'Banana',
    ]);
  });

  it('more than four top-level component paths answer (200), filtered correctly', async () => {
    const five = [
      'fields.seo.title[match]=a',
      'fields.seo.title[ne]=x',
      'fields.seo.rank[gte]=2',
      'fields.seo.rank[lte]=5',
      'fields.seo.title[exists]=true',
    ].join('&');
    expect(await titles(app, `${D}/entries?content_type=page&${five}`, 'cda')).toEqual([
      'Apricot',
      'Banana',
    ]);
    expect(await titles(app, `${P}/entries?content_type=page&${five}`, 'cpa')).toEqual([
      'Apricot',
      'Banana',
    ]);
    const body = await graphql(app, 'cda', {
      'fields.seo.title[match]': 'a',
      'fields.seo.title[ne]': 'x',
      'fields.seo.rank[gte]': 2,
      'fields.seo.rank[lte]': 5,
      'fields.seo.title[exists]': true,
    });
    expect(body.errors).toBeUndefined();
    expect(body.data?.pageCollection.map((p) => p.title).sort()).toEqual(['Apricot', 'Banana']);
    // Inside where, which is new, the cap holds.
    const where = encodeURIComponent(
      JSON.stringify({ and: Array(5).fill({ field: 'seo.title', op: 'exists' }) }),
    );
    expect((await get(app, `${D}/entries?where=${where}`, 'cda')).status).toBe(422);
  });

  it('an unknown operator is still ignored', async () => {
    expect(
      await titles(app, `${D}/entries?content_type=page&fields.title[like]=x`, 'cda'),
    ).toHaveLength(4);
  });
});

describe('where across parameters and GraphQL', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });

  it('repeated where parameters AND together', async () => {
    const a = encodeURIComponent(
      JSON.stringify({ field: 'fields.title', op: 'startsWith', value: 'A' }),
    );
    const b = encodeURIComponent(JSON.stringify({ field: 'fields.views', op: 'gte', value: 20 }));
    expect(
      await titles(app, `${D}/entries?content_type=page&where=${a}&where=${b}`, 'cda'),
    ).toEqual(['Apricot']);
  });

  it('GraphQL: and and or together take no more depth than the REST spelling', async () => {
    const leaf = { field: 'title', op: 'startsWith', value: 'Ap' };
    // and(1) > or(2) > and(3) > or(4) > leaf: the deepest tree REST accepts.
    const deep = { or: [{ and: [{ or: [leaf] }] }] };
    const body = await graphql(app, 'cda', {
      and: [deep],
      or: [leaf, { field: 'views', value: 70 }],
    });
    expect(body.errors).toBeUndefined();
    expect(body.data?.pageCollection.map((p) => p.title).sort()).toEqual(['Apple', 'Apricot']);
  });
});

describe('field rules on the new query inputs', () => {
  let app: App;
  let token: string;
  beforeEach(async () => {
    app = await seed();
    token = await roleKey(
      app,
      'cda',
      ['delivery:read'],
      [{ contentTypeApiId: 'page', actions: ['read'], deniedFields: ['secret'] }],
    );
  });

  it('REST: where naming a hidden field, a path under it, or links_to_entry inside where → 403', async () => {
    for (const where of [
      {
        or: [
          { field: 'title', value: 'x' },
          { field: 'fields.secret', value: 's' },
        ],
      },
      { field: 'secret.inner', value: 's' },
      { and: [{ field: '*', op: 'ref', value: 'some-id' }] },
    ]) {
      const res = await get(
        app,
        `${D}/entries?content_type=page&where=${encodeURIComponent(JSON.stringify(where))}`,
        token,
      );
      expect(res.status, JSON.stringify(where)).toBe(403);
    }
    expect(
      (await get(app, `${D}/entries?content_type=page&fields.secret.inner=s`, token)).status,
    ).toBe(403);
    // The same key may filter on what it can read.
    expect(
      (await get(app, `${D}/entries?content_type=page&fields.seo.title=Apricots`, token)).status,
    ).toBe(200);
  });

  it('GraphQL: a where naming a hidden field is refused', async () => {
    const body = await graphql(app, token, { or: [{ field: 'secret', value: 's' }] });
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(body.data?.pageCollection ?? null).toBeNull();
  });
});

describe('who may list field values', () => {
  let app: App;
  beforeEach(async () => {
    app = await seed();
  });
  const values = `${M}/content-types/page/fields/title/values`;

  it('a Delivery key, a role without the type, and a key of another space are refused (403)', async () => {
    expect((await get(app, values, 'cda')).status).toBe(403);
    const other = await roleKey(
      app,
      'cma',
      ['preview:read'],
      [{ contentTypeApiId: 'post', actions: ['read'] }],
    );
    expect((await get(app, values, other)).status).toBe(403);
    const elsewhere = await get(
      app,
      '/spaces/s2/environments/main/content-types/page/fields/title/values',
      'cma',
    );
    expect(elsewhere.status).toBe(403);
  });
});
