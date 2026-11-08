import {
  ConflictError,
  nextSlugCandidate,
  normalizeSlug,
  ValidationError,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  duplicateEntry,
  publishContentType,
  restoreEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
let ctx: AppContext;
let store: InMemoryContentStore;

type FieldOverrides = Record<string, unknown>;

/** An `article` type whose `slug` field can be tuned per test. */
async function seed(slug: FieldOverrides = {}, extra: FieldOverrides[] = [], locales = ['en-US']) {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
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
      {
        apiId: 'slug',
        name: 'Slug',
        type: 'Slug',
        localized: false,
        required: false,
        position: 1,
        ...slug,
      },
      ...extra.map((f, i) => ({ localized: false, required: false, position: 2 + i, ...f })),
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'article');
}

const article = (title: string, fields: Record<string, unknown> = {}) => ({
  contentTypeApiId: 'article',
  fields: { title: { 'en-US': title }, ...fields },
});

describe('the Slug field type', () => {
  beforeEach(() => seed());

  it('normalizes what the editor typed into something URL-safe', async () => {
    const { fields } = await createEntry(
      ctx,
      scope,
      article('Post', { slug: { 'en-US': '  Héllo, World!  ' } }),
    );
    expect(fields.slug).toEqual({ 'en-US': 'hello-world' });
  });

  it('is idempotent, so re-saving never churns the value', async () => {
    const { entry } = await createEntry(ctx, scope, article('Post', { slug: { 'en-US': 'a b' } }));
    const updated = await updateEntry(ctx, scope, entry.id, {
      title: { 'en-US': 'Post' },
      slug: { 'en-US': 'a-b' },
    });
    expect(updated.fields.slug).toEqual({ 'en-US': 'a-b' });
  });

  it('transliterates accents rather than dropping the letter', () => {
    expect(normalizeSlug('Crème Brûlée')).toBe('creme-brulee');
    expect(normalizeSlug('北京')).toBe('');
  });

  it('collapses punctuation runs and trims stray hyphens', () => {
    expect(normalizeSlug('--a---b--')).toBe('a-b');
    expect(normalizeSlug('C++ / Rust')).toBe('c-rust');
  });

  it('numbers a duplicate without stacking suffixes', () => {
    expect(nextSlugCandidate('post', 2)).toBe('post-2');
    expect(nextSlugCandidate('post-2', 3)).toBe('post-3');
  });
});

