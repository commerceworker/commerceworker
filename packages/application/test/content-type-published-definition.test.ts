import {
  ConflictError,
  type FieldDefinition,
  type Principal,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneEnvironment,
  contentTypeDependents,
  createContentType,
  createEntry,
  createEnvironment,
  createMenu,
  deleteContentType,
  deliveryReads,
  exportSnapshot,
  getContentType,
  importSnapshot,
  listDeliveredRedirects,
  listDeliveredRoutes,
  listPublishedEntries,
  mergeEnvironments,
  previewMenu,
  publishContentType,
  publishEntry,
  requestPromotion,
  SYSTEM_CALLER,
  updateContentType,
  updateEntry,
  writeSnapshotModel,
} from '../src';

/** The test-kit's half of 0030_published_definition; `packages/store/test` holds D1 to the same. */
const scope = { spaceId: 's1', environmentId: 'main' };
const promoter: Principal = {
  spaceId: 's1',
  kind: 'user',
  subject: 'ada',
  scopes: [SCOPES.contentPublish],
};
const copy = { spaceId: 's1', environmentId: 'copy' };

const field = (
  apiId: string,
  type: FieldDefinition['type'],
  position: number,
): FieldDefinition => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});
const fields = [field('title', 'Symbol', 0), field('slug', 'Slug', 1)];
const subtitle = [...fields, field('subtitle', 'Symbol', 2)];

let store: InMemoryContentStore;
let ctx: AppContext;

const delivered = async (at = scope) =>
  ((await deliveryReads(ctx).read(at, { contentTypes: true })).contentTypes ?? []).find(
    (t) => t.apiId === 'page',
  );
const events = () => store.allEvents().filter((e) => e.type.startsWith('content_type.'));

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('p') };
  await createEnvironment(ctx, 's1', 'copy');
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    urlPattern: '/{slug}',
    fields,
  });
  await publishContentType(ctx, scope, 'page');
});

describe('a draft revision of a live type', () => {
  it('changes nothing Delivery serves, so it announces nothing', async () => {
    const before = events().length;
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      fields: subtitle,
      urlPattern: '/p/{slug}',
    });
    expect(events()).toHaveLength(before);
    expect(await delivered()).toMatchObject({
      name: 'Page',
      urlPattern: '/{slug}',
      version: 1,
      status: 'published',
    });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it('reaches Delivery with its publish, which announces it', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: '/p/{slug}' });
    const before = events().length;
    await publishContentType(ctx, scope, 'page');
    expect(events()).toHaveLength(before + 1);
    expect(await delivered()).toMatchObject({ urlPattern: '/p/{slug}', version: 2 });
    expect((await store.contentTypes.publishedDefinitions(scope)).size).toBe(0);
  });

  it('stays the draft on a Management read', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: '/p/{slug}' });
    expect(await getContentType(ctx, scope, 'page')).toMatchObject({
      urlPattern: '/p/{slug}',
      version: 2,
      status: 'draft',
    });
  });

  it('keeps the first published definition through later drafts', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Two' });
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Three' });
    expect(await delivered()).toMatchObject({ name: 'Page', version: 1 });
  });

  it('rolls back with a failed unit', async () => {
    const page = await getContentType(ctx, scope, 'page');
    await expect(
      store.withTransaction(async (tx) => {
        await tx.contentTypes.save(scope, { ...page, version: 2, status: 'draft' });
        throw new Error('lost');
      }),
    ).rejects.toThrow('lost');
    expect((await store.contentTypes.publishedDefinitions(scope)).size).toBe(0);
  });

  it('goes with the type', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields,
    });
    await publishContentType(ctx, scope, 'note');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { name: 'Two' });
    expect((await store.contentTypes.publishedDefinitions(scope)).has('note')).toBe(true);
    await deleteContentType(ctx, scope, 'note');
    expect((await store.contentTypes.publishedDefinitions(scope)).has('note')).toBe(false);
  });

  it('holds a delete back by the URL pattern Delivery serves, though a draft cleared it', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: null });
    expect((await contentTypeDependents(ctx, scope, 'page')).urlPattern).toBe('/{slug}');
    await expect(deleteContentType(ctx, scope, 'page')).rejects.toBeInstanceOf(ConflictError);
  });

  it('is kept per environment', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Two' });
    expect((await store.contentTypes.publishedDefinitions(copy)).size).toBe(0);
  });

  it('survives a merge of a draft, and yields to a merge of a published type', async () => {
    await createContentType(ctx, SYSTEM_CALLER, copy, {
      apiId: 'page',
      name: 'Other',
      displayField: 'title',
      urlPattern: '/o/{slug}',
      fields,
    });
    await mergeEnvironments(ctx, 's1', 'copy', 'main', { contentTypes: ['page'] });
    expect(await delivered()).toMatchObject({ name: 'Page', urlPattern: '/{slug}' });

    await publishContentType(ctx, copy, 'page');
    await mergeEnvironments(ctx, 's1', 'copy', 'main', { contentTypes: ['page'] });
    expect(await delivered()).toMatchObject({ name: 'Other', urlPattern: '/o/{slug}' });
  });
});

