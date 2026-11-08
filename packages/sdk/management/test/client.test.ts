import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagementClient, ManagementError } from '../src/index.js';

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

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma-tok' };

describe('@commerceworker/sdk-management client', () => {
  let calls: { url: string; init?: RequestInit }[];
  beforeEach(() => {
    calls = [];
  });

  it('creates an entry with the bearer token and JSON body', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return {
        entry: {
          id: 'e1',
          contentTypeApiId: 'article',
          status: 'draft',
          currentVersion: 1,
          publishedVersion: null,
        },
        fields: { title: { 'en-US': 'Hi' } },
      };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const view = await client.entries.create({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hi' } },
    });
    expect(view.entry.id).toBe('e1');
    const call = calls[0];
    expect(call?.url).toBe('https://cms.test/spaces/s1/environments/main/entries');
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer cma-tok');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hi' } },
    });
  });

  it('lists and creates spaces at the deployment root, not under the bound space', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return init?.method === 'POST'
        ? { id: 'acme', name: 'Acme', starter: 'sample' }
        : { items: [{ id: 's1', name: 'One' }] };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    expect(await client.spaces.list()).toEqual([{ id: 's1', name: 'One' }]);
    const created = await client.spaces.create({
      spaceId: 'acme',
      name: 'Acme',
      defaultLocale: 'en-US',
      starter: 'sample',
    });
    expect(created.starter).toBe('sample');
    expect(calls[0]?.url).toBe('https://cms.test/spaces');
    expect(calls[1]?.url).toBe('https://cms.test/spaces');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      spaceId: 'acme',
      name: 'Acme',
      defaultLocale: 'en-US',
      starter: 'sample',
    });
  });

  it('lists the starters and follows a background install at the deployment root', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return url.endsWith('/starters')
        ? { items: [{ id: 'enterprise', title: 'E', description: 'd', background: true }] }
        : { install: 'i1', status: 'running', step: 1, steps: 9 };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    expect((await client.spaces.starters()).map((s) => s.id)).toEqual(['enterprise']);
    expect((await client.spaces.starterInstall('acme', 'main', 'i1')).status).toBe('running');
    expect(calls.map((c) => c.url)).toEqual([
      'https://cms.test/starters',
      'https://cms.test/spaces/acme/environments/main/starter-installs/i1',
    ]);
  });

  it('publishes and unpublishes via POST/DELETE on /published, returning the bare entry', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      // The publish routes return the Entry itself, not an { entry, fields } view.
      return {
        id: 'e1',
        contentTypeApiId: 'article',
        status: init?.method === 'POST' ? 'published' : 'draft',
        currentVersion: 1,
        publishedVersion: init?.method === 'POST' ? 1 : null,
      };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const published = await client.entries.publish('e1');
    const unpublished = await client.entries.unpublish('e1');
    expect(published.status).toBe('published');
    expect(unpublished.publishedVersion).toBeNull();
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/entries/e1/published');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.method).toBe('DELETE');
  });

  it('updates an entry by wrapping fields in the PUT body', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { entry: {}, fields: {} };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await client.entries.update('e1', { title: { 'en-US': 'New' } });
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      fields: { title: { 'en-US': 'New' } },
    });
  });

  it('unwraps { items } list envelopes', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { items: [{ apiId: 'article', name: 'Article' }] };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const types = await client.contentTypes.list();
    expect(types[0]?.apiId).toBe('article');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/content-types');
  });

  it('reads entry counts per content type from their own route', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return {
        items: [
          { contentType: 'article', total: 3, draft: 1, changed: 1, published: 1, archived: 2 },
        ],
      };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const counts = await client.contentTypes.entryCounts();
    expect(counts[0]?.total).toBe(3);
    expect(calls[0]?.url).toBe(
      'https://cms.test/spaces/s1/environments/main/content-types/entry-counts',
    );
  });

  it('counts what waits in Approvals', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { workflowTasks: 2, agentReviews: 1, total: 3 };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    expect(await client.approvals.count()).toEqual({ workflowTasks: 2, agentReviews: 1, total: 3 });
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/approvals/count');
  });

  it('passes query params for version diffs and drops undefined ones', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { changes: [] };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await client.entries.versions.diff('e1', 1, 3);
    expect(calls[0]?.url).toBe(
      'https://cms.test/spaces/s1/environments/main/entries/e1/versions/diff?from=1&to=3',
    );
    await client.entries.versions.diff('e1', 'published', 'draft');
    expect(calls[1]?.url).toBe(
      'https://cms.test/spaces/s1/environments/main/entries/e1/versions/diff?from=published&to=draft',
    );

    await client.assets.list();
    expect(calls[2]?.url).toBe('https://cms.test/spaces/s1/environments/main/assets');
  });

  it('encodes path segments', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { apiId: 'a b' };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await client.contentTypes.get('a b');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/content-types/a%20b');
  });

  it('addresses space-level routes without the environment segment', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { id: 'k1', kind: 'cda', token: 'raw-token' };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const created = await client.apiKeys.create({ kind: 'cda', name: 'site' });
    expect(created.token).toBe('raw-token');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/api-keys');

    await client.environments.aliases.set('prod', 'main');
    expect(calls[1]?.url).toBe('https://cms.test/spaces/s1/environment-aliases/prod');
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ targetEnvironmentId: 'main' });
  });

  it('resolves void for 204 responses', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await expect(client.webhooks.delete('w1')).resolves.toBeUndefined();
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('maps non-2xx responses to ManagementError with status and parsed body', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: 'Validation failed' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const err = await client.entries
      .create({ contentTypeApiId: 'article', fields: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect(err).toMatchObject({ status: 422, body: { error: 'Validation failed' } });
  });

  it('tolerates non-JSON error bodies', async () => {
    const fetchImpl = fakeFetch(() => new Response('nope', { status: 500 }));
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await expect(client.contentTypes.list()).rejects.toMatchObject({
      status: 500,
      body: undefined,
    });
  });

  it('drives the release lifecycle with the documented routes', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { release: { id: 'r1' }, items: [] };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await client.releases.addEntry('r1', { entityId: 'e1' });
    await client.releases.removeEntry('r1', 'e1');
    const shipped = await client.releases.publish('r1');
    expect(shipped.release.id).toBe('r1'); // publish returns { release, items }
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'POST https://cms.test/spaces/s1/environments/main/releases/r1/items',
      'DELETE https://cms.test/spaces/s1/environments/main/releases/r1/items/e1',
      'POST https://cms.test/spaces/s1/environments/main/releases/r1/published',
    ]);
  });

  it('resolves the principal from the root-level /auth/me route', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { spaceId: 's1', kind: 'cma', scopes: [], restricted: false };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const principal = await client.me();
    expect(principal.spaceId).toBe('s1');
    expect(calls[0]?.url).toBe('https://cms.test/auth/me');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('wraps bulk create in { items } and bulk publish/unpublish in { ids }', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { succeeded: 0, failed: 0, results: [] };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const batch = [{ contentTypeApiId: 'article', fields: {} }];
    await client.entries.bulkCreate(batch);
    await client.entries.bulkPublish(['e1', 'e2']);
    await client.entries.bulkUnpublish(['e3']);
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'POST https://cms.test/spaces/s1/environments/main/bulk/entries',
      'POST https://cms.test/spaces/s1/environments/main/bulk/entries/publish',
      'POST https://cms.test/spaces/s1/environments/main/bulk/entries/unpublish',
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ items: batch });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ ids: ['e1', 'e2'] });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ ids: ['e3'] });
  });

  it('patches asset metadata with the raw metadata object', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { id: 'a1' };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await client.assets.setMetadata('a1', { altText: { 'en-US': 'x' } });
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/assets/a1/metadata');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ altText: { 'en-US': 'x' } });
  });

  it('creates and cancels a scheduled action, parsing the canceled action from DELETE', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { id: 'sa1', status: url.endsWith('/sa1') ? 'canceled' : 'pending' };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const input = {
      action: 'publish' as const,
      entityType: 'Entry' as const,
      entityId: 'e1',
      scheduledFor: '2026-08-01T00:00:00Z',
    };
    await client.scheduledActions.create(input);
    const canceled = await client.scheduledActions.cancel('sa1');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(input);
    expect(calls[1]?.init?.method).toBe('DELETE');
    expect(calls[1]?.url).toBe(
      'https://cms.test/spaces/s1/environments/main/scheduled-actions/sa1',
    );
    expect(canceled.status).toBe('canceled');
  });

  it('returns the draft asset and presigned upload target from asset create', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return {
        asset: { id: 'a1', status: 'draft' },
        upload: { url: 'https://blob.test/put/a1', headers: { 'content-type': 'image/png' } },
      };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    const created = await client.assets.create({ fileName: 'a.png', contentType: 'image/png' });
    expect(created.upload.url).toBe('https://blob.test/put/a1');
    expect(created.upload.headers['content-type']).toBe('image/png');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/assets');
  });

  it('lists, fetches, and restores entry versions on the documented routes', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return url.endsWith('/versions') ? { items: [] } : { entryId: 'e1', version: 3, fields: {} };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await client.entries.versions.list('e1');
    await client.entries.versions.get('e1', 3);
    await client.entries.versions.restore('e1', 3);
    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'GET https://cms.test/spaces/s1/environments/main/entries/e1/versions',
      'GET https://cms.test/spaces/s1/environments/main/entries/e1/versions/3',
      'POST https://cms.test/spaces/s1/environments/main/entries/e1/versions/3/restore',
    ]);
    // A body-less POST must not claim a JSON content type.
    const restoreHeaders = calls[2]?.init?.headers as Record<string, string>;
    expect(restoreHeaders['content-type']).toBeUndefined();
  });

  it('addresses every remaining namespace method with the expected verb and path', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { items: [], release: {}, entry: {}, fields: {} };
    });
    const c = createManagementClient({ ...base, fetch: fetchImpl });
    const env = 'https://cms.test/spaces/s1/environments/main';
    const space = 'https://cms.test/spaces/s1';

    await c.contentTypes.create({ apiId: 'a', name: 'A', displayField: 'title', fields: [] });
    await c.contentTypes.publish('a');
    await c.entries.get('e1');
    await c.entries.reverseReferences('e1');
    await c.assets.get('a1');
    await c.assets.usage('a1');
    await c.assets.publish('a1');
    await c.assets.unpublish('a1');
    await c.assets.list({ limit: 5 });
    await c.assets.list({ kind: 'image', folder: 'root', status: 'all', cursor: 'abc' });
    await c.assets.archive('a1');
    await c.assets.restore('a1');
    await c.assets.delete('a1');
    await c.assets.move(['a1', 'a2'], 'f1');
    await c.assets.search({ q: 'mug', kind: 'image', folder: 'root' });
    await c.assets.reingest('a1');
    await c.assets.reindex({ all: true });
    await c.assets.folders.list();
    await c.assets.folders.create({ name: 'Brand' });
    await c.assets.folders.update('f1', { parentId: null });
    await c.assets.folders.delete('f1');
    await c.assets.startReplace('a1', { fileName: 'b.png', contentType: 'image/png' });
    await c.assets.uploads.startReplace('a1', {
      fileName: 'b.mov',
      contentType: 'video/quicktime',
      size: 200 * 1024 * 1024,
    });
    await c.assets.commitFile('a1', { version: 2, fileName: 'b.png', contentType: 'image/png' });
    await c.assets.versions('a1');
    await c.assets.restoreVersion('a1', 1);
    await c.assets.setRights('a1', { license: 'CC BY', expiresAt: '2030-01-01T00:00:00Z' });
    await c.assets.bulk({ action: 'move', ids: ['a1'], folderId: null });
    await c.bulkJobs.list({ limit: 5 });
    await c.bulkJobs.get('j1');
    await c.bulkJobs.report('j1');
    await c.bulkJobs.cancel('j1');
    await c.entries.move('e1', { after: null });
    await c.entries.previewLink('e1', { locale: 'fr' });
    await c.bulkJobs.setFields({
      contentTypeApiId: 'post',
      entryIds: ['e1'],
      fields: { category: { 'en-US': 'news' } },
    });
    await c.webhooks.list();
    await c.webhooks.create({ url: 'https://x.test', topics: ['*'], secret: 's' });
    await c.webhooks.update('w1', { active: false });
    await c.webhooks.deliveries('w1', { limit: 10 });
    await c.webhooks.test('w1');
    await c.webhooks.resend('w1', 7);
    await c.releases.list();
    await c.releases.get('r1');
    await c.releases.create({ title: 'T' });
    await c.releases.delete('r1');
    await c.environments.list();
    await c.environments.create('staging', 'Staging');
    await c.environments.aliases.list();
    await c.environments.aliases.delete('prod');
    await c.apiKeys.list();
    await c.apiKeys.revoke('k1');

    expect(calls.map((x) => `${x.init?.method} ${x.url}`)).toEqual([
      `POST ${env}/content-types`,
      `POST ${env}/content-types/a/published`,
      `GET ${env}/entries/e1`,
      `GET ${env}/entries/e1/reverse-references`,
      `GET ${env}/assets/a1`,
      `GET ${env}/assets/a1/usage`,
      `POST ${env}/assets/a1/published`,
      `DELETE ${env}/assets/a1/published`,
      `GET ${env}/assets?limit=5`,
      `GET ${env}/assets?kind=image&folder=root&status=all&cursor=abc`,
      `POST ${env}/assets/a1/archive`,
      `POST ${env}/assets/a1/restore`,
      `DELETE ${env}/assets/a1`,
      `POST ${env}/assets/move`,
      `GET ${env}/assets/search?q=mug&kind=image&folder=root`,
      `POST ${env}/assets/a1/reingest`,
      `POST ${env}/assets/reindex`,
      `GET ${env}/asset-folders`,
      `POST ${env}/asset-folders`,
      `PATCH ${env}/asset-folders/f1`,
      `DELETE ${env}/asset-folders/f1`,
      `POST ${env}/assets/a1/file`,
      `POST ${env}/assets/a1/file/uploads`,
      `POST ${env}/assets/a1/file/commit`,
      `GET ${env}/assets/a1/versions`,
      `POST ${env}/assets/a1/versions/1/restore`,
      `PUT ${env}/assets/a1/rights`,
      `POST ${env}/assets/bulk`,
      `GET ${env}/bulk/jobs?limit=5`,
      `GET ${env}/bulk/jobs/j1`,
      `GET ${env}/bulk/jobs/j1/report`,
      `POST ${env}/bulk/jobs/j1/cancel`,
      `POST ${env}/entries/e1/move`,
      `POST ${env}/entries/e1/preview-link`,
      `POST ${env}/bulk/jobs/set-fields`,
      `GET ${env}/webhooks`,
      `POST ${env}/webhooks`,
      `PUT ${env}/webhooks/w1`,
      `GET ${env}/webhooks/w1/deliveries?limit=10`,
      `POST ${env}/webhooks/w1/test`,
      `POST ${env}/webhooks/w1/deliveries/7/resend`,
      `GET ${env}/releases`,
      `GET ${env}/releases/r1`,
      `POST ${env}/releases`,
      `DELETE ${env}/releases/r1`,
      `GET ${space}/environments`,
      `POST ${space}/environments`,
      `GET ${space}/environment-aliases`,
      `DELETE ${space}/environment-aliases/prod`,
      `GET ${space}/api-keys`,
      `DELETE ${space}/api-keys/k1`,
    ]);
  });

  it('strips a trailing slash from baseUrl and encodes space/environment ids', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { items: [] };
    });
    const client = createManagementClient({
      baseUrl: 'https://cms.test/',
      space: 'my space',
      environment: 'main/2',
      token: 't',
      fetch: fetchImpl,
    });

    await client.contentTypes.list();
    expect(calls[0]?.url).toBe(
      'https://cms.test/spaces/my%20space/environments/main%2F2/content-types',
    );
  });

  it('filters scheduled actions by status via query param', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { items: [] };
    });
    const client = createManagementClient({ ...base, fetch: fetchImpl });

    await client.scheduledActions.list({ status: 'pending' });
    expect(calls[0]?.url).toBe(
      'https://cms.test/spaces/s1/environments/main/scheduled-actions?status=pending',
    );
  });
});

