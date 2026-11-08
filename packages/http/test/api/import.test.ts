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
const cda = { Authorization: 'Bearer cda', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';
/** Drafts read back through the Preview API — imported entries are not published. */
const P = '/preview/s1/main';

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  await app.request(`${M}/content-types`, {
    method: 'POST',
    headers: cma,
    body: JSON.stringify({
      apiId: 'product',
      name: 'Product',
      displayField: 'name',
      fields: [
        {
          apiId: 'name',
          name: 'Name',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'sku',
          name: 'SKU',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 1,
        },
        {
          apiId: 'price',
          name: 'Price',
          type: 'Number',
          localized: false,
          required: false,
          position: 2,
        },
      ],
    }),
  });
  await app.request(`${M}/content-types/product/published`, { method: 'POST', headers: cma });
});

const CSV = 'sku,title,price\nA-1,Widget,9.99\nA-2,Gadget,19.50\n';

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    source: 'csv',
    payload: CSV,
    mapping: {
      contentTypeApiId: 'product',
      fields: { name: 'title', sku: 'sku', price: 'price' },
      identityField: 'sku',
    },
    sourceOptions: { identityField: 'sku' },
    ...over,
  });

describe('import over HTTP', () => {
  it('lists the sources this deployment can read', async () => {
    const res = await app.request(`${M}/imports/sources`, { headers: cma });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { id: string }[] };
    expect(items.map((i) => i.id).sort()).toEqual(['csv', 'json', 'wxr']);
  });

  it('analyzes a CSV without creating anything', async () => {
    const res = await app.request(`${M}/imports/analyze`, {
      method: 'POST',
      headers: cma,
      body: body(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ records: 2, willCreate: 2, executable: true });

    const entries = await app.request(`${P}/entries?contentType=product`, { headers: cpa });
    expect(((await entries.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it('runs the import and creates drafts', async () => {
    const res = await app.request(`${M}/imports`, { method: 'POST', headers: cma, body: body() });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: 2, updated: 0 });

    const drafts = await app.request(`${P}/entries?contentType=product`, { headers: cpa });
    const { items } = (await drafts.json()) as { items: { status: string }[] };
    expect(items).toHaveLength(2);
    // Drafts: arriving live would publish two entries nobody reviewed.
    expect(items.every((e) => e.status === 'draft')).toBe(true);

    const published = await app.request('/delivery/s1/main/entries?contentType=product', {
      headers: { Authorization: 'Bearer cda' },
    });
    expect(((await published.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it('is re-runnable — a second run creates nothing', async () => {
    await app.request(`${M}/imports`, { method: 'POST', headers: cma, body: body() });
    const second = await app.request(`${M}/imports`, {
      method: 'POST',
      headers: cma,
      body: body(),
    });
    expect(await second.json()).toMatchObject({ created: 0, skipped: 2 });
  });

  it('names the sources it does know when given one it does not', async () => {
    const res = await app.request(`${M}/imports/analyze`, {
      method: 'POST',
      headers: cma,
      body: body({ source: 'xml' }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/csv/);
  });

  it('reports a broken payload as a validation failure, not a 500', async () => {
    const res = await app.request(`${M}/imports/analyze`, {
      method: 'POST',
      headers: cma,
      body: body({ source: 'json', payload: '{oh no' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('import authority', () => {
  it('is refused to a delivery key', async () => {
    // Creating thousands of entries is a write, whatever the file looks like.
    const res = await app.request(`${M}/imports`, { method: 'POST', headers: cda, body: body() });
    expect(res.status).toBe(403);
  });

  it('is refused to an unauthenticated caller', async () => {
    const res = await app.request(`${M}/imports/sources`);
    expect(res.status).toBe(401);
  });
});

describe('the durable path', () => {
  it('accepts the same body and answers with a job, having written nothing yet', async () => {
    const res = await app.request(`${M}/imports/job`, {
      method: 'POST',
      headers: cma,
      body: body(),
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as {
      job: { id: string; action: string; totalItems: number; status: string };
      analysis: { willCreate: number };
    };
    expect(started.job).toMatchObject({ action: 'import', status: 'running', totalItems: 2 });
    expect(started.analysis.willCreate).toBe(2);

    // The report comes back before any record is written; a consumer runs the
    // chunks.
    const entries = await app.request(`${P}/entries?contentType=product`, { headers: cpa });
    expect(((await entries.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it('shows up in the bulk-job list, so progress is pollable', async () => {
    const started = await (
      await app.request(`${M}/imports/job`, { method: 'POST', headers: cma, body: body() })
    ).json();
    const id = (started as { job: { id: string } }).job.id;

    const job = await app.request(`${M}/bulk/jobs/${id}`, { headers: cma });
    expect(job.status).toBe(200);
    expect(await job.json()).toMatchObject({ action: 'import', totalChunks: 1 });
  });

  it('refuses a mapping that cannot work, exactly as the synchronous path does', async () => {
    const res = await app.request(`${M}/imports/job`, {
      method: 'POST',
      headers: cma,
      body: body({ mapping: { contentTypeApiId: 'product', fields: { price: 'title' } } }),
    });
    expect(res.status).toBe(422);
  });

  it('is refused to a delivery key', async () => {
    const res = await app.request(`${M}/imports/job`, {
      method: 'POST',
      headers: cda,
      body: body(),
    });
    expect(res.status).toBe(403);
  });
});

describe('importing a WordPress export over HTTP', () => {
  const post = (id: string, title: string, type = 'post') => `
    <item>
      <title><![CDATA[${title}]]></title>
      <content:encoded><![CDATA[<!-- wp:paragraph --><p>About ${title}</p><!-- /wp:paragraph -->]]></content:encoded>
      <wp:post_id>${id}</wp:post_id>
      <wp:post_name><![CDATA[${title.toLowerCase()}]]></wp:post_name>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:post_type><![CDATA[${type}]]></wp:post_type>
    </item>`;
  const WXR = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><wp:wxr_version>1.2</wp:wxr_version>${post('1', 'Widget')}${post('2', 'Gadget')}${post('3', 'About', 'page')}</channel>
</rss>`;

  beforeEach(async () => {
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId: 'post',
        name: 'Post',
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
          {
            apiId: 'wpId',
            name: 'WordPress id',
            type: 'Symbol',
            localized: false,
            required: false,
            position: 1,
          },
          {
            apiId: 'body',
            name: 'Body',
            type: 'RichText',
            localized: false,
            required: false,
            position: 2,
          },
        ],
      }),
    });
    await app.request(`${M}/content-types/post/published`, { method: 'POST', headers: cma });
  });

  const wxrBody = (sourceOptions: Record<string, unknown> = {}) =>
    JSON.stringify({
      source: 'wxr',
      payload: WXR,
      mapping: {
        contentTypeApiId: 'post',
        fields: { title: 'title', wpId: 'id', body: 'content' },
        identityField: 'wpId',
      },
      sourceOptions,
    });

  it('imports the posts as rich-text drafts, and says the page was left behind', async () => {
    const analysis = await app.request(`${M}/imports/analyze`, {
      method: 'POST',
      headers: cma,
      body: wxrBody(),
    });
    expect(await analysis.json()).toMatchObject({
      records: 2,
      willCreate: 2,
      executable: true,
      warnings: [expect.stringMatching(/page \(1\)/)],
    });

    const res = await app.request(`${M}/imports`, {
      method: 'POST',
      headers: cma,
      body: wxrBody(),
    });
    expect(await res.json()).toMatchObject({ created: 2, failed: [] });

    const drafts = await app.request(`${P}/entries?contentType=post`, { headers: cpa });
    const { items } = (await drafts.json()) as {
      items: {
        fields: { title: Record<string, string>; body: Record<string, { nodeType: string }> };
      }[];
    };
    expect(items.map((e) => e.fields.title['en-US']).sort()).toEqual(['Gadget', 'Widget']);
    expect(items[0]?.fields.body['en-US']?.nodeType).toBe('document');
  });

  it('reads another post type when asked, and re-runs without duplicating', async () => {
    const pages = wxrBody({ postType: 'page' });
    const first = await app.request(`${M}/imports`, { method: 'POST', headers: cma, body: pages });
    expect(await first.json()).toMatchObject({ created: 1 });
    const second = await app.request(`${M}/imports`, { method: 'POST', headers: cma, body: pages });
    expect(await second.json()).toMatchObject({ created: 0, skipped: 1 });
  });
});