describe('a type that was never published', () => {
  it('is delivered as it stands, status draft, out of the routes', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'event',
      name: 'Event',
      displayField: 'title',
      urlPattern: '/e/{slug}',
      fields,
    });
    const { contentTypes = [] } = await deliveryReads(ctx).read(scope, { contentTypes: true });
    expect(contentTypes.find((t) => t.apiId === 'event')).toMatchObject({
      status: 'draft',
      urlPattern: '/e/{slug}',
    });
    expect((await listDeliveredRoutes(ctx, scope)).map((r) => r.contentType)).toEqual(['page']);
  });
});

describe('Management reads that say what Delivery does', () => {
  async function published(slug: string) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': slug }, slug: { 'en-US': slug } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  }

  it('answers a reference filter by the links as last published', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [
        field('title', 'Symbol', 0),
        { ...field('author', 'Link', 1), linkType: 'Entry' } as FieldDefinition,
      ],
    });
    await publishContentType(ctx, scope, 'post');
    const ann = await published('ann');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { author: { 'en-US': { id: ann, linkType: 'Entry' } } },
    });
    await publishEntry(ctx, scope, entry.id);
    const query = {
      contentTypeApiId: 'post',
      filters: [{ field: 'author', op: 'ref' as const, value: ann }],
    };
    const ids = async () => (await listPublishedEntries(ctx, scope, query)).map((e) => e.id);
    expect(await ids()).toEqual([entry.id]);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'post', {
      fields: [field('title', 'Symbol', 0), field('author', 'Symbol', 1)],
    });
    expect(await ids()).toEqual([entry.id]);
  });

  it('moves a slug by the published URL pattern while a draft has another', async () => {
    const id = await published('team');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: '/p/{slug}' });
    await updateEntry(ctx, scope, id, {
      title: { 'en-US': 'team' },
      slug: { 'en-US': 'people' },
    });
    await publishEntry(ctx, scope, id);
    expect(
      (await listDeliveredRedirects(ctx, scope)).map((r) => [r.source, r.destination]),
    ).toEqual([['/team', '/people']]);
  });

  it('moves no slug for a type with nothing kept and no pattern', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields,
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'a' }, slug: { 'en-US': 'a' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'a' }, slug: { 'en-US': 'b' } });
    await publishEntry(ctx, scope, entry.id);
    expect(await listDeliveredRedirects(ctx, scope)).toEqual([]);
  });

  it('previews a menu item of a live type as live through a draft', async () => {
    const id = await published('about');
    const menu = await createMenu(ctx, scope, {
      handle: 'main',
      name: 'Main',
      items: [{ id: 'about', link: { type: 'entry', entryId: id } }],
    });
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Two' });
    expect((await previewMenu(ctx, scope, menu.id)).items[0]).toMatchObject({
      status: 'live',
      url: '/about',
    });
  });
});

