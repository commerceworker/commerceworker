import {
  type AppContext,
  cloneEnvironment,
  createContentType,
  createEntry,
  createEnvironment,
  createMenu,
  createSpace,
  deleteContentType,
  deliveryReads,
  exportSnapshot,
  getContentType,
  getDeliveredMenu,
  getDeliveredSingleton,
  importSnapshot,
  listDeliveredRedirects,
  listDeliveredRoutes,
  listDeliveredSitemap,
  listPublishedEntries,
  mergeEnvironments,
  previewMenu,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  updateContentType,
  updateEntry,
} from '@commerceworker/application';
import type { ContentType, FieldDefinition, Scope } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * What Delivery serves while a live type has an unpublished revision, on D1: the definition as
 * last published, whatever the row's draft says. Each test makes its own space: the file shares
 * one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
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
const definition = { apiId: 'page', name: 'Page', displayField: 'title', fields };

/** A published `page` at `/{slug}` with one published entry, in a menu. */
async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `ct-draft-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Draft', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, { ...definition, urlPattern: '/{slug}' });
  await publishContentType(ctx, scope, 'page');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'page',
    fields: { title: { 'en-US': 'About' }, slug: { 'en-US': 'about' } },
  });
  await publishEntry(ctx, scope, entry.id);
  await createMenu(ctx, scope, {
    handle: 'main',
    name: 'Main',
    items: [{ id: 'about', link: { type: 'entry', entryId: entry.id } }],
  });
  return { ctx, scope };
}

/** What the store's upsert sent before 0030: a save by code that has never heard of the column. */
const saveAsOldCode = (scope: Scope, ct: ContentType) =>
  testDb
    .prepare(
      `INSERT INTO content_types
         (space_id, environment_id, api_id, name, display_field, fields, version, status,
          updated_at, url_pattern, singleton, published_singleton)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (space_id, environment_id, api_id) DO UPDATE SET
         name = excluded.name, display_field = excluded.display_field, fields = excluded.fields,
         version = excluded.version, status = excluded.status, updated_at = excluded.updated_at,
         url_pattern = excluded.url_pattern, singleton = excluded.singleton`,
    )
    .bind(
      scope.spaceId,
      scope.environmentId,
      ct.apiId,
      ct.name,
      ct.displayField,
      JSON.stringify(ct.fields),
      ct.version,
      ct.status,
      Date.now(),
      ct.urlPattern ?? null,
      ct.singleton ? 1 : 0,
      ct.status === 'published' && ct.singleton ? 1 : 0,
    )
    .run();

const kept = async (scope: Scope, apiId = 'page') => {
  const row = await testDb
    .prepare(
      'select published_definition as d from content_types where space_id = ? and environment_id = ? and api_id = ?',
    )
    .bind(scope.spaceId, scope.environmentId, apiId)
    .first<{ d: string | null }>();
  return row?.d ?? null;
};

const delivered = async (ctx: AppContext, scope: Scope, apiId = 'page') => {
  const { contentTypes = [] } = await deliveryReads(ctx).read(scope, { contentTypes: true });
  return contentTypes.find((t) => t.apiId === apiId);
};

const fieldIds = (ct: ContentType | undefined) => ct?.fields.map((f) => f.apiId);

describe('a draft revision of a live content type on D1', () => {
  it('leaves Delivery’s definition as last published', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      fields: [...fields, field('subtitle', 'Symbol', 2)],
    });
    const { contentTypes = [] } = await deliveryReads(ctx).read(scope, { contentTypes: true });
    expect(contentTypes.find((t) => t.apiId === 'page')?.fields.map((f) => f.apiId)).toEqual([
      'title',
      'slug',
    ]);
  });

  it('keeps the type in the routes', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Pages' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it('keeps the type’s entries in the sitemap', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Pages' });
    expect((await listDeliveredSitemap(ctx, scope)).items).toHaveLength(1);
  });

  it('keeps the entry’s URL in a menu', async () => {
    const { ctx, scope } = await harness();
    expect((await getDeliveredMenu(ctx, scope, 'main')).items[0]).toMatchObject({ url: '/about' });
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Pages' });
    expect((await getDeliveredMenu(ctx, scope, 'main')).items[0]).toMatchObject({ url: '/about' });
  });

  it('keeps serving the URL pattern as last published', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: '/pages/{slug}' });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });

  it('keeps a live target routed through a merge of the source’s draft', async () => {
    const { ctx, scope } = await harness();
    await createEnvironment(ctx, scope.spaceId, 'staging');
    const staging = { ...scope, environmentId: 'staging' };
    await createContentType(ctx, SYSTEM_CALLER, staging, { ...definition, urlPattern: '/{slug}' });
    await mergeEnvironments(ctx, scope.spaceId, 'staging', 'main', { contentTypes: ['page'] });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
  });
});

describe('writers that know nothing of the column', () => {
  const page: ContentType = {
    ...definition,
    urlPattern: '/{slug}',
    version: 1,
    status: 'published',
  };
  const withSubtitle = [...fields, field('subtitle', 'Symbol', 2)];
  const withBoth = [...withSubtitle, field('summary', 'Symbol', 3)];

  it('never serves an older definition after old code publishes and then saves a draft', async () => {
    const { ctx, scope } = await harness();
    // New code keeps v1 for a draft; old code publishes that draft, then saves one of its own.
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: withSubtitle });
    await saveAsOldCode(scope, { ...page, fields: withSubtitle, version: 2 });
    await saveAsOldCode(scope, { ...page, fields: withBoth, version: 3, status: 'draft' });

    const live = await delivered(ctx, scope);
    expect(fieldIds(live)).toEqual(['title', 'slug', 'subtitle']);
    expect(live).toMatchObject({ version: 2, status: 'published' });
  });

  it('keeps the published definition when old code saves the draft', async () => {
    const { ctx, scope } = await harness();
    await saveAsOldCode(scope, { ...page, fields: withSubtitle, version: 2, status: 'draft' });
    expect(fieldIds(await delivered(ctx, scope))).toEqual(['title', 'slug']);
    expect(await listDeliveredRoutes(ctx, scope)).toHaveLength(1);
  });

  it('clears the kept definition when old code publishes', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: withSubtitle });
    expect(await kept(scope)).not.toBeNull();
    await saveAsOldCode(scope, { ...page, fields: withSubtitle, version: 2 });
    expect(await kept(scope)).toBeNull();
    expect(fieldIds(await delivered(ctx, scope))).toEqual(['title', 'slug', 'subtitle']);
  });

  it('serves a published row over any copy left beside it', async () => {
    const { ctx, scope } = await harness();
    const stale = JSON.stringify({ name: 'Old', displayField: 'title', fields: [], version: 0 });
    await testDb
      .prepare(
        'update content_types set published_definition = ? where space_id = ? and api_id = ?',
      )
      .bind(stale, scope.spaceId, 'page')
      .run();
    expect(fieldIds(await delivered(ctx, scope))).toEqual(['title', 'slug']);

    // Nor does the next draft inherit it: leaving published keeps the row, not the leftover.
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: withSubtitle });
    expect(fieldIds(await delivered(ctx, scope))).toEqual(['title', 'slug']);
  });

  it('serves a draft from before the column as it stands, until its next publish', async () => {
    const { ctx, scope } = await harness();
    const legacy: ContentType = {
      ...page,
      apiId: 'legacy',
      fields: withSubtitle,
      version: 4,
      status: 'draft',
    };
    await saveAsOldCode(scope, legacy);
    expect(await kept(scope, 'legacy')).toBeNull();
    expect(await delivered(ctx, scope, 'legacy')).toMatchObject({ version: 4, status: 'draft' });
    expect(fieldIds(await delivered(ctx, scope, 'legacy'))).toEqual(['title', 'slug', 'subtitle']);
    expect((await listDeliveredRoutes(ctx, scope)).map((r) => r.contentType)).toEqual(['page']);

    await publishContentType(ctx, scope, 'legacy');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'legacy', { fields: withBoth });
    expect(fieldIds(await delivered(ctx, scope, 'legacy'))).toEqual(['title', 'slug', 'subtitle']);
  });
});

describe('the definition kept for a live type', () => {
  const subtitle = [...fields, field('subtitle', 'Symbol', 2)];

  it('stays the published one through later drafts, and goes with the publish', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { fields: subtitle });
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Pages' });
    expect(await delivered(ctx, scope)).toMatchObject({ name: 'Page', version: 1 });
    expect(fieldIds(await delivered(ctx, scope))).toEqual(['title', 'slug']);

    await publishContentType(ctx, scope, 'page');
    expect(await kept(scope)).toBeNull();
    expect(await delivered(ctx, scope)).toMatchObject({ name: 'Pages', version: 3 });
    expect(fieldIds(await delivered(ctx, scope))).toEqual(['title', 'slug', 'subtitle']);
  });

  it('leaves the Management read as the draft', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      fields: subtitle,
      urlPattern: '/pages/{slug}',
    });
    const working = await getContentType(ctx, scope, 'page');
    expect(working).toMatchObject({ status: 'draft', version: 2, urlPattern: '/pages/{slug}' });
    expect(fieldIds(working)).toEqual(['title', 'slug', 'subtitle']);
  });

  it('is what the store reports for it, and only for it', async () => {
    const { ctx, scope } = await harness();
    expect((await store.contentTypes.publishedDefinitions(scope)).size).toBe(0);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Pages' });
    const definitions = await store.contentTypes.publishedDefinitions(scope);
    expect(definitions.get('page')).toMatchObject({
      name: 'Page',
      displayField: 'title',
      urlPattern: '/{slug}',
      version: 1,
    });
    await publishContentType(ctx, scope, 'page');
    expect((await store.contentTypes.publishedDefinitions(scope)).size).toBe(0);
  });

  it('is written with its unit, and not by one that fails', async () => {
    const { ctx, scope } = await harness();
    const page = await getContentType(ctx, scope, 'page');
    await expect(
      store.withTransaction(async (tx) => {
        await tx.contentTypes.save(scope, { ...page, version: 2, status: 'draft' });
        await tx.contentTypes.guard(scope, 'page', { singleton: true });
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await kept(scope)).toBeNull();
    expect((await getContentType(ctx, scope, 'page')).status).toBe('published');
  });

  it('holds a guard over a saved draft', async () => {
    const { ctx, scope } = await harness();
    const page = await getContentType(ctx, scope, 'page');
    await store.withTransaction(async (tx) => {
      await tx.contentTypes.guard(scope, 'page', { singleton: false });
      await tx.contentTypes.save(scope, { ...page, version: 2, status: 'draft' });
      await tx.contentTypes.guard(scope, 'page', { singleton: false });
    });
    expect(await kept(scope)).not.toBeNull();
  });

  it('belongs to its environment', async () => {
    const { ctx, scope } = await harness();
    await createEnvironment(ctx, scope.spaceId, 'staging');
    const staging = { ...scope, environmentId: 'staging' };
    await createContentType(ctx, SYSTEM_CALLER, staging, {
      ...definition,
      urlPattern: '/s/{slug}',
    });
    await publishContentType(ctx, staging, 'page');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { name: 'Pages' });
    expect(await kept(staging)).toBeNull();
    expect((await delivered(ctx, staging))?.urlPattern).toBe('/s/{slug}');
  });

  it('goes with the type, so a new type of the name starts clean', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, { ...definition, apiId: 'note' });
    await publishContentType(ctx, scope, 'note');
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'note', { name: 'Notes' });
    expect(await kept(scope, 'note')).not.toBeNull();
    await deleteContentType(ctx, scope, 'note');
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      ...definition,
      apiId: 'note',
      name: 'Fresh',
    });
    expect(await kept(scope, 'note')).toBeNull();
    expect(await delivered(ctx, scope, 'note')).toMatchObject({ name: 'Fresh', status: 'draft' });
  });

  it('goes with its environment', async () => {
    const { ctx, scope } = await harness();
    const clock = ctx.clock;
    const env = `gone-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, scope.spaceId, env);
    const gone = { ...scope, environmentId: env };
    await createContentType(ctx, SYSTEM_CALLER, gone, definition);
    await publishContentType(ctx, gone, 'page');
    await updateContentType(ctx, SYSTEM_CALLER, gone, 'page', { name: 'Pages' });
    expect(await kept(gone)).not.toBeNull();
    await store.spaces.deleteEnvironment(scope.spaceId, env, [], {
      id: uid(),
      spaceId: scope.spaceId,
      environmentId: env,
      at: clock.now().toISOString(),
      actor: 'test',
      action: 'environment.deleted',
      status: 200,
    });
    while ((await store.spaces.purgeEnvironmentStep(scope.spaceId, env, 500, clock.now())) > 0) {}
    const left = await testDb
      .prepare('select count(*) as n from content_types where space_id = ? and environment_id = ?')
      .bind(scope.spaceId, env)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('is replaced by a published merge, and kept through a draft one', async () => {
    const { ctx, scope } = await harness();
    await createEnvironment(ctx, scope.spaceId, 'staging');
    const staging = { ...scope, environmentId: 'staging' };
    await createContentType(ctx, SYSTEM_CALLER, staging, {
      ...definition,
      urlPattern: '/s/{slug}',
    });
    await mergeEnvironments(ctx, scope.spaceId, 'staging', 'main', { contentTypes: ['page'] });
    expect((await delivered(ctx, scope))?.urlPattern).toBe('/{slug}');

    await publishContentType(ctx, staging, 'page');
    await mergeEnvironments(ctx, scope.spaceId, 'staging', 'main', { contentTypes: ['page'] });
    expect(await kept(scope)).toBeNull();
    expect((await delivered(ctx, scope))?.urlPattern).toBe('/s/{slug}');
  });
});

