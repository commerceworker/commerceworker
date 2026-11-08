import {
  ConflictError,
  type DomainEvent,
  NotFoundError,
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
  cancelBulkJob,
  cloneContentType,
  contentTypeDeletionOf,
  contentTypeDependents,
  createContentType,
  createEntry,
  createEnvironment,
  createMenu,
  createSpace,
  deleteContentType,
  deleteContentTypeWithEntries,
  dispatchEvent,
  ENTRY_TRASH_CHUNK_SIZE,
  getBulkJob,
  getBulkJobReport,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  let dispatched = 0;
  /** Runs the outbox's new events through dispatch, as the engine does (chunks included). */
  const drain = async () => {
    while (store.allEvents().length > dispatched) {
      const batch = store.allEvents().slice(dispatched);
      dispatched += batch.length;
      for (const e of batch) {
        await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, e as DomainEvent);
      }
    }
  };
  return { ctx, store, drain };
}
type Harness = ReturnType<typeof setup>;

const title = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol' as const,
  localized: false,
  required: false,
  position: 0,
};
const link = (apiId: string, to: string, position = 1) => ({
  apiId,
  name: apiId,
  type: 'Link' as const,
  linkType: 'Entry' as const,
  localized: false,
  required: false,
  position,
  validations: { linkContentTypes: [to] },
});

