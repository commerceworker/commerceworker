import {
  createContentType,
  createEnvironment,
  createMenu,
  mergeEnvironments,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { ApiConfig } from '@commerceworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * Field grants while a live type has an unpublished revision: a denial is judged by the definition
 * Delivery serves, so neither a field the draft dropped nor a URL pattern it changed gets round it.
 */
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
const main = { spaceId: 's1', environmentId: 'main' };
const staging = { spaceId: 's1', environmentId: 'staging' };

const field = (apiId: string, type: string, position: number) => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});
const base = [field('title', 'Symbol', 0), field('slug', 'Slug', 1)];
const page = (fields: unknown[], urlPattern = '/{slug}') => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  urlPattern,
  fields,
});

async function setup(definition: ReturnType<typeof page>) {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: admin,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await post(`${M}/content-types`, definition)).status).toBe(201);
  expect((await post(`${M}/content-types/page/published`)).status).toBe(200);
  const publish = async (values: Record<string, string>) => {
    const res = await post(`${M}/entries`, {
      contentTypeApiId: 'page',
      fields: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { 'en-US': v }])),
    });
    expect(res.status).toBe(201);
    const { entry } = (await res.json()) as { entry: { id: string } };
    expect((await post(`${M}/entries/${entry.id}/published`)).status).toBe(200);
    return entry.id;
  };
  /** A delivery key whose role reads `page` with `deniedFields` denied. */
  const reader = async (deniedFields: string[]) => {
    const role = (await (
      await post('/spaces/s1/roles', {
        name: `Reader ${deniedFields.join(' ')}`,
        scopes: ['delivery:read'],
        contentGrants: [{ contentTypeApiId: 'page', actions: ['read'], deniedFields }],
      })
    ).json()) as { id: string };
    const { token } = (await (
      await post('/spaces/s1/api-keys', { kind: 'cda', roleId: role.id })
    ).json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    return {
      entry: async (id: string) => {
        const res = await app.request(`${D}/entries/${id}?locale=en-US`, { headers });
        return ((await res.json()) as { fields: Record<string, unknown> }).fields;
      },
      graphql: async (query: string) => {
        const res = await app.request(`${D}/graphql`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query }),
        });
        return {
          status: res.status,
          body: (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] },
        };
      },
      sitemap: async () => {
        const res = await app.request(`${D}/sitemap`, { headers });
        return ((await res.json()) as { items: { urls: { url: string }[] }[] }).items;
      },
      routes: async () => {
        const res = await app.request(`${D}/routes`, { headers });
        return ((await res.json()) as { items: unknown[] }).items;
      },
      menu: async () => {
        const res = await app.request(`${D}/menus/main?locale=en-US`, { headers });
        return ((await res.json()) as { items: { id: string; url: string | null }[] }).items;
      },
    };
  };
  /** Saves `fields` as a draft over main by a merge, which has no in-use check to refuse it. */
  const draftByMerge = async (fields: unknown[], urlPattern?: string) => {
    await createEnvironment(wired.ctx, 's1', 'staging');
    await createContentType(wired.ctx, SYSTEM_CALLER, staging, page(fields, urlPattern) as never);
    await mergeEnvironments(wired.ctx, 's1', 'staging', 'main', { contentTypes: ['page'] });
  };
  return { app, wired, post, publish, reader, draftByMerge };
}