describe('what else Delivery reads through the published view', () => {
  it('answers a singleton by the definition as last published', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      ...definition,
      apiId: 'home',
      singleton: true,
    });
    await publishContentType(ctx, scope, 'home');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'home',
      fields: { title: { 'en-US': 'Home' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'home', { singleton: false, name: 'Homes' });

    expect((await getDeliveredSingleton(ctx, scope, 'home')).id).toBe(entry.id);
    const { singleton } = await deliveryReads(ctx).read(scope, {
      singleton: { contentType: 'home' },
    });
    expect(singleton?.contentType).toMatchObject({
      name: 'Page',
      singleton: true,
      status: 'published',
    });
  });

  it('answers a reference filter by the links as last published', async () => {
    const { ctx, scope } = await harness();
    const link = { ...field('author', 'Link', 1), linkType: 'Entry' } as FieldDefinition;
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'post',
      name: 'Post',
      displayField: 'title',
      fields: [field('title', 'Symbol', 0), link],
    });
    await publishContentType(ctx, scope, 'post');
    const { entry: ann } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Ann' }, slug: { 'en-US': 'ann' } },
    });
    await publishEntry(ctx, scope, ann.id);
    const { entry: post } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'By Ann' },
        author: { 'en-US': { id: ann.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, post.id);
    const query = {
      contentTypeApiId: 'post',
      // In an OR, so the engine answers it from the model rather than the edges alone.
      where: {
        or: [
          { field: 'author', op: 'ref' as const, value: ann.id },
          { field: 'title', op: 'eq' as const, value: 'nobody' },
        ],
      },
    };
    const ids = async () => (await listPublishedEntries(ctx, scope, query)).map((e) => e.id);
    expect(await ids()).toEqual([post.id]);

    await updateContentType(ctx, SYSTEM_CALLER, scope, 'post', {
      fields: [field('title', 'Symbol', 0), field('author', 'Symbol', 1)],
    });
    expect(await ids()).toEqual([post.id]);
  });

  it('moves a slug by the URL pattern Delivery serves, not the draft’s', async () => {
    const { ctx, scope } = await harness();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Team' }, slug: { 'en-US': 'team' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: '/pages/{slug}' });
    await updateEntry(ctx, scope, entry.id, {
      title: { 'en-US': 'Team' },
      slug: { 'en-US': 'people' },
    });
    await publishEntry(ctx, scope, entry.id);
    expect(
      (await listDeliveredRedirects(ctx, scope)).map((r) => [r.source, r.destination]),
    ).toEqual([['/team', '/people']]);
  });

  it('previews a menu as Delivery resolves it', async () => {
    const { ctx, scope } = await harness();
    const menu = (await store.menus.all(scope))[0];
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', { urlPattern: '/pages/{slug}' });
    expect((await previewMenu(ctx, scope, menu?.id ?? '')).items[0]).toMatchObject({
      url: '/about',
      status: 'live',
    });
  });
});

