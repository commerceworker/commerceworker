import { ForbiddenError, type Principal, SCOPES, ValidationError } from '@commerceworker/domain';
import type { ImportSource, SourceRecord } from '@commerceworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  authorizeBulkJobAccess,
  createContentType,
  createEntry,
  getBulkJob,
  getBulkJobReport,
  IMPORT_JOB_CHUNK_SIZE,
  type ImportInput,
  importChunkRunner,
  listPreviewEntries,
  publishContentType,
  runBulkChunk,
  SYSTEM_CALLER,
  startImportJob,
  updateEntry,
} from '../src/index';

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
let ctx: AppContext;
let blob: FakeBlobStore;

/** A person whose role holds `content:write` and these grants. */
const asRole = (contentGrants: Principal['contentGrants']): Principal => ({
  spaceId: SPACE,
  kind: 'user',
  scopes: [SCOPES.contentWrite],
  ...(contentGrants ? { contentGrants } : {}),
});

const rows = (values: Record<string, unknown>[]): ImportSource => ({
  id: 'fake',
  name: 'Fake',
  async read() {
    const records: SourceRecord[] = values.map((v, i) => ({
      externalId: String(v.code ?? `x${i + 1}`),
      values: v,
    }));
    return { records, fields: [...new Set(values.flatMap((v) => Object.keys(v)))], warnings: [] };
  },
});

const input = (over: Partial<ImportInput> = {}): ImportInput => ({
  payload: '',
  mapping: { contentTypeApiId: 'article', fields: { title: 'name' }, ...over.mapping },
  ...over,
});

/** Drains every pending chunk, the way the queue consumer would. */
const drain = async (jobId: string) => {
  const runner = importChunkRunner(ctx, blob);
  const chunks = await ctx.store.bulkJobs.listChunks(scope, jobId);
  for (const chunk of chunks) {
    await runBulkChunk(
      ctx,
      { id: 'e', type: 'bulk.chunk_due', scope, occurredAt: '', jobId, chunkId: chunk.chunkId },
      { importChunk: runner },
    );
  }
};

/** The actionable text of a refusal; `ValidationError.message` is generic. */
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    return err instanceof ValidationError ? (err.issues[0]?.message ?? '') : String(err);
  }
  return '';
};

const many = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `Item ${i}`, code: `A-${i}` }));

beforeEach(async () => {
  blob = new FakeBlobStore();
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
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
      { apiId: 'sku', name: 'SKU', type: 'Symbol', localized: false, required: false, position: 1 },
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'article');
});

