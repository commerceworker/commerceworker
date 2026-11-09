import {
  createContentType,
  createEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
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
const scope = { spaceId: 's1', environmentId: 'main' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** The app over its fakes, with a published `page` type at /pages/{slug} and one page. */
async function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai, inMemoryEdge());
  const ctx = wired.ctx;
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'menupage',
    name: 'Menu page',
    displayField: 'title',
    urlPattern: '/pages/{slug}',
    fields: [
      field({ apiId: 'title', type: 'Symbol', localized: true }),
      field({ apiId: 'slug', type: 'Slug', position: 1 }),
    ],
  });
  await publishContentType(ctx, scope, 'menupage');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'menupage',
    fields: { title: { 'en-US': 'About', de: 'Über uns' }, slug: { 'en-US': 'about' } },
  });
  await publishEntry(ctx, scope, entry.id);
  return { app, ctx, pageId: entry.id };
}
type App = Awaited<ReturnType<typeof makeApp>>['app'];

const send = (app: App, method: string, path: string, body?: unknown, headers = admin) =>
  app.request(`${M}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

interface MenuBody {
  id: string;
  handle: string;
  revision: number;
  items: { id: string; children: { id: string }[] }[];
}

describe('menus over HTTP', () => {
  it('creates, reads, lists, reorders, updates and deletes', async () => {
    const { app, pageId } = await makeApp();
    const created = await send(app, 'POST', '/menus', {
      handle: 'main',
      name: 'Main',
      items: [
        { id: 'home', label: 'Home', link: { type: 'url', url: '/' } },
        { id: 'about', link: { type: 'entry', entryId: pageId } },
      ],
    });
    expect(created.status).toBe(201);
    const menu = await json<MenuBody>(created);
    expect(menu).toMatchObject({ handle: 'main', revision: 1 });
    expect((await send(app, 'GET', `/menus/${menu.id}`)).status).toBe(200);
    const list = await json<{ items: { handle: string; itemCount: number }[]; total: number }>(
      await send(app, 'GET', '/menus', undefined, cpa),
    );
    expect(list).toEqual({
      items: [expect.objectContaining({ handle: 'main', itemCount: 2 })],
      total: 1,
    });

    const moved = await json<MenuBody>(
      await send(app, 'POST', `/menus/${menu.id}/move`, {
        itemId: 'about',
        parentId: 'home',
        index: 0,
        revision: 1,
      }),
    );
    expect(moved.items.map((i) => [i.id, i.children.map((c) => c.id)])).toEqual([
      ['home', ['about']],
    ]);

    // A save against the revision read before the move is a conflict, not an overwrite.
    const stale = await send(app, 'PATCH', `/menus/${menu.id}`, { name: 'Old', revision: 1 });
    expect(stale.status).toBe(409);
    const renamed = await send(app, 'PATCH', `/menus/${menu.id}`, { name: 'Header', revision: 2 });
    expect(await json<{ name: string; revision: number }>(renamed)).toMatchObject({
      name: 'Header',
      revision: 3,
    });

    expect((await send(app, 'DELETE', `/menus/${menu.id}?revision=2`)).status).toBe(409);
    expect((await send(app, 'DELETE', `/menus/${menu.id}?revision=x`)).status).toBe(422);
    expect((await send(app, 'DELETE', `/menus/${menu.id}?revision=3`)).status).toBe(204);
    expect((await send(app, 'GET', `/menus/${menu.id}`)).status).toBe(404);
  });

  it('refuses bad items with 422 naming each, a taken handle with 409, and a reader’s write', async () => {
    const { app } = await makeApp();
    const bad = await send(app, 'POST', '/menus', {
      handle: 'main',
      name: 'Main',
      items: [
        { label: 'x', link: { type: 'url', url: 'javascript:alert(1)' } },
        { link: { type: 'entry', entryId: 'nope' } },
      ],
    });
    expect(bad.status).toBe(422);
    const fields = (await json<{ error: { issues: { field: string }[] } }>(bad)).error.issues.map(
      (d) => d.field,
    );
    expect(fields).toEqual(['items[0].link.url']);
    const missing = await send(app, 'POST', '/menus', {
      handle: 'main',
      name: 'Main',
      items: [{ link: { type: 'entry', entryId: 'nope' } }],
    });
    expect(missing.status).toBe(422);
    expect((await send(app, 'POST', '/menus', { handle: 'main', name: 'Main' })).status).toBe(201);
    expect((await send(app, 'POST', '/menus', { handle: 'main', name: 'Again' })).status).toBe(409);
    expect((await send(app, 'POST', '/menus', { handle: 'x', name: 'X' }, cpa)).status).toBe(403);
  });

  it('previews each item, and Delivery serves the menu resolved against published entries', async () => {
    const { app, ctx, pageId } = await makeApp();
    const menu = await json<MenuBody>(
      await send(app, 'POST', '/menus', {
        handle: 'footer',
        name: 'Footer',
        items: [
          {
            id: 'about',
            link: { type: 'entry', entryId: pageId },
            children: [{ id: 'mail', label: 'Mail', link: { type: 'url', url: 'mailto:a@b.co' } }],
          },
        ],
      }),
    );
    const preview = await json<{ items: { id: string; status: string; url: string | null }[] }>(
      await send(app, 'GET', `/menus/${menu.id}/preview?locale=de`),
    );
    expect(preview.items[0]).toMatchObject({ id: 'about', status: 'live', url: '/pages/about' });

    const delivered = await app.request(`${D}/menus/footer?locale=de`, { headers: cda });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({
      handle: 'footer',
      name: 'Footer',
      locale: 'de',
      items: [
        {
          id: 'about',
          label: 'Über uns',
          url: '/pages/about',
          entry: { id: pageId, contentType: 'menupage' },
          children: [{ id: 'mail', label: 'Mail', url: 'mailto:a@b.co', children: [] }],
        },
      ],
    });
    expect(await json(await app.request(`${D}/menus`, { headers: cda }))).toEqual({
      items: [{ handle: 'footer', name: 'Footer' }],
      total: 1,
    });

    // Unpublished, the page drops out and its child takes its place.
    await unpublishEntry(ctx, scope, pageId);
    const after = await json<{ items: { id: string }[] }>(
      await app.request(`${D}/menus/footer`, { headers: cda }),
    );
    expect(after.items.map((i) => i.id)).toEqual(['mail']);
    expect((await app.request(`${D}/menus/nope`, { headers: cda })).status).toBe(404);
    expect((await app.request(`${D}/menus/footer`)).status).toBe(401);
  });

  it('serves a grant-limited key only what its grants let it read, on Delivery and management', async () => {
    const { app, pageId } = await makeApp();
    await send(app, 'POST', '/menus', {
      handle: 'main',
      name: 'Main',
      items: [
        { id: 'about', link: { type: 'entry', entryId: pageId } },
        { id: 'home', label: 'Home', link: { type: 'url', url: '/' } },
      ],
    });
    const keyFor = async (scopes: string[], contentGrants: unknown[]) => {
      const role = await json<{ id: string }>(
        await app.request('/spaces/s1/roles', {
          method: 'POST',
          headers: admin,
          body: JSON.stringify({ name: `r-${scopes.join()}`, scopes, contentGrants }),
        }),
      );
      const { token } = await json<{ token: string }>(
        await app.request('/spaces/s1/api-keys', {
          method: 'POST',
          headers: admin,
          body: JSON.stringify({
            kind: scopes.includes('delivery:read') ? 'cda' : 'cpa',
            roleId: role.id,
          }),
        }),
      );
      return { Authorization: `Bearer ${token}` };
    };
    const labels = async (url: string, headers: Record<string, string>) =>
      (
        await json<{ items: { id: string; label: string }[] }>(await app.request(url, { headers }))
      ).items.map((i) => [i.id, i.label]);

    // Denied the title: the label isn't its value.
    const noTitle = await keyFor(
      ['delivery:read'],
      [{ contentTypeApiId: 'menupage', actions: ['read'], deniedFields: ['title'] }],
    );
    expect(await labels(`${D}/menus/main`, noTitle)).toEqual([
      ['about', pageId],
      ['home', 'Home'],
    ]);
    // No grant on the type: the item is left out.
    const other = await keyFor(
      ['delivery:read'],
      [{ contentTypeApiId: 'other', actions: ['read'] }],
    );
    expect(await labels(`${D}/menus/main`, other)).toEqual([['home', 'Home']]);
    // The management twin answers the same, with the caller's grants.
    const preview = await keyFor(
      ['preview:read'],
      [{ contentTypeApiId: 'other', actions: ['read'] }],
    );
    expect(await labels(`${M}/menus/resolve/main`, preview)).toEqual([['home', 'Home']]);
    expect(await labels(`${M}/menus/resolve/main`, admin)).toEqual([
      ['about', 'About'],
      ['home', 'Home'],
    ]);
  });
});
