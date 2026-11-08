import type { ApiConfig } from '@commerceworker/platform/config';
import { createDeliveryClient } from '@commerceworker/sdk-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

// Filter by referenced entry on every read surface: Delivery and Preview REST, GraphQL, and the
// field-rule refusal a key with hidden fields gets for links_to_entry.

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
const sym = (apiId: string, position: number) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});
const link = (id: string) => ({ id, linkType: 'Entry' });

type App = ReturnType<typeof createApp>;

async function seed(): Promise<{ app: App; ann: string; bob: string }> {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  const post = async (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: admin, body: JSON.stringify(body) });
  await post(`${M}/content-types`, {
    apiId: 'person',
    name: 'Person',
    displayField: 'name',
    fields: [sym('name', 0)],
  });
  await post(`${M}/content-types`, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      sym('title', 0),
      sym('notes', 1),
      {
        apiId: 'author',
        name: 'Author',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 2,
      },
    ],
  });
  for (const t of ['person', 'article']) await post(`${M}/content-types/${t}/published`, {});
  const entry = async (contentTypeApiId: string, fields: Record<string, unknown>) => {
    const res = await post(`${M}/entries`, {
      contentTypeApiId,
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { 'en-US': v }])),
    });
    const { entry } = (await res.json()) as { entry: { id: string } };
    await post(`${M}/entries/${entry.id}/published`, {});
    return entry.id;
  };
  const ann = await entry('person', { name: 'Ann' });
  const bob = await entry('person', { name: 'Bob' });
  await entry('article', { title: 'By Ann', author: link(ann) });
  await entry('article', { title: 'By Bob', author: link(bob) });
  await entry('article', { title: 'Nobody' });
  return { app, ann, bob };
}

const titles = async (app: App, path: string, token = 'cda') => {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { items: { fields: { title: Record<string, string> } }[] };
  return body.items.map((i) => i.fields.title['en-US']).sort();
};

describe('filter by referenced entry over HTTP', () => {
  let app: App;
  let ann: string;
  let bob: string;
  beforeEach(async () => {
    ({ app, ann, bob } = await seed());
  });

  it('Delivery: fields.<link>[ref], [refIn] and links_to_entry', async () => {
    const q = `${D}/entries?content_type=article`;
    expect(await titles(app, `${q}&fields.author[ref]=${ann}`)).toEqual(['By Ann']);
    expect(await titles(app, `${q}&fields.author[refIn]=${ann},${bob}`)).toEqual([
      'By Ann',
      'By Bob',
    ]);
    expect(await titles(app, `${q}&links_to_entry=${bob}`)).toEqual(['By Bob']);
    expect(await titles(app, `${q}&links_to_entry=nobody`)).toEqual([]);
  });

  it('Preview: the same filters over the current versions', async () => {
    const q = `${P}/entries?content_type=article`;
    expect(await titles(app, `${q}&fields.author[ref]=${ann}`, 'cpa')).toEqual(['By Ann']);
    expect(await titles(app, `${q}&links_to_entry=${ann},${bob}`, 'cpa')).toEqual([
      'By Ann',
      'By Bob',
    ]);
  });

  it('treats an empty links_to_entry as absent', async () => {
    expect(await titles(app, `${D}/entries?content_type=article&links_to_entry=`)).toEqual([
      'By Ann',
      'By Bob',
      'Nobody',
    ]);
  });

  it('refuses a malformed reference filter (422), on Delivery and Preview', async () => {
    for (const path of [`${D}/entries?fields.author[ref]=`, `${P}/entries?links_to_entry=a"b`]) {
      const res = await app.request(path, {
        headers: { Authorization: `Bearer ${path.startsWith(D) ? 'cda' : 'cpa'}` },
      });
      expect(res.status, path).toBe(422);
    }
  });

  it('SDK: references() and linksTo() send the same filters', async () => {
    const cda = createDeliveryClient({
      baseUrl: '',
      space: 's1',
      environment: 'main',
      token: 'cda',
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        app.request(String(url), init)) as typeof fetch,
    });
    const title = (r: { items: { fields: Record<string, unknown> }[] }) =>
      r.items.map((i) => (i.fields.title as Record<string, string>)['en-US']).sort();
    expect(
      title(await cda.query().contentType('article').references('author', ann).fetch()),
    ).toEqual(['By Ann']);
    expect(title(await cda.query().contentType('article').linksTo(ann, bob).fetch())).toEqual([
      'By Ann',
      'By Bob',
    ]);
  });

  it('GraphQL: the where argument takes the same keys', async () => {
    const res = await app.request(`${D}/graphql`, {
      method: 'POST',
      headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query ($a: JSON, $b: JSON) {
          a: articleCollection(where: $a) { title }
          b: articleCollection(where: $b) { title }
        }`,
        variables: {
          a: { 'fields.author[ref]': ann },
          b: { links_to_entry: [ann, bob] },
        },
      }),
    });
    const body = (await res.json()) as {
      data: { a: { title: string }[]; b: { title: string }[] };
      errors?: unknown[];
    };
    expect(body.errors).toBeUndefined();
    expect(body.data.a.map((x) => x.title)).toEqual(['By Ann']);
    expect(body.data.b.map((x) => x.title).sort()).toEqual(['By Ann', 'By Bob']);
  });

  it('refuses links_to_entry to a key with a hidden field (403), allows ref on a readable one', async () => {
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Reader',
        scopes: ['delivery:read'],
        contentGrants: [
          { contentTypeApiId: 'article', actions: ['read'], deniedFields: ['notes'] },
        ],
      }),
    });
    const role = (await roleRes.json()) as { id: string };
    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cda', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    const q = `${D}/entries?content_type=article`;
    const refused = await app.request(`${q}&links_to_entry=${ann}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(refused.status).toBe(403);
    expect(await titles(app, `${q}&fields.author[ref]=${ann}`, token)).toEqual(['By Ann']);
  });
});
