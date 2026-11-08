import {
  ConflictError,
  InvalidStateError,
  MAX_POSITION_LENGTH,
  ValidationError,
} from '@commerceworker/domain';
import { type IdGenerator, TransactionConflictError } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  listPublishedEntries,
  moveEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };

/** Ids that sort by creation, as UUIDv7s do (zero-padded, so `e10` doesn't sort before `e9`). */
class TimeOrderedIds implements IdGenerator {
  private n = 0;
  newId(): string {
    this.n += 1;
    return `0${String(this.n).padStart(8, '0')}`;
  }
}

let store: InMemoryContentStore;
let ctx: AppContext;

async function note(title: string, type = 'note'): Promise<string> {
  return (
    await createEntry(ctx, scope, { contentTypeApiId: type, fields: { title: { 'en-US': title } } })
  ).entry.id;
}

/** The type's entries in manual order, by title. */
async function order(type = 'note'): Promise<string[]> {
  const items = await store.entries.list(scope, {
    contentTypeApiId: type,
    order: [{ field: 'sys.position', direction: 'asc' }],
  });
  return items.map((e) => (e.fields.title as Record<string, string>)['en-US'] as string);
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new TimeOrderedIds() };
  await createSpace(ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
  for (const apiId of ['note', 'page']) {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId,
      name: apiId,
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
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, scope, apiId);
  }
});

