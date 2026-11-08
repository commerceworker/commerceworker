import { type BulkChunkDueEvent, type DomainEvent, ValidationError } from '@commerceworker/domain';
import type {
  ConvertedSpace,
  RemoteFetcher,
  RemoteFile,
  SpaceExportReader,
} from '@commerceworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  allAssets,
  analyzeSpaceExport,
  createContentType,
  createEnvironment,
  getBulkJob,
  getBulkJobReport,
  importChunkRunner,
  runBulkChunk,
  SYSTEM_CALLER,
  startSpaceExportImport,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'import' };
const other = { spaceId: 's1', environmentId: 'main' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let ctx: AppContext;
let store: InMemoryContentStore;
let blob: FakeBlobStore;
const ran = new Set<string>();

/**
 * A reader returning what the space export adapter produces for a small export: two posts that
 * link each other (one published), an image both use, a tag, and a German locale falling back to
 * English. The adapter's own mapping is tested with the adapter; this is about what is done with it.
 */
function reader(over: Partial<ConvertedSpace> = {}): SpaceExportReader & { payloads: string[] } {
  const payloads: string[] = [];
  return {
    id: 'space-export',
    name: 'Space export (JSON)',
    payloads,
    async read(payload, options) {
      payloads.push(payload);
      const [first, second, image] = [options.newId(), options.newId(), options.newId()];
      return {
        defaultLocale: 'en-US',
        locales: [
          { code: 'en-US', name: 'English', fallback: null, default: true },
          { code: 'de-DE', name: 'German', fallback: 'en-US', default: false },
        ],
        contentTypes: [
          {
            apiId: 'post',
            name: 'Post',
            displayField: 'title',
            version: 1,
            status: 'published',
            fields: [
              {
                apiId: 'title',
                name: 'Title',
                type: 'Symbol',
                localized: true,
                required: true,
                position: 0,
              },
              {
                apiId: 'next',
                name: 'Next',
                type: 'Link',
                linkType: 'Entry',
                localized: false,
                required: false,
                position: 1,
              },
              {
                apiId: 'image',
                name: 'Image',
                type: 'Link',
                linkType: 'Asset',
                localized: false,
                required: false,
                position: 2,
              },
            ],
          },
        ],
        tags: [{ id: 'src-tag', name: 'Featured' }],
        entries: [
          {
            id: first,
            sourceId: 'post-1',
            contentTypeApiId: 'post',
            status: 'published',
            fields: {
              title: { 'en-US': 'First', 'de-DE': 'Erste' },
              next: { 'en-US': { id: second, linkType: 'Entry' } },
              image: { 'en-US': { id: image, linkType: 'Asset' } },
            },
            tags: ['src-tag'],
          },
          {
            id: second,
            sourceId: 'post-2',
            contentTypeApiId: 'post',
            status: 'draft',
            fields: {
              title: { 'en-US': 'Second' },
              next: { 'en-US': { id: first, linkType: 'Entry' } },
            },
            tags: [],
          },
        ],
        assets: [
          {
            id: image,
            sourceId: 'img-1',
            status: 'published',
            title: { 'en-US': 'Map' },
            description: {},
            file: {
              url: 'https://assets.example.com/a/map.png',
              fileName: 'map.png',
              contentType: 'image/png',
              size: PNG.byteLength,
            },
          },
        ],
        findings: {
          unmappedFields: ['post.sponsor (ResourceLink): no equivalent field type here'],
          unmappedValidations: ['post.image: assetFileSize'],
          warnings: [],
          missingLinks: [{ entry: 'post-2', field: 'author', linkType: 'Entry', target: 'gone' }],
          invalidEntries: [{ entry: 'post-3', messages: ['title (en-US): Field is required'] }],
        },
        entriesRead: 3,
        assetsRead: 1,
        ...over,
      };
    },
  };
}

/** A fetcher answering from a table of URLs; `fail` answers or throws for the next call to a URL. */
function fetcher(
  files: Record<string, RemoteFile> = {
    'https://assets.example.com/a/map.png': { status: 200, contentType: 'image/png', bytes: PNG },
  },
): RemoteFetcher & { calls: string[]; fail: Map<string, RemoteFile | Error> } {
  const calls: string[] = [];
  const fail = new Map<string, RemoteFile | Error>();
  return {
    calls,
    fail,
    async get() {
      throw new Error('not used');
    },
    async getBytes(url) {
      calls.push(url);
      const once = fail.get(url);
      if (once) {
        fail.delete(url);
        if (once instanceof Error) throw once;
        return once;
      }
      return files[url] ?? { status: 404, bytes: new Uint8Array() };
    },
  };
}

/** Runs every `bulk.chunk_due` not yet run, as the engine's consumer would. */
async function drain(remote: RemoteFetcher | undefined) {
  for (let round = 0; round < 20; round++) {
    const due = (await store.outbox.readPending(10_000)).filter(
      (e: DomainEvent): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due' && !ran.has(e.id),
    );
    if (due.length === 0) return;
    for (const event of due) {
      ran.add(event.id);
      await runBulkChunk(ctx, event, { importChunk: importChunkRunner(ctx, blob, remote) });
    }
  }
}

const payload = '{"contentTypes":[]}';

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('x') };
  blob = new FakeBlobStore();
  ran.clear();
  await createEnvironment(ctx, 's1', 'import');
});