describe('copying a live type with a draft', () => {
  const subtitle = [...fields, field('subtitle', 'Symbol', 2)];

  async function source() {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      fields: subtitle,
      urlPattern: '/p/{slug}',
    });
    const target = { ...scope, environmentId: `copy-${uid().slice(0, 8)}` };
    await createEnvironment(ctx, scope.spaceId, target.environmentId);
    return { ctx, scope, target };
  }

  const expectLiveWithDraft = async (ctx: AppContext, target: Scope) => {
    expect(await listDeliveredRoutes(ctx, target)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
    expect(fieldIds(await delivered(ctx, target))).toEqual(['title', 'slug']);
    const working = await getContentType(ctx, target, 'page');
    expect(working).toMatchObject({ status: 'draft', urlPattern: '/p/{slug}' });
    expect(fieldIds(working)).toEqual(['title', 'slug', 'subtitle']);
  };

  it('keeps both definitions through a clone', async () => {
    const { ctx, scope, target } = await source();
    await cloneEnvironment(ctx, scope, target);
    await expectLiveWithDraft(ctx, target);
  });

  it('keeps both definitions through a snapshot', async () => {
    const { ctx, scope, target } = await source();
    const snapshot = JSON.parse(JSON.stringify(await exportSnapshot(ctx, scope)));
    await importSnapshot(ctx, target, snapshot);
    await expectLiveWithDraft(ctx, target);
  });

  it('restores a snapshot from before these were kept as a plain draft', async () => {
    const { ctx, scope, target } = await source();
    const snapshot = await exportSnapshot(ctx, scope);
    await importSnapshot(ctx, target, {
      ...snapshot,
      contentTypes: snapshot.contentTypes.map(({ published: _old, ...ct }) => ct),
    });
    expect(await getContentType(ctx, target, 'page')).toMatchObject({ status: 'draft' });
    expect(await kept(target)).toBeNull();
    expect(await listDeliveredRoutes(ctx, target)).toEqual([]);
  });
});