describe('starting a durable import', () => {
  it('reports the same plan the synchronous path would', async () => {
    const { job, analysis } = await startImportJob(ctx, blob, admin, scope, rows(many(3)), input());
    expect(analysis).toMatchObject({ records: 3, willCreate: 3, executable: true });
    expect(job).toMatchObject({ action: 'import', status: 'running', totalItems: 3 });
  });

  it('writes nothing until a chunk runs', async () => {
    await startImportJob(ctx, blob, admin, scope, rows(many(3)), input());
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(0);
  });

  it('chunks the work rather than one job-sized lump', async () => {
    const { job } = await startImportJob(
      ctx,
      blob,
      admin,
      scope,
      rows(many(IMPORT_JOB_CHUNK_SIZE + 1)),
      input(),
    );
    expect(job.totalChunks).toBe(2);
  });

  it('stages each chunk before the job exists', async () => {
    // A chunk claimed before its work is readable would fail for no reason.
    const { job } = await startImportJob(ctx, blob, admin, scope, rows(many(3)), input());
    const chunks = await ctx.store.bulkJobs.listChunks(scope, job.id);
    for (const chunk of chunks) {
      expect(chunk.payloadKey).toBeTruthy();
      expect(await blob.get(chunk.payloadKey as string)).toBeTruthy();
    }
  });

  it('refuses a mapping that cannot work, before staging anything', async () => {
    await expect(
      startImportJob(
        ctx,
        blob,
        admin,
        scope,
        rows(many(3)),
        input({ mapping: { contentTypeApiId: 'article', fields: { sku: 'name' } } }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(blob.keys()).toHaveLength(0);
  });

  it('refuses a file where nothing would be imported', async () => {
    // Starting a job that writes nothing gives an operator a progress bar to
    // watch for no reason.
    expect(
      await refusal(
        startImportJob(ctx, blob, admin, scope, rows([{ other: 'no title' }]), input()),
      ),
    ).toMatch(/nothing in this file/i);
  });

  it('does not stage records the report already counted as skipped', async () => {
    const { job } = await startImportJob(
      ctx,
      blob,
      admin,
      scope,
      rows([{ name: 'Fine' }, { other: 'no title' }]),
      input(),
    );
    expect(job.totalItems).toBe(1);
  });
});

describe('running the chunks', () => {
  it('imports everything, across chunks', async () => {
    const { job } = await startImportJob(
      ctx,
      blob,
      admin,
      scope,
      rows(many(IMPORT_JOB_CHUNK_SIZE + 5)),
      input(),
    );
    await drain(job.id);

    expect(await listPreviewEntries(ctx, scope, { limit: 1000 })).toHaveLength(
      IMPORT_JOB_CHUNK_SIZE + 5,
    );
    expect(await getBulkJob(ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: IMPORT_JOB_CHUNK_SIZE + 5,
      failed: 0,
    });
  });

  it('discards the staged records once written', async () => {
    const { job } = await startImportJob(ctx, blob, admin, scope, rows(many(2)), input());
    await drain(job.id);
    // Otherwise a copy of every import sits in object storage indefinitely.
    expect(blob.keys()).toHaveLength(0);
  });

  it('records a failed record without abandoning the chunk', async () => {
    const { job } = await startImportJob(ctx, blob, admin, scope, rows(many(3)), input());
    // Make one write fail the way a constraint would.
    const create = ctx.store.entries.create.bind(ctx.store.entries);
    let calls = 0;
    ctx.store.entries.create = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('conflict');
      return create(...args);
    };
    await drain(job.id);

    const finished = await getBulkJob(ctx, scope, job.id);
    expect(finished).toMatchObject({ status: 'completed', succeeded: 2, failed: 1 });
    const report = await getBulkJobReport(ctx, scope, job.id);
    expect(JSON.stringify(report)).toContain('conflict');
  });

  it('leaves the chunk claimable when the consumer forgot to wire imports', async () => {
    const { job } = await startImportJob(ctx, blob, admin, scope, rows(many(2)), input());
    const [chunk] = await ctx.store.bulkJobs.listChunks(scope, job.id);
    const result = await runBulkChunk(ctx, {
      id: 'e',
      type: 'bulk.chunk_due',
      scope,
      occurredAt: '',
      jobId: job.id,
      chunkId: chunk?.chunkId ?? '',
    });
    // A wiring fault, so a retry after it is fixed should find the work
    // waiting — not a job reporting an import that never happened.
    expect(result.outcome).toBe('skipped');
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(0);
    expect((await getBulkJob(ctx, scope, job.id)).status).toBe('running');
  });

  it('fails the chunk when its staged records have vanished', async () => {
    const { job } = await startImportJob(ctx, blob, admin, scope, rows(many(2)), input());
    const [chunk] = await ctx.store.bulkJobs.listChunks(scope, job.id);
    await blob.delete(chunk?.payloadKey ?? '');

    // Reporting success would claim records were imported that never were.
    await expect(drain(job.id)).rejects.toThrow(/missing/i);
    expect((await getBulkJob(ctx, scope, job.id)).status).toBe('running');
  });

  it('applies the conflict policy the job was started with', async () => {
    const withSku = input({
      mapping: {
        contentTypeApiId: 'article',
        fields: { title: 'name', sku: 'code' },
        identityField: 'sku',
      },
    });
    const first = await startImportJob(ctx, blob, admin, scope, rows(many(2)), withSku);
    await drain(first.job.id);

    // Second run of the same file: nothing new to write, so it refuses to
    // start rather than producing an empty job.
    expect(await refusal(startImportJob(ctx, blob, admin, scope, rows(many(2)), withSku))).toMatch(
      /nothing in this file/i,
    );
    expect(await listPreviewEntries(ctx, scope, { limit: 100 })).toHaveLength(2);
  });
});

describe('re-delivery', () => {
  it('does not double-write a chunk that already completed', async () => {
    const { job } = await startImportJob(ctx, blob, admin, scope, rows(many(2)), input());
    await drain(job.id);
    // The queue redelivers; the chunk is completed and its claim is lost.
    const runner = vi.fn();
    const [chunk] = await ctx.store.bulkJobs.listChunks(scope, job.id);
    const result = await runBulkChunk(
      ctx,
      {
        id: 'e',
        type: 'bulk.chunk_due',
        scope,
        occurredAt: '',
        jobId: job.id,
        chunkId: chunk?.chunkId ?? '',
      },
      { importChunk: runner as never },
    );
    expect(result.outcome).toBe('skipped');
    expect(runner).not.toHaveBeenCalled();
    expect(await listPreviewEntries(ctx, scope, { limit: 100 })).toHaveLength(2);
  });
});

describe('a job started by a role', () => {
  const mapped = input({
    mapping: { contentTypeApiId: 'article', fields: { title: 'name', sku: 'code' } },
  });
  const noSku = asRole([
    { contentTypeApiId: 'article', actions: ['read', 'write'], deniedFields: ['sku'] },
  ]);

  it('refuses a type the role cannot write before staging anything', async () => {
    const onlyPost = asRole([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]);
    await expect(
      startImportJob(ctx, blob, onlyPost, scope, rows(many(3)), input()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(blob.keys()).toHaveLength(0);
    expect(await ctx.store.bulkJobs.listChunks(scope, 'e1')).toHaveLength(0);
  });

  it('never stages a record setting a blocked field, so the engine cannot write it', async () => {
    const { job, analysis } = await startImportJob(
      ctx,
      blob,
      noSku,
      scope,
      rows([{ name: 'Clean' }, { name: 'Blocked', code: 'secret' }]),
      mapped,
    );
    expect(analysis).toMatchObject({ willCreate: 1, invalid: 1 });
    expect(job.totalItems).toBe(1);
    const chunks = await ctx.store.bulkJobs.listChunks(scope, job.id);
    for (const chunk of chunks) {
      expect(await blob.get(chunk.payloadKey as string)).not.toContain('secret');
    }

    await drain(job.id);
    const written = await listPreviewEntries(ctx, scope, { limit: 100 });
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain('secret');
  });

  it('refuses a file every record of which is blocked', async () => {
    expect(
      await refusal(
        startImportJob(ctx, blob, noSku, scope, rows([{ name: 'A', code: 'secret' }]), mapped),
      ),
    ).toMatch(/nothing in this file/i);
    expect(blob.keys()).toHaveLength(0);
  });

  it('keeps a blocked field set after planning, reading it as the chunk runs', async () => {
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'One' } },
    });
    const { job } = await startImportJob(
      ctx,
      blob,
      asRole([
        { contentTypeApiId: 'article', actions: ['read', 'write'], readOnlyFields: ['sku'] },
      ]),
      scope,
      rows([{ name: 'One' }]),
      input({
        mapping: { contentTypeApiId: 'article', fields: { title: 'name' }, identityField: 'title' },
      }),
      { conflicts: 'update' },
    );
    await updateEntry(ctx, scope, created.entry.id, {
      title: { 'en-US': 'One' },
      sku: { 'en-US': 'set-later' },
    });
    const [chunk] = await ctx.store.bulkJobs.listChunks(scope, job.id);
    expect(await blob.get(chunk?.payloadKey as string)).not.toContain('set-later');

    await drain(job.id);
    const after = await ctx.store.entries.get(scope, created.entry.id);
    expect(after?.entry.currentVersion).toBe(3);
    expect(after?.fields.sku).toEqual({ 'en-US': 'set-later' });
  });

  it('still runs for an unrestricted principal', async () => {
    const { job } = await startImportJob(
      ctx,
      blob,
      asRole(undefined),
      scope,
      rows([{ name: 'One', code: 'A' }]),
      mapped,
    );
    await drain(job.id);
    expect(await listPreviewEntries(ctx, scope, { limit: 100 })).toHaveLength(1);
  });
});

