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
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function seed() {
  const { ctx, rag, blob, ai } = wire(config);
  const app = createApp(ctx, config, rag, blob, ai);
  for (const apiId of ['note', 'page']) {
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId,
        name: apiId,
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
    await app.request(`${M}/content-types/${apiId}/published`, { method: 'POST', headers: cma });
  }
  const create = async (type: string, title: string) => {
    const { entry } = await json<{ entry: { id: string } }>(
      await app.request(`${M}/entries`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify({ contentTypeApiId: type, fields: { title: { 'en-US': title } } }),
      }),
    );
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });
    return entry.id;
  };
  const move = (id: string, body: unknown, headers: Record<string, string> = cma) =>
    app.request(`${M}/entries/${id}/move`, { method: 'POST', headers, body: JSON.stringify(body) });
  const delivered = async () =>
    (
      await json<{ items: { id: string }[] }>(
        await app.request(`${D}/entries?content_type=note&order=sys.position`, {
          headers: { Authorization: 'Bearer cda' },
        }),
      )
    ).items.map((i) => i.id);
  return { app, create, move, delivered };
}

describe('moving entries over HTTP', () => {
  it('moves an entry first and last, and Delivery serves the order at once', async () => {
    const h = await seed();
    const ids = [
      await h.create('note', 'A'),
      await h.create('note', 'B'),
      await h.create('note', 'C'),
    ];
    const start = await h.delivered();
    const last = start.at(-1) as string;
    const res = await h.move(last, { after: null });
    expect(res.status).toBe(200);
    expect(await json<{ id: string; position: string }>(res)).toMatchObject({ id: last });
    expect((await h.delivered())[0]).toBe(last);
    const first = (await h.delivered())[0] as string;
    expect((await h.move(first, { before: null })).status).toBe(200);
    expect((await h.delivered()).at(-1)).toBe(first);
    expect(new Set(await h.delivered())).toEqual(new Set(ids));
  });

  it('refuses a bad body, an anchor of another type, and a role without write on the type', async () => {
    const h = await seed();
    const a = await h.create('note', 'A');
    const b = await h.create('note', 'B');
    const page = await h.create('page', 'P');
    expect((await h.move(a, { after: b, before: b })).status).toBe(422);
    expect((await h.move(a, {})).status).toBe(422);
    expect((await h.move(a, { after: page })).status).toBe(422);

    const role = await json<{ id: string }>(
      await h.app.request('/spaces/s1/roles', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          name: 'Pages only',
          scopes: ['content:write', 'preview:read'],
          contentGrants: [{ contentTypeApiId: 'page', actions: ['read', 'write'] }],
        }),
      }),
    );
    const { token } = await json<{ token: string }>(
      await h.app.request('/spaces/s1/api-keys', {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ kind: 'cma', roleId: role.id }),
      }),
    );
    const pagesOnly = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await h.move(a, { after: b }, pagesOnly)).status).toBe(403);
  });
});
