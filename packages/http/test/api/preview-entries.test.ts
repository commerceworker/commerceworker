import type { ApiConfig } from '@commerceworker/platform/config';
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
const cpa = { Authorization: 'Bearer cpa' };
const M = '/spaces/s1/environments/main';
const P = '/preview/s1/main';

interface Page {
  items: { id: string; status: string; updatedAt?: string; fields: Record<string, unknown> }[];
  total: number;
  nextCursor?: string;
}

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      apiId: 'note',
      name: 'Note',
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
  await app.request(`${M}/content-types/note/published`, { method: 'POST', headers: cma });
});

const create = (title: string) =>
  app.request(`${M}/entries`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({ contentTypeApiId: 'note', fields: { title: { 'en-US': title } } }),
  });

const list = async (qs: string) => {
  const res = await app.request(`${P}/entries?${qs}`, { headers: cpa });
  return { status: res.status, body: (await res.json()) as Page };
};

describe('GET /preview/.../entries paging', () => {
  it('pages past 100 entries with nextCursor, each entry once, and stops at the end', async () => {
    for (let i = 0; i < 130; i++) await create(`Note ${i}`);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { status, body } = await list(
        `content_type=note&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(status).toBe(200);
      expect(body.total).toBe(body.items.length);
      seen.push(...body.items.map((e) => e.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(130);
  });

  it('carries when each entry last changed', async () => {
    await create('Stamped');
    const { body } = await list('content_type=note');
    expect(body.items[0]?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(body.nextCursor).toBeUndefined();
  });

  it('walks a header sort: the order and its cursor travel together', async () => {
    for (const t of ['b', 'c', 'a']) await create(t);
    const first = await list('content_type=note&order=-fields.title&limit=2');
    const next = await list(
      `content_type=note&order=-fields.title&limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
    );
    const titles = [...first.body.items, ...next.body.items].map(
      (e) => (e.fields.title as Record<string, string>)['en-US'],
    );
    expect(titles).toEqual(['c', 'b', 'a']);
  });

  it('refuses a cursor from another order as invalid (422)', async () => {
    for (const t of ['b', 'c', 'a']) await create(t);
    const first = await list('content_type=note&limit=1');
    const res = await app.request(
      `${P}/entries?content_type=note&order=fields.title&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`,
      { headers: cpa },
    );
    expect(res.status).toBe(422);
  });

  it('refuses skip, so a client paging by offset hears it (422)', async () => {
    const res = await app.request(`${P}/entries?content_type=note&skip=100`, { headers: cpa });
    expect(res.status).toBe(422);
  });
});
