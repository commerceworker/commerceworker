import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiFieldIssues,
  assetUsageOf,
  BOOKMARK_HEADER,
  type Connection,
  createManagementClient,
  currentBookmark,
  resetBookmark,
  sameOriginUpload,
  UploadPartError,
} from '~/cms/lib/management';

beforeEach(() => resetBookmark());

const conn: Connection = {
  space: 's1',
  environment: 'main',
  locale: 'en-US',
};

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = handler(url, init);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('admin ManagementClient', () => {
  it('lists content types from the same-origin management base, with no bearer token', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [{ apiId: 'article', name: 'Article' }] }));
    const client = createManagementClient(conn, fn);
    const types = await client.listContentTypes();
    expect(types[0]?.apiId).toBe('article');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/content-types');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(calls[0]!.init!.credentials).toBe('same-origin');
  });

  it('lists entries from the PREVIEW base (drafts), filtered by content type', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [] }));
    const client = createManagementClient(conn, fn);
    await client.listEntries('article');
    expect(calls[0]?.url).toBe('/preview/s1/main/entries?content_type=article');
  });

  it('reads a list longer than one API page page by page, following the cursor to the end', async () => {
    const { fn, calls } = fakeFetch((url) => {
      const from = Number(new URL(url, 'http://x').searchParams.get('cursor') ?? 0);
      // 250 entries in all: two full pages of 100, then 50 with no cursor after it.
      const n = Math.max(0, Math.min(100, 250 - from));
      return {
        items: Array.from({ length: n }, (_, i) => ({ id: `e${from + i}` })),
        ...(from + n < 250 ? { nextCursor: String(from + n) } : {}),
      };
    });
    const client = createManagementClient(conn, fn);
    const items = await client.listEntries('article', { limit: 300 });
    expect(items).toHaveLength(250);
    expect(calls.map((c) => new URL(c.url, 'http://x').searchParams.get('cursor'))).toEqual([
      null,
      '100',
      '200',
    ]);
    expect(calls.every((c) => new URL(c.url, 'http://x').searchParams.get('limit') === '100')).toBe(
      true,
    );
  });

  it('reads one page with its cursor, and hands back the next', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [], nextCursor: 'c2' }));
    const client = createManagementClient(conn, fn);
    const page = await client.listEntryPage('article', { search: 'x' }, 'c1');
    expect(page.nextCursor).toBe('c2');
    expect(calls[0]?.url).toBe('/preview/s1/main/entries?query=x&content_type=article&cursor=c1');
  });

  it('sends localized fields through on create (the form owns localization)', async () => {
    const { fn, calls } = fakeFetch(() => ({ entry: { id: 'e1' }, fields: {} }));
    const client = createManagementClient(conn, fn);
    await client.createEntry('article', { title: { 'en-US': 'Hi', 'de-DE': 'Hallo' } });
    const body = JSON.parse((calls[0]?.init?.body as string) ?? '{}');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/entries');
    expect(body).toEqual({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hi', 'de-DE': 'Hallo' } },
    });
  });

  it('reads space config (locales) from the management base', async () => {
    const { fn, calls } = fakeFetch(() => ({
      spaceId: 's1',
      name: 'Space 1',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de-DE'],
    }));
    const client = createManagementClient(conn, fn);
    const cfg = await client.getSpaceConfig();
    expect(cfg.locales).toEqual(['en-US', 'de-DE']);
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/space-config');
  });

  it('sets locale settings with a PUT of only the locales changed', async () => {
    const { fn, calls } = fakeFetch(() => ({
      spaceId: 's1',
      name: 'Space 1',
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar'],
      localeSettings: {
        'en-US': { delivered: true, direction: 'ltr' },
        ar: { delivered: false, direction: 'rtl' },
      },
    }));
    const client = createManagementClient(conn, fn);
    const cfg = await client.setLocaleSettings({ ar: { delivered: false } });
    expect(cfg.localeSettings?.ar?.delivered).toBe(false);
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/locale-settings');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      localeSettings: { ar: { delivered: false } },
    });
  });

  it('publishes via the management entries action', async () => {
    const { fn, calls } = fakeFetch(() => ({ id: 'e1', status: 'published' }));
    const client = createManagementClient(conn, fn);
    await client.publishEntry('e1');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/entries/e1/published');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('uploadAsset creates → PUTs bytes to the presigned URL → publishes', async () => {
    const seq: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seq.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/assets')) {
        return new Response(
          JSON.stringify({
            asset: { id: 'asset_1', status: 'draft' },
            upload: { url: 'https://blob.test/put?sig', headers: { 'content-type': 'text/plain' } },
          }),
          { status: 201 },
        );
      }
      if (url === 'https://blob.test/put?sig') return new Response('', { status: 200 }); // presigned PUT
      return new Response(JSON.stringify({ id: 'asset_1', status: 'published' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createManagementClient(conn, fn);
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const published = await client.uploadAsset(file);
    expect(published.status).toBe('published');
    expect(seq).toEqual([
      'POST /spaces/s1/environments/main/assets',
      'PUT https://blob.test/put?sig',
      'POST /spaces/s1/environments/main/assets/asset_1/published',
    ]);
  });

  it('replaceAssetFile starts → PUTs the next version → commits what the start returned', async () => {
    const seq: string[] = [];
    const bodies: unknown[] = [];
    const commit = { version: 3, fileName: 'v3.txt', contentType: 'text/plain' };
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seq.push(`${init?.method ?? 'GET'} ${url}`);
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      if (url.endsWith('/assets/a1/file')) {
        return new Response(
          JSON.stringify({
            asset: { id: 'a1', version: 2 },
            upload: { url: 'https://blob.test/v3?sig', headers: { 'content-type': 'text/plain' } },
            commit,
          }),
          { status: 201 },
        );
      }
      if (url === 'https://blob.test/v3?sig') return new Response('', { status: 200 });
      return new Response(JSON.stringify({ id: 'a1', version: 3 }), { status: 200 });
    }) as unknown as typeof fetch;

    const next = await createManagementClient(conn, fn).replaceAssetFile(
      'a1',
      new File(['new'], 'v3.txt', { type: 'text/plain' }),
    );
    expect(next.version).toBe(3);
    expect(seq).toEqual([
      'POST /spaces/s1/environments/main/assets/a1/file',
      'PUT https://blob.test/v3?sig',
      'POST /spaces/s1/environments/main/assets/a1/file/commit',
    ]);
    expect(bodies).toEqual([{ fileName: 'v3.txt', contentType: 'text/plain' }, commit]);
  });

  it('does not commit a replacement whose bytes never arrived', async () => {
    const seq: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seq.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/file')) {
        return new Response(
          JSON.stringify({
            asset: { id: 'a1' },
            upload: { url: 'https://blob.test/v2', headers: {} },
            commit: { version: 2, fileName: 'x', contentType: 'x' },
          }),
          { status: 201 },
        );
      }
      return new Response('denied', { status: 403 });
    }) as unknown as typeof fetch;
    await expect(
      createManagementClient(conn, fn).replaceAssetFile('a1', new File(['x'], 'x')),
    ).rejects.toBeInstanceOf(ApiError);
    expect(seq.some((s) => s.endsWith('/commit'))).toBe(false);
  });

  it('reads the fields a 422 named, and nothing from other failures', () => {
    const body = {
      error: {
        code: 'validation',
        issues: [
          { field: 'rights.expiresAt', message: 'expiresAt must be after embargoUntil' },
          { field: 'rights.expiresAt', message: 'a second, ignored' },
          { field: 'rights.license', message: 'license is at most 500 characters' },
        ],
      },
    };
    expect(apiFieldIssues(new ApiError(422, 'PUT → 422', body))).toEqual({
      'rights.expiresAt': 'expiresAt must be after embargoUntil',
      'rights.license': 'license is at most 500 characters',
    });
    expect(apiFieldIssues(new ApiError(409, 'x', body))).toEqual({});
    expect(apiFieldIssues(new Error('x'))).toEqual({});
  });

  it('starts an asset bulk job and reads its report', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/report') ? { job: { id: 'j1' }, chunks: [] } : { id: 'j1', status: 'running' },
    );
    const client = createManagementClient(conn, fn);
    await client.startAssetBulkJob({ action: 'move', ids: ['a1'], folderId: null });
    await client.getBulkJobReport('j1');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/assets/bulk');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      action: 'move',
      ids: ['a1'],
      folderId: null,
    });
    expect(calls[1]?.url).toBe('/spaces/s1/environments/main/bulk/jobs/j1/report');
  });

  it('lists assets from the management base', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [{ id: 'a1' }], nextCursor: 'c2' }));
    const client = createManagementClient(conn, fn);
    const page = await client.listAssets();
    expect(page.items[0]?.id).toBe('a1');
    expect(page.nextCursor).toBe('c2');
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/assets');
  });

  it('sends the library filters, sort and cursor as the query, leaving out empty ones', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [] }));
    const client = createManagementClient(conn, fn);
    await client.listAssets({
      kind: 'image',
      folder: 'root',
      status: 'archived',
      tag: '',
      sort: 'size',
      order: 'asc',
      limit: 50,
      cursor: 'abc',
    });
    const url = new URL(calls[0]?.url ?? '', 'http://x');
    expect(url.pathname).toBe('/spaces/s1/environments/main/assets');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'image',
      folder: 'root',
      status: 'archived',
      sort: 'size',
      order: 'asc',
      limit: '50',
      cursor: 'abc',
    });
  });

  it('moves, archives, restores and deletes assets, and manages folders', async () => {
    const { fn, calls } = fakeFetch((_url, init) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : { items: [], moved: 2 },
    );
    const client = createManagementClient(conn, fn);
    const base = '/spaces/s1/environments/main';
    expect(await client.moveAssets(['a1', 'a2'], 'f1')).toMatchObject({ moved: 2 });
    await client.archiveAsset('a1');
    await client.restoreAsset('a1');
    await client.deleteAsset('a1');
    await client.listAssetFolders();
    await client.createAssetFolder({ name: 'Brand', parentId: 'f0' });
    await client.updateAssetFolder('f1', { parentId: null });
    await client.deleteAssetFolder('f1');
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST ${base}/assets/move`,
      `POST ${base}/assets/a1/archive`,
      `POST ${base}/assets/a1/restore`,
      `DELETE ${base}/assets/a1`,
      `GET ${base}/asset-folders`,
      `POST ${base}/asset-folders`,
      `PATCH ${base}/asset-folders/f1`,
      `DELETE ${base}/asset-folders/f1`,
    ]);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      ids: ['a1', 'a2'],
      folderId: 'f1',
    });
    expect(JSON.parse(calls[6]?.init?.body as string)).toEqual({ parentId: null });
  });

  it('reads the entries that hold an asset from a refused delete', async () => {
    const usage = [
      {
        fromEntryId: 'e1',
        fromField: 'hero',
        toId: 'a1',
        toType: 'Asset',
        contentTypeApiId: 'page',
        entryTitle: 'Home page',
      },
    ];
    const { fn } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'asset_in_use', message: 'used', usage, total: 73 } }),
          { status: 409 },
        ),
    );
    const err = await createManagementClient(conn, fn)
      .deleteAsset('a1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('asset_in_use');
    // The titles and the full count ride in the body: nothing to fetch per link.
    expect(assetUsageOf(err)).toEqual({ usage, total: 73 });
    expect(assetUsageOf(new ApiError(409, 'conflict'))).toBeNull();
  });

  it('uploads into a folder', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/assets')
        ? { asset: { id: 'a1' }, upload: { url: 'https://blob.test/put', headers: {} } }
        : { id: 'a1', status: 'published' },
    );
    await createManagementClient(conn, fn).uploadAsset(new File(['x'], 'a.png'), {
      folderId: 'f1',
    });
    expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({ folderId: 'f1' });
  });

  it('reads agent runs + usage from management, and searches via delivery', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('/agent-runs/usage')) return { runs: 2, inputTokens: 300, outputTokens: 50 };
      if (url.includes('/agent-runs'))
        return {
          items: [
            {
              id: 'r1',
              workflow: 'enrich',
              status: 'completed',
              inputTokens: 100,
              outputTokens: 20,
              decisions: [],
              entryId: 'e1',
              createdAt: 'now',
            },
          ],
        };
      return { hits: [{ entryId: 'e1', score: 0.9, snippet: 'hi' }] };
    });
    const client = createManagementClient(conn, fn);

    expect((await client.listAgentRuns())[0]?.workflow).toBe('enrich');
    expect((await client.agentUsage()).inputTokens).toBe(300);
    expect((await client.search('database'))[0]?.entryId).toBe('e1');

    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/agent-runs');
    expect(calls[1]?.url).toBe('/spaces/s1/environments/main/agent-runs/usage');
    expect(calls[2]?.url).toBe('/delivery/s1/main/search?q=database');
  });

  it('reads the published version via delivery (for diff), rendered for the locale', async () => {
    const { fn, calls } = fakeFetch(() => ({
      id: 'e1',
      contentType: 'article',
      fields: { title: 'Published' },
      publishedAt: 'then',
    }));
    const client = createManagementClient(conn, fn);
    const pub = await client.getPublished('e1');
    expect(pub.fields.title).toBe('Published');
    expect(calls[0]?.url).toBe('/delivery/s1/main/entries/e1?locale=en-US');
  });

  it('manages API keys at the space base (list + mint with one-time token)', async () => {
    const { fn, calls } = fakeFetch((_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return { items: [{ id: 'k1', kind: 'cda', scopes: ['delivery:read'], revoked: false }] };
      }
      return { id: 'k2', kind: 'cma', token: 'cwk_cma_secret' };
    });
    const client = createManagementClient(conn, fn);

    expect((await client.listApiKeys())[0]?.kind).toBe('cda');
    const minted = await client.createApiKey({ kind: 'cma', name: 'CI' });
    expect(minted.token).toBe('cwk_cma_secret');

    expect(calls[0]?.url).toBe('/spaces/s1/api-keys'); // space-scoped, no env
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '{}')).toEqual({
      kind: 'cma',
      name: 'CI',
    });
  });

  it('manages webhooks at the environment base', async () => {
    const { fn, calls } = fakeFetch(() => ({
      id: 'w1',
      url: 'https://x.test',
      topics: ['*'],
      active: true,
    }));
    const client = createManagementClient(conn, fn);
    await client.createWebhook({ url: 'https://x.test', secret: 's', topics: ['entry.published'] });
    expect(calls[0]?.url).toBe('/spaces/s1/environments/main/webhooks');
    expect(JSON.parse((calls[0]?.init?.body as string) ?? '{}').topics).toEqual([
      'entry.published',
    ]);
  });

  it('throws ApiError with status on non-2xx', async () => {
    const { fn } = fakeFetch(() => new Response('forbidden', { status: 403 }));
    const client = createManagementClient(conn, fn);
    await expect(client.listContentTypes()).rejects.toBeInstanceOf(ApiError);
    await expect(client.listContentTypes()).rejects.toMatchObject({ status: 403 });
  });
});

describe('plugin endpoints are space-scoped', () => {
  /**
   * A plugin is installed once for a space and runs in every environment in
   * it, so these routes carry no `/environments/:env`. Sending them there
   * 404s, and a 404 on the list reads as "no plugins installed" — a silent
   * failure that looks exactly like success.
   */
  const cases: [
    string,
    (c: ReturnType<typeof createManagementClient>) => Promise<unknown>,
    string,
  ][] = [
    ['list', (c) => c.listPlugins(), '/spaces/s1/plugins'],
    [
      'install',
      (c) =>
        c.installPlugin({
          manifest: {
            id: 'p',
            name: 'P',
            version: '1',
            capabilities: [],
            hooks: [],
            entrypoint: 'i.js',
          },
          bundle: 'x',
          approvedCapabilities: [],
        }),
      '/spaces/s1/plugins',
    ],
    [
      'install from url',
      (c) =>
        c.installPluginFromUrl({ packageUrl: 'https://x.test/p.json', approvedCapabilities: [] }),
      '/spaces/s1/plugins/from-url',
    ],
    [
      'enable',
      (c) => c.setPluginEnabled('com.example.seo', true),
      '/spaces/s1/plugins/com.example.seo/enabled',
    ],
    [
      'uninstall',
      (c) => c.uninstallPlugin('com.example.seo'),
      '/spaces/s1/plugins/com.example.seo',
    ],
  ];

  for (const [name, call, expected] of cases) {
    it(`${name} goes to the space, not the environment`, async () => {
      const { fn, calls } = fakeFetch(() => ({ items: [] }));
      await call(createManagementClient(conn, fn));
      expect(calls[0]?.url).toBe(expected);
    });
  }
});

describe('read-your-writes bookmark', () => {
  it('sends no bookmark until the api has answered with one', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [] }));
    await createManagementClient(conn, fn).listContentTypes();
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers[BOOKMARK_HEADER]).toBeUndefined();
  });

  // Real D1 bookmarks: hex groups joined by dashes, ordered oldest to newest as strings.
  const bm = (n: number) => `0000000${n}-00000033-00005008-a8d7ea3c4bb30f2ca9e0e0b8f6e00e19`;

  it('keeps the newest x-cw-bookmark and sends it on every later request, from any client', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => {
      n += 1;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { [BOOKMARK_HEADER]: bm(n) },
      });
    });
    await createManagementClient(conn, fn).listContentTypes();
    expect(currentBookmark()).toBe(bm(1));
    // A different client (another scope) still carries the browser's latest write position.
    await createManagementClient({ ...conn, space: 's2' }, fn).listContentTypes();
    expect((calls[1]!.init!.headers as Record<string, string>)[BOOKMARK_HEADER]).toBe(bm(1));
    expect(currentBookmark()).toBe(bm(2));
    await createManagementClient(conn, fn).listContentTypes();
    expect((calls[2]!.init!.headers as Record<string, string>)[BOOKMARK_HEADER]).toBe(bm(2));
  });

  it('never moves backwards when concurrent replies arrive out of order', async () => {
    // The write's reply (newer bookmark) lands first; a slower read started earlier lands after.
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const replies = vi.fn(async (input: string | URL | Request) => {
      const older = String(input).endsWith('/content-types');
      if (older) await slow;
      return new Response(JSON.stringify({ items: [] }), {
        headers: { [BOOKMARK_HEADER]: bm(older ? 1 : 5) },
      });
    }) as unknown as typeof fetch;
    const client = createManagementClient(conn, replies);
    const older = client.listContentTypes();
    await client.listAssets();
    expect(currentBookmark()).toBe(bm(5));
    releaseSlow();
    await older;
    expect(currentBookmark()).toBe(bm(5));
  });

  it('ignores a bookmark that is not D1-shaped', async () => {
    const { fn } = fakeFetch(
      (url) =>
        new Response(JSON.stringify({ items: [] }), {
          headers: {
            [BOOKMARK_HEADER]: url.endsWith('/content-types') ? bm(2) : 'zzzz-not-a-bookmark',
          },
        }),
    );
    const client = createManagementClient(conn, fn);
    await client.listContentTypes();
    await client.listAssets();
    expect(currentBookmark()).toBe(bm(2));
  });

  it('keeps the bookmark a failed response carries, and the previous one when none comes back', async () => {
    const { fn } = fakeFetch((url) =>
      url.endsWith('/content-types')
        ? new Response('nope', { status: 500, headers: { [BOOKMARK_HEADER]: bm(3) } })
        : new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const client = createManagementClient(conn, fn);
    await expect(client.listContentTypes()).rejects.toBeInstanceOf(ApiError);
    expect(currentBookmark()).toBe(bm(3));
    await client.listAssets();
    expect(currentBookmark()).toBe(bm(3));
  });
});

describe('collections, share links, multipart uploads and zips', () => {
  const body = (call: { init?: RequestInit } | undefined) =>
    JSON.parse((call?.init?.body as string | undefined) ?? 'null');
  const MGMT = '/spaces/s1/environments/main';

  it('manages collections and their members at the environment base', async () => {
    const { fn, calls } = fakeFetch((url, init) =>
      init?.method === 'DELETE' || url.endsWith('/order')
        ? new Response(null, { status: 204 })
        : url.endsWith('/assets') && init?.method === 'POST'
          ? { added: 2, skipped: ['gone'] }
          : { items: [], id: 'c1' },
    );
    const client = createManagementClient(conn, fn);
    await client.listAssetCollections({ limit: 100, cursor: 'next' });
    await client.createAssetCollection({ name: 'Launch', description: 'Spring' });
    await client.updateAssetCollection('c1', { description: '' });
    await client.listAssetCollectionAssets('c1', { status: 'all', limit: 100 });
    const added = await client.addToAssetCollection('c1', ['a1', 'a2', 'gone']);
    await client.removeFromAssetCollection('c1', ['a1']);
    await client.reorderAssetCollection('c1', ['a2', 'a1']);
    await client.deleteAssetCollection('c1');
    expect(added).toEqual({ added: 2, skipped: ['gone'] });
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `GET ${MGMT}/asset-collections?limit=100&cursor=next`,
      `POST ${MGMT}/asset-collections`,
      `PATCH ${MGMT}/asset-collections/c1`,
      `GET ${MGMT}/asset-collections/c1/assets?status=all&limit=100`,
      `POST ${MGMT}/asset-collections/c1/assets`,
      `POST ${MGMT}/asset-collections/c1/assets/remove`,
      `PUT ${MGMT}/asset-collections/c1/order`,
      `DELETE ${MGMT}/asset-collections/c1`,
    ]);
    expect(body(calls[1])).toEqual({ name: 'Launch', description: 'Spring' });
    // An empty description is sent, not dropped: it is how a description is cleared.
    expect(body(calls[2])).toEqual({ description: '' });
    expect(body(calls[4])).toEqual({ assetIds: ['a1', 'a2', 'gone'] });
    expect(body(calls[6])).toEqual({ assetIds: ['a2', 'a1'] });
  });

  it('lists share links for one target, makes one and revokes it', async () => {
    const link = { id: 'l1', targetType: 'asset', targetId: 'a1', hasPassword: true };
    const { fn, calls } = fakeFetch((url) => (url.includes('?') ? { items: [link] } : link));
    const client = createManagementClient(conn, fn);
    expect(await client.listShareLinks({ targetType: 'asset', targetId: 'a1' })).toEqual([link]);
    await client.listShareLinks({
      targetType: 'collection',
      targetId: 'c1',
      includeInactive: true,
    });
    await client.createShareLink({
      targetType: 'asset',
      targetId: 'a1',
      expiresAt: '2026-11-08T00:00:00.000Z',
      allowDownload: false,
      password: 'correct horse',
    });
    await client.revokeShareLink('l1');
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `GET ${MGMT}/share-links?targetType=asset&targetId=a1`,
      `GET ${MGMT}/share-links?targetType=collection&targetId=c1&includeInactive=true`,
      `POST ${MGMT}/share-links`,
      `DELETE ${MGMT}/share-links/l1`,
    ]);
    expect(body(calls[2])).toEqual({
      targetType: 'asset',
      targetId: 'a1',
      expiresAt: '2026-11-08T00:00:00.000Z',
      allowDownload: false,
      password: 'correct horse',
    });
  });

  it('starts replacing a file in parts on the asset’s own route', async () => {
    const { fn, calls } = fakeFetch(() => ({
      asset: { id: 'a/1' },
      version: 2,
      upload: { uploadId: 'u1', partSize: 8, partCount: 2 },
    }));
    const started = await createManagementClient(conn, fn).startAssetFileUpload('a/1', {
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: 12,
    });
    expect(started.version).toBe(2);
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST ${MGMT}/assets/a%2F1/file/uploads`,
    ]);
    expect(body(calls[0])).toEqual({
      fileName: 'cut.mov',
      contentType: 'video/quicktime',
      size: 12,
    });
  });

  it('starts a multipart upload with a localized title, signs parts, completes and aborts', async () => {
    const { fn, calls } = fakeFetch((_url, init) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : { asset: { id: 'a1' }, upload: { uploadId: 'u1', partSize: 8, partCount: 2 } },
    );
    const client = createManagementClient(conn, fn);
    await client.startAssetUpload({
      fileName: 'film.mov',
      contentType: 'video/quicktime',
      size: 12,
      title: 'film.mov',
      folderId: 'f1',
    });
    await client.signAssetUploadParts('a1', 'u/1', [1, 2]);
    await client.completeAssetUpload('a1', 'u/1', [{ partNumber: 1, etag: '"e1"' }]);
    await client.abortAssetUpload('a1', 'u/1');
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST ${MGMT}/assets/uploads`,
      // The upload id is a path segment, escaped as one.
      `POST ${MGMT}/assets/a1/uploads/u%2F1/parts`,
      `POST ${MGMT}/assets/a1/uploads/u%2F1/complete`,
      `DELETE ${MGMT}/assets/a1/uploads/u%2F1`,
    ]);
    expect(body(calls[0])).toEqual({
      fileName: 'film.mov',
      contentType: 'video/quicktime',
      size: 12,
      title: { 'en-US': 'film.mov' },
      folderId: 'f1',
    });
    expect(body(calls[1])).toEqual({ partNumbers: [1, 2] });
    expect(body(calls[2])).toEqual({ parts: [{ partNumber: 1, etag: '"e1"' }] });
  });

  it('PUTs a part straight to its signed URL and returns the ETag storage named it by', async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(null, { status: 200, headers: { etag: '"part-1"' } }),
    );
    const client = createManagementClient(conn, fn);
    const bytes = new Blob(['12345678']);
    expect(await client.putUploadPart('https://r2.example/p1?sig', bytes)).toBe('"part-1"');
    expect(calls[0]?.url).toBe('https://r2.example/p1?sig');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toBe(bytes);
    // Storage authenticates by the signature: no session cookie, no JSON headers.
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('fails a part as an UploadPartError when storage refuses it or names no ETag', async () => {
    const refused = createManagementClient(
      conn,
      fakeFetch(() => new Response('expired', { status: 403 })).fn,
    );
    const err = await refused
      .putUploadPart('https://r2.example/p1', new Blob(['x']))
      .catch((e) => e);
    expect(err).toBeInstanceOf(UploadPartError);
    expect(err.status).toBe(403);
    const unnamed = createManagementClient(conn, fakeFetch(() => new Response(null)).fn);
    await expect(unnamed.putUploadPart('https://r2.example/p1', new Blob(['x']))).rejects.toThrow(
      /without an ETag/,
    );
  });

  it('starts a zip of a selection or a collection and follows it', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/asset-zips') ? { id: 'z1', items: [] } : { id: 'z1', status: 'running' },
    );
    const client = createManagementClient(conn, fn);
    await client.startAssetZip({ assetIds: ['a1', 'a2'] });
    await client.startAssetZip({ collectionId: 'c1', name: 'Launch' });
    await client.getAssetZip('z1');
    await client.listAssetZips();
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      `POST ${MGMT}/asset-zips`,
      `POST ${MGMT}/asset-zips`,
      `GET ${MGMT}/asset-zips/z1`,
      `GET ${MGMT}/asset-zips`,
    ]);
    expect(body(calls[0])).toEqual({ assetIds: ['a1', 'a2'] });
    expect(body(calls[1])).toEqual({ collectionId: 'c1', name: 'Launch' });
  });

  it('PUTs a signed /media/ URL on the api’s host to the same path on the admin’s origin', async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(null, { status: 200, headers: { etag: '"p1"' } }),
    );
    const client = createManagementClient(conn, fn);
    await client.putUploadPart(
      'https://api.example/media/s1/main/a1/v1/film.mov?uploadId=u1&part=1&sig=abc',
      new Blob(['x']),
    );
    expect(calls[0]?.url).toBe('/media/s1/main/a1/v1/film.mov?uploadId=u1&part=1&sig=abc');
  });

  it('PUTs a single upload’s signed /media/ URL same-origin too', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith('/assets')
        ? { asset: { id: 'a1' }, upload: { url: 'https://api.example/media/x?sig=1', headers: {} } }
        : { id: 'a1' },
    );
    await createManagementClient(conn, fn).uploadAsset(new File(['x'], 'x.png'));
    expect(calls[1]?.url).toBe('/media/x?sig=1');
  });

  it('leaves any URL that isn’t the api’s /media/ route alone', () => {
    expect(sameOriginUpload('https://upload.videodelivery.net/abc')).toBe(
      'https://upload.videodelivery.net/abc',
    );
    expect(sameOriginUpload('/media/a?b=1')).toBe('/media/a?b=1');
  });
});
