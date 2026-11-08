import {
  type AppContext,
  cancelBulkJob,
  cloneContentType,
  contentTypeDependents,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  deleteContentType,
  deleteContentTypeWithEntries,
  getContentType,
  getDeliveredSingleton,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
} from '@commerceworker/application';
import { ConflictError, type FieldDefinition, NotFoundError } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Deleting and cloning a content type on D1: the delete is a compare-and-set on the type's version
 * whose own WHERE refuses a type with any entry (the trash included), so an entry written after
 * the use-case looked fails the commit; the outbox event rides in the same batch. Each test makes
 * its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const title: FieldDefinition = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
};

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `ct-life-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Lifecycle', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [title],
  });
  await publishContentType(ctx, scope, 'note');
  return { ctx, scope };
}

async function deletedEvents(spaceId: string): Promise<number> {
  const row = await testDb
    .prepare(
      "select count(*) as n from outbox where json_extract(payload, '$.scope.spaceId') = ? and json_extract(payload, '$.type') = 'content_type.deleted'",
    )
    .bind(spaceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('content type delete on D1', () => {
  it('deletes at its version with the event, and refuses a stale version', async () => {
    const { ctx, scope } = await harness();
    // Revised since the caller read version 1.
    await expect(store.contentTypes.delete(scope, 'note', 2)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await deleteContentType(ctx, scope, 'note');
    expect(await store.contentTypes.get(scope, 'note')).toBeNull();
    expect(await deletedEvents(scope.spaceId)).toBe(1);
  });

  it('fails the commit when an entry exists by then, the trash included, and writes no event', async () => {
    const { ctx, scope } = await harness();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'x' } },
    });
    await trashEntry(ctx, scope, entry.id);
    const version = (await store.contentTypes.get(scope, 'note'))?.version ?? 0;
    await expect(
      store.withTransaction(async (tx) => {
        await tx.contentTypes.delete(scope, 'note', version);
        await tx.outbox.append({
          id: uid(),
          type: 'content_type.deleted',
          scope,
          occurredAt: new Date().toISOString(),
          contentTypeApiId: 'note',
          version,
        });
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.contentTypes.get(scope, 'note')).not.toBeNull();
    expect(await deletedEvents(scope.spaceId)).toBe(0);
    expect((await contentTypeDependents(ctx, scope, 'note')).entries).toEqual({
      live: 0,
      trashed: 1,
    });
  });

  it('touches only its own environment', async () => {
    const { ctx, scope } = await harness();
    await createEnvironment(ctx, scope.spaceId, 'staging');
    const staging = { spaceId: scope.spaceId, environmentId: 'staging' };
    await createContentType(ctx, SYSTEM_CALLER, staging, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    await deleteContentType(ctx, scope, 'note');
    expect(await store.contentTypes.get(staging, 'note')).not.toBeNull();
  });

  it('clones the definition under a new apiId', async () => {
    const { ctx, scope } = await harness();
    const clone = await cloneContentType(ctx, SYSTEM_CALLER, scope, 'note', 'memo', 'Memo');
    expect(await store.contentTypes.get(scope, 'memo')).toEqual(clone);
    expect(clone).toMatchObject({ version: 1, status: 'draft', displayField: 'title' });
  });

  it('clones the group, description, icon and layout, which the insert stores', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', {
      group: 'Docs',
      description: 'A short note',
      icon: 'newspaper',
      agentInstructions: 'Keep titles short.',
      layout: {
        tabs: [{ apiId: 'main', name: 'Main', groups: [{ fields: ['title'] }] }],
      },
    });
    const clone = await cloneContentType(ctx, SYSTEM_CALLER, scope, 'note', 'memo', 'Memo');
    expect(clone).toMatchObject({
      group: 'Docs',
      description: 'A short note',
      icon: 'newspaper',
      agentInstructions: 'Keep titles short.',
    });
    expect(clone.layout?.tabs[0]?.groups[0]?.fields).toEqual(['title']);
    expect(await store.contentTypes.get(scope, 'memo')).toEqual(clone);
  });

  it('refuses a second clone to one apiId at the insert, keeping the first', async () => {
    const { ctx, scope } = await harness();
    const first = await cloneContentType(ctx, SYSTEM_CALLER, scope, 'note', 'memo', 'Memo');
    const again = { ...first, name: 'Memo 2' };
    await expect(store.contentTypes.create(scope, again)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await expect(
      store.withTransaction((tx) => tx.contentTypes.create(scope, again)),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect((await store.contentTypes.get(scope, 'memo'))?.name).toBe('Memo');
  });
});

describe('the content type guard on D1', () => {
  it('passes for the type as read, and fails the commit once it is deleted or flipped', async () => {
    const { ctx, scope } = await harness();
    await store.contentTypes.guard(scope, 'note', { singleton: false });
    await expect(
      store.contentTypes.guard(scope, 'note', { singleton: true }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { singleton: true });
    // A create that read the ordinary type: its unit fails and writes nothing.
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'one' } },
    });
    await expect(
      store.withTransaction(async (tx) => {
        await tx.contentTypes.guard(scope, 'note', { singleton: false });
        await tx.entries.create(
          scope,
          {
            id: uid(),
            contentTypeApiId: 'note',
            status: 'draft',
            currentVersion: 1,
            publishedVersion: null,
          },
          { entryId: 'x', version: 1, fields: {}, createdAt: new Date().toISOString() },
        );
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(
      (await store.entries.list(scope, { contentTypeApiId: 'note' })).map((e) => e.entry.id),
    ).toEqual([entry.id]);
    await expect(
      store.contentTypes.guard(scope, 'gone', { singleton: false }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
  });

  it('refuses an entry outside the trash beyond those it allows, through one JSON parameter', async () => {
    const { ctx, scope } = await harness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': `n${i}` } },
      });
      ids.push(entry.id);
    }
    await trashEntry(ctx, scope, ids[2] as string);
    // Past D1's 100-parameter cap, as one bound value.
    const allowed = [...ids.slice(0, 2), ...Array.from({ length: 150 }, () => uid())];
    await store.contentTypes.guard(scope, 'note', { singleton: false, entries: allowed });
    await expect(
      store.contentTypes.guard(scope, 'note', { singleton: false, entries: [ids[0] as string] }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    // Turning the flag on after a second entry arrived unseen is refused the same way.
    const list = store.entries.list;
    store.entries.list = async (s, q) => (await list(s, q)).filter((e) => e.entry.id === ids[0]);
    try {
      await expect(
        updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { singleton: true }),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      store.entries.list = list;
    }
    expect((await getContentType(ctx, scope, 'note')).singleton).toBeUndefined();
  });
});

describe('content type ids and job outcomes on D1', () => {
  it('pages a type’s entry ids by id, the trash included, in its own scope only', async () => {
    const { ctx, scope } = await harness();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': `n${i}` } },
      });
      ids.push(entry.id);
    }
    await trashEntry(ctx, scope, ids[0] as string);
    const sorted = [...ids].sort();
    const first = await store.entries.idsOfType(scope, 'note', { limit: 3 });
    expect(first).toEqual(sorted.slice(0, 3));
    expect(await store.entries.idsOfType(scope, 'note', { after: first[2], limit: 3 })).toEqual(
      sorted.slice(3),
    );
    const other = { spaceId: `${scope.spaceId}-x`, environmentId: 'main' };
    expect(await store.entries.idsOfType(other, 'note', { limit: 3 })).toEqual([]);
  });

  it('merges an outcome into a job’s config, keeping what it had', async () => {
    const { ctx, scope } = await harness();
    await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'x' } },
    });
    const started = await deleteContentTypeWithEntries(ctx, scope, 'note');
    if (started.deleted) throw new Error('expected a job');
    await store.bulkJobs.mergeConfig(scope, started.job.id, {
      typeDeletion: { deleted: false, reason: 'kept' },
    });
    expect((await store.bulkJobs.getJob(scope, started.job.id))?.config).toEqual({
      contentType: 'note',
      typeDeletion: { deleted: false, reason: 'kept' },
    });
  });
});

describe('stopping a content type delete on D1', () => {
  it('stops the job and records the outcome in one unit, once', async () => {
    const { ctx, scope } = await harness();
    await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'x' } },
    });
    const started = await deleteContentTypeWithEntries(ctx, scope, 'note');
    if (started.deleted) throw new Error('expected a job');
    const stopped = await cancelBulkJob(ctx, scope, started.job.id);
    const outcome = { deleted: false, reason: 'the job was stopped' };
    expect(stopped).toMatchObject({ status: 'cancelled', config: { typeDeletion: outcome } });
    const stored = await store.bulkJobs.getJob(scope, started.job.id);
    expect(stored?.status).toBe('cancelled');
    expect(stored?.config).toEqual({ contentType: 'note', typeDeletion: outcome });
    // Again: already terminal, nothing changes.
    expect((await cancelBulkJob(ctx, scope, started.job.id)).config).toEqual(stored?.config);
  });
});

describe('a singleton served by its published revision on D1', () => {
  it('reads the flag as last published, not as the draft has it', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { singleton: true });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'one' } },
    });
    await publishEntry(ctx, scope, entry.id);
    // A draft turned it on: not served yet.
    await expect(getDeliveredSingleton(ctx, scope, 'note')).rejects.toBeInstanceOf(NotFoundError);
    await publishContentType(ctx, scope, 'note');
    expect((await getDeliveredSingleton(ctx, scope, 'note')).id).toBe(entry.id);
    // A draft turning it off keeps it served until that is published.
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { singleton: false });
    expect((await getDeliveredSingleton(ctx, scope, 'note')).id).toBe(entry.id);
    // Delivery's list of types (GraphQL's roots) agrees with it.
    const delivered = async () =>
      (await store.delivery.read(scope, { contentTypes: true })).contentTypes?.find(
        (t) => t.apiId === 'note',
      )?.singleton;
    expect(await delivered()).toBe(true);
    await publishContentType(ctx, scope, 'note');
    await expect(getDeliveredSingleton(ctx, scope, 'note')).rejects.toBeInstanceOf(NotFoundError);
    expect(await delivered()).toBeUndefined();
  });
});
