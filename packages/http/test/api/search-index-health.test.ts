import type { ApiConfig } from '@commerceworker/platform/config';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import { InMemorySearchIndex } from '@commerceworker/test-kit';
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
const cda = { Authorization: 'Bearer cda' };
const M = '/spaces/s1/environments/main';

function build(searchIndex?: InMemorySearchIndex) {
  const { ctx, rag, blob, ai } = wire(config);
  return {
    ctx,
    app: createApp(
      ctx,
      config,
      searchIndex ? { ...rag, searchIndex } : rag,
      blob,
      ai,
      inMemoryEdge(),
    ),
  };
}

async function publishArticle(app: ReturnType<typeof createApp>, title: string) {
  const created = await app.request(`${M}/entries`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title } },
    }),
  });
  const { entry } = (await created.json()) as { entry: { id: string } };
  await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });
  return entry.id;
}

let app: ReturnType<typeof createApp>;
let index: InMemorySearchIndex;

beforeEach(async () => {
  index = new InMemorySearchIndex();
  app = build(index).app;
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
});

describe('GET search/index', () => {
  it('is mounted and reports the environment it was asked about', async () => {
    await publishArticle(app, 'One');
    const res = await app.request(`${M}/search/index`, { headers: cma });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ publishedEntries: 1 });
  });

  it('surfaces drift the operator would otherwise have to guess at', async () => {
    await publishArticle(app, 'One');
    await publishArticle(app, 'Two');
    await index.index(
      { spaceId: 's1', environmentId: 'main' },
      { entryId: 'e-only-one', contentTypeApiId: 'article', textByLocale: {}, entryVersion: 1 },
    );
    const body = (await (await app.request(`${M}/search/index`, { headers: cma })).json()) as {
      drift: number;
      inSync: boolean;
    };
    expect(body.drift).toBe(-1);
    expect(body.inSync).toBe(false);
  });

  it('narrows to a content type when asked', async () => {
    await publishArticle(app, 'One');
    const res = await app.request(`${M}/search/index?content_type=nothing`, { headers: cma });
    expect(await res.json()).toMatchObject({ publishedEntries: 0 });
  });

  it('says no index is bound rather than reporting a broken one', async () => {
    const plain = build().app;
    const res = await plain.request(`${M}/search/index`, { headers: cma });
    expect(await res.json()).toMatchObject({ bound: false });
  });

  it('refuses a delivery token', async () => {
    // A CDA token carries search:read and ships in browsers. How much is
    // published, and whether indexing has quietly stopped, is operational
    // posture — not something to hand to every visitor.
    expect((await app.request(`${M}/search/index`, { headers: cda })).status).toBe(403);
  });
});