describe('the published view on D1', () => {
  it('holds no admin-only details', async () => {
    const { ctx, scope } = await harness();
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      group: 'Site',
      description: 'Pages',
      icon: 'file',
    });
    await publishContentType(ctx, scope, 'page');
    const live = await delivered(ctx, scope);
    for (const key of ['group', 'description', 'icon', 'layout']) {
      expect(live).not.toHaveProperty(key);
    }
  });
});

/**
 * A replica behind the migration: every statement naming the column fails as D1 fails it, because
 * the name is rewritten to one the database truly lacks. Only reads go through this.
 */
const replicaBehind0030 = (target: D1Database): D1Database => {
  const lag = (sql: string) => sql.replaceAll('published_definition', 'published_definition_lag');
  return new Proxy(target, {
    get(t, key) {
      if (key === 'prepare') return (sql: string) => t.prepare(lag(sql));
      const value = Reflect.get(t, key, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
};

describe('a read replica that hasn’t reached 0030', () => {
  it('answers Delivery’s read as a database with nothing kept', async () => {
    const { ctx, scope } = await harness();
    const lagging = createD1Store(replicaBehind0030(testDb));
    const reads = deliveryReads({ ...ctx, store: lagging });
    const { contentTypes = [], config } = await reads.read(scope, {
      contentTypes: true,
      config: true,
    });
    expect(config).toBeTruthy();
    expect(contentTypes.find((t) => t.apiId === 'page')).toMatchObject({
      urlPattern: '/{slug}',
      status: 'published',
    });
  });

  it('answers a lone read of the types, and a singleton read', async () => {
    const { ctx, scope } = await harness();
    const lagging = createD1Store(replicaBehind0030(testDb));
    expect(await listDeliveredRoutes({ ...ctx, store: lagging }, scope)).toEqual([
      { contentType: 'page', urlPattern: '/{slug}' },
    ]);
    const { singleton } = await lagging.delivery.read(scope, {
      singleton: { contentType: 'page' },
    });
    expect(singleton?.contentType).toMatchObject({ apiId: 'page' });
  });

  it('reports nothing kept', async () => {
    const { scope } = await harness();
    const lagging = createD1Store(replicaBehind0030(testDb));
    expect((await lagging.contentTypes.publishedDefinitions(scope)).size).toBe(0);
  });

  it('still surfaces a missing column that isn’t the kept definition', async () => {
    const { scope } = await harness();
    // Qualified, or SQLite reads the name as a string. Only the statement that names the kept
    // definition breaks, so a check that retried on any missing column would succeed, not reject.
    const broken = new Proxy(testDb, {
      get(t, key) {
        if (key === 'prepare') {
          return (sql: string) =>
            t.prepare(
              sql.includes('published_definition')
                ? sql.replaceAll(
                    '"published_singleton"',
                    '"content_types"."published_singleton_gone"',
                  )
                : sql,
            );
        }
        const value = Reflect.get(t, key, t);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
    const refused = await createD1Store(broken)
      .delivery.read(scope, { contentTypes: true })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).cause)).toContain('no such column');
    expect(String((refused as Error).cause)).toContain('published_singleton_gone');
  });
});
