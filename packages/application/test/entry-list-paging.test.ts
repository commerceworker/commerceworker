import { ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  type ListedPreviewEntry,
  listPreviewEntryPage,
  publishContentType,
  SYSTEM_CALLER,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };
const other = { spaceId: 'space-1', environmentId: 'staging' };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

async function seedType(ctx: AppContext, at = scope) {
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
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
    ],
  });
  await publishContentType(ctx, at, 'article');
}

const create = (ctx: AppContext, title: string, at = scope) =>
  createEntry(ctx, at, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title }, body: { 'en-US': `about ${title}` } },
  });

const titleOf = (e: ListedPreviewEntry) => (e.fields.title as Record<string, string>)['en-US'];

/** Every page of a query, following `nextCursor` to the end. */
async function walk(
  ctx: AppContext,
  query: Parameters<typeof listPreviewEntryPage>[2] = {},
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

describe('preview entry list paging', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = makeContext();
    await seedType(ctx);
  });

  it('pages a type past the 100-row cap, each entry once, and ends without a cursor', async () => {
    for (let i = 0; i < 250; i++) await create(ctx, `Entry ${String(i).padStart(3, '0')}`);
    const pages = await walk(ctx, { contentTypeApiId: 'article' });
    expect(pages.map((p) => p.length)).toEqual([100, 100, 50]);
    const ids = pages.flat().map((e) => e.id);
    expect(new Set(ids).size).toBe(250);
    // Least recently changed first, which is creation order here.
    expect(titleOf(pages[0]?.[0] as ListedPreviewEntry)).toBe('Entry 000');
    expect(pages.flat().every((e) => typeof e.updatedAt === 'string')).toBe(true);
  });

  it('holds a full last page to no cursor: one row past the page decides', async () => {
    for (let i = 0; i < 4; i++) await create(ctx, `E${i}`);
    const first = await listPreviewEntryPage(ctx, scope, { limit: 2 });
    expect(first.nextCursor).toBeDefined();
    const second = await listPreviewEntryPage(ctx, scope, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
  });

  it('walks a sort with ties exactly, matching the sort read in one go', async () => {
    for (const t of ['b', 'a', 'b', 'c', 'a', 'b', 'c']) await create(ctx, t);
    const order = [{ field: 'title', direction: 'desc' as const }];
    const pages = await walk(ctx, { order, limit: 2 });
    const all = await listPreviewEntryPage(ctx, scope, { order });
    expect(pages.flat().map((e) => e.id)).toEqual(all.items.map((e) => e.id));
    expect(all.items.map(titleOf)).toEqual(['c', 'c', 'b', 'b', 'b', 'a', 'a']);
  });

  it('skips nothing when an entry already read is edited before the next page', async () => {
    const created = [];
    for (let i = 0; i < 6; i++) created.push(await create(ctx, `E${i}`));
    const first = await listPreviewEntryPage(ctx, scope, { limit: 3 });
    // The edit moves E0 to the end of the default order; an offset would now skip E3.
    await updateEntry(ctx, scope, created[0]?.entry.id as string, {
      title: { 'en-US': 'E0 edited' },
    });
    const rest = await walk(ctx, { limit: 3, cursor: first.nextCursor as string });
    expect(rest.flat().map(titleOf)).toEqual(['E3', 'E4', 'E5', 'E0 edited']);
  });

  it('pages a projection that leaves the sorted field out, and returns only what was asked', async () => {
    for (const t of ['c', 'a', 'b']) await create(ctx, t);
    const first = await listPreviewEntryPage(ctx, scope, {
      order: [{ field: 'title', direction: 'asc' }],
      select: ['body'],
      limit: 2,
    });
    expect(Object.keys(first.items[0]?.fields ?? {})).toEqual(['body']);
    const second = await listPreviewEntryPage(ctx, scope, {
      order: [{ field: 'title', direction: 'asc' }],
      select: ['body'],
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((e) => e.fields.body)).toEqual([{ 'en-US': 'about c' }]);
  });

  it('refuses a cursor from another order, and one it never issued', async () => {
    for (let i = 0; i < 3; i++) await create(ctx, `E${i}`);
    const { nextCursor } = await listPreviewEntryPage(ctx, scope, { limit: 1 });
    await expect(
      listPreviewEntryPage(ctx, scope, {
        order: [{ field: 'title', direction: 'asc' }],
        cursor: nextCursor as string,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      listPreviewEntryPage(ctx, scope, { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('narrows a restricted caller in the query: no page ends on, no cursor carries, a hidden entry', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'secret',
      name: 'Secret',
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
    await publishContentType(ctx, scope, 'secret');
    const hidden = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await create(ctx, `a${i}`);
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'secret',
        fields: { title: { 'en-US': `a${i} hidden` } },
      });
      hidden.add(entry.id);
    }
    const readable = (t: string) => t === 'article';
    const seen: ListedPreviewEntry[] = [];
    const cursors: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPreviewEntryPage(
        ctx,
        scope,
        { order: [{ field: 'title', direction: 'asc' }], limit: 2, ...(cursor ? { cursor } : {}) },
        { readable },
      );
      seen.push(...page.items);
      cursor = page.nextCursor;
      if (cursor) cursors.push(cursor);
    } while (cursor);
    expect(seen.map(titleOf)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    const decoded = cursors.map((c) =>
      decodeURIComponent(atob(c.replace(/-/g, '+').replace(/_/g, '/'))),
    );
    for (const d of decoded) {
      expect(d).not.toContain('hidden');
      for (const id of hidden) expect(d).not.toContain(id);
    }
    // A type the caller can't read, asked for by name, is an empty page.
    expect(
      await listPreviewEntryPage(ctx, scope, { contentTypeApiId: 'secret' }, { readable }),
    ).toEqual({ items: [] });
  });

  it('issues URL-safe cursors', async () => {
    for (let i = 0; i < 40; i++) await create(ctx, `Ünïcødé ${'?'.repeat(i % 7)} ${i}`);
    const pages = await walk(ctx, { order: [{ field: 'title', direction: 'asc' }], limit: 1 });
    expect(pages.flat()).toHaveLength(40);
  });

  it("never lists another environment's entries", async () => {
    await seedType(ctx, other);
    await create(ctx, 'here');
    await create(ctx, 'there', other);
    const page = await listPreviewEntryPage(ctx, scope, {});
    expect(page.items.map(titleOf)).toEqual(['here']);
  });
});
