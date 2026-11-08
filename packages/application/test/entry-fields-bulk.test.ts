import {
  ConflictError,
  type DomainEvent,
  ForbiddenError,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  authorizeBulkJobAccess,
  authorizeSetFieldsJob,
  createContentType,
  createEntry,
  createSpace,
  dispatchEvent,
  ENTRY_TRASH_CHUNK_SIZE,
  entryFieldsChunkRunner,
  getBulkJob,
  getBulkJobReport,
  listBulkJobs,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  startSetFieldsJob,
  trashEntry,
  withFieldValues,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('f') };
  let dispatched = 0;
  /** Runs the outbox's new events through dispatch, as the engine does (chunks included). */
  const drain = async () => {
    while (store.allEvents().length > dispatched) {
      const events = store.allEvents();
      const batch = events.slice(dispatched);
      dispatched = events.length;
      for (const e of batch) {
        await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, e as DomainEvent);
      }
    }
  };
  return { ctx, store, drain };
}

type Harness = ReturnType<typeof setup>;

const symbol = (apiId: string, position: number, extra: Record<string, unknown> = {}) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
  ...extra,
});

async function model(h: Harness) {
  await createContentType(h.ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      symbol('title', 0, { required: true }),
      symbol('category', 1, { validations: { in: ['news', 'guide'] } }),
      symbol('teaser', 2, { localized: true }),
      symbol('slug', 3, { type: 'Slug', unique: true }),
      symbol('handle', 4, { type: 'Slug' }),
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(h.ctx, scope, 'post');
  await createContentType(h.ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [symbol('title', 0)],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(h.ctx, scope, 'page');
}

async function entry(h: Harness, type: string, fields: Record<string, Record<string, unknown>>) {
  return (await createEntry(h.ctx, scope, { contentTypeApiId: type, fields })).entry;
}

const fieldsOf = async (h: Harness, id: string) => (await h.store.entries.get(scope, id))?.fields;

describe('bulk field edit', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, {
      spaceId: 'site',
      name: 'Site',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de-DE'],
      environments: ['main', 'staging'],
    });
    await model(h);
  });

  it('sets a field on every entry of a selection larger than one chunk, keeping the rest', async () => {
    const ids: string[] = [];
    for (let i = 0; i < ENTRY_TRASH_CHUNK_SIZE + 2; i++) {
      ids.push((await entry(h, 'post', { title: { 'en-US': `p${i}` } })).id);
    }
    const live = ids[0] ?? '';
    await publishEntry(h.ctx, scope, live);

    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: ids,
      fields: { category: { 'en-US': 'news' } },
    });
    expect(job).toMatchObject({ action: 'set_fields', totalChunks: 2, status: 'running' });
    await h.drain();

    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: ids.length,
      failed: 0,
    });
    expect(await fieldsOf(h, ids[1] ?? '')).toEqual({
      title: { 'en-US': 'p1' },
      category: { 'en-US': 'news' },
    });
    // A new draft, as an edit makes: the published version stays what Delivery serves.
    const after = await h.store.entries.get(scope, live);
    expect(after?.entry).toMatchObject({
      status: 'changed',
      currentVersion: 2,
      publishedVersion: 1,
    });
  });

  it('sets only the locales named, and clears one given null', async () => {
    const a = await entry(h, 'post', {
      title: { 'en-US': 'A' },
      teaser: { 'en-US': 'Old', 'de-DE': 'Alt' },
    });
    await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id],
      fields: { teaser: { 'en-US': 'New', 'de-DE': null } },
    });
    await h.drain();
    expect((await fieldsOf(h, a.id))?.teaser).toEqual({ 'en-US': 'New' });
  });

  it('reports each entry it could not save and saves the others', async () => {
    const ok = await entry(h, 'post', { title: { 'en-US': 'Ok' } });
    const page = await entry(h, 'page', { title: { 'en-US': 'Page' } });
    const trashed = await entry(h, 'post', { title: { 'en-US': 'Gone' } });
    await trashEntry(h.ctx, scope, trashed.id);

    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [ok.id, page.id, trashed.id, 'missing'],
      fields: { category: { 'en-US': 'news' } },
    });
    await h.drain();

    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({
      status: 'completed',
      succeeded: 1,
      failed: 3,
    });
    const failures = (await getBulkJobReport(h.ctx, scope, job.id)).chunks.flatMap(
      (c) => c.failures,
    );
    expect(failures).toEqual([
      // One message for another type's entry and a missing one: the report doesn't say which.
      { id: page.id, error: 'No "post" entry with this id' },
      { id: trashed.id, error: 'The entry is in the trash; restore it first' },
      { id: 'missing', error: 'No "post" entry with this id' },
    ]);
    expect((await fieldsOf(h, ok.id))?.category).toEqual({ 'en-US': 'news' });
    expect((await fieldsOf(h, page.id))?.category).toBeUndefined();
  });

  it('judges each value as a save does, refusing one the field’s validations reject', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' } });
    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id],
      fields: { category: { 'en-US': 'opinion' } },
    });
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 0, failed: 1 });
    const [failure] = (await getBulkJobReport(h.ctx, scope, job.id)).chunks.flatMap(
      (c) => c.failures,
    );
    expect(failure?.error).toMatch(/category/i);
    expect((await fieldsOf(h, a.id))?.category).toBeUndefined();
  });

  it('saves nothing again when a chunk runs twice', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' } });
    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id],
      fields: { category: { 'en-US': 'guide' } },
    });
    const [chunk] = await h.store.bulkJobs.listChunks(scope, job.id);
    // As the consumer reads it: from the store, values and all.
    const stored = await h.store.bulkJobs.getJob(scope, job.id);
    const run = entryFieldsChunkRunner(h.ctx);
    if (!chunk || !stored) throw new Error('no job');
    expect(await run(scope, stored, chunk)).toEqual({ succeeded: 1, failures: [] });
    expect(await run(scope, stored, chunk)).toEqual({ succeeded: 1, failures: [] });
    expect((await h.store.entries.get(scope, a.id))?.entry.currentVersion).toBe(2);
  });

  it('refuses an entry in the trash even when it already holds the values', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' }, category: { 'en-US': 'news' } });
    await trashEntry(h.ctx, scope, a.id);
    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id],
      fields: { category: { 'en-US': 'news' } },
    });
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 0, failed: 1 });
  });

  it('saves nothing again for a value the save normalizes, such as a slug', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' } });
    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id],
      fields: { handle: { 'en-US': 'Hello World' } },
    });
    const [chunk] = await h.store.bulkJobs.listChunks(scope, job.id);
    if (!chunk) throw new Error('no chunk');
    const stored = await h.store.bulkJobs.getJob(scope, job.id);
    if (!stored) throw new Error('no job');
    const run = entryFieldsChunkRunner(h.ctx);
    await run(scope, stored, chunk);
    expect((await fieldsOf(h, a.id))?.handle).toEqual({ 'en-US': 'hello-world' });
    expect(await run(scope, stored, chunk)).toEqual({ succeeded: 1, failures: [] });
    expect((await h.store.entries.get(scope, a.id))?.entry.currentVersion).toBe(2);
  });

  it('sets the values on what an entry holds now when someone saved it meanwhile', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' } });
    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id],
      fields: { category: { 'en-US': 'guide' } },
    });
    // The first save loses its version to another writer, as D1's primary key would refuse it.
    const save = h.store.entries.saveVersion.bind(h.store.entries);
    let lost = false;
    h.store.entries.saveVersion = async (...args) => {
      if (!lost) {
        lost = true;
        throw new ConflictError('A unique value is already taken');
      }
      return save(...args);
    };
    await h.drain();
    expect(lost).toBe(true);
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await fieldsOf(h, a.id))?.category).toEqual({ 'en-US': 'guide' });
  });

  it('clears a unique field on many entries, which can’t collide', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' }, slug: { 'en-US': 'a' } });
    const b = await entry(h, 'post', { title: { 'en-US': 'B' }, slug: { 'en-US': 'b' } });
    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id, b.id],
      fields: { slug: { 'en-US': null } },
    });
    await h.drain();
    expect(await getBulkJob(h.ctx, scope, job.id)).toMatchObject({ succeeded: 2, failed: 0 });
    expect((await fieldsOf(h, a.id))?.slug).toBeUndefined();
  });

  it('touches only its own environment’s entries', async () => {
    const staging = { spaceId: 'site', environmentId: 'staging' };
    await createContentType(h.ctx, SYSTEM_CALLER, staging, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [symbol('title', 0), symbol('category', 1)],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(h.ctx, staging, 'post');
    const elsewhere = (
      await createEntry(h.ctx, staging, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'S' } },
      })
    ).entry;
    const job = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [elsewhere.id],
      fields: { category: { 'en-US': 'news' } },
    });
    await h.drain();
    const failures = (await getBulkJobReport(h.ctx, scope, job.id)).chunks.flatMap(
      (c) => c.failures,
    );
    expect(failures).toEqual([{ id: elsewhere.id, error: 'No "post" entry with this id' }]);
    expect((await h.store.entries.get(staging, elsewhere.id))?.fields.category).toBeUndefined();
  });

  it('never reads its values back, only the names of the fields it sets', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' } });
    const started = await startSetFieldsJob(h.ctx, scope, {
      contentTypeApiId: 'post',
      entryIds: [a.id],
      fields: { category: { 'en-US': 'news' } },
    });
    const seen = [
      started,
      await getBulkJob(h.ctx, scope, started.id),
      ...(await listBulkJobs(h.ctx, scope)),
      (await getBulkJobReport(h.ctx, scope, started.id)).job,
    ];
    for (const job of seen) {
      expect(job.config).toMatchObject({ contentTypeApiId: 'post', fieldNames: ['category'] });
      expect(JSON.stringify(job)).not.toContain('news');
    }
    // The chunks still read them from the store.
    expect((await h.store.bulkJobs.getJob(scope, started.id))?.config?.fields).toEqual({
      category: { 'en-US': 'news' },
    });
  });

  it('refuses values that can’t apply to the type before touching any entry', async () => {
    const a = await entry(h, 'post', { title: { 'en-US': 'A' } });
    const start = (fields: Record<string, Record<string, unknown>>) =>
      startSetFieldsJob(h.ctx, scope, { contentTypeApiId: 'post', entryIds: [a.id], fields });
    await expect(start({})).rejects.toBeInstanceOf(ValidationError);
    await expect(start({ colour: { 'en-US': 'red' } })).rejects.toBeInstanceOf(ValidationError);
    await expect(start({ slug: { 'en-US': 'one' } })).rejects.toBeInstanceOf(ValidationError);
    await expect(start({ slug: { 'en-US': null, 'de-DE': 'x' } })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(start({ teaser: { 'fr-FR': 'Salut' } })).rejects.toBeInstanceOf(ValidationError);
    await expect(start({ category: { 'de-DE': 'news' } })).rejects.toBeInstanceOf(ValidationError);
    await expect(start({ category: {} })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      startSetFieldsJob(h.ctx, scope, {
        contentTypeApiId: 'nope',
        entryIds: [a.id],
        fields: { title: { 'en-US': 'x' } },
      }),
    ).rejects.toThrow('nope');
    expect(await h.store.bulkJobs.listJobs(scope)).toEqual([]);
  });
});

