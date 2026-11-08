import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assetUrl,
  createDeliveryClient,
  type DeliveredAsset,
  DeliveryError,
  srcset,
} from '../src/index.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = handler(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cda-tok' };

describe('@commerceworker/sdk-core delivery client', () => {
  let calls: { url: string; init?: RequestInit }[];
  beforeEach(() => {
    calls = [];
  });

  it('builds scoped URLs, sends the bearer token, and passes query params', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { id: 'e1', contentType: 'article', fields: { title: 'Hi' }, publishedAt: 'now' };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });

    const entry = await client.getEntry('e1', { locale: 'de-DE', include: 2 });
    expect(entry.fields.title).toBe('Hi');
    const call = calls[0];
    expect(call?.url).toBe('https://cms.test/delivery/s1/main/entries/e1?locale=de-DE&include=2');
    expect((call!.init!.headers as Record<string, string>).authorization).toBe('Bearer cda-tok');
  });

  it('lists entries via the query builder', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return {
        items: [{ id: 'a', contentType: 'article', fields: {}, publishedAt: 'now' }],
        total: 1,
      };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    const res = await client.query().contentType('article').locale('en-US').limit(5).fetch();
    expect(res.total).toBe(1);
    expect(calls[0]?.url).toContain('content_type=article');
    expect(calls[0]?.url).toContain('locale=en-US');
    expect(calls[0]?.url).toContain('limit=5');
  });

  it('caches responses within the TTL', async () => {
    const fetchImpl = fakeFetch(() => ({
      id: 'e1',
      contentType: 'a',
      fields: {},
      publishedAt: 'now',
    }));
    const client = createDeliveryClient({ ...base, fetch: fetchImpl, cacheTtlMs: 1000 });
    await client.getEntry('e1');
    await client.getEntry('e1');
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // second served from cache
  });

  it('maps non-2xx responses to DeliveryError with the status', async () => {
    const fetchImpl = fakeFetch(() => new Response('nope', { status: 404 }));
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    await expect(client.getEntry('missing')).rejects.toBeInstanceOf(DeliveryError);
    await expect(client.getEntry('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('carries the API error code, message and parsed body on DeliveryError', async () => {
    const body = { error: { code: 'not_found', message: 'Entry missing not found' } };
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch(() => Response.json(body, { status: 404 })),
    });
    const err = await client.getEntry('missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', body });
    expect((err as Error).message).toContain('(Entry missing not found)');
  });

  it('keeps the gateway’s string error as the message, with no code', async () => {
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch(() => Response.json({ error: 'rate limited' }, { status: 429 })),
    });
    const err = (await client.getEntry('e1').catch((e: unknown) => e)) as DeliveryError;
    expect(err.status).toBe(429);
    expect(err.code).toBeUndefined();
    expect(err.body).toEqual({ error: 'rate limited' });
    expect(err.message).toContain('(rate limited)');
  });

  it('caps the server message it puts into DeliveryError.message', async () => {
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch(() =>
        Response.json({ error: { code: 'x', message: 'm'.repeat(5000) } }, { status: 400 }),
      ),
    });
    const err = (await client.getEntry('e1').catch((e: unknown) => e)) as DeliveryError;
    expect(err.message).toContain(`(${'m'.repeat(200)})`);
    expect(err.message).not.toContain('m'.repeat(201));
  });

  it('assetUrl ignores a rendition name that is a prototype key', () => {
    expect(assetUrl(image, { rendition: 'constructor' })).toBeUndefined();
    expect(assetUrl(image, { rendition: '__proto__' })).toBeUndefined();
  });

  it('leaves code and body undefined when the error body is not JSON', async () => {
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 })),
    });
    const err = (await client.getEntry('e1').catch((e: unknown) => e)) as DeliveryError;
    expect(err).toMatchObject({ status: 502, code: undefined, body: undefined });
  });

  it('hits the search endpoint and unwraps hits', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { hits: [{ entryId: 'e1', score: 0.9, snippet: 'x' }] };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    const hits = await client.search('database', { topK: 3 });
    expect(hits[0]?.entryId).toBe('e1');
    expect(calls[0]?.url).toContain('/search?q=database&top_k=3');
  });

  it('reads the site routes and unwraps the items', async () => {
    const routes = [
      { contentType: 'article', urlPattern: '/blog/{slug}' },
      { contentType: 'page', urlPattern: '/{slug}' },
    ];
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { items: routes, total: 2 };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    expect(await client.routes()).toEqual(routes);
    expect(calls[0]?.url).toBe('https://cms.test/delivery/s1/main/routes');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer cda-tok');
  });

  it('reads a page of the sitemap with its query', async () => {
    const page = {
      items: [
        {
          entryId: 'e1',
          contentType: 'article',
          lastmod: '2026-01-01T00:00:00.000Z',
          urls: [{ path: '/blog/hello', locale: 'en-US' }],
        },
      ],
      next: 'e2',
    };
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return page;
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    expect(await client.sitemap({ from: 'e0', limit: 1, base: 'https://example.com' })).toEqual(
      page,
    );
    expect(calls[0]?.url).toBe(
      'https://cms.test/delivery/s1/main/sitemap?from=e0&limit=1&base=https%3A%2F%2Fexample.com',
    );
  });

  it('surfaces a refused routes read as a DeliveryError', async () => {
    const fetchImpl = fakeFetch(() => new Response('Unauthorized', { status: 401 }));
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    await expect(client.routes()).rejects.toMatchObject({ status: 401 });
    await expect(client.routes()).rejects.toBeInstanceOf(DeliveryError);
  });
});

