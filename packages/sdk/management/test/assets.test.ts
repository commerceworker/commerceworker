import { describe, expect, it, vi } from 'vitest';
import { createManagementClient } from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma-tok' };
const M = 'https://cms.test/spaces/s1/environments/main';

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** A fake api that answers each request with `answer(call)` (a 204 for `undefined`). */
function api(answer: (call: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    const out = answer(call);
    return out === undefined
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(out), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  }) as unknown as typeof fetch;
  return { client: createManagementClient({ ...base, fetch: fetchImpl }), calls };
}

const route = (c: Call) => `${c.method} ${c.url.replace(M, '')}`;

describe('assets.renditions', () => {
  it('lists, reads, creates, replaces and deletes presets on the asset-renditions routes', async () => {
    const preset = { name: 'thumb', width: 200, createdAt: 'x', updatedAt: 'x' };
    const { client, calls } = api((c) =>
      c.method === 'DELETE'
        ? undefined
        : c.url.endsWith('/asset-renditions') && c.method === 'GET'
          ? { items: [preset] }
          : preset,
    );
    expect(await client.assets.renditions.list()).toEqual([preset]);
    expect(await client.assets.renditions.get('thumb')).toEqual(preset);
    await client.assets.renditions.create({ name: 'thumb', width: 200, fit: 'crop' });
    await client.assets.renditions.update('thumb', { width: 320, format: 'webp' });
    await expect(client.assets.renditions.delete('thumb')).resolves.toBeUndefined();
    expect(calls.map(route)).toEqual([
      'GET /asset-renditions',
      'GET /asset-renditions/thumb',
      'POST /asset-renditions',
      'PUT /asset-renditions/thumb',
      'DELETE /asset-renditions/thumb',
    ]);
    expect(calls[2]?.body).toEqual({ name: 'thumb', width: 200, fit: 'crop' });
    expect(calls[3]?.body).toEqual({ width: 320, format: 'webp' });
  });
});

describe('assets.videos', () => {
  it('creates a video asset and refreshes its status from the host', async () => {
    const { client, calls } = api((c) =>
      c.url.endsWith('/assets/videos')
        ? {
            asset: { id: 'v1' },
            upload: { videoId: 'h1', uploadUrl: 'https://up', method: 'POST', fileField: 'file' },
          }
        : { id: 'v1', file: { video: { status: 'ready' } } },
    );
    const created = await client.assets.videos.create({
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      maxDurationSeconds: 60,
    });
    expect(created.upload.fileField).toBe('file');
    const refreshed = await client.assets.videos.refresh('v1');
    expect(refreshed.file.video?.status).toBe('ready');
    expect(calls.map(route)).toEqual(['POST /assets/videos', 'POST /assets/v1/video/refresh']);
    expect(calls[0]?.body).toEqual({
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      maxDurationSeconds: 60,
    });
  });
});

describe('assets AI helpers and transforms', () => {
  it('generates alt text and tags, sending apply and the other options as the body', async () => {
    const { client, calls } = api((c) =>
      c.url.endsWith('/alt-text')
        ? {
            altText: 'A cup',
            locale: 'en-US',
            applied: true,
            usage: { inputTokens: 1, outputTokens: 2 },
          }
        : {
            tagIds: ['t1'],
            newTags: ['mug'],
            applied: false,
            usage: { inputTokens: 1, outputTokens: 2 },
          },
    );
    const alt = await client.assets.generateAltText('a1', { apply: true, locale: 'en-US' });
    expect(alt).toMatchObject({ altText: 'A cup', applied: true });
    const tags = await client.assets.autoTag('a1');
    expect(tags.newTags).toEqual(['mug']);
    expect(calls.map(route)).toEqual(['POST /assets/a1/alt-text', 'POST /assets/a1/auto-tag']);
    expect(calls[0]?.body).toEqual({ apply: true, locale: 'en-US' });
    expect(calls[1]?.body).toEqual({});
  });

  it('asks for a transform URL with the query names the route reads (w, h, fit, fm, q)', async () => {
    const { client, calls } = api(() => ({ url: 'https://img/x', transform: { width: 400 } }));
    const out = await client.assets.transformUrl('a1', {
      width: 400,
      height: 300,
      fit: 'crop',
      format: 'webp',
      quality: 80,
    });
    expect(out.url).toBe('https://img/x');
    expect(calls[0]?.url).toBe(`${M}/assets/a1/transform?w=400&h=300&fit=crop&fm=webp&q=80`);

    await client.assets.transformUrl('a1', { width: 10 });
    expect(calls[1]?.url).toBe(`${M}/assets/a1/transform?w=10`);
  });
});

