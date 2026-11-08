import { ConflictError } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { and, eq, ne } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { chunked, createDb, UnitOfWork } from '../src/exec';
import * as schema from '../src/schema';
import { testDb } from './env';

const db = createDb(testDb);
const scope = { spaceId: 's1', environmentId: 'main' };

async function seedJob(id: string) {
  await db.insert(schema.bulkJobs).values({
    ...scope,
    id,
    action: 'publish',
    status: 'running',
    totalItems: 1,
    totalChunks: 1,
  });
}

const tagIds = async (...ids: string[]) =>
  (await db.select().from(schema.tags)).map((t) => t.id).filter((id) => ids.includes(id));

describe('UnitOfWork', () => {
  it('commits every buffered write atomically', async () => {
    const uow = new UnitOfWork(db);
    await uow.write(db.insert(schema.tags).values({ ...scope, id: 't1', name: 'one' }));
    await uow.write(db.insert(schema.tags).values({ ...scope, id: 't2', name: 'two' }));
    // Nothing is visible before commit: reads see committed state only.
    expect(await tagIds('t1', 't2')).toEqual([]);
    await uow.commit();
    expect(await tagIds('t1', 't2')).toEqual(['t1', 't2']);
  });

  it('a failed guard discards the whole unit and reports a transaction conflict', async () => {
    await seedJob('job-a');
    const uow = new UnitOfWork(db);
    await uow.write(db.insert(schema.tags).values({ ...scope, id: 't3', name: 'x' }));
    // A compare-and-set that matches no row (the job is 'running').
    await uow.write(
      db
        .update(schema.bulkJobs)
        .set({ status: 'completed' })
        .where(and(eq(schema.bulkJobs.id, 'job-a'), ne(schema.bulkJobs.status, 'running'))),
    );
    uow.expectChanged(1);
    await expect(uow.commit()).rejects.toBeInstanceOf(TransactionConflictError);
    // The tag insert before the guard was rolled back with it.
    expect(await tagIds('t3')).toEqual([]);
  });

  it('a passing guard commits and leaves the guard table empty', async () => {
    await seedJob('job-b');
    const uow = new UnitOfWork(db);
    await uow.write(
      db
        .update(schema.bulkJobs)
        .set({ status: 'completed' })
        .where(and(eq(schema.bulkJobs.id, 'job-b'), eq(schema.bulkJobs.status, 'running'))),
    );
    uow.expectChanged(1);
    await uow.commit();
    const [job] = await db.select().from(schema.bulkJobs).where(eq(schema.bulkJobs.id, 'job-b'));
    expect(job?.status).toBe('completed');
    expect(await db.select().from(schema.guard)).toHaveLength(0);
  });

  it('maps a unique violation at commit to ConflictError', async () => {
    const uow = new UnitOfWork(db);
    const claim = {
      ...scope,
      contentTypeApiId: 'page',
      fieldApiId: 'slug',
      locale: 'en-US',
      value: 'about',
    };
    await uow.write(db.insert(schema.entryUniqueValues).values({ ...claim, entryId: 'e1' }));
    await uow.write(db.insert(schema.entryUniqueValues).values({ ...claim, entryId: 'e2' }));
    const err = await uow.commit().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(TransactionConflictError);
    expect(await db.select().from(schema.entryUniqueValues)).toHaveLength(0);
  });
});

describe('chunked', () => {
  it('keeps each chunk under D1’s 100-parameter cap', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const chunks = chunked(ids, 1, 4);
    expect(chunks.every((c) => c.length <= 96)).toBe(true);
    expect(chunks.flat()).toEqual(ids);
    expect(chunked(ids, 2, 4).every((c) => c.length * 2 + 4 <= 100)).toBe(true);
  });
});