describe('moving an entry in its type’s manual order', () => {
  it('starts in creation order, and moves first, last, after and before', async () => {
    const [a, b, c, d] = [await note('A'), await note('B'), await note('C'), await note('D')];
    expect(await order()).toEqual(['A', 'B', 'C', 'D']);
    await moveEntry(ctx, scope, d, { after: null });
    expect(await order()).toEqual(['D', 'A', 'B', 'C']);
    await moveEntry(ctx, scope, d, { before: null });
    expect(await order()).toEqual(['A', 'B', 'C', 'D']);
    await moveEntry(ctx, scope, a, { after: c });
    expect(await order()).toEqual(['B', 'C', 'A', 'D']);
    await moveEntry(ctx, scope, d, { before: b });
    expect(await order()).toEqual(['D', 'B', 'C', 'A']);
    // An entry created now lands at the end.
    await note('E');
    expect(await order()).toEqual(['D', 'B', 'C', 'A', 'E']);
  });

  it('makes no version and leaves status and authorship as they were', async () => {
    const a = await note('A');
    const b = await note('B');
    await publishEntry(ctx, scope, a);
    const before = (await store.entries.get(scope, a))?.entry;
    const moved = await moveEntry(ctx, scope, a, { after: b });
    const after = (await store.entries.get(scope, a))?.entry;
    expect(after).toMatchObject({
      status: before?.status,
      currentVersion: before?.currentVersion,
      updatedBy: before?.updatedBy ?? null,
      position: moved.position,
    });
  });

  it('serves a published entry’s new place on Delivery at once, and says so', async () => {
    const a = await note('A');
    const b = await note('B');
    await publishEntry(ctx, scope, a);
    await publishEntry(ctx, scope, b);
    await moveEntry(ctx, scope, a, { after: b });
    const live = await listPublishedEntries(ctx, scope, {
      contentTypeApiId: 'note',
      order: [{ field: 'sys.position', direction: 'asc' }],
    });
    expect(live.map((e) => e.id)).toEqual([b, a]);
    const draft = await note('C');
    await moveEntry(ctx, scope, draft, { after: null });
    const moves = store.allEvents().filter((e) => e.type === 'entry.moved');
    expect(moves).toEqual([
      expect.objectContaining({ entryId: a, contentTypeApiId: 'note', published: true }),
      expect.objectContaining({ entryId: draft, published: false }),
    ]);
  });

  it('writes nothing when the entry is already there', async () => {
    const a = await note('A');
    const b = await note('B');
    const events = store.allEvents().length;
    expect(await moveEntry(ctx, scope, b, { after: a })).toMatchObject({ position: b });
    expect(store.allEvents().length).toBe(events);
    expect((await store.entries.get(scope, b))?.entry.position ?? null).toBeNull();
  });

  it('keeps its place through a save that read it before the move', async () => {
    const a = await note('A');
    const b = await note('B');
    const stale = await store.entries.get(scope, a);
    await moveEntry(ctx, scope, a, { after: b });
    if (!stale) throw new Error('no entry');
    await store.entries.saveVersion(
      scope,
      { ...stale.entry, currentVersion: 2 },
      { entryId: a, version: 2, fields: { title: { 'en-US': 'A2' } } },
    );
    await updateEntry(ctx, scope, a, { title: { 'en-US': 'A3' } });
    expect(await order()).toEqual(['B', 'A3']);
  });

  it('refuses an anchor that is itself, of another type or in the trash, and a trashed entry', async () => {
    const a = await note('A');
    const b = await note('B');
    const page = await note('P', 'page');
    const gone = await note('Gone');
    await trashEntry(ctx, scope, gone);
    await expect(moveEntry(ctx, scope, a, { after: a })).rejects.toBeInstanceOf(ValidationError);
    await expect(moveEntry(ctx, scope, a, { after: page })).rejects.toBeInstanceOf(ValidationError);
    await expect(moveEntry(ctx, scope, a, { before: gone })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(moveEntry(ctx, scope, gone, { after: b })).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    await expect(moveEntry(ctx, scope, 'missing', { after: b })).rejects.toThrow('missing');
  });

  it('puts a restored entry back where it was', async () => {
    const [a, b, c] = [await note('A'), await note('B'), await note('C')];
    await moveEntry(ctx, scope, c, { after: a });
    await trashEntry(ctx, scope, c);
    await moveEntry(ctx, scope, b, { after: null });
    const { restoreEntry } = await import('../src/index');
    await restoreEntry(ctx, scope, c);
    expect(await order()).toEqual(['B', 'A', 'C']);
    // b took no key the trashed c holds.
    const keys = (await store.entries.getMany(scope, [a, b, c])).map(
      (e) => e.entry.position ?? e.entry.id,
    );
    expect(new Set(keys).size).toBe(3);
  });

  it('keeps moving into one gap, re-keying its neighbours when the key would grow too long', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await note(`N${i}`));
    const [first, second] = ids as [string, string];
    // Always into the gap right after `first`: each key is longer than the last.
    for (let i = 0; i < 400; i++) {
      const moving = ids[2 + (i % 4)] as string;
      await moveEntry(ctx, scope, moving, { after: first });
    }
    const all = await store.entries.getMany(scope, ids);
    expect(all.every((e) => (e.entry.position ?? e.entry.id).length <= MAX_POSITION_LENGTH)).toBe(
      true,
    );
    const ordered = await order();
    expect(ordered[0]).toBe('N0');
    expect(new Set(ordered).size).toBe(6);
    // `second` was only ever pushed back: still after everything moved in front of it.
    expect(ordered.at(-1)).toBe((await store.entries.get(scope, second))?.fields.title?.['en-US']);
  });

  it('refuses a write whose neighbours moved since it read them', async () => {
    const [a, b, c] = [await note('A'), await note('B'), await note('C')];
    // Another move took the gap after `a` first: a write planned before it must not land too.
    await moveEntry(ctx, scope, c, { after: a });
    await expect(
      store.entries.setPositions(scope, 'note', [{ id: b, position: `${a}V`, expected: b }], {
        lo: a,
        hi: b,
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    // Or a key that changed since it was read.
    await expect(
      store.entries.setPositions(scope, 'note', [{ id: c, position: '-', expected: c }], {
        lo: null,
        hi: a,
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
  });

  it('retries a move that lost a race, and gives up after three', async () => {
    const [a, , c] = [await note('A'), await note('B'), await note('C')];
    const set = store.entries.setPositions.bind(store.entries);
    let losses = 1;
    store.entries.setPositions = async (...args) => {
      if (losses-- > 0) throw new TransactionConflictError();
      return set(...args);
    };
    await moveEntry(ctx, scope, c, { after: a });
    expect(await order()).toEqual(['A', 'C', 'B']);

    store.entries.setPositions = async () => {
      throw new TransactionConflictError();
    };
    await expect(moveEntry(ctx, scope, a, { before: null })).rejects.toBeInstanceOf(ConflictError);
  });
});
