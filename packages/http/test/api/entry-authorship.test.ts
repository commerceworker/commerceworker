import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * Authorship over HTTP: Management and Preview serve who created an entry and changed it last,
 * `sys.createdBy=me` names the caller, and Delivery serves the first publish and nobody's id.
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

const json = { 'Content-Type': 'application/json' };
const cma = { Authorization: 'Bearer cma', ...json };
const admin = { Authorization: 'Bearer admin', ...json };
const M = '/spaces/s1/environments/main';
const P = '/preview/s1/main';
const D = '/delivery/s1/main';

interface Authored {
  id: string;
  createdAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  firstPublishedAt: string | null;
}

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      apiId: 'memo',
      name: 'Memo',
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
  await app.request(`${M}/content-types/memo/published`, { method: 'POST', headers: cma });
});

const create = async (headers: Record<string, string>, title: string) => {
  const res = await app.request(`${M}/entries`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contentTypeApiId: 'memo', fields: { title: { 'en-US': title } } }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { entry: Authored }).entry;
};

const previewList = async (headers: Record<string, string>, qs: string) => {
  const res = await app.request(`${P}/entries?content_type=memo&${qs}`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Authored[] }).items;
};

describe('entry authorship over HTTP', () => {
  it('serves who created and last changed an entry in Management and Preview', async () => {
    const created = await create(cma, 'Hello');
    expect(created).toMatchObject({ createdBy: 'cma', updatedBy: 'cma', firstPublishedAt: null });
    expect(created.createdAt).toEqual(expect.any(String));

    const saved = await app.request(`${M}/entries/${created.id}`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ fields: { title: { 'en-US': 'Hello again' } } }),
    });
    expect(saved.status).toBe(200);
    const published = await app.request(`${M}/entries/${created.id}/published`, {
      method: 'POST',
      headers: admin,
    });
    expect(published.status).toBe(200);

    const got = (await (
      await app.request(`${M}/entries/${created.id}`, { headers: cma })
    ).json()) as { entry: Authored };
    expect(got.entry).toMatchObject({ createdBy: 'cma', updatedBy: 'admin-token' });
    expect(got.entry.firstPublishedAt).toEqual(expect.any(String));

    const [row] = await previewList(cma, '');
    expect(row).toMatchObject({
      id: created.id,
      createdBy: 'cma',
      updatedBy: 'admin-token',
      firstPublishedAt: got.entry.firstPublishedAt,
    });
  });

  it('lists the caller’s own entries with sys.createdBy=me', async () => {
    const mine = await create(cma, 'Mine');
    const theirs = await create(admin, 'Theirs');
    expect((await previewList(cma, 'sys.createdBy=me')).map((e) => e.id)).toEqual([mine.id]);
    expect((await previewList(admin, 'sys.createdBy=me')).map((e) => e.id)).toEqual([theirs.id]);
    expect((await previewList(cma, 'sys.createdBy[ne]=me')).map((e) => e.id)).toEqual([theirs.id]);
    expect((await previewList(cma, 'order=-sys.createdBy')).map((e) => e.createdBy)).toEqual([
      'cma',
      'admin-token',
    ]);
  });

  it('delivers the first publish, sorted by it, and no person or key ids', async () => {
    const ids: string[] = [];
    for (const title of ['One', 'Two']) {
      const e = await create(cma, title);
      await app.request(`${M}/entries/${e.id}/published`, { method: 'POST', headers: cma });
      ids.push(e.id);
    }
    const res = await app.request(`${D}/entries?content_type=memo&order=-sys.firstPublishedAt`, {
      headers: { Authorization: 'Bearer cda' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    // Newest first publish first. The two can share a millisecond on the real clock, so the check
    // is the order of the instants, not of the ids.
    expect(body.items.map((e) => e.id).sort()).toEqual([...ids].sort());
    const firsts = body.items.map((e) => Date.parse(e.firstPublishedAt as string));
    expect(firsts).toEqual([...firsts].sort((a, b) => b - a));
    for (const item of body.items) {
      expect(item.firstPublishedAt).toEqual(expect.any(String));
      expect(item).not.toHaveProperty('createdBy');
      expect(item).not.toHaveProperty('updatedBy');
    }
    // And filtering on an author through Delivery finds nothing: it has none to compare.
    const byAuthor = await app.request(`${D}/entries?content_type=memo&sys.createdBy=cma`, {
      headers: { Authorization: 'Bearer cda' },
    });
    expect(((await byAuthor.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('serves a preview key no writer ids, and refuses it a filter or order on them', async () => {
    const created = await create(cma, 'Draft');
    const cpa = { Authorization: 'Bearer cpa' };
    const [row] = await previewList(cpa, '');
    expect(row).toMatchObject({ id: created.id, createdAt: expect.any(String) });
    expect(row).not.toHaveProperty('createdBy');
    expect(row).not.toHaveProperty('updatedBy');
    const one = await app.request(`${P}/entries/${created.id}`, { headers: cpa });
    expect(one.status).toBe(200);
    const single = (await one.json()) as Record<string, unknown>;
    expect(single).not.toHaveProperty('createdBy');
    expect(single).not.toHaveProperty('updatedBy');

    for (const qs of ['sys.createdBy=cma', 'sys.updatedBy[ne]=cma', 'order=sys.createdBy']) {
      const refused = await app.request(`${P}/entries?content_type=memo&${qs}`, { headers: cpa });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'author_ids_not_served',
      );
    }
    // A management key still reads and filters on them.
    expect((await previewList(cma, 'sys.createdBy=cma')).map((e) => e.id)).toEqual([created.id]);
  });

  it('serves a preview key no writer ids on the entry and its versions', async () => {
    const created = await create(cma, 'Draft');
    const cpa = { Authorization: 'Bearer cpa' };
    const read = async (path: string, headers: Record<string, string>) => {
      const res = await app.request(`${M}/entries/${created.id}${path}`, { headers });
      expect(res.status).toBe(200);
      return res.json();
    };

    const entry = (await read('', cpa)) as { entry: Record<string, unknown> };
    expect(entry.entry).toMatchObject({ id: created.id, createdAt: expect.any(String) });
    expect(entry.entry).not.toHaveProperty('createdBy');
    expect(entry.entry).not.toHaveProperty('updatedBy');
    const versions = (await read('/versions', cpa)) as { items: Record<string, unknown>[] };
    expect(versions.items).not.toHaveLength(0);
    for (const v of versions.items) expect(v).not.toHaveProperty('createdBy');
    const first = (await read('/versions/1', cpa)) as Record<string, unknown>;
    expect(first).toMatchObject({ version: 1 });
    expect(first).not.toHaveProperty('createdBy');

    // A management key reads the same records with who wrote them.
    expect(((await read('', cma)) as { entry: Authored }).entry.createdBy).toBe('cma');
    const theirs = (await read('/versions', cma)) as { items: { createdBy: string }[] };
    expect(theirs.items.map((v) => v.createdBy)).toEqual(['cma']);
    expect(((await read('/versions/1', cma)) as { createdBy: string }).createdBy).toBe('cma');
  });

  it('serves a preview key a singleton without writer ids, and a management key with them', async () => {
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId: 'settings',
        name: 'Settings',
        displayField: 'title',
        singleton: true,
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: false,
            position: 0,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/settings/published`, { method: 'POST', headers: cma });
    const made = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ contentTypeApiId: 'settings', fields: { title: { 'en-US': 'One' } } }),
    });
    expect(made.status).toBe(201);

    const read = async (headers: Record<string, string>) => {
      const res = await app.request(`${P}/singletons/settings`, { headers });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const theirs = await read({ Authorization: 'Bearer cpa' });
    expect(theirs).toMatchObject({ contentType: 'settings', createdAt: expect.any(String) });
    expect(theirs).not.toHaveProperty('createdBy');
    expect(theirs).not.toHaveProperty('updatedBy');
    expect(await read(cma)).toMatchObject({ createdBy: 'cma', updatedBy: 'cma' });
  });

  it('refuses a preview key a where predicate on a writer id', async () => {
    await create(cma, 'Draft');
    const cpa = { Authorization: 'Bearer cpa' };
    const where = (tree: unknown) => `where=${encodeURIComponent(JSON.stringify(tree))}`;
    for (const tree of [
      { field: 'sys.createdBy', op: 'eq', value: 'cma' },
      {
        or: [
          { field: 'title', op: 'eq', value: 'Nope' },
          { and: [{ field: 'sys.updatedBy', op: 'ne', value: 'cma' }] },
        ],
      },
    ]) {
      const refused = await app.request(`${P}/entries?content_type=memo&${where(tree)}`, {
        headers: cpa,
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'author_ids_not_served',
      );
    }
    // A management key may.
    const mine = await previewList(cma, where({ field: 'sys.createdBy', op: 'eq', value: 'cma' }));
    expect(mine).toHaveLength(1);
  });
});
