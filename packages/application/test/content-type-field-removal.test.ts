import { ConflictError, type FieldDefinition } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  publishContentType,
  publishEntry,
  purgeEntry,
  removedContentInUse,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const staging = { spaceId: 's1', environmentId: 'staging' };
let ctx: AppContext;
let store: InMemoryContentStore;

const f = (apiId: string, type: string, over: Partial<FieldDefinition> = {}) =>
  ({
    apiId,
    name: apiId,
    type,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const TITLE = f('title', 'Symbol', { required: true });
const TEASER = f('teaser', 'Text', { position: 1 });
const SEO = f('seo', 'Component', {
  position: 2,
  fields: [f('description', 'Text'), f('noindex', 'Boolean', { position: 1 })],
});
const SEO_SLIM = { ...SEO, fields: [f('noindex', 'Boolean', { position: 1 })] };

async function defineArticle(s = scope) {
  await createContentType(ctx, SYSTEM_CALLER, s, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [TITLE, TEASER, SEO],
  });
  await publishContentType(ctx, s, 'article');
}

const article = (title: string, more: Record<string, unknown> = {}) => ({
  contentTypeApiId: 'article',
  fields: {
    title: { 'en-US': title },
    ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, { 'en-US': v }])),
  },
});

const dropTeaser = () =>
  updateContentType(ctx, SYSTEM_CALLER, scope, 'article', { fields: [TITLE, SEO] });

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: 's1',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    environments: ['main', 'staging'],
  });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('id') };
  await defineArticle();
});

describe('removing a field', () => {
  it('is refused while an entry holds a value for it, naming the entry', async () => {
    const { entry } = await createEntry(ctx, scope, article('Home', { teaser: 'Short' }));
    const err = await dropTeaser().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain(`teaser (entry ${entry.id})`);
    expect((err as ConflictError).details).toEqual({
      fieldsInUse: [{ field: 'teaser', entries: [entry.id] }],
    });
    // The type is unchanged.
    const ct = await store.contentTypes.get(scope, 'article');
    expect(ct?.fields.map((x) => x.apiId)).toEqual(['title', 'teaser', 'seo']);
  });

  it('is refused for a nested field too', async () => {
    const { entry } = await createEntry(
      ctx,
      scope,
      article('Home', { seo: { description: 'About', noindex: false } }),
    );
    const err = await updateContentType(ctx, SYSTEM_CALLER, scope, 'article', {
      fields: [TITLE, TEASER, SEO_SLIM],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toEqual({
      fieldsInUse: [{ field: 'seo.description', entries: [entry.id] }],
    });
  });

  it('is allowed when no entry holds a value, or once the values are cleared', async () => {
    const { entry } = await createEntry(ctx, scope, article('Home', { teaser: 'Short' }));
    await createEntry(ctx, scope, article('Other'));
    await expect(dropTeaser()).rejects.toBeInstanceOf(ConflictError);
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'Home' } });
    const revised = await dropTeaser();
    expect(revised.fields.map((x) => x.apiId)).toEqual(['title', 'seo']);
  });

  it('still counts the published snapshot until the cleared draft is published', async () => {
    const { entry } = await createEntry(ctx, scope, article('Home', { teaser: 'Short' }));
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'Home' } });
    await expect(dropTeaser()).rejects.toThrow(entry.id);
    await publishEntry(ctx, scope, entry.id);
    await expect(dropTeaser()).resolves.toBeDefined();
  });

  it('counts an entry in the trash until it is purged', async () => {
    const { entry } = await createEntry(ctx, scope, article('Home', { teaser: 'Short' }));
    await trashEntry(ctx, scope, entry.id);
    await expect(dropTeaser()).rejects.toThrow(entry.id);
    await purgeEntry(ctx, scope, entry.id);
    await expect(dropTeaser()).resolves.toBeDefined();
  });

  it('ignores entries in another environment', async () => {
    await defineArticle(staging);
    await createEntry(ctx, staging, article('Staged', { teaser: 'Short' }));
    await expect(dropTeaser()).resolves.toBeDefined();
  });

  it('reads past the first page of entries', async () => {
    for (let i = 0; i < 120; i++) await createEntry(ctx, scope, article(`P${i}`));
    const { entry } = await createEntry(ctx, scope, article('Last', { teaser: 'Short' }));
    await expect(dropTeaser()).rejects.toThrow(entry.id);
  });

  it('finds nothing when a revision only adds a field', async () => {
    await createEntry(ctx, scope, article('Home', { teaser: 'Short' }));
    const current = await store.contentTypes.get(scope, 'article');
    expect(
      await removedContentInUse(ctx, scope, current!, {
        fields: [...current!.fields, f('kicker', 'Symbol', { position: 3 })],
      }),
    ).toEqual({ variantsInUse: [], fieldsInUse: [] });
  });
});
