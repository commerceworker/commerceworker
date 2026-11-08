import type { ApiConfig } from '@commerceworker/platform/config';
import { FakeImageTransformer, FakeMediaPathSigner } from '@commerceworker/test-kit';
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
    locales: ['en-US', 'de-DE'],
    scale: 1,
  },
});

const MEDIA = 'https://media.example.test';
const paths = new FakeMediaPathSigner();
const mediaBase = (id: string) =>
  `${MEDIA}/s1/main/${id}/v1/${paths.token({ spaceId: 's1', environmentId: 'main' }, id, 1)}`;
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const cda = { Authorization: 'Bearer cda' };
const cpa = { Authorization: 'Bearer cpa' };
const M = '/spaces/s1/environments/main';
const D = '/delivery/s1/main';

function makeApp(opts: { media?: boolean; onWire?: (w: ReturnType<typeof wire>) => void } = {}) {
  const wired = wire(config);
  opts.onWire?.(wired);
  const { ctx, rag, blob, ai } = wired;
  return createApp(
    {
      ...ctx,
      images: new FakeImageTransformer(),
      ...(opts.media === false ? {} : { mediaPublicUrl: MEDIA, mediaPaths: paths }),
    },
    config,
    rag,
    blob,
    ai,
  );
}

type App = ReturnType<typeof makeApp>;

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return (await r.json()) as T;
}

/** Creates (and by default publishes) an image with localized title and alt text. */
async function image(app: App, opts: { publish?: boolean; fileName?: string } = {}) {
  const fileName = opts.fileName ?? 'hero.jpg';
  const { asset } = await json<{ asset: { id: string; file: { url: string } } }>(
    app.request(`${M}/assets`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        fileName,
        contentType: 'image/jpeg',
        title: { 'en-US': 'Hero', 'de-DE': 'Held' },
      }),
    }),
    201,
  );
  await json(
    app.request(`${M}/assets/${asset.id}/metadata`, {
      method: 'PATCH',
      headers: cma,
      body: JSON.stringify({ altText: { 'en-US': 'A hero' }, focalPoint: { x: 0.5, y: 0.2 } }),
    }),
  );
  if (opts.publish !== false) {
    await json(app.request(`${M}/assets/${asset.id}/published`, { method: 'POST', headers: cma }));
  }
  return asset;
}