describe('@commerceworker/sdk-management read-your-writes', () => {
  // Real D1 bookmarks: hex groups joined by dashes, newer sorts later.
  const OLD = '00000001-00000010-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';
  const NEW = '00000001-00000033-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';

  function bookmarking(answers: (string | undefined)[], from?: string) {
    const sent: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string> | undefined)?.['x-cw-bookmark']);
      const answer = answers.shift();
      const res = new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: answer ? { 'x-cw-bookmark': answer } : {},
      });
      if (from) Object.defineProperty(res, 'url', { value: from });
      return res;
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  }

  it("reads after its own write at the write's bookmark", async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEW]);
    const cma = createManagementClient({ ...base, fetch: fetchImpl });

    await cma.entries.update('e1', { title: { 'en-US': 'Hi' } });
    await cma.entries.get('e1');
    expect(sent).toEqual([undefined, NEW]);
    expect(cma.bookmark).toBe(NEW);
  });

  it('never moves back to an older bookmark from a late response', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, OLD]);
    const cma = createManagementClient({ ...base, fetch: fetchImpl });

    await cma.entries.get('e1');
    await cma.entries.get('e1');
    await cma.entries.get('e1');
    expect(sent).toEqual([undefined, NEW, NEW]);
  });

  it('hands its bookmark to another client, which reads from there', async () => {
    const writer = bookmarking([NEW]);
    const cma = createManagementClient({ ...base, fetch: writer.fetchImpl });
    await cma.entries.publish('e1');

    const reader = bookmarking([]);
    const next = createManagementClient({
      ...base,
      bookmark: cma.bookmark,
      fetch: reader.fetchImpl,
    });
    await next.entries.get('e1');
    expect(reader.sent).toEqual([NEW]);
  });

  it('keeps the bookmark of a failed write', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'conflict' }), {
          status: 409,
          headers: { 'x-cw-bookmark': NEW },
        }),
    ) as unknown as typeof fetch;
    const cma = createManagementClient({ ...base, fetch: fetchImpl });

    await expect(cma.entries.publish('e1', { expectedVersion: 1 })).rejects.toBeInstanceOf(
      ManagementError,
    );
    expect(cma.bookmark).toBe(NEW);
  });

  it('never sends or keeps one with readYourWrites: false', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEW]);
    const cma = createManagementClient({
      ...base,
      readYourWrites: false,
      bookmark: OLD,
      fetch: fetchImpl,
    });

    await cma.entries.get('e1');
    await cma.entries.get('e1');
    expect(sent).toEqual([undefined, undefined]);
    expect(cma.bookmark).toBeUndefined();
  });

  it('ignores a bookmark from a response redirected to another origin, and malformed ones', async () => {
    const redirected = bookmarking([NEW], 'https://elsewhere.test/x');
    const cma = createManagementClient({ ...base, bookmark: OLD, fetch: redirected.fetchImpl });
    await cma.entries.get('e1');
    expect(cma.bookmark).toBe(OLD);

    const junk = bookmarking(['"><script>', 'first-primary']);
    const other = createManagementClient({ ...base, fetch: junk.fetchImpl });
    await other.entries.get('e1');
    await other.entries.get('e1');
    await other.entries.get('e1');
    expect(junk.sent).toEqual([undefined, undefined, undefined]);
  });
});