async function type(h: Harness, apiId: string, extra: Record<string, unknown> = {}, s = scope) {
  await createContentType(h.ctx, SYSTEM_CALLER, s, {
    apiId,
    name: apiId,
    displayField: 'title',
    fields: [title],
    ...extra,
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(h.ctx, s, apiId);
}

const entry = async (h: Harness, apiId: string, fields: Record<string, unknown> = {}) =>
  (
    await createEntry(h.ctx, scope, {
      contentTypeApiId: apiId,
      fields: { title: { 'en-US': `${apiId} entry` }, ...fields },
    })
  ).entry.id;

const events = (h: Harness, t: string) => h.store.allEvents().filter((e) => e.type === t);

describe('deleting a content type', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
  });

  it('deletes a type with no entries and emits content_type.deleted once', async () => {
    await type(h, 'note');
    await deleteContentType(h.ctx, scope, 'note');
    expect(await h.store.contentTypes.get(scope, 'note')).toBeNull();
    expect(events(h, 'content_type.deleted')).toMatchObject([
      { contentTypeApiId: 'note', version: 1, scope },
    ]);
    // A second request has nothing to delete.
    await expect(deleteContentType(h.ctx, scope, 'note')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses while entries exist, the trash included, and names every dependent', async () => {
    await type(h, 'author', { urlPattern: '/people/{id}' });
    await type(h, 'post', {
      fields: [
        title,
        link('author', 'author'),
        {
          apiId: 'body',
          name: 'Body',
          type: 'Array',
          localized: false,
          required: false,
          position: 2,
          items: {
            type: 'Component',
            variants: [{ apiId: 'byline', name: 'Byline', fields: [link('who', 'author', 0)] }],
          },
        },
      ],
    });
    const ann = await entry(h, 'author');
    await publishEntry(h.ctx, scope, ann);
    await createMenu(h.ctx, scope, {
      handle: 'main',
      name: 'Main',
      items: [{ id: 'a', link: { type: 'entry', entryId: ann } }],
    });
    const gone = await entry(h, 'author');
    await trashEntry(h.ctx, scope, gone);

    const d = await contentTypeDependents(h.ctx, scope, 'author');
    expect(d).toMatchObject({
      entries: { live: 1, trashed: 1 },
      linkedFrom: [
        { contentType: 'post', field: 'author' },
        { contentType: 'post', field: 'body.byline.who' },
      ],
      menus: [{ handle: 'main' }],
      urlPattern: '/people/{id}',
    });
    const refused = deleteContentType(h.ctx, scope, 'author');
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(
      /2 entries \(1 in the trash\).*post\.author.*main.*\/people/,
    );
    expect(await h.store.contentTypes.get(scope, 'author')).not.toBeNull();
    expect(events(h, 'content_type.deleted')).toEqual([]);
  });

  it('refuses a type whose definition changed after the reads, at the delete itself', async () => {
    await type(h, 'note');
    // What a concurrent revision does to the stored version between the read and the commit.
    const get = h.store.contentTypes.get;
    h.store.contentTypes.get = async (s, apiId) => {
      const found = await get(s, apiId);
      h.store.contentTypes.get = get;
      await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'note', { name: 'Notes' });
      return found;
    };
    await expect(deleteContentType(h.ctx, scope, 'note')).rejects.toThrow(/changed or gained/);
    expect((await h.store.contentTypes.get(scope, 'note'))?.name).toBe('Notes');
  });

  it('with its entries: a resumable job trashes and purges them, then the type goes', async () => {
    await type(h, 'note', { fields: [title, link('next', 'note')] });
    const ids: string[] = [];
    for (let i = 0; i < ENTRY_TRASH_CHUNK_SIZE + 2; i++) {
      // Each links the one before: purging an earlier one is not blocked by a later one.
      const id = await entry(
        h,
        'note',
        i > 0 ? { next: { 'en-US': { id: ids[i - 1], linkType: 'Entry' } } } : {},
      );
      await publishEntry(h.ctx, scope, id);
      ids.push(id);
    }
    await trashEntry(h.ctx, scope, ids[0] as string);

    const started = await deleteContentTypeWithEntries(h.ctx, scope, 'note');
    if (started.deleted) throw new Error('expected a job');
    expect(started.job).toMatchObject({ action: 'content_type_delete', totalItems: ids.length });
    expect(await h.store.contentTypes.get(scope, 'note')).not.toBeNull();

    await h.drain();
    expect((await getBulkJob(h.ctx, scope, started.job.id)).status).toBe('completed');
    expect(await h.store.entries.getMany(scope, ids)).toEqual([]);
    expect(await h.store.contentTypes.get(scope, 'note')).toBeNull();
    expect(events(h, 'content_type.deleted')).toHaveLength(1);
    // The outcome is on the job, where its readers wait for it.
    expect(contentTypeDeletionOf(await getBulkJob(h.ctx, scope, started.job.id))).toEqual({
      deleted: true,
    });
    // Each live entry was unpublished on the way, as a trash does (the first by its own trash).
    expect(events(h, 'entry.unpublished')).toHaveLength(ids.length);

    // A redelivered completion finds nothing left to do.
    const completed = events(h, 'bulk.job_completed')[0] as DomainEvent;
    await dispatchEvent(h.ctx, { sender: new RecordingWebhookSender() }, completed);
    expect(events(h, 'content_type.deleted')).toHaveLength(1);
  });

  it('keeps the type, and the entry, when another type’s published entry links to one', async () => {
    await type(h, 'note');
    await type(h, 'page', { fields: [title, { ...link('ref', 'note'), validations: undefined }] });
    const note = await entry(h, 'note');
    await publishEntry(h.ctx, scope, note);
    const page = await entry(h, 'page', { ref: { 'en-US': { id: note, linkType: 'Entry' } } });
    await publishEntry(h.ctx, scope, page);

    const started = await deleteContentTypeWithEntries(h.ctx, scope, 'note');
    if (started.deleted) throw new Error('expected a job');
    await h.drain();
    const report = await getBulkJobReport(h.ctx, scope, started.job.id);
    expect(report.job.failed).toBe(1);
    expect(report.chunks[0]?.failures[0]).toMatchObject({ id: note });
    expect(report.chunks[0]?.failures[0]?.error).toMatch(/link/i);
    expect(await h.store.contentTypes.get(scope, 'note')).not.toBeNull();
    expect(await h.store.entries.get(scope, note)).not.toBeNull();
    expect(events(h, 'content_type.deleted')).toEqual([]);
    expect(contentTypeDeletionOf(await getBulkJob(h.ctx, scope, started.job.id))).toEqual({
      deleted: false,
      reason: '1 entry could not be deleted',
    });
  });

  it('records why it kept the type when a dependent arrived while the job ran', async () => {
    await type(h, 'note');
    await entry(h, 'note');
    const started = await deleteContentTypeWithEntries(h.ctx, scope, 'note');
    if (started.deleted) throw new Error('expected a job');
    // Undecided until the job ends: readers wait for this, not only for the status.
    expect(contentTypeDeletionOf(await getBulkJob(h.ctx, scope, started.job.id))).toBeUndefined();
    await type(h, 'post', { fields: [title, link('note', 'note')] });
    await h.drain();
    expect(await h.store.contentTypes.get(scope, 'note')).not.toBeNull();
    const outcome = contentTypeDeletionOf(await getBulkJob(h.ctx, scope, started.job.id));
    expect(outcome?.deleted).toBe(false);
    expect(outcome && !outcome.deleted && outcome.reason).toMatch(/post\.note/);
  });

  it('records a stopped job as keeping the type', async () => {
    await type(h, 'note');
    await entry(h, 'note');
    const started = await deleteContentTypeWithEntries(h.ctx, scope, 'note');
    if (started.deleted) throw new Error('expected a job');
    const stopped = await cancelBulkJob(h.ctx, scope, started.job.id);
    const outcome = { deleted: false, reason: 'the job was stopped' };
    expect(contentTypeDeletionOf(stopped)).toEqual(outcome);
    expect(contentTypeDeletionOf(await getBulkJob(h.ctx, scope, started.job.id))).toEqual(outcome);
  });

  it('refuses to start the job while another type links to it, and deletes an empty type at once', async () => {
    await type(h, 'author');
    await type(h, 'post', { fields: [title, link('author', 'author')] });
    await entry(h, 'author');
    await expect(deleteContentTypeWithEntries(h.ctx, scope, 'author')).rejects.toThrow(
      /post\.author/,
    );
    expect(await h.store.bulkJobs.listJobs(scope)).toEqual([]);

    await type(h, 'empty');
    expect(await deleteContentTypeWithEntries(h.ctx, scope, 'empty')).toEqual({ deleted: true });
  });

  it('acts in its own environment only', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await type(h, 'note');
    await type(h, 'note', {}, staging);
    await createEntry(h.ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'x' } },
    });
    await deleteContentType(h.ctx, scope, 'note');
    expect(await h.store.contentTypes.get(staging, 'note')).not.toBeNull();
    await expect(deleteContentType(h.ctx, staging, 'note')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('cloning a content type', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
  });

  it('copies the definition under a new apiId, as a draft with no entries and no URL pattern', async () => {
    await type(h, 'post', {
      fields: [title, link('related', 'post')],
      urlPattern: '/blog/{id}',
      singleton: true,
    });
    await entry(h, 'post');
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'post', { name: 'Post' });

    const clone = await cloneContentType(h.ctx, SYSTEM_CALLER, scope, 'post', 'news', 'News');
    expect(clone).toMatchObject({
      apiId: 'news',
      name: 'News',
      displayField: 'title',
      singleton: true,
      version: 1,
      status: 'draft',
    });
    expect('urlPattern' in clone).toBe(false);
    expect(clone.fields.map((f) => f.apiId)).toEqual(['title', 'related']);
    expect(clone.fields[1]?.validations?.linkContentTypes).toEqual(['post']);
    expect(await h.store.entries.list(scope, { contentTypeApiId: 'news' })).toEqual([]);
    expect(await h.store.contentTypes.get(scope, 'news')).toEqual(clone);
  });

  it('refuses a taken apiId, an unknown source and an invalid apiId', async () => {
    await type(h, 'post');
    await type(h, 'page');
    await expect(
      cloneContentType(h.ctx, SYSTEM_CALLER, scope, 'post', 'page', 'Page'),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      cloneContentType(h.ctx, SYSTEM_CALLER, scope, 'nope', 'x', 'X'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      cloneContentType(h.ctx, SYSTEM_CALLER, scope, 'post', 'bad-id', 'Bad'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses the second of two clones to one apiId, whose read saw it free', async () => {
    await type(h, 'post');
    const first = await cloneContentType(h.ctx, SYSTEM_CALLER, scope, 'post', 'news', 'News');
    // The second clone's read ran before the first committed: it saw no "news".
    const get = h.store.contentTypes.get;
    h.store.contentTypes.get = async (s, apiId) => (apiId === 'news' ? null : get(s, apiId));
    try {
      const second = cloneContentType(h.ctx, SYSTEM_CALLER, scope, 'post', 'news', 'Newer');
      await expect(second).rejects.toBeInstanceOf(ConflictError);
    } finally {
      h.store.contentTypes.get = get;
    }
    expect(await h.store.contentTypes.get(scope, 'news')).toEqual(first);
  });
});