describe('who may read the report of, or cancel, an import job', () => {
  const into = { action: 'import', config: { contentTypeApiId: 'post', locale: 'en-US' } } as const;
  const snapshot = { action: 'import', config: { kind: 'snapshot', phase: 'create' } } as const;
  const post = asRole([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]);
  const page = asRole([{ contentTypeApiId: 'page', actions: ['read', 'write'] }]);
  const fieldRule = asRole([
    { contentTypeApiId: 'post', actions: ['read', 'write'], readOnlyFields: ['sku'] },
  ]);
  const everyType = asRole([{ contentTypeApiId: '*', actions: ['read', 'write'] }]);

  it('goes by the type a single-type job wrote', () => {
    expect(() => authorizeBulkJobAccess(post, into, 'report')).not.toThrow();
    expect(() => authorizeBulkJobAccess(post, into, 'cancel')).not.toThrow();
    expect(() => authorizeBulkJobAccess(page, into, 'report')).toThrow(ForbiddenError);
    expect(() => authorizeBulkJobAccess(page, into, 'cancel')).toThrow(ForbiddenError);
  });

  it('keeps the report from a role with field rules, whose failures could quote a value', () => {
    expect(() => authorizeBulkJobAccess(fieldRule, into, 'report')).toThrow(ForbiddenError);
    expect(() => authorizeBulkJobAccess(fieldRule, into, 'cancel')).not.toThrow();
  });

  it('asks for every type of a job that reached every type', () => {
    expect(() => authorizeBulkJobAccess(post, snapshot, 'cancel')).toThrow(ForbiddenError);
    expect(() => authorizeBulkJobAccess(everyType, snapshot, 'report')).not.toThrow();
    expect(() => authorizeBulkJobAccess(asRole(undefined), snapshot, 'report')).not.toThrow();
  });

  it('treats a job naming no type as one over every type', () => {
    const unnamed = { action: 'import' } as const;
    expect(() => authorizeBulkJobAccess(post, unnamed, 'report')).toThrow(ForbiddenError);
  });
});
