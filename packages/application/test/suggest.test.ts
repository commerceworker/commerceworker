import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  publishContentType,
  SUGGEST_MAX_LIMIT,
  SYSTEM_CALLER,
  suggestEntries,
  trashEntry,
} from '../src/index';

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
let ctx: AppContext;

const defineType = (apiId: string, displayField = 'title') =>
  createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId,
    name: apiId,
    displayField,
    fields: [
      {
        apiId: displayField,
        name: displayField,
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
    ],
  } as Parameters<typeof createContentType>[3]);

const add = (contentTypeApiId: string, title: string, field = 'title') =>
  createEntry(ctx, scope, {
    contentTypeApiId,
    fields: { [field]: { 'en-US': title } },
  });

beforeEach(async () => {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await defineType('article');
  await publishContentType(ctx, scope, 'article');
});

describe('finding an entry by what you are typing', () => {
  beforeEach(async () => {
    await add('article', 'Baking sourdough');
    await add('article', 'Baking bread');
    await add('article', 'Cycling in winter');
  });

  it('matches on the display field', async () => {
    const hits = await suggestEntries(ctx, scope, { q: 'Baking' });
    expect(hits.map((h) => h.title).sort()).toEqual(['Baking bread', 'Baking sourdough']);
  });

  it('returns what a chooser renders, not a whole entry', async () => {
    const [hit] = await suggestEntries(ctx, scope, { q: 'Cycling' });
    expect(Object.keys(hit ?? {}).sort()).toEqual(['contentType', 'id', 'status', 'title']);
  });

  it('returns recent entries when nothing has been typed yet', async () => {
    // An empty box should offer something rather than nothing.
    expect((await suggestEntries(ctx, scope, {})).length).toBe(3);
  });

  it('finds nothing rather than everything when nothing matches', async () => {
    expect(await suggestEntries(ctx, scope, { q: 'zzz' })).toEqual([]);
  });
});

describe('reaching entries a capped list cannot', () => {
  it('finds an entry well past the list endpoint’s page', async () => {
    // The reason this exists: the picker used to list entries and filter in
    // the browser, so anything past the first page was not slow to find, it
    // was impossible to pick.
    for (let i = 0; i < 150; i += 1) await add('article', `Filler ${i}`);
    await add('article', 'Needle in the haystack');

    const hits = await suggestEntries(ctx, scope, { q: 'Needle' });
    expect(hits.map((h) => h.title)).toEqual(['Needle in the haystack']);
  });
});

describe('bounds', () => {
  beforeEach(async () => {
    for (let i = 0; i < 80; i += 1) await add('article', `Item ${i}`);
  });

  it('caps what a caller can ask for', async () => {
    const hits = await suggestEntries(ctx, scope, { limit: 1000 });
    expect(hits.length).toBe(SUGGEST_MAX_LIMIT);
  });

  it('honours a smaller limit', async () => {
    expect((await suggestEntries(ctx, scope, { limit: 3 })).length).toBe(3);
  });
});

describe('scoping', () => {
  beforeEach(async () => {
    await defineType('recipe', 'name');
    await publishContentType(ctx, scope, 'recipe');
    await add('article', 'Baking bread');
    await add('recipe', 'Baking powder', 'name');
  });

  it('searches one content type when asked', async () => {
    const hits = await suggestEntries(ctx, scope, { q: 'Baking', contentTypeApiId: 'recipe' });
    expect(hits.map((h) => h.contentType)).toEqual(['recipe']);
  });

  it('matches each type on its own display field when not', async () => {
    // `recipe` displays `name`, not `title` — a single field name would find
    // nothing for it.
    const hits = await suggestEntries(ctx, scope, { q: 'Baking' });
    expect(hits.map((h) => h.contentType).sort()).toEqual(['article', 'recipe']);
  });

  it('returns nothing for a content type that does not exist', async () => {
    expect(await suggestEntries(ctx, scope, { contentTypeApiId: 'ghost' })).toEqual([]);
  });

  it('leaves trashed entries out', async () => {
    const [entry] = await suggestEntries(ctx, scope, { q: 'Baking bread' });
    await trashEntry(ctx, scope, entry?.id ?? '');
    // Offering something in the trash as a link target would create a
    // reference to content someone deleted.
    expect(await suggestEntries(ctx, scope, { q: 'Baking bread' })).toEqual([]);
  });
});

describe('titles', () => {
  it('uses the requested locale', async () => {
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Bread', 'de-DE': 'Brot' } },
    });
    // Matched on the German string, because that is what someone typing in a
    // German editor types; the title comes back in the same locale.
    const [hit] = await suggestEntries(ctx, scope, { q: 'Brot', locale: 'de-DE' });
    expect(hit?.title).toBe('Brot');
  });

  it('falls back to the id when the display field is empty', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'note',
      displayField: 'label',
      fields: [
        {
          apiId: 'label',
          name: 'label',
          type: 'Symbol',
          localized: true,
          required: false,
          position: 0,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, scope, 'note');
    await createEntry(ctx, scope, { contentTypeApiId: 'note', fields: {} });
    const hits = await suggestEntries(ctx, scope, { contentTypeApiId: 'note' });
    // A blank row is unpickable; an id at least identifies it.
    expect(hits[0]?.title).toBe(hits[0]?.id);
  });
});