describe('unique fields', () => {
  beforeEach(() => seed({ unique: true }));

  it('refuses a second entry with the same value, naming the holder', async () => {
    const first = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    const err = await createEntry(ctx, scope, article('Two', { slug: { 'en-US': 'about' } })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain('about');
    expect((err as Error).message).toContain(first.entry.id);
  });

  it('leaves the value free once the holder is trashed', async () => {
    const { entry } = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    await trashEntry(ctx, scope, entry.id);
    // An editor who deleted "about" expects to be able to reuse it.
    await expect(
      createEntry(ctx, scope, article('Two', { slug: { 'en-US': 'about' } })),
    ).resolves.toBeTruthy();
  });

  it('refuses to restore an entry whose value was taken meanwhile', async () => {
    const { entry } = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    await trashEntry(ctx, scope, entry.id);
    await createEntry(ctx, scope, article('Two', { slug: { 'en-US': 'about' } }));

    // Silently restoring a duplicate slug would break front-end routing.
    await expect(restoreEntry(ctx, scope, entry.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets an entry keep its own value across an edit', async () => {
    const { entry } = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    await expect(
      updateEntry(ctx, scope, entry.id, {
        title: { 'en-US': 'One edited' },
        slug: { 'en-US': 'about' },
      }),
    ).resolves.toBeTruthy();
  });

  it('frees the old value when an entry changes it', async () => {
    const { entry } = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    await updateEntry(ctx, scope, entry.id, {
      title: { 'en-US': 'One' },
      slug: { 'en-US': 'about-us' },
    });
    await expect(
      createEntry(ctx, scope, article('Two', { slug: { 'en-US': 'about' } })),
    ).resolves.toBeTruthy();
  });

  it('does not treat "no value" as a value', async () => {
    // Otherwise one entry with an empty slug would block every other entry
    // from having one.
    await createEntry(ctx, scope, article('One'));
    await expect(createEntry(ctx, scope, article('Two'))).resolves.toBeTruthy();
  });

  it('compares per locale, so two locales may share a value', async () => {
    await seed({ unique: true, localized: true }, [], ['en-US', 'de-DE']);
    await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about', 'de-DE': 'about' } }));
    // The same string in a different locale is a different claim.
    const stored = await store.entries.get(scope, 'e-2');
    expect(stored).toBeTruthy();
  });

  it('scopes uniqueness to the content type', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
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
        {
          apiId: 'slug',
          name: 'Slug',
          type: 'Slug',
          localized: false,
          required: false,
          position: 1,
          unique: true,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, scope, 'page');

    await createEntry(ctx, scope, article('Post', { slug: { 'en-US': 'about' } }));
    // A post named "about" must not stop a page being named "about".
    await expect(
      createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: { title: { 'en-US': 'Page' }, slug: { 'en-US': 'about' } },
      }),
    ).resolves.toBeTruthy();
  });

  it('gives a duplicate a free value instead of failing', async () => {
    const { entry } = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    const copy = await duplicateEntry(ctx, scope, entry.id);
    expect(copy.fields.slug).toEqual({ 'en-US': 'about-2' });

    // And again, without stacking suffixes.
    const third = await duplicateEntry(ctx, scope, entry.id);
    expect(third.fields.slug).toEqual({ 'en-US': 'about-3' });
  });

  it('is refused on a field type where it could not mean anything', async () => {
    await expect(
      createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId: 'bad',
        name: 'Bad',
        displayField: 'body',
        fields: [
          {
            apiId: 'body',
            name: 'Body',
            type: 'RichText',
            localized: false,
            required: false,
            position: 0,
            unique: true,
          },
        ],
      } as Parameters<typeof createContentType>[3]),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('defaultValue', () => {
  it('fills a field the caller omitted', async () => {
    await seed({}, [{ apiId: 'status', name: 'Status', type: 'Symbol', defaultValue: 'review' }]);
    const { fields } = await createEntry(ctx, scope, article('One'));
    expect(fields.status).toEqual({ 'en-US': 'review' });
  });

  it('does not overwrite a value the caller sent', async () => {
    await seed({}, [{ apiId: 'status', name: 'Status', type: 'Symbol', defaultValue: 'review' }]);
    const { fields } = await createEntry(
      ctx,
      scope,
      article('One', { status: { 'en-US': 'done' } }),
    );
    expect(fields.status).toEqual({ 'en-US': 'done' });
  });

  it('is never applied on update, so a cleared field stays cleared', async () => {
    await seed({}, [{ apiId: 'status', name: 'Status', type: 'Symbol', defaultValue: 'review' }]);
    const { entry } = await createEntry(ctx, scope, article('One'));
    const updated = await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'One' } });
    expect(updated.fields.status).toBeUndefined();
  });

  it('fills every locale of a localized field', async () => {
    await seed(
      {},
      [
        {
          apiId: 'status',
          name: 'Status',
          type: 'Symbol',
          localized: true,
          defaultValue: 'review',
        },
      ],
      ['en-US', 'de-DE'],
    );
    const { fields } = await createEntry(ctx, scope, article('One'));
    expect(fields.status).toEqual({ 'en-US': 'review', 'de-DE': 'review' });
  });

  it('accepts a per-locale default map', async () => {
    await seed(
      {},
      [
        {
          apiId: 'status',
          name: 'Status',
          type: 'Symbol',
          localized: true,
          defaultValue: { 'en-US': 'review', 'de-DE': 'pruefung' },
        },
      ],
      ['en-US', 'de-DE'],
    );
    const { fields } = await createEntry(ctx, scope, article('One'));
    expect(fields.status).toEqual({ 'en-US': 'review', 'de-DE': 'pruefung' });
  });

  it('does not mistake a JSON default for a locale map', async () => {
    // `{ theme: 'dark' }` is the value, not a per-locale mapping — tearing it
    // apart would silently corrupt the default.
    await seed({}, [
      { apiId: 'config', name: 'Config', type: 'JSON', defaultValue: { theme: 'dark' } },
    ]);
    const { fields } = await createEntry(ctx, scope, article('One'));
    expect(fields.config).toEqual({ 'en-US': { theme: 'dark' } });
  });
});
