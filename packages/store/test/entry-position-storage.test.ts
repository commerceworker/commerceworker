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
  unpublishEntry,
  updateEntry,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The storage behind manual entry order (0034_entry_position): `entries.position`, the copy on
 * `entry_published` its triggers keep, and the indexes an ordered list reads. Nothing in the store
 * writes `position` yet, so these tests write it as a move will, with SQL. Each test makes its own
 * space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `order-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Order', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'note',
    name: 'Note',
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
    ] as FieldDefinition[],
  });
  await publishContentType(ctx, scope, 'note');
  const note = async (title: string) =>
    (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': title } },
      })
    ).entry.id;
  const move = (id: string, position: string) =>
    testDb
      .prepare(
        'UPDATE entries SET position = ? WHERE space_id = ? AND environment_id = ? AND id = ?',
      )
      .bind(position, spaceId, 'main', id)
      .run();
  const positions = async (table: 'entries' | 'entry_published', id: string) =>
    (
      await testDb
        .prepare(
          `SELECT position FROM ${table} WHERE space_id = ? AND environment_id = ? AND ${
            table === 'entries' ? 'id' : 'entry_id'
          } = ?`,
        )
        .bind(spaceId, 'main', id)
        .first<{ position: string | null }>()
    )?.position;
  return { ctx, scope, note, move, positions };
}

describe('entry position storage on D1', () => {
  it('starts with no key, so an entry sorts by its id', async () => {
    const h = await harness();
    const id = await h.note('A');
    await publishEntry(h.ctx, h.scope, id);
    expect(await h.positions('entries', id)).toBeNull();
    expect(await h.positions('entry_published', id)).toBeNull();
  });

  it('copies a move to the published row, and a first publish copies the key', async () => {
    const h = await harness();
    const live = await h.note('Live');
    await publishEntry(h.ctx, h.scope, live);
    await h.move(live, 'V');
    expect(await h.positions('entry_published', live)).toBe('V');

    const draft = await h.note('Draft');
    await h.move(draft, 'W');
    await publishEntry(h.ctx, h.scope, draft);
    expect(await h.positions('entry_published', draft)).toBe('W');
  });

  it('keeps the key through a save, a republish and an unpublish', async () => {
    const h = await harness();
    const id = await h.note('A');
    await publishEntry(h.ctx, h.scope, id);
    await h.move(id, 'V');
    await updateEntry(h.ctx, h.scope, id, { title: { 'en-US': 'A2' } });
    await publishEntry(h.ctx, h.scope, id);
    expect(await h.positions('entries', id)).toBe('V');
    expect(await h.positions('entry_published', id)).toBe('V');
    await unpublishEntry(h.ctx, h.scope, id);
    await publishEntry(h.ctx, h.scope, id);
    expect(await h.positions('entry_published', id)).toBe('V');
  });

  it('serves published entries in manual order, each way', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (const t of ['a', 'b', 'c', 'd']) {
      const id = await h.note(t);
      await publishEntry(h.ctx, h.scope, id);
      ids.push(id);
    }
    const [a, b, c, d] = ids as [string, string, string, string];
    await h.move(d, '-');
    await h.move(b, `${c}V`);
    const list = async (direction: 'asc' | 'desc') =>
      (
        await listPublishedEntries(h.ctx, h.scope, {
          contentTypeApiId: 'note',
          order: [{ field: 'sys.position', direction }],
        })
      ).map((e) => e.id);
    // These ids are random, not time-ordered: an entry not moved sorts by its id wherever it falls.
    const keys = new Map<string, string>([
      [a, a],
      [b, `${c}V`],
      [c, c],
      [d, '-'],
    ]);
    const expected = [...ids].sort((x, y) => ((keys.get(x) ?? x) < (keys.get(y) ?? y) ? -1 : 1));
    expect(expected[0]).toBe(d);
    expect(expected.indexOf(b)).toBe(expected.indexOf(c) + 1);
    expect(await list('asc')).toEqual(expected);
    expect(await list('desc')).toEqual([...expected].reverse());
  });

  it('reads both ordered lists as one index range, with no sort', async () => {
    const h = await harness();
    for (const t of ['a', 'b', 'c']) await publishEntry(h.ctx, h.scope, await h.note(t));
    const lists = [
      `SELECT id FROM entries WHERE space_id = ? AND environment_id = ? AND content_type_api_id = ?
       ORDER BY COALESCE(position, id), id LIMIT 10`,
      `SELECT entry_id FROM entry_published WHERE space_id = ? AND environment_id = ? AND content_type_api_id = ?
       ORDER BY COALESCE(position, entry_id) DESC, entry_id DESC LIMIT 10`,
    ];
    for (const text of lists) {
      const plan = (
        await testDb
          .prepare(`EXPLAIN QUERY PLAN ${text}`)
          .bind(h.scope.spaceId, 'main', 'note')
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join('\n');
      expect(plan).toMatch(/_by_position/);
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });

  it('moves through the store with its guards, the published row following', async () => {
    const h = await harness();
    await h.note('A');
    await h.note('B');
    await h.note('C');
    const ordered = async () =>
      (
        await store.entries.list(h.scope, {
          contentTypeApiId: 'note',
          order: [{ field: 'sys.position', direction: 'asc' }],
        })
      ).map((e) => e.entry.id);
    // These ids are random: whatever sorts last moves to the front.
    const [a, c, b] = (await ordered()) as [string, string, string];
    await publishEntry(h.ctx, h.scope, b);
    const moved = await moveEntry(h.ctx, h.scope, b, { after: null });
    expect((await ordered())[0]).toBe(b);
    expect(await h.positions('entry_published', b)).toBe(moved.position);
    expect(moved.position < a).toBe(true);
    // A write planned against keys that have changed since is refused whole.
    await expect(
      store.withTransaction((tx) =>
        tx.entries.setPositions(h.scope, 'note', [{ id: c, position: '-', expected: c }], {
          lo: null,
          hi: a,
        }),
      ),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    await expect(
      store.entries.setPositions(h.scope, 'note', [{ id: a, position: 'zz', expected: 'nope' }], {
        lo: null,
        hi: null,
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await h.positions('entries', c)).toBeNull();
    expect(await h.positions('entries', a)).toBeNull();
  });
});