describe('copying a live type with a draft', () => {
  beforeEach(async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      fields: subtitle,
      urlPattern: '/p/{slug}',
    });
  });

  const expectBoth = async () => {
    expect(await delivered(copy)).toMatchObject({ urlPattern: '/{slug}', status: 'published' });
    expect((await delivered(copy))?.fields.map((f) => f.apiId)).toEqual(['title', 'slug']);
    const working = await getContentType(ctx, copy, 'page');
    expect(working).toMatchObject({ urlPattern: '/p/{slug}', status: 'draft' });
    expect(working.fields.map((f) => f.apiId)).toEqual(['title', 'slug', 'subtitle']);
  };

  it('carries the published definition in the snapshot', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    expect(snapshot.contentTypes[0]?.published).toMatchObject({
      urlPattern: '/{slug}',
      version: 1,
    });
    expect(snapshot.snapshotVersion).toBe(1);
  });

  it('leaves a type with no draft as it was in the snapshot', async () => {
    await publishContentType(ctx, scope, 'page');
    expect((await exportSnapshot(ctx, scope)).contentTypes[0]).not.toHaveProperty('published');
  });

  it('restores both through an import', async () => {
    await importSnapshot(ctx, copy, await exportSnapshot(ctx, scope));
    await expectBoth();
  });

  it('restores both through a clone', async () => {
    await cloneEnvironment(ctx, scope, copy);
    await expectBoth();
  });

  it('writes the model again without going back through the published definition', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    await importSnapshot(ctx, copy, snapshot);
    await createEntry(ctx, copy, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'a' }, subtitle: { 'en-US': 'held' } },
    });
    await writeSnapshotModel(ctx, copy, snapshot, []);
    await expectBoth();
  });

  it('restores the published singleton flag', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'home',
      name: 'Home',
      displayField: 'title',
      fields,
      singleton: true,
    });
    await publishContentType(ctx, scope, 'home');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'home', { singleton: false });
    await cloneEnvironment(ctx, scope, copy);
    const { contentTypes = [] } = await deliveryReads(ctx).read(copy, { contentTypes: true });
    expect(contentTypes.find((t) => t.apiId === 'home')?.singleton).toBe(true);
    expect((await getContentType(ctx, copy, 'home')).singleton).toBeUndefined();
  });

  it('restores a snapshot written before these were kept, as a plain draft', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    await importSnapshot(ctx, copy, {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map(({ published: _old, ...ct }) => ct),
    });
    expect(await getContentType(ctx, copy, 'page')).toMatchObject({ status: 'draft' });
    expect((await store.contentTypes.publishedDefinitions(copy)).size).toBe(0);
    expect(await listDeliveredRoutes(ctx, copy)).toEqual([]);
  });
});

describe('a clone of a draft that cleared the URL pattern', () => {
  it('keeps the draft’s clearing, though the draft dropped the slug too', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      urlPattern: null,
      fields: [field('title', 'Symbol', 0)],
    });
    await cloneEnvironment(ctx, scope, copy);
    const working = await getContentType(ctx, copy, 'page');
    expect(working.urlPattern).toBeUndefined();
    expect(working.fields.map((f) => f.apiId)).toEqual(['title']);
    expect(await delivered(copy)).toMatchObject({ urlPattern: '/{slug}', status: 'published' });
  });

  it('keeps the draft’s clearing when the slug stays', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: null });
    await cloneEnvironment(ctx, scope, copy);
    expect((await getContentType(ctx, copy, 'page')).urlPattern).toBeUndefined();
  });
});

