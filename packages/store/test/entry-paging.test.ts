import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  type ListedPreviewEntry,
  listPreviewEntryPage,
  publishContentType,
  SYSTEM_CALLER,
  updateEntry,
} from '@commerceworker/application';
import type { Scope } from '@commerceworker/domain';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * The draft list's keyset cursor against D1: (updated_at, id) walked in SQL when the list has no
 * order, the order sorted over the scan when it has one. Both cross the 100-row page.
 */
const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const uid = () => crypto.randomUUID();
const ids: IdGenerator = { newId: uid };
const ctx: AppContext = { store: createD1Store(testDb), clock, ids };
const scope: Scope = { spaceId: `paging-${uid()}`, environmentId: 'main' };
const elsewhere: Scope = { spaceId: `paging-other-${uid()}`, environmentId: 'main' };

async function seedSpace(at: Scope) {
  await createSpace(ctx, {
    spaceId: at.spaceId,
    name: 'Paging',
    defaultLocale: 'en-US',
    locales: ['en-US'],
  });
  await createContentType(ctx, SYSTEM_CALLER, at, {
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
    ],
  });
  await publishContentType(ctx, at, 'article');
}

const titleOf = (e: ListedPreviewEntry) => (e.fields.title as Record<string, string>)['en-US'];

async function walk(
  query: Parameters<typeof listPreviewEntryPage>[2],
): Promise<ListedPreviewEntry[][]> {
  const pages: ListedPreviewEntry[][] = [];
  let cursor: string | undefined;
  do {
    const page = await listPreviewEntryPage(ctx, scope, {
      ...query,
      ...(cursor ? { cursor } : {}),
    });
    pages.push([...page.items]);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

const created: string[] = [];

beforeAll(async () => {
  await seedSpace(scope);
  await seedSpace(elsewhere);
  // Three titles over 130 entries: a sort on title is all ties, which only the id breaks.
  for (let i = 0; i < 130; i++) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': ['a', 'b', 'c'][i % 3] as string } },
    });
    created.push(entry.id);
  }
  await createEntry(ctx, elsewhere, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'not here' } },
  });
});

describe('draft list keyset paging (D1)', () => {
  it('walks (updated_at, id) past the 100-row page, every entry once', async () => {
    const pages = await walk({ contentTypeApiId: 'article' });
    expect(pages.map((p) => p.length)).toEqual([100, 30]);
    const seen = pages.flat().map((e) => e.id);
    expect(new Set(seen)).toEqual(new Set(created));
    // Least recently changed first; the stamp rides on each row.
    const stamps = pages.flat().map((e) => e.updatedAt as string);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('walks an order of ties exactly as one read of it sorts', async () => {
    const order = [{ field: 'title', direction: 'desc' as const }];
    const pages = await walk({ contentTypeApiId: 'article', order, limit: 40 });
    expect(pages.map((p) => p.length)).toEqual([40, 40, 40, 10]);
    const flat = pages.flat();
    expect(new Set(flat.map((e) => e.id)).size).toBe(130);
    expect(flat.map(titleOf)).toEqual([...flat.map(titleOf)].sort().reverse());
  });

  it('skips nothing when an entry already read changes before the next page', async () => {
    const first = await listPreviewEntryPage(ctx, scope, {
      contentTypeApiId: 'article',
      limit: 50,
    });
    const firstId = first.items[0]?.id as string;
    await updateEntry(ctx, scope, firstId, { title: { 'en-US': 'moved' } });
    const rest = await walk({ contentTypeApiId: 'article', cursor: first.nextCursor as string });
    const seen = new Set([...first.items, ...rest.flat()].map((e) => e.id));
    expect(seen).toEqual(new Set(created));
    // The edited entry comes round again at the end, as it changed last.
    expect(rest.flat().at(-1)?.id).toBe(firstId);
  });

  it('walks the manual order in SQL, each way, every entry once', async () => {
    // Five entries moved to the front, in reverse: keys as a move writes them, before any id.
    const moved = created.slice(0, 5);
    for (const [i, id] of moved.entries()) {
      await testDb
        .prepare(
          'UPDATE entries SET position = ? WHERE space_id = ? AND environment_id = ? AND id = ?',
        )
        .bind(`-${5 - i}`, scope.spaceId, scope.environmentId, id)
        .run();
    }
    const key = (id: string) => {
      const i = moved.indexOf(id);
      return i < 0 ? id : `-${5 - i}`;
    };
    const expected = [...created].sort((a, b) => (key(a) < key(b) ? -1 : 1));
    expect(expected.slice(0, 5)).toEqual([...moved].reverse());
    for (const direction of ['asc', 'desc'] as const) {
      const pages = await walk({
        contentTypeApiId: 'article',
        order: [{ field: 'sys.position', direction }],
        limit: 40,
      });
      expect(pages.map((p) => p.length)).toEqual([40, 40, 40, 10]);
      const ids = pages.flat().map((e) => e.id);
      expect(ids).toEqual(direction === 'asc' ? expected : [...expected].reverse());
    }
    for (const id of moved) {
      await testDb
        .prepare(
          'UPDATE entries SET position = NULL WHERE space_id = ? AND environment_id = ? AND id = ?',
        )
        .bind(scope.spaceId, scope.environmentId, id)
        .run();
    }
  });

  it("lists no other space's entries", async () => {
    const pages = await walk({});
    expect(pages.flat().some((e) => titleOf(e) === 'not here')).toBe(false);
  });
});