const image: DeliveredAsset = {
  id: 'a1',
  title: 'Hero',
  description: null,
  altText: 'A hill',
  focalPoint: { x: 0.5, y: 0.25 },
  contentType: 'image/jpeg',
  size: 1000,
  width: 1000,
  height: 600,
  kind: 'image',
  url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/o/hero.jpg',
  renditions: { thumb: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/r-thumb/hero.jpg' },
  srcset: [
    {
      width: 320,
      url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/w320/hero.jpg?fm=auto',
    },
    {
      width: 640,
      url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/w640/hero.jpg?fm=auto',
    },
    {
      width: 960,
      url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/w960/hero.jpg?fm=auto',
    },
  ],
  placeholder: null,
  file: { url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/o/hero.jpg' },
};

describe('preview entry paging', () => {
  it('sends the cursor and hands back the next one', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calls.push(url);
      return { items: [], total: 0, nextCursor: 'c2' };
    });
    const client = createDeliveryClient({ ...base, preview: true, fetch: fetchImpl });
    const page = await client.listEntries({ contentType: 'article', limit: 50, cursor: 'c1' });
    expect(page.nextCursor).toBe('c2');
    expect(calls[0]).toBe(
      'https://cms.test/preview/s1/main/entries?content_type=article&limit=50&cursor=c1',
    );
  });
});

