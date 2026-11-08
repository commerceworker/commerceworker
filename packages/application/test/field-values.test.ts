import { type FieldDefinition, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  listFieldValues,
  SYSTEM_CALLER,
  trashEntry,
} from '../src/index';

// Distinct field values: what a value picker or a facet offers, paged with a cursor.

const scope = { spaceId: 'space-1', environmentId: 'main' };
const other = { spaceId: 'space-2', environmentId: 'main' };

const field = (apiId: string, type: FieldDefinition['type'], position: number, extra = {}) =>
  ({
    apiId,
    name: apiId,
    type,
    localized: false,
    required: false,
    position,
    ...extra,
  }) as FieldDefinition;

async function seed(ctx: AppContext, s = scope) {
  await createContentType(ctx, SYSTEM_CALLER, s, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      field('title', 'Symbol', 0),
      field('category', 'Symbol', 1, { localized: true }),
      field('year', 'Integer', 2),
      field('featured', 'Boolean', 3),
      field('tags', 'Array', 4, { items: { type: 'Symbol' } }),
      field('body', 'RichText', 5),
      field('notes', 'Text', 6),
    ],
  });
  const make = (f: Record<string, unknown>) =>
    createEntry(ctx, s, { contentTypeApiId: 'post', fields: f as never });
  const ids = [
    await make({
      title: { 'en-US': 'a' },
      category: { 'en-US': 'news', de: 'Nachrichten' },
      year: { 'en-US': 2024 },
      featured: { 'en-US': true },
      tags: { 'en-US': ['x', 'y', 'x'] },
    }),
    await make({
      title: { 'en-US': 'b' },
      category: { 'en-US': 'news' },
      year: { 'en-US': 2025 },
      featured: { 'en-US': false },
      tags: { 'en-US': ['y'] },
    }),
    await make({
      title: { 'en-US': 'c' },
      category: { 'en-US': 'sport' },
      year: { 'en-US': 2024 },
    }),
  ];
  return ids.map((v) => v.entry.id);
}

describe('listFieldValues', () => {
  let ctx: AppContext;
  let ids: string[];
  beforeEach(async () => {
    const store = new InMemoryContentStore();
    for (const s of [scope, other])
      store.seedSpace({ spaceId: s.spaceId, defaultLocale: 'en-US', locales: ['en-US', 'de'] });
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    ids = await seed(ctx);
  });

  it('counts the entries holding each value, every locale by default', async () => {
    expect((await listFieldValues(ctx, scope, 'post', 'category')).items).toEqual([
      { value: 'Nachrichten', count: 1 },
      { value: 'news', count: 2 },
      { value: 'sport', count: 1 },
    ]);
    expect((await listFieldValues(ctx, scope, 'post', 'category', { locale: 'de' })).items).toEqual(
      [{ value: 'Nachrichten', count: 1 }],
    );
  });

  it('lists each element of a list once per entry, and numbers and booleans as such', async () => {
    expect((await listFieldValues(ctx, scope, 'post', 'tags')).items).toEqual([
      { value: 'x', count: 1 },
      { value: 'y', count: 2 },
    ]);
    expect((await listFieldValues(ctx, scope, 'post', 'year')).items).toEqual([
      { value: 2024, count: 2 },
      { value: 2025, count: 1 },
    ]);
    expect((await listFieldValues(ctx, scope, 'post', 'featured')).items).toEqual([
      { value: false, count: 1 },
      { value: true, count: 1 },
    ]);
  });

  it('pages with the cursor until the last page, which has none', async () => {
    const first = await listFieldValues(ctx, scope, 'post', 'category', { limit: 2 });
    expect(first.items.map((i) => i.value)).toEqual(['Nachrichten', 'news']);
    const second = await listFieldValues(ctx, scope, 'post', 'category', {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second).toEqual({ items: [{ value: 'sport', count: 1 }] });
  });

  it('leaves out the trash and other spaces', async () => {
    await seed(ctx, other);
    await trashEntry(ctx, scope, ids[2] as string);
    expect((await listFieldValues(ctx, scope, 'post', 'category')).items).toEqual([
      { value: 'Nachrichten', count: 1 },
      { value: 'news', count: 2 },
    ]);
  });

  it('refuses an unknown field, a structured or long-text field and a forged cursor', async () => {
    for (const [f, cursor] of [
      ['nope', undefined],
      ['body', undefined],
      ['notes', undefined],
      ['title', 'not-a-cursor'],
    ] as const) {
      await expect(
        listFieldValues(ctx, scope, 'post', f, cursor ? { cursor } : {}),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(listFieldValues(ctx, scope, 'nothing', 'title')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