/** Answers a cursor-paged list from `all`, `size` at a time, keyed by an index cursor. */
function paged<T>(all: readonly T[], size: number) {
  return (c: Call) => {
    const at = Number(new URL(c.url).searchParams.get('cursor') ?? '0');
    const next = at + size;
    return {
      items: all.slice(at, next),
      ...(next < all.length ? { nextCursor: String(next) } : {}),
    };
  };
}

describe('iterators', () => {
  const assets = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}` }));

  it('assets.iterate follows nextCursor, keeping the filters on every page', async () => {
    const { client, calls } = api(paged(assets, 2));
    const seen: string[] = [];
    for await (const a of client.assets.iterate({ kind: 'image', limit: 2 })) seen.push(a.id);
    expect(seen).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(calls.map((c) => c.url.replace(M, ''))).toEqual([
      '/assets?kind=image&limit=2',
      '/assets?kind=image&limit=2&cursor=2',
      '/assets?kind=image&limit=2&cursor=4',
    ]);
  });

  it('fetches no further than the loop reads', async () => {
    const { client, calls } = api(paged(assets, 2));
    for await (const a of client.assets.iterate({ limit: 2 })) {
      if (a.id === 'a1') break;
    }
    expect(calls).toHaveLength(1);
  });

  it('starts from a given cursor', async () => {
    const { client } = api(paged(assets, 2));
    const seen: string[] = [];
    for await (const a of client.assets.iterate({ cursor: '3', limit: 2 })) seen.push(a.id);
    expect(seen).toEqual(['a3', 'a4']);
  });

  it('collections.iterate and collections.iterateAssets page their own routes', async () => {
    const collections = [{ id: 'c0' }, { id: 'c1' }, { id: 'c2' }];
    const { client, calls } = api((c) =>
      c.url.includes('/asset-collections/c1/assets')
        ? paged(assets, 3)(c)
        : paged(collections, 2)(c),
    );
    const cs: string[] = [];
    for await (const c of client.assets.collections.iterate({ limit: 2 })) cs.push(c.id);
    expect(cs).toEqual(['c0', 'c1', 'c2']);
    const members: string[] = [];
    for await (const a of client.assets.collections.iterateAssets('c1', { status: 'all' })) {
      members.push(a.id);
    }
    expect(members).toHaveLength(5);
    expect(calls.map((c) => c.url.replace(M, ''))).toEqual([
      '/asset-collections?limit=2',
      '/asset-collections?limit=2&cursor=2',
      '/asset-collections/c1/assets?status=all',
      '/asset-collections/c1/assets?status=all&cursor=3',
    ]);
  });

  it('stops with an error when the api hands back a cursor it already gave', async () => {
    const { client } = api(() => ({ items: [{ id: 'x' }], nextCursor: 'same' }));
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const a of client.assets.iterate()) seen.push(a.id);
      })(),
    ).rejects.toThrow(/cursor same twice/);
    expect(seen).toEqual(['x', 'x']);
  });

  it('a failed page rejects the loop with the ManagementError', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      n++ === 0
        ? new Response(JSON.stringify({ items: [{ id: 'a0' }], nextCursor: '1' }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'internal', message: 'x' } }), {
            status: 500,
          }),
    ) as unknown as typeof fetch;
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const a of client.assets.iterate()) seen.push(a.id);
      })(),
    ).rejects.toMatchObject({ status: 500, code: 'internal' });
    expect(seen).toEqual(['a0']);
  });
});