describe('assets', () => {
  it('gets and lists assets on the delivery surface, with paging and filters', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calls.push(url);
      return url.includes('/assets/') ? image : { items: [image], total: 1, nextCursor: 'c2' };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });

    expect((await client.getAsset('a1', { locale: 'de-DE' })).id).toBe('a1');
    expect(calls[0]).toBe('https://cms.test/delivery/s1/main/assets/a1?locale=de-DE');

    const page = await client.listAssets({
      limit: 10,
      cursor: 'c1',
      skip: 5,
      kind: 'image',
      tag: 't1',
      folder: 'root',
      locale: 'en-US',
    });
    expect(page.nextCursor).toBe('c2');
    // A cursor wins over an offset.
    expect(calls[1]).toBe(
      'https://cms.test/delivery/s1/main/assets?limit=10&cursor=c1&kind=image&tag=t1&folder=root&locale=en-US',
    );
    await client.listAssets({ skip: 20 });
    expect(calls[2]).toBe('https://cms.test/delivery/s1/main/assets?skip=20');
  });

  it('searches published assets with ?q= and the filters', async () => {
    const calls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return { items: [image], total: 1, facets: { kind: { image: 1 }, tag: {}, folder: {} } };
      }),
    });
    const page = await client.searchAssets('red mug', { kind: 'image', folder: 'root', limit: 5 });
    expect(page.facets.kind).toEqual({ image: 1 });
    expect(calls[0]).toBe(
      'https://cms.test/delivery/s1/main/assets?q=red+mug&limit=5&kind=image&folder=root',
    );
  });

  it('reads a collection’s published assets, in its order, a page at a time', async () => {
    const calls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return { id: 'c1', name: 'Kit', items: [image], nextCursor: 'n2' };
      }),
    });
    const page = await client.getCollection('c 1', { limit: 5, cursor: 'n1', locale: 'en-US' });
    expect(page.items[0]?.id).toBe(image.id);
    expect(page.nextCursor).toBe('n2');
    expect(calls[0]).toBe(
      'https://cms.test/delivery/s1/main/collections/c%201?limit=5&cursor=n1&locale=en-US',
    );
  });

  it('iterates every asset across pages, following nextCursor until the last page', async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown> = {
      first: {
        items: [
          { ...image, id: 'a1' },
          { ...image, id: 'a2' },
        ],
        total: 2,
        nextCursor: 'c2',
      },
      c2: { items: [{ ...image, id: 'a3' }], total: 1, nextCursor: 'c3' },
      c3: { items: [], total: 0 },
    };
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return pages[new URL(url).searchParams.get('cursor') ?? 'first'];
      }),
    });
    const ids: string[] = [];
    for await (const asset of client.iterateAssets({ kind: 'image', limit: 2, skip: 10 })) {
      ids.push(asset.id);
    }
    expect(ids).toEqual(['a1', 'a2', 'a3']);
    expect(calls).toEqual([
      'https://cms.test/delivery/s1/main/assets?limit=2&skip=10&kind=image',
      'https://cms.test/delivery/s1/main/assets?limit=2&cursor=c2&kind=image',
      'https://cms.test/delivery/s1/main/assets?limit=2&cursor=c3&kind=image',
    ]);
  });

  it('fetches the next page only when the loop asks for it', async () => {
    const calls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return { items: [image, image], total: 2, nextCursor: 'more' };
      }),
    });
    for await (const _ of client.iterateAssets()) break;
    expect(calls).toHaveLength(1);
  });

  it('stops with an error on a cursor that repeats instead of paging forever', async () => {
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch(() => ({ items: [image], total: 1, nextCursor: 'same' })),
    });
    const seen: string[] = [];
    await expect(async () => {
      for await (const asset of client.iterateAssets()) seen.push(asset.id);
    }).rejects.toThrow(/cursor same twice/);
    expect(seen).toHaveLength(2);
  });

  it('treats a starting cursor that comes back as a repeat, without yielding its page twice', async () => {
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch(() => ({ items: [image], total: 1, nextCursor: 'c' })),
    });
    const seen: string[] = [];
    await expect(async () => {
      for await (const asset of client.iterateAssets({ cursor: 'c' })) seen.push(asset.id);
    }).rejects.toThrow(/cursor c twice/);
    expect(seen).toHaveLength(1);
  });

  it('iterates a collection’s members across pages, in its order', async () => {
    const calls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return new URL(url).searchParams.get('cursor') === 'n2'
          ? { id: 'c1', name: 'Kit', items: [{ ...image, id: 'm3' }] }
          : {
              id: 'c1',
              name: 'Kit',
              items: [
                { ...image, id: 'm1' },
                { ...image, id: 'm2' },
              ],
              nextCursor: 'n2',
            };
      }),
    });
    const ids: string[] = [];
    for await (const a of client.iterateCollection('c1', { limit: 2, locale: 'en-US' })) {
      ids.push(a.id);
    }
    expect(ids).toEqual(['m1', 'm2', 'm3']);
    expect(calls[1]).toBe(
      'https://cms.test/delivery/s1/main/collections/c1?limit=2&cursor=n2&locale=en-US',
    );
  });

  it('reads drafts from the preview surface', async () => {
    const calls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      preview: true,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return image;
      }),
    });
    await client.getAsset('a1');
    expect(calls[0]).toBe('https://cms.test/preview/s1/main/assets/a1');
  });

  it('picks a rendition, the width step at or above, or the original', () => {
    expect(assetUrl(image)).toBe(image.url);
    expect(assetUrl(image, { rendition: 'thumb' })).toBe(image.renditions.thumb);
    expect(assetUrl(image, { rendition: 'nope' })).toBeUndefined();
    expect(assetUrl(image, { width: 500 })).toBe(image.srcset[1]?.url);
    expect(assetUrl(image, { width: 640 })).toBe(image.srcset[1]?.url);
    // Past the ladder: its largest step.
    expect(assetUrl(image, { width: 5000 })).toBe(image.srcset[2]?.url);
    // No ladder (a PDF, a video): the original.
    expect(assetUrl({ ...image, srcset: [] }, { width: 500 })).toBe(image.url);
    const client = createDeliveryClient(base);
    expect(client.assetUrl(image, { width: 1 })).toBe(image.srcset[0]?.url);
  });

  it('formats the ladder as an srcset value', () => {
    expect(srcset(image)).toBe(
      `${image.srcset[0]?.url} 320w, ${image.srcset[1]?.url} 640w, ${image.srcset[2]?.url} 960w`,
    );
    expect(srcset({ srcset: [] })).toBe('');
  });
});