describe('a saved menu’s links', () => {
  async function published() {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'a' }, slug: { 'en-US': 'a' } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  }
  const menuOf = (entryId: string) =>
    createMenu(ctx, scope, {
      handle: 'main',
      name: 'Main',
      items: [{ id: 'a', link: { type: 'entry', entryId } }],
    });

  it('takes an entry of a live type whose draft cleared the pattern Delivery still serves', async () => {
    const id = await published();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: null });
    const menu = await menuOf(id);
    expect((await previewMenu(ctx, scope, menu.id)).items[0]).toMatchObject({
      status: 'live',
      url: '/a',
    });
  });

  it('takes a pattern only a draft has, and the preview says Delivery has no URL yet', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields,
    });
    await publishContentType(ctx, scope, 'note');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'n' }, slug: { 'en-US': 'n' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { urlPattern: '/n/{slug}' });
    const menu = await menuOf(entry.id);
    expect((await previewMenu(ctx, scope, menu.id)).items[0]).toMatchObject({ status: 'no_url' });
  });

  it('takes an entry of a never-published draft with a pattern', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'event',
      name: 'Event',
      displayField: 'title',
      urlPattern: '/e/{slug}',
      fields,
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'event',
      fields: { title: { 'en-US': 'e' }, slug: { 'en-US': 'e' } },
    });
    await expect(menuOf(entry.id)).resolves.toMatchObject({ handle: 'main' });
  });

  it('still refuses an entry of a type with no pattern anywhere', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields,
    });
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'n' }, slug: { 'en-US': 'n' } },
    });
    await expect(menuOf(entry.id)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the delete check when the kept definition has no pattern', () => {
  it('ignores a pattern only the draft has: Delivery doesn’t route it', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields,
    });
    await publishContentType(ctx, scope, 'note');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { urlPattern: '/n/{slug}' });
    expect((await contentTypeDependents(ctx, scope, 'note')).urlPattern).toBeUndefined();
    await deleteContentType(ctx, scope, 'note');
    expect(await store.contentTypes.get(scope, 'note')).toBeNull();
  });

  it('still counts a never-published draft’s pattern', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'event',
      name: 'Event',
      displayField: 'title',
      urlPattern: '/e/{slug}',
      fields,
    });
    expect((await contentTypeDependents(ctx, scope, 'event')).urlPattern).toBe('/e/{slug}');
  });
});

describe('the published view’s shape', () => {
  it('leaves out the admin-only details, as D1 does', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      group: 'Site',
      description: 'Pages',
      icon: 'file',
      layout: { tabs: [{ apiId: 'main', name: 'Main', groups: [] }] },
    });
    await publishContentType(ctx, scope, 'page');
    const live = await delivered();
    for (const key of ['group', 'description', 'icon', 'layout']) {
      expect(live).not.toHaveProperty(key);
    }
  });
});

describe('a promotion over a target with a draft', () => {
  const secret = [...fields, field('secret', 'Symbol', 2)];

  it('names a field the promotion removes that the target still serves', async () => {
    // The target serves `secret`; its own draft already dropped it, so that draft alone shows no risk.
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: secret });
    await publishContentType(ctx, scope, 'page');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields });
    await createContentType(ctx, SYSTEM_CALLER, copy, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      urlPattern: '/{slug}',
      fields,
    });
    await publishContentType(ctx, copy, 'page');
    const { risk } = await requestPromotion(ctx, promoter, 's1', {
      source: 'copy',
      target: 'main',
      contentTypes: ['page'],
    });
    expect(risk.reasons.join('\n')).toContain('removes the field "secret"');
  });

  it('says nothing of it when what arrives is a draft, which changes nothing served', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: secret });
    await publishContentType(ctx, scope, 'page');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields });
    await createContentType(ctx, SYSTEM_CALLER, copy, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      urlPattern: '/{slug}',
      fields,
    });
    const { risk } = await requestPromotion(ctx, promoter, 's1', {
      source: 'copy',
      target: 'main',
      contentTypes: ['page'],
    });
    expect(risk.reasons.join('\n')).not.toContain('secret');
  });
});

