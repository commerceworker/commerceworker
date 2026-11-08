import { type AppContext, importChunkRunner, runBulkChunk } from '@commerceworker/application';
import type { BulkChunkDueEvent } from '@commerceworker/domain';
import type { ApiConfig } from '@commerceworker/platform/config';
import type { BlobStore, RemoteFetcher } from '@commerceworker/ports';
import { spaceExportFixture } from '@commerceworker/test-kit';
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
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const TARGET = '/spaces/s1/environments/imported';

let app: ReturnType<typeof createApp>;
let ctx: AppContext;
let blob: BlobStore;

/** Answers every asset URL with a few bytes, as the export's file host would. */
const files: RemoteFetcher & { calls: string[] } = {
  calls: [],
  async get() {
    throw new Error('not used');
  },
  async getBytes(url) {
    files.calls.push(url);
    return { status: 200, contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
  },
};

/** The body as JSON, or the failure with what the server said. */
async function json(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  return JSON.parse(text);
}

/** Runs the import's chunks as the engine's consumer would. */
async function drain() {
  const ran = new Set<string>();
  for (let round = 0; round < 20; round++) {
    const due = (await ctx.store.outbox.readPending(10_000)).filter(
      (e): e is BulkChunkDueEvent => 'type' in e && e.type === 'bulk.chunk_due' && !ran.has(e.id),
    );
    if (due.length === 0) return;
    for (const event of due) {
      ran.add(event.id);
      await runBulkChunk(ctx, event, { importChunk: importChunkRunner(ctx, blob, files) });
    }
  }
}

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ payload: JSON.stringify(spaceExportFixture()), ...over });

type Report = {
  dryRun: boolean;
  executable: boolean;
  problems: string[];
  locales: { toAdd: string[] };
  entries: { read: number; imported: number; published: number; invalid: number };
  assets: { read: number; imported: number; published: number };
  unmappedFields: string[];
  missingLinkCount: number;
};

beforeEach(async () => {
  const wired = wire(config);
  ctx = wired.ctx;
  blob = wired.blob;
  files.calls.length = 0;
  app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  await app.request('/spaces/s1/environments', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ id: 'imported' }),
  });
});

describe('space export import over HTTP', () => {
  it('analyzes without writing, naming the locales the space lacks', async () => {
    const res = await app.request(`${TARGET}/imports/space-export/analyze`, {
      method: 'POST',
      headers: admin,
      body: body(),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as Report;
    expect(report).toMatchObject({
      dryRun: true,
      executable: false,
      locales: { toAdd: ['de-DE', 'fr-FR'] },
      entries: { read: 11, imported: 8, published: 5, invalid: 3 },
      assets: { read: 4, imported: 3, published: 2 },
      unmappedFields: ['blogPost.sponsor (ResourceLink): no equivalent field type here'],
      missingLinkCount: 2,
    });
    expect(report.problems[0]).toMatch(/no de-DE, fr-FR locale/);

    const types = await app.request(`${TARGET}/content-types`, { headers: admin });
    expect(((await types.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('refuses to start what the analysis says cannot run', async () => {
    const res = await app.request(`${TARGET}/imports/space-export`, {
      method: 'POST',
      headers: admin,
      body: body(),
    });
    expect(res.status).toBe(422);
    // An environment that already has a content model.
    await app.request(`${TARGET}/content-types`, {
      method: 'POST',
      headers: admin,
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
            required: false,
            position: 0,
          },
        ],
      }),
    });
    const occupied = await app.request(`${TARGET}/imports/space-export`, {
      method: 'POST',
      headers: admin,
      body: body({ addLocales: true }),
    });
    expect(occupied.status).toBe(422);
    expect(JSON.stringify(await occupied.json())).toContain('import into an empty environment');
  });

  it('refuses a payload that is not a space export, as a 422', async () => {
    const res = await app.request(`${TARGET}/imports/space-export/analyze`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ payload: '[1, 2]' }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('Not a space export');
  });

  it('starts the import as jobs, and the job lands every entry, file and link', async () => {
    const res = await app.request(`${TARGET}/imports/space-export`, {
      method: 'POST',
      headers: admin,
      body: body({ addLocales: true }),
    });
    if (res.status !== 202) throw new Error(await res.text());
    const started = (await res.json()) as {
      report: Report;
      job: { id: string; action: string; totalItems: number };
      publishJobId: string;
    };
    expect(started.report.dryRun).toBe(false);
    expect(started.job).toMatchObject({ action: 'import', totalItems: 3 + 8 });

    const config = await app.request(`${TARGET}/space-config`, { headers: admin });
    expect(await json(config)).toMatchObject({
      locales: ['en-US', 'de-DE', 'fr-FR'],
      fallbacks: { 'de-DE': 'en-US', 'fr-FR': 'de-DE' },
    });

    await drain();
    expect(files.calls.sort()).toEqual([
      'https://assets.example.com/space-a/asset-avatar/ada.jpg',
      'https://assets.example.com/space-a/asset-doc/whitepaper.pdf',
      'https://assets.example.com/space-a/asset-hero/edge-map.png',
    ]);
    const job = await app.request(`${TARGET}/bulk/jobs/${started.job.id}`, { headers: admin });
    expect(await json(job)).toMatchObject({ status: 'completed', succeeded: 11, failed: 0 });
    const publishing = await app.request(`${TARGET}/bulk/jobs/${started.publishJobId}`, {
      headers: admin,
    });
    expect(await json(publishing)).toMatchObject({ status: 'completed', succeeded: 7, failed: 0 });

    // The published post, read back through the API: its links and rich-text embeds point at
    // what this environment holds now.
    const posts = (
      await ctx.store.entries.list(
        { spaceId: 's1', environmentId: 'imported' },
        { contentTypeApiId: 'blogPost' },
      )
    ).map((r) => ({ id: r.entry.id, status: r.entry.status, fields: r.fields }));
    const hello = posts.find((p) => p.fields.slug?.['en-US'] === 'hello-edge');
    const second = posts.find((p) => p.fields.slug?.['en-US'] === 'second-post');
    if (!hello || !second) throw new Error('posts were not imported');
    expect(hello.status).toBe('published');
    expect(second.status).toBe('draft');
    expect(hello.fields.related?.['en-US']).toEqual([{ id: second.id, linkType: 'Entry' }]);
    expect(second.fields.related?.['en-US']).toEqual([{ id: hello.id, linkType: 'Entry' }]);
    const document = hello.fields.body?.['en-US'] as {
      content: { nodeType: string; data: unknown }[];
    };
    const embedded = document.content.find((n) => n.nodeType === 'embedded-asset-block');
    const hero = (hello.fields.heroImage?.['en-US'] as { id: string } | undefined)?.id;
    expect(embedded?.data).toEqual({ target: { id: hero, linkType: 'Asset' } });

    const asset = await app.request(`${TARGET}/assets/${hero}`, { headers: admin });
    expect(await json(asset)).toMatchObject({
      status: 'published',
      file: { fileName: 'edge-map.png', size: 3 },
    });
  });
});