describe('@commerceworker/sdk-core read-your-writes (preview)', () => {
  // Real D1 bookmarks: hex groups joined by dashes, newer sorts later.
  const OLD = '00000001-00000010-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';
  const NEW = '00000001-00000033-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';
  const NEWER = '00000001-00000040-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';

  /** Answers each request with the next bookmark in `answers` (none once they run out). */
  function bookmarking(answers: (string | undefined)[], from?: string) {
    const sent: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string> | undefined)?.['x-cw-bookmark']);
      const answer = answers.shift();
      const res = new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: answer ? { 'x-cw-bookmark': answer } : {},
      });
      // What a redirect to another host leaves on the Response it resolves to.
      if (from) Object.defineProperty(res, 'url', { value: from });
      return res;
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  }

  it('sends nothing first, then the bookmark of the last response', async () => {
    const { sent, fetchImpl } = bookmarking([OLD, NEW]);
    const client = createDeliveryClient({ ...base, preview: true, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([undefined, OLD, NEW]);
    expect(client.bookmark).toBe(NEW);
  });

  it('keeps the newest bookmark when concurrent responses arrive out of order', async () => {
    const { fetchImpl } = bookmarking([NEW, OLD]);
    const client = createDeliveryClient({ ...base, preview: true, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    expect(client.bookmark).toBe(NEW);
  });

  it('starts from a seeded bookmark and can be handed one explicitly', async () => {
    const { sent, fetchImpl } = bookmarking([]);
    const client = createDeliveryClient({
      ...base,
      preview: true,
      bookmark: NEW,
      fetch: fetchImpl,
    });

    await client.listEntries();
    // Explicit replaces, even with an older one; garbage is dropped; undefined clears.
    client.bookmark = OLD;
    await client.listEntries();
    client.bookmark = 'not-a-bookmark';
    await client.listEntries();
    client.bookmark = NEWER;
    client.bookmark = undefined;
    await client.listEntries();
    expect(sent).toEqual([NEW, OLD, undefined, undefined]);
  });

  it('never sends or keeps one with readYourWrites: false', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEW]);
    const client = createDeliveryClient({
      ...base,
      preview: true,
      readYourWrites: false,
      bookmark: OLD,
      fetch: fetchImpl,
    });

    await client.listEntries();
    client.bookmark = NEWER;
    await client.listEntries();
    expect(sent).toEqual([undefined, undefined]);
    expect(client.bookmark).toBeUndefined();
  });

  it('a Delivery client never sends one: the cached CDN ignores it and refuses the header', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEW]);
    const client = createDeliveryClient({ ...base, bookmark: OLD, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([undefined, undefined]);
    expect(client.bookmark).toBeUndefined();
  });

  it('ignores a bookmark from a response that was redirected to another origin', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEWER], 'https://elsewhere.test/x');
    const client = createDeliveryClient({
      ...base,
      preview: true,
      bookmark: OLD,
      fetch: fetchImpl,
    });

    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([OLD, OLD]);
    expect(client.bookmark).toBe(OLD);
  });

  it('keeps the bookmark of a failed request', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 404, headers: { 'x-cw-bookmark': NEW } }),
    ) as unknown as typeof fetch;
    const client = createDeliveryClient({ ...base, preview: true, fetch: fetchImpl });

    await expect(client.getEntry('missing')).rejects.toBeInstanceOf(DeliveryError);
    expect(client.bookmark).toBe(NEW);
  });
});

describe('@commerceworker/sdk-core read-your-writes on a relative baseUrl', () => {
  it('treats a relative baseUrl as same-origin', async () => {
    const BM = '00000001-00000033-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';
    const sent: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string> | undefined)?.['x-cw-bookmark']);
      return new Response('{"items":[],"total":0}', { headers: { 'x-cw-bookmark': BM } });
    }) as unknown as typeof fetch;
    const client = createDeliveryClient({ ...base, baseUrl: '', preview: true, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([undefined, BM]);
  });
});