describe('@commerceworker/sdk-management taxonomy', () => {
  it('creates, updates, lists and repairs terms on the environment’s taxonomy routes', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const client = createManagementClient({
      ...base,
      fetch: fakeFetch((url, init) => {
        calls.push({
          url,
          method: init?.method ?? 'GET',
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return url.endsWith('/tags') && (init?.method ?? 'GET') === 'GET'
          ? { items: [{ id: 't1', usage: { count: 2, byContentType: { article: 2 } } }] }
          : { id: 't1', slug: 'news' };
      }),
    });
    await client.taxonomy.tags.create({ name: 'News', labels: { de: 'Nachrichten' } });
    await client.taxonomy.tags.update('t1', { slug: 'latest', description: null });
    const [tag] = await client.taxonomy.tags.list();
    expect(tag?.usage.count).toBe(2);
    await client.taxonomy.concepts.update('c1', { prefLabel: 'Cats' });
    await client.taxonomy.repair();
    const env = 'https://cms.test/spaces/s1/environments/main';
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${env}/taxonomy/tags`,
      `PATCH ${env}/taxonomy/tags/t1`,
      `GET ${env}/taxonomy/tags`,
      `PATCH ${env}/taxonomy/concepts/c1`,
      `POST ${env}/taxonomy/repair`,
    ]);
    expect(calls[0]?.body).toEqual({ name: 'News', labels: { de: 'Nachrichten' } });
    expect(calls[1]?.body).toEqual({ slug: 'latest', description: null });
  });
});

describe('entries.list and imports', () => {
  it('lists entries from Preview on the same origin, mapping the query to its parameters', async () => {
    const calls: string[] = [];
    const cma = createManagementClient({
      ...base,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return { items: [], total: 0 };
      }),
    });

    await cma.entries.list({
      contentType: 'article',
      limit: 20,
      skip: 40,
      order: '-sys.updatedAt',
    });
    await cma.entries.list();
    const first = new URL(calls[0] as string);
    expect(first.origin + first.pathname).toBe('https://cms.test/preview/s1/main/entries');
    expect(Object.fromEntries(first.searchParams)).toEqual({
      content_type: 'article',
      limit: '20',
      skip: '40',
      order: '-sys.updatedAt',
    });
    // No empty parameters: an absent filter is not a filter for ''.
    expect(calls[1]).toBe('https://cms.test/preview/s1/main/entries');
  });

  it('posts the same input to analyze, run and start', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const cma = createManagementClient({
      ...base,
      fetch: fakeFetch((url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return url.endsWith('/sources') ? { items: [{ id: 'csv', name: 'CSV' }] } : {};
      }),
    });
    const input = {
      source: 'csv',
      payload: 'title\nHello',
      mapping: { contentTypeApiId: 'article', fields: { title: 'title' } },
    };

    expect(await cma.imports.sources()).toEqual([{ id: 'csv', name: 'CSV' }]);
    await cma.imports.analyze(input);
    await cma.imports.run(input);
    await cma.imports.start(input);
    const M = 'https://cms.test/spaces/s1/environments/main';
    expect(calls.map((c) => c.url)).toEqual([
      `${M}/imports/sources`,
      `${M}/imports/analyze`,
      `${M}/imports`,
      `${M}/imports/job`,
    ]);
    expect(calls.slice(1).every((c) => JSON.stringify(c.body) === JSON.stringify(input))).toBe(
      true,
    );
  });
});