describe('analyzing a space export', () => {
  it('reports what would happen, and writes nothing', async () => {
    const source = reader();
    const report = await analyzeSpaceExport(ctx, scope, source, { payload, addLocales: true });

    expect(source.payloads).toEqual([payload]);
    expect(report).toMatchObject({
      dryRun: true,
      executable: true,
      problems: [],
      locales: {
        default: 'en-US',
        declared: [
          { code: 'en-US', fallback: null },
          { code: 'de-DE', fallback: 'en-US' },
        ],
        toAdd: ['de-DE'],
      },
      contentTypes: 1,
      tags: 1,
      entries: { read: 3, imported: 2, published: 1, invalid: 1 },
      assets: { read: 1, imported: 1, published: 1 },
      unmappedFields: ['post.sponsor (ResourceLink): no equivalent field type here'],
      unmappedValidations: ['post.image: assetFileSize'],
      missingLinkCount: 1,
      invalidEntries: [{ entry: 'post-3', messages: ['title (en-US): Field is required'] }],
    });
    expect(await store.contentTypes.list(scope)).toEqual([]);
    expect((await store.spaces.getConfig(scope))?.locales).toEqual(['en-US']);
    expect(blob.keys()).toEqual([]);
  });

  it('names what stops the import: missing locales without addLocales, another default, a model already there', async () => {
    const missing = await analyzeSpaceExport(ctx, scope, reader(), { payload });
    expect(missing.executable).toBe(false);
    expect(missing.problems).toEqual([
      'This space has no de-DE locale(s). A space admin can import with addLocales to add them, or add them to the space first.',
    ]);

    const german = await analyzeSpaceExport(ctx, scope, reader({ defaultLocale: 'de-DE' }), {
      payload,
      addLocales: true,
    });
    expect(german.problems[0]).toMatch(/default locale is de-DE; this space's is en-US/);

    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'existing',
      name: 'Existing',
      displayField: 'name',
      fields: [
        {
          apiId: 'name',
          name: 'Name',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 0,
        },
      ],
    });
    const occupied = await analyzeSpaceExport(ctx, scope, reader(), { payload, addLocales: true });
    expect(occupied.problems).toEqual([
      'Environment "import" already defines 1 content type(s); import into an empty environment',
    ]);
    await expect(
      startSpaceExportImport(ctx, blob, scope, reader(), { payload, addLocales: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(blob.keys()).toEqual([]);
  });

  it('turns a payload the reader refuses into a validation error', async () => {
    const broken: SpaceExportReader = {
      id: 'space-export',
      name: 'Space export (JSON)',
      read: async () => {
        throw new Error('Not valid JSON');
      },
    };
    await expect(analyzeSpaceExport(ctx, scope, broken, { payload: '{' })).rejects.toMatchObject({
      issues: [
        { field: 'payload', message: 'Space export (JSON) could not be read: Not valid JSON' },
      ],
    });
  });
});

describe('importing a space export as a job', () => {
  it('adds the locales, writes the model, copies the files, creates and then publishes', async () => {
    const remote = fetcher();
    const started = await startSpaceExportImport(ctx, blob, scope, reader(), {
      payload,
      addLocales: true,
    });
    expect(started.report.dryRun).toBe(false);
    const job = started.job;
    if (!job) throw new Error('expected a job');

    const config = await store.spaces.getConfig(scope);
    expect(config?.locales).toEqual(['en-US', 'de-DE']);
    expect(config?.fallbacks).toEqual({ 'de-DE': 'en-US' });
    expect((await store.contentTypes.list(scope)).map((t) => t.apiId)).toEqual(['post']);
    // Nothing is fetched until the job runs.
    expect(remote.calls).toEqual([]);

    await drain(remote);
    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: 3,
      failed: 0,
    });
    expect(remote.calls).toEqual(['https://assets.example.com/a/map.png']);

    // The file is in this deployment's storage under the asset's own key, and the record says so.
    const [first, second, assetId] = ['x-1', 'x-2', 'x-3'];
    const asset = await store.assets.get(scope, assetId as string);
    expect(asset?.r2Key).toBe(`s1/import/${assetId}/map.png`);
    expect(asset?.file).toMatchObject({
      url: `https://blob.local/s1/import/${assetId}/map.png`,
      size: PNG.byteLength,
      contentType: 'image/png',
    });
    expect(await blob.get(`s1/import/${assetId}/map.png`)).toBe(String.fromCharCode(...PNG));

    // The publishing job: the export's published entry and asset, the draft left a draft.
    expect(await getBulkJob(ctx, scope, started.publishJobId as string)).toMatchObject({
      status: 'completed',
      succeeded: 2,
      failed: 0,
    });
    expect((await store.assets.get(scope, assetId as string))?.status).toBe('published');
    const published = await store.entries.getPublished(scope, first as string);
    expect(published?.fields.next).toEqual({ 'en-US': { id: second, linkType: 'Entry' } });
    expect((await store.entries.get(scope, second as string))?.entry.status).toBe('draft');
    // The cycle back resolves too.
    expect((await store.entries.get(scope, second as string))?.fields.next).toEqual({
      'en-US': { id: first, linkType: 'Entry' },
    });
    // The export's tag became one of this environment's, and the entry carries that one.
    const [tag] = await store.taxonomy.listTags(scope);
    expect(tag?.name).toBe('Featured');
    const [meta] = await store.taxonomy.getEntryMetadataMany(scope, [first as string]);
    expect(meta?.metadata.tags).toEqual([tag?.id]);
    expect(blob.keys().filter((k) => k.startsWith('imports/'))).toEqual([]);
  });

  it('runs a chunk again when a download fails for now, without creating anything twice', async () => {
    const remote = fetcher();
    remote.fail.set('https://assets.example.com/a/map.png', {
      status: 503,
      bytes: new Uint8Array(),
    });
    const started = await startSpaceExportImport(ctx, blob, scope, reader(), {
      payload,
      addLocales: true,
    });
    const job = started.job;
    if (!job) throw new Error('expected a job');
    const [due] = (await store.outbox.readPending(100)).filter(
      (e): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due',
    );
    if (!due) throw new Error('expected a chunk');

    // The first run gives up at the file (a 503): the chunk is released, not completed.
    await expect(
      runBulkChunk(ctx, due, { importChunk: importChunkRunner(ctx, blob, remote) }),
    ).rejects.toThrow(/answered 503/);
    expect((await getBulkJob(ctx, scope, job.id)).completedChunks).toBe(0);
    expect(await store.assets.get(scope, 'x-3')).toBeNull();

    // The redelivery finishes it; what the first run did is not done twice.
    await runBulkChunk(ctx, due, { importChunk: importChunkRunner(ctx, blob, remote) });
    ran.add(due.id);
    await drain(remote);
    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: 3,
      failed: 0,
    });
    expect(remote.calls).toHaveLength(2);
    expect((await store.entries.list(scope, {})).length).toBe(2);
    expect(await allAssets(ctx, scope)).toHaveLength(1);
  });

  it('reports a file that cannot be had, and leaves publishing to a clean run', async () => {
    const remote = fetcher({});
    const started = await startSpaceExportImport(ctx, blob, scope, reader(), {
      payload,
      addLocales: true,
    });
    const job = started.job;
    if (!job) throw new Error('expected a job');
    await drain(remote);

    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: 2,
      failed: 1,
    });
    const report = await getBulkJobReport(ctx, scope, job.id);
    expect(JSON.stringify(report)).toContain(
      'Downloading https://assets.example.com/a/map.png answered 404',
    );
    // The entries are there as drafts; publishing waits for the operator.
    expect(await store.bulkJobs.getJob(scope, started.publishJobId as string)).toBeNull();
    expect((await store.entries.get(scope, 'x-1'))?.entry.status).toBe('draft');
  });

  it('never fetches a URL the outbound guard refuses', async () => {
    const remote = fetcher();
    const internal = reader();
    const local: SpaceExportReader = {
      ...internal,
      async read(p, o) {
        const space = await internal.read(p, o);
        return {
          ...space,
          assets: space.assets.map((a) => ({
            ...a,
            file: { ...a.file, url: 'http://169.254.169.254/latest' },
          })),
        };
      },
    };
    const started = await startSpaceExportImport(ctx, blob, scope, local, {
      payload,
      addLocales: true,
    });
    await drain(remote);
    expect(remote.calls).toEqual([]);
    expect((await getBulkJob(ctx, scope, started.job?.id as string)).failed).toBe(1);
    expect(blob.keys().filter((k) => !k.startsWith('imports/'))).toEqual([]);
  });

  it('leaves a chunk that needs a fetcher for a consumer that has one', async () => {
    const started = await startSpaceExportImport(ctx, blob, scope, reader(), {
      payload,
      addLocales: true,
    });
    const [due] = (await store.outbox.readPending(100)).filter(
      (e): e is BulkChunkDueEvent => e.type === 'bulk.chunk_due',
    );
    if (!due) throw new Error('expected a chunk');
    await expect(
      runBulkChunk(ctx, due, { importChunk: importChunkRunner(ctx, blob) }),
    ).rejects.toThrow(/no outbound fetcher/);
    expect((await getBulkJob(ctx, scope, started.job?.id as string)).completedChunks).toBe(0);
  });

  it('touches only the environment it imports into', async () => {
    await startSpaceExportImport(ctx, blob, scope, reader(), { payload, addLocales: true });
    await drain(fetcher());
    expect(await store.contentTypes.list(other)).toEqual([]);
    expect(await store.entries.list(other, {})).toEqual([]);
    expect(await store.taxonomy.listTags(other)).toEqual([]);
    expect((await store.entries.list(scope, {})).length).toBe(2);
  });
});