describe('@commerceworker/sdk-core taxonomy', () => {
  const tag = {
    id: 't1',
    slug: 'news',
    label: 'Nachrichten',
    description: null,
    count: 3,
    countsByContentType: { article: 3 },
  };

  it('lists and gets tags and concepts by slug', async () => {
    const urls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        urls.push(url);
        return url.includes('/taxonomy/tags/') || url.includes('/taxonomy/concepts/')
          ? tag
          : { items: [tag] };
      }),
    });
    expect(await client.listTags({ locale: 'de', contentType: 'article' })).toEqual([tag]);
    expect((await client.getTag('news')).count).toBe(3);
    await client.listConcepts({ scheme: 'topics' });
    await client.getConcept('a b', { scheme: 'topics' });
    expect(urls).toEqual([
      'https://cms.test/delivery/s1/main/taxonomy/tags?locale=de&content_type=article',
      'https://cms.test/delivery/s1/main/taxonomy/tags/news',
      'https://cms.test/delivery/s1/main/taxonomy/concepts?scheme=topics',
      'https://cms.test/delivery/s1/main/taxonomy/concepts/a%20b?scheme=topics',
    ]);
  });

  it('filters entries by tag slug, and passes metadata filters through unprefixed', async () => {
    const urls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        urls.push(url);
        return { items: [], total: 0 };
      }),
    });
    await client.query().contentType('article').tagged('news', 'sport').fetch();
    await client.listEntries({
      filters: [{ field: 'metadata.concepts.slug', op: 'nin', value: ['cats'] }],
    });
    const first = new URL(urls[0] ?? '');
    expect(first.searchParams.get('metadata.tags.slug[in]')).toBe('news,sport');
    expect(new URL(urls[1] ?? '').searchParams.get('metadata.concepts.slug[nin]')).toBe('cats');
  });

  it('filters by referenced entry: references() on a field, linksTo() from any', async () => {
    const urls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        urls.push(url);
        return { items: [], total: 0 };
      }),
    });
    await client.query().contentType('post').references('author', 'a1').fetch();
    await client.query().references('related', 'a1', 'a2').linksTo('b1').linksTo('b2').fetch();
    const [one, two] = urls.map((u) => new URL(u).searchParams);
    expect(one?.get('fields.author[ref]')).toBe('a1');
    expect(two?.get('fields.related[refIn]')).toBe('a1,a2');
    expect(two?.get('links_to_entry')).toBe('b1,b2');
  });

  it('chained or() groups join one root and, however many', async () => {
    const urls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        urls.push(url);
        return { items: [], total: 0 };
      }),
    });
    let q = client.query();
    for (let i = 0; i < 5; i++) q = q.or({ field: 'title', value: `t${i}` });
    await q.fetch();
    const where = JSON.parse(new URL(urls[0] ?? '').searchParams.get('where') ?? 'null');
    expect(where).toEqual({
      and: Array.from({ length: 5 }, (_, i) => ({ or: [{ field: 'title', value: `t${i}` }] })),
    });
  });

  it('references() without an id throws rather than sending an empty filter', () => {
    const client = createDeliveryClient({ ...base, fetch: fakeFetch(() => ({ items: [] })) });
    expect(() => client.query().references('author')).toThrow(/at least one entry id/);
  });

  it('sends startsWith, between, component paths and or() groups as the API spells them', async () => {
    const urls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        urls.push(url);
        return { items: [], total: 0 };
      }),
    });
    await client
      .query()
      .where('title', 'startsWith', 'Ap')
      .where('views', 'between', [10, 20])
      .where('seo.title', 'match', 'jam')
      .or({ field: 'title', value: 'A' }, { field: 'views', op: 'gt', value: 9 })
      .or({ field: 'tags', value: 'x' })
      .fetch();
    const params = new URL(urls[0] ?? '').searchParams;
    expect(params.get('fields.title[startsWith]')).toBe('Ap');
    expect(params.get('fields.views[between]')).toBe('10,20');
    expect(params.get('fields.seo.title[match]')).toBe('jam');
    expect(JSON.parse(params.get('where') ?? 'null')).toEqual({
      and: [
        {
          or: [
            { field: 'title', value: 'A' },
            { field: 'views', op: 'gt', value: 9 },
          ],
        },
        { or: [{ field: 'tags', value: 'x' }] },
      ],
    });
  });
});