describe('who may edit fields in bulk', () => {
  const role = (grant: Record<string, unknown>): Principal =>
    ({
      spaceId: 'site',
      kind: 'user',
      scopes: [SCOPES.contentWrite],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write'], ...grant }],
    }) as Principal;
  const fields = { category: { 'en-US': 'news' } };

  it('takes write on the type, not a role on every type', () => {
    expect(() => authorizeSetFieldsJob(role({}), 'post', fields)).not.toThrow();
    expect(() => authorizeSetFieldsJob(role({}), 'page', fields)).toThrow(ForbiddenError);
    expect(() => authorizeSetFieldsJob(role({ actions: ['read'] }), 'post', fields)).toThrow(
      ForbiddenError,
    );
  });

  it('refuses a field the role denies or makes read-only', () => {
    expect(() =>
      authorizeSetFieldsJob(role({ readOnlyFields: ['category'] }), 'post', fields),
    ).toThrow(ForbiddenError);
    expect(() =>
      authorizeSetFieldsJob(role({ deniedFields: ['category'] }), 'post', fields),
    ).toThrow(ForbiddenError);
    expect(() =>
      authorizeSetFieldsJob(role({ readOnlyFields: ['teaser'] }), 'post', fields),
    ).not.toThrow();
  });

  it('closes the report to a role with field rules on the type, as an import’s is', () => {
    const job = { action: 'set_fields' as const, config: { contentTypeApiId: 'post' } };
    expect(() => authorizeBulkJobAccess(role({}), job, 'report')).not.toThrow();
    expect(() =>
      authorizeBulkJobAccess(role({ readOnlyFields: ['teaser'] }), job, 'report'),
    ).toThrow(ForbiddenError);
    expect(() =>
      authorizeBulkJobAccess(role({ readOnlyFields: ['teaser'] }), job, 'cancel'),
    ).not.toThrow();
  });
});

describe('withFieldValues', () => {
  it('lays values over the stored fields locale by locale', () => {
    expect(
      withFieldValues(
        { title: { 'en-US': 'A' }, teaser: { 'en-US': 'x', 'de-DE': 'y' } },
        { teaser: { 'de-DE': null }, category: { 'en-US': 'news' } },
      ),
    ).toEqual({
      title: { 'en-US': 'A' },
      teaser: { 'en-US': 'x' },
      category: { 'en-US': 'news' },
    });
    expect(withFieldValues({ teaser: { 'en-US': 'x' } }, { teaser: { 'en-US': null } })).toEqual(
      {},
    );
  });
});
