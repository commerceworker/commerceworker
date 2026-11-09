import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
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
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';
const P = '/preview/s1/main';

let app: ReturnType<typeof createApp>;

const suggest = async (qs: string, headers: Record<string, string> = cpa) =>
  app.request(`${P}/suggest${qs}`, { headers });

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai, inMemoryEdge());
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
      ],
    }),
  });
  await app.request(`${M}/content-types/article/published`, { method: 'POST', headers: cma });
});

const create = (title: string) =>
  app.request(`${M}/entries`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({ contentTypeApiId: 'article', fields: { title: { 'en-US': title } } }),
  });

describe('suggest over HTTP', () => {
  it('returns entries matching what was typed', async () => {
    await create('Baking sourdough');
    await create('Cycling in winter');

    const res = await suggest('?q=Baking');
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { title: string; id: string }[] };
    expect(items.map((i) => i.title)).toEqual(['Baking sourdough']);
    expect(items[0]?.id).toBeTruthy();
  });

  it('reaches an entry the list endpoint would never show', async () => {
    // The whole reason this endpoint exists. The list is capped at 100, so a
    // chooser that fetches and filters cannot see this one at all.
    for (let i = 0; i < 120; i += 1) await create(`Filler ${i}`);
    await create('Needle in the haystack');

    const listed = await (await app.request(`${P}/entries?limit=100`, { headers: cpa })).json();
    const listedTitles = ((listed as { items: { fields: Record<string, unknown> }[] }).items ?? [])
      .map((e) => (e.fields.title as Record<string, string> | undefined)?.['en-US'])
      .filter(Boolean);
    expect(listedTitles).not.toContain('Needle in the haystack');

    const { items } = (await (await suggest('?q=Needle')).json()) as { items: { title: string }[] };
    expect(items.map((i) => i.title)).toEqual(['Needle in the haystack']);
  });

  it('caps what a caller can ask for', async () => {
    for (let i = 0; i < 60; i += 1) await create(`Item ${i}`);
    const { items } = (await (await suggest('?limit=999')).json()) as { items: unknown[] };
    expect(items.length).toBeLessThanOrEqual(50);
  });

  it('needs preview:read — a delivery key reads published content, not drafts', async () => {
    expect((await suggest('?q=x', cda)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await app.request(`${P}/suggest?q=x`)).status).toBe(401);
  });
});
