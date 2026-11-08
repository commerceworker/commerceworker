import {
  createContentType,
  createEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { ApiConfig } from '@commerceworker/platform/config';
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
const cpa = { Authorization: 'Bearer cpa', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };

function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  return { app, ctx: wired.ctx };
}

type AssetBody = { id: string; status: string; folderId?: string; createdBy?: string };

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function upload(app: ReturnType<typeof makeApp>['app'], body: Record<string, unknown>) {
  const res = await app.request(`${M}/assets`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await json<{ asset: AssetBody }>(res)).asset;
}

describe('the asset library over HTTP', () => {
  it('lists with filters and pages with nextCursor', async () => {
    const { app } = makeApp();
    const folder = await json<{ id: string }>(
      await app.request(`${M}/asset-folders`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify({ name: 'Campaign' }),
      }),
    );
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      made.push(
        (
          await upload(app, {
            fileName: `p${i}.png`,
            contentType: 'image/png',
            folderId: folder.id,
          })
        ).id,
      );
    }
    await upload(app, {
      fileName: 'brief.pdf',
      contentType: 'application/pdf',
      folderId: folder.id,
    });

    const images = await json<{ items: AssetBody[]; nextCursor?: string }>(
      await app.request(`${M}/assets?folder=${folder.id}&kind=image&limit=2`, { headers: cpa }),
    );
    expect(images.items).toHaveLength(2);
    expect(images.nextCursor).toBeTruthy();
    const rest = await json<{ items: AssetBody[]; nextCursor?: string }>(
      await app.request(
        `${M}/assets?folder=${folder.id}&kind=image&limit=2&cursor=${encodeURIComponent(images.nextCursor ?? '')}`,
        { headers: cpa },
      ),
    );
    expect(rest.nextCursor).toBeUndefined();
    expect([...images.items, ...rest.items].map((a) => a.id).sort()).toEqual([...made].sort());

    const bad = await app.request(`${M}/assets?kind=spreadsheet`, { headers: cpa });
    expect(bad.status).toBe(422);
  });

  it('records the creating principal, and moves assets between folders', async () => {
    const { app } = makeApp();
    const a = await upload(app, { fileName: 'a.png', contentType: 'image/png' });
    expect(a.createdBy).toBe('cma');
    const folder = await json<{ id: string }>(
      await app.request(`${M}/asset-folders`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify({ name: 'Moved' }),
      }),
    );

    const denied = await app.request(`${M}/assets/move`, {
      method: 'POST',
      headers: cpa,
      body: JSON.stringify({ ids: [a.id], folderId: folder.id }),
    });
    expect(denied.status).toBe(403);

    const moved = await app.request(`${M}/assets/move`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ids: [a.id], folderId: folder.id }),
    });
    expect(await json(moved)).toEqual({ moved: 1 });
    const filed = await json<{ items: AssetBody[] }>(
      await app.request(`${M}/assets?folder=${folder.id}`, { headers: cma }),
    );
    expect(filed.items.map((x) => x.id)).toEqual([a.id]);

    const unknown = await app.request(`${M}/assets/move`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ids: [a.id], folderId: 'nope' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('archives (hidden by default, gone from Delivery) and restores', async () => {
    const { app } = makeApp();
    const a = await upload(app, { fileName: 'arch.png', contentType: 'image/png' });
    await app.request(`${M}/assets/${a.id}/published`, { method: 'POST', headers: cma });

    const archived = await app.request(`${M}/assets/${a.id}/archive`, {
      method: 'POST',
      headers: cma,
    });
    expect((await json<AssetBody>(archived)).status).toBe('archived');
    const delivered = await app.request(`/delivery/s1/main/assets/${a.id}`, {
      headers: { Authorization: 'Bearer cda' },
    });
    expect(delivered.status).toBe(404);
    const listed = await json<{ items: AssetBody[] }>(
      await app.request(`${M}/assets?limit=100`, { headers: cma }),
    );
    expect(listed.items.some((x) => x.id === a.id)).toBe(false);
    const trash = await json<{ items: AssetBody[] }>(
      await app.request(`${M}/assets?status=archived`, { headers: cma }),
    );
    expect(trash.items.map((x) => x.id)).toEqual([a.id]);

    const restored = await app.request(`${M}/assets/${a.id}/restore`, {
      method: 'POST',
      headers: cma,
    });
    expect((await json<AssetBody>(restored)).status).toBe('draft');
  });

  it('refuses to delete a linked asset with 409 and the links, and deletes it once unlinked', async () => {
    const { app, ctx } = makeApp();
    const a = await upload(app, { fileName: 'hero.png', contentType: 'image/png' });
    await app.request(`${M}/assets/${a.id}/published`, { method: 'POST', headers: cma });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'banner',
      name: 'Banner',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'T',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'image',
          name: 'Image',
          type: 'Link',
          linkType: 'Asset',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    await publishContentType(ctx, scope, 'banner');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'banner',
      fields: { title: { 'en-US': 'B' }, image: { 'en-US': { id: a.id, linkType: 'Asset' } } },
    });
    await publishEntry(ctx, scope, entry.id);

    const refused = await app.request(`${M}/assets/${a.id}`, { method: 'DELETE', headers: cma });
    expect(refused.status).toBe(409);
    const body = await json<{ error: { code: string; usage: unknown[]; total: number } }>(refused);
    expect(body.error.code).toBe('asset_in_use');
    // Each link names its entry, so a client shows the list without reading every entry.
    expect(body.error.usage).toEqual([
      {
        fromEntryId: entry.id,
        fromField: 'image',
        toId: a.id,
        toType: 'Asset',
        contentTypeApiId: 'banner',
        entryTitle: 'B',
      },
    ]);
    expect(body.error.total).toBe(1);

    const b = await upload(app, { fileName: 'free.png', contentType: 'image/png' });
    const cpaDenied = await app.request(`${M}/assets/${b.id}`, { method: 'DELETE', headers: cpa });
    expect(cpaDenied.status).toBe(403);
    // Not archived yet: the bytes can't come back, so archiving comes first.
    const early = await app.request(`${M}/assets/${b.id}`, { method: 'DELETE', headers: cma });
    expect(early.status).toBe(400);
    expect((await json<{ error: { code: string } }>(early)).error.code).toBe('invalid_state');
    await app.request(`${M}/assets/${b.id}/archive`, { method: 'POST', headers: cma });
    const gone = await app.request(`${M}/assets/${b.id}`, { method: 'DELETE', headers: cma });
    expect(gone.status).toBe(204);
    expect((await app.request(`${M}/assets/${b.id}`, { headers: cma })).status).toBe(404);
  });

  it('creates, renames, moves and deletes folders', async () => {
    const { app } = makeApp();
    const create = (body: Record<string, unknown>) =>
      app.request(`${M}/asset-folders`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify(body),
      });
    const parent = await json<{ id: string; path: string }>(await create({ name: 'Brand' }));
    const child = await json<{ id: string }>(await create({ name: 'Logos', parentId: parent.id }));
    expect((await create({ name: 'Brand' })).status).toBe(409);

    const renamed = await app.request(`${M}/asset-folders/${child.id}`, {
      method: 'PATCH',
      headers: cma,
      body: JSON.stringify({ name: 'Marks', parentId: null }),
    });
    expect(await json(renamed)).toMatchObject({ name: 'Marks', path: `/${child.id}/` });

    const list = await json<{ items: { id: string }[] }>(
      await app.request(`${M}/asset-folders`, { headers: cpa }),
    );
    expect(list.items.map((f) => f.id)).toEqual(expect.arrayContaining([parent.id, child.id]));

    const a = await upload(app, {
      fileName: 'x.png',
      contentType: 'image/png',
      folderId: parent.id,
    });
    expect(
      (await app.request(`${M}/asset-folders/${parent.id}`, { method: 'DELETE', headers: cma }))
        .status,
    ).toBe(409);
    await app.request(`${M}/assets/move`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ ids: [a.id], folderId: null }),
    });
    expect(
      (await app.request(`${M}/asset-folders/${parent.id}`, { method: 'DELETE', headers: cma }))
        .status,
    ).toBe(204);
  });
});