describe('a field a role is denied', () => {
  it('stays denied when only the kept definition has it', async () => {
    const { publish, reader, draftByMerge } = await setup(
      page([...base, field('secret', 'Symbol', 2)]),
    );
    const id = await publish({ title: 'T', slug: 't', secret: 'hidden' });
    await draftByMerge(base);

    const full = await reader([]);
    const masked = await reader(['secret']);
    const query = '{ pageCollection(locale: "en-US") { title secret } }';
    expect((await full.graphql(query)).body.data).toEqual({
      pageCollection: [{ title: 'T', secret: 'hidden' }],
    });
    expect((await masked.graphql(query)).body.data).toEqual({
      pageCollection: [{ title: 'T', secret: null }],
    });
    expect(await full.entry(id)).toMatchObject({ secret: 'hidden' });
    expect(await masked.entry(id)).not.toHaveProperty('secret');
  });

  it('stays denied when only the draft has it', async () => {
    const { post, publish, reader } = await setup(page(base));
    await post(`${M}/content-types`, page([...base, field('notes', 'Symbol', 2)]));
    const id = await publish({ title: 'T', slug: 't', notes: 'hidden' });
    const masked = await reader(['notes']);
    const query = '{ pageCollection(locale: "en-US") { notes } }';

    expect(await masked.entry(id)).not.toHaveProperty('notes');
    expect((await masked.graphql(query)).status).toBe(400);

    await post(`${M}/content-types/page/published`);
    expect((await masked.graphql(query)).body.data).toEqual({ pageCollection: [{ notes: null }] });
    expect(await masked.entry(id)).not.toHaveProperty('notes');
  });
});

describe('a URL pattern naming a slug a role is denied', () => {
  it('keeps the type out of the sitemap, though a draft’s pattern no longer names it', async () => {
    const { post, publish, reader } = await setup(page(base));
    await publish({ title: 'T', slug: 'private-slug' });
    await post(`${M}/content-types`, page(base, '/{id}'));
    expect(await (await reader(['slug'])).sitemap()).toEqual([]);
    expect(JSON.stringify(await (await reader([])).sitemap())).toContain('private-slug');
  });

  it('keeps the slug out of a menu, though a draft’s pattern no longer names it', async () => {
    const { wired, post, publish, reader } = await setup(page(base));
    const id = await publish({ title: 'T', slug: 'private-slug' });
    await createMenu(wired.ctx, main, {
      handle: 'main',
      name: 'Main',
      items: [{ id: 'a', link: { type: 'entry', entryId: id } }],
    });
    await post(`${M}/content-types`, page(base, '/{id}'));
    expect(JSON.stringify(await (await reader(['slug'])).menu())).not.toContain('private-slug');
    expect(JSON.stringify(await (await reader([])).menu())).toContain('private-slug');
  });

  it('judges by the served pattern when only a draft’s names the denied slug', async () => {
    const { post, publish, reader } = await setup(page(base, '/p/{id}'));
    const id = await publish({ title: 'T', slug: 'private-slug' });
    await post(`${M}/content-types`, page(base, '/{slug}'));
    const urls = JSON.stringify(await (await reader(['slug'])).sitemap());
    expect(urls).toContain(`/p/${id}`);
    expect(urls).not.toContain('private-slug');
  });
});

describe('two principals with different grants through a draft', () => {
  it('holds each to its own grant, sharing no schema or render', async () => {
    const { app, post, publish, reader } = await setup(
      page([...base, field('secret', 'Symbol', 2)]),
    );
    await publish({ title: 'T', slug: 't', secret: 'hidden' });
    const one = await reader([]);
    const two = await reader(['secret']);
    const query = '{ pageCollection(locale: "en-US") { secret } }';
    const before = [await one.graphql(query), await two.graphql(query)];

    await post(
      `${M}/content-types`,
      page([...base, field('secret', 'Symbol', 2), field('extra', 'Symbol', 3)]),
    );

    for (let run = 0; run < 2; run++) {
      expect((await one.graphql(query)).body).toEqual(before[0]?.body);
      expect((await two.graphql(query)).body).toEqual(before[1]?.body);
    }
    expect(before[0]?.body.data).toEqual({ pageCollection: [{ secret: 'hidden' }] });
    expect(before[1]?.body.data).toEqual({ pageCollection: [{ secret: null }] });

    // A role with no grant on the type never sees it, through the draft as before.
    const none = (await (
      await post('/spaces/s1/roles', {
        name: 'Nothing',
        scopes: ['delivery:read'],
        contentGrants: [{ contentTypeApiId: 'other', actions: ['read'] }],
      })
    ).json()) as { id: string };
    const { token } = (await (
      await post('/spaces/s1/api-keys', { kind: 'cda', roleId: none.id })
    ).json()) as { token: string };
    const res = await app.request(`${D}/routes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
    expect(await one.routes()).toHaveLength(1);
  });
});