describe('delivered assets over REST', () => {
  it('serve the v2 shape with media URLs, renditions and a srcset', async () => {
    const app = makeApp();
    await json(
      app.request(`${M}/asset-renditions`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify({ name: 'card', width: 600, height: 400, fit: 'crop' }),
      }),
      201,
    );
    const a = await image(app);
    const d = await json<Record<string, unknown>>(
      app.request(`${D}/assets/${a.id}`, { headers: cda }),
    );
    const base = mediaBase(a.id);
    expect(d).toMatchObject({
      id: a.id,
      title: { 'en-US': 'Hero', 'de-DE': 'Held' },
      altText: { 'en-US': 'A hero' },
      focalPoint: { x: 0.5, y: 0.2 },
      contentType: 'image/jpeg',
      kind: 'image',
      url: `${base}/o/hero.jpg`,
      renditions: { card: `${base}/r-card/hero.jpg` },
      file: { url: `${base}/o/hero.jpg`, fileName: 'hero.jpg' },
    });
    expect((d.srcset as { width: number }[]).map((s) => s.width)).toEqual([
      320, 640, 960, 1280, 1920, 2560,
    ]);

    const de = await json<Record<string, unknown>>(
      app.request(`${D}/assets/${a.id}?locale=de-DE`, { headers: cda }),
    );
    // Alt text falls back to the default locale.
    expect(de).toMatchObject({ title: 'Held', altText: 'A hero' });
  });

  it('list a page at a time with a cursor, and filter', async () => {
    const app = makeApp();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await image(app, { fileName: `p${i}.jpg` })).id);
    await image(app, { publish: false, fileName: 'draft.jpg' });
    const first = await json<{ items: { id: string }[]; total: number; nextCursor?: string }>(
      app.request(`${D}/assets?limit=2&locale=en-US`, { headers: cda }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await json<{ items: { id: string; title: unknown }[]; nextCursor?: string }>(
      app.request(`${D}/assets?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`, {
        headers: cda,
      }),
    );
    expect(second.nextCursor).toBeUndefined();
    expect([...first.items, ...second.items].map((x) => x.id).sort()).toEqual([...ids].sort());
    const none = await json<{ items: unknown[] }>(
      app.request(`${D}/assets?kind=video`, { headers: cda }),
    );
    expect(none.items).toEqual([]);
    expect((await app.request(`${D}/assets?kind=nonsense`, { headers: cda })).status).toBe(422);
  });

  it('redirect the deprecated transform permanently to the matching media URL', async () => {
    const app = makeApp();
    const a = await image(app);
    const res = await app.request(`${D}/assets/${a.id}/transform?w=700&fit=crop`, {
      headers: cda,
    });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${mediaBase(a.id)}/w960/hero.jpg?fm=auto`);
    const unknown = await app.request(`${D}/assets/${a.id}/transform?rendition=nope`, {
      headers: cda,
    });
    expect(unknown.status).toBe(404);
  });

  it('keep the stored URL without a media origin', async () => {
    const app = makeApp({ media: false });
    const a = await image(app);
    const d = await json<{ url: string; srcset: unknown[] }>(
      app.request(`${D}/assets/${a.id}`, { headers: cda }),
    );
    // The stored URL: what the create response signed, without its expiry.
    expect(d.url).toBe(a.file.url.replace(/\?ttl=900$/, ''));
    expect(d.srcset).toEqual([]);
  });
});

describe('Management and Preview asset reads', () => {
  it('hand out short-lived signed URLs, never the stored one', async () => {
    const app = makeApp();
    const a = await image(app, { publish: false });
    const got = await json<{ file: { url: string } }>(
      app.request(`${M}/assets/${a.id}`, { headers: cma }),
    );
    const listed = await json<{ items: { id: string; file: { url: string } }[] }>(
      app.request(`${M}/assets`, { headers: cma }),
    );
    // Even the create response's.
    for (const url of [
      a.file.url,
      got.file.url,
      listed.items.find((x) => x.id === a.id)?.file.url,
    ]) {
      expect(url).toMatch(/\?ttl=900$/);
    }
  });

  it('serve drafts on Preview in Delivery’s shape, signed and expiring', async () => {
    const app = makeApp();
    const a = await image(app, { publish: false });
    // Not on Delivery: it isn't published.
    expect((await app.request(`${D}/assets/${a.id}`, { headers: cda })).status).toBe(404);
    const p = await json<{ id: string; url: string; title: unknown; srcset: unknown[] }>(
      app.request(`/preview/s1/main/assets/${a.id}?locale=en-US`, { headers: cpa }),
    );
    expect(p).toMatchObject({ id: a.id, title: 'Hero' });
    expect(p.url).toMatch(/^https:\/\/media\.example\.test\/.+\?ttl=900$/);
    expect(p.srcset).toHaveLength(6);
    const list = await json<{ items: { id: string }[] }>(
      app.request('/preview/s1/main/assets', { headers: cpa }),
    );
    expect(list.items.map((x) => x.id)).toContain(a.id);
    // A delivery key can't read Preview.
    expect((await app.request(`/preview/s1/main/assets/${a.id}`, { headers: cda })).status).toBe(
      403,
    );
  });
});

describe('the GraphQL Asset type', () => {
  it('chooses URLs by rendition or width and text by locale', async () => {
    const app = makeApp();
    await json(
      app.request(`${M}/asset-renditions`, {
        method: 'POST',
        headers: cma,
        body: JSON.stringify({ name: 'thumb', width: 100 }),
      }),
      201,
    );
    const a = await image(app);
    const query = `{
      asset(id: "${a.id}", locale: "de-DE") {
        id title altText enTitle: title(locale: "en-US") kind contentType
        url thumb: url(rendition: "thumb") mid: url(width: 700) huge: url(width: 99999)
        missing: url(rendition: "nope")
        srcset { width url }
        focalPoint { x y }
        video { status }
      }
    }`;
    const res = await json<{ data: { asset: Record<string, unknown> }; errors?: unknown }>(
      app.request(`${D}/graphql`, {
        method: 'POST',
        headers: { ...cda, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
    );
    expect(res.errors).toBeUndefined();
    const base = mediaBase(a.id);
    expect(res.data.asset).toMatchObject({
      id: a.id,
      title: 'Held',
      // No German alt text: the space's fallback.
      altText: 'A hero',
      enTitle: 'Hero',
      kind: 'image',
      url: `${base}/o/hero.jpg`,
      thumb: `${base}/r-thumb/hero.jpg`,
      mid: `${base}/w960/hero.jpg?fm=auto`,
      huge: `${base}/w2560/hero.jpg?fm=auto`,
      missing: null,
      focalPoint: { x: 0.5, y: 0.2 },
      video: null,
    });
    expect((res.data.asset.srcset as unknown[]).length).toBe(6);
  });
});

describe('image placeholders', () => {
  const placeholder = {
    thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw==',
    dominantColor: '#a07850',
  };
  const scope = { spaceId: 's1', environmentId: 'main' };

  it('are null until ingest records one, then on Delivery, GraphQL and Preview alike', async () => {
    let store: ReturnType<typeof wire>['ctx']['store'] | undefined;
    const app = makeApp({ onWire: (w) => (store = w.ctx.store) });
    const a = await image(app);
    const before = await json<{ placeholder: unknown }>(
      app.request(`${D}/assets/${a.id}`, { headers: cda }),
    );
    expect(before.placeholder).toBeNull();

    // What ingest's placeholder and finish steps write.
    await store?.assets.recordIngest(scope, a.id, 1, { placeholder });
    await store?.assets.recordPublishedFile(scope, a.id, 1, { placeholder });

    const rest = await json<{ placeholder: unknown }>(
      app.request(`${D}/assets/${a.id}`, { headers: cda }),
    );
    expect(rest.placeholder).toEqual(placeholder);
    const preview = await json<{ placeholder: unknown }>(
      app.request(`/preview/s1/main/assets/${a.id}`, { headers: cpa }),
    );
    expect(preview.placeholder).toEqual(placeholder);
    const gql = await json<{ data: { asset: { placeholder: unknown } }; errors?: unknown }>(
      app.request(`${D}/graphql`, {
        method: 'POST',
        headers: { ...cda, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `{ asset(id: "${a.id}") { placeholder { thumbhash dominantColor } } }`,
        }),
      }),
    );
    expect(gql.errors).toBeUndefined();
    expect(gql.data.asset.placeholder).toEqual(placeholder);
  });
});

describe('rendition presets over REST', () => {
  it('are managed with content:manage and read with preview:read', async () => {
    const app = makeApp();
    const body = JSON.stringify({ name: 'og', width: 1200, height: 630, fit: 'crop' });
    const created = await json<{ name: string }>(
      app.request(`${M}/asset-renditions`, { method: 'POST', headers: cma, body }),
      201,
    );
    expect(created).toMatchObject({ name: 'og', width: 1200, height: 630, fit: 'crop' });
    expect(
      (await app.request(`${M}/asset-renditions`, { method: 'POST', headers: cma, body })).status,
    ).toBe(409);
    expect(
      (
        await app.request(`${M}/asset-renditions`, {
          method: 'POST',
          headers: cma,
          body: JSON.stringify({ name: 'Bad Name', width: 1 }),
        })
      ).status,
    ).toBe(422);
    const replaced = await json<Record<string, unknown>>(
      app.request(`${M}/asset-renditions/og`, {
        method: 'PUT',
        headers: cma,
        body: JSON.stringify({ width: 600, format: 'webp' }),
      }),
    );
    expect(replaced).toMatchObject({ name: 'og', width: 600, format: 'webp' });
    expect(replaced.height).toBeUndefined();
    const listed = await json<{ items: { name: string }[] }>(
      app.request(`${M}/asset-renditions`, { headers: { Authorization: 'Bearer cpa' } }),
    );
    expect(listed.items.map((r) => r.name)).toEqual(['og']);
    // A Preview key reads them but can't change them.
    expect(
      (
        await app.request(`${M}/asset-renditions/og`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer cpa' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request(`${M}/asset-renditions/og`, { method: 'DELETE', headers: cma })).status,
    ).toBe(204);
    expect((await app.request(`${M}/asset-renditions/og`, { headers: cma })).status).toBe(404);
  });
});