describe('a snapshot of a draft the write path would take', () => {
  // `tier`'s rule reads `rating` as a number. A revision that retypes `rating` leaves the rule alone
  // and is accepted, as it would not be on a type defined from nothing.
  const tier = {
    ...field('tier', 'Symbol', 3),
    rules: [{ action: 'hide', when: { field: 'rating', operator: 'gt', value: 3 } }],
  } as FieldDefinition;
  const ruled = [...fields, field('rating', 'Integer', 2), tier];
  const retyped = [...fields, field('rating', 'Symbol', 2), tier];

  beforeEach(async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: ruled });
    await publishContentType(ctx, scope, 'page');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: retyped });
  });

  it('passes a dry run, and imports both definitions', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    await importSnapshot(ctx, copy, snapshot, { dryRun: true });
    await importSnapshot(ctx, copy, snapshot);
    const types = async (at: typeof scope) => [
      (await delivered(at))?.fields.find((f) => f.apiId === 'rating')?.type,
      (await getContentType(ctx, at, 'page')).fields.find((f) => f.apiId === 'rating')?.type,
    ];
    expect(await types(copy)).toEqual(['Integer', 'Symbol']);
    expect(await types(copy)).toEqual(await types(scope));
  });

  it('clones', async () => {
    await cloneEnvironment(ctx, scope, copy);
    expect((await delivered(copy))?.status).toBe('published');
    expect((await getContentType(ctx, copy, 'page')).status).toBe('draft');
  });

  it('drops the rule from the copy’s draft, as normalizing any snapshot drops an unusable one', async () => {
    await importSnapshot(ctx, copy, await exportSnapshot(ctx, scope));
    const tierOf = (ct: { fields: readonly FieldDefinition[] } | undefined) =>
      ct?.fields.find((f) => f.apiId === 'tier');
    expect(tierOf(await delivered(copy))?.rules).toHaveLength(1);
    expect(tierOf(await getContentType(ctx, copy, 'page'))).not.toHaveProperty('rules');
    expect(tierOf(await getContentType(ctx, scope, 'page'))?.rules).toHaveLength(1);
  });
});

describe('a snapshot with a definition that can’t be written', () => {
  const crafted: FieldDefinition[] = [
    ...fields,
    {
      ...field('body', 'Array', 2),
      items: {
        type: 'Component',
        variants: [
          { apiId: 'hero', name: 'Hero', fields: [] },
          { apiId: 'hero', name: 'Twice', fields: [] },
        ],
      },
    } as FieldDefinition,
  ];

  it('refuses a bad block in the type, writing nothing', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    const bad = {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map((ct) => ({ ...ct, fields: crafted })),
    };
    const refused = await importSnapshot(ctx, copy, bad).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((refused as ValidationError).issues)).toContain('page');
    expect(await store.contentTypes.list(copy)).toEqual([]);
  });

  it('refuses a bad block in the published definition, writing nothing', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Two' });
    const snapshot = await exportSnapshot(ctx, scope);
    const bad = {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map((ct) =>
        ct.published ? { ...ct, published: { ...ct.published, fields: crafted } } : ct,
      ),
    };
    await expect(importSnapshot(ctx, copy, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(await store.contentTypes.list(copy)).toEqual([]);
  });

  it('refuses a bad block in the draft over a good published definition', async () => {
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Two' });
    const snapshot = await exportSnapshot(ctx, scope);
    const bad = {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map((ct) => ({ ...ct, fields: crafted })),
    };
    await expect(importSnapshot(ctx, copy, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(await store.contentTypes.list(copy)).toEqual([]);
  });

  it('ignores `published` on a published row, as the write does', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    const stray = {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map((ct) => ({
        ...ct,
        published: { name: 'x', displayField: 'title', fields: crafted, version: 1 },
      })),
    };
    await importSnapshot(ctx, copy, stray);
    expect((await delivered(copy))?.fields.map((f) => f.apiId)).toEqual(['title', 'slug']);
  });

  it('reports it on a dry run', async () => {
    const snapshot = await exportSnapshot(ctx, scope);
    const bad = {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map((ct) => ({ ...ct, fields: crafted })),
    };
    await expect(importSnapshot(ctx, copy, bad, { dryRun: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await store.contentTypes.list(copy)).toEqual([]);
  });
});
