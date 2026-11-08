import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createMenu,
  createSpace,
  createTag,
  deleteMenu,
  getDeliveredMenu,
  getMenu,
  listMenus,
  moveMenuItem,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
  updateMenu,
} from '@commerceworker/application';
import { ConflictError, type FieldDefinition, type Menu } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Menus on D1 (0020_menus): the item tree stored whole, one menu per handle, the revision's
 * compare-and-set refusing a lost race at commit, Delivery's one-batch read of a menu and what its
 * links name (past the 100-parameter cap), and the table cleared with its environment. Each test
 * makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-01-01T00:00:00.000Z';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

async function harness() {
  const clock = new FixedClock(new Date(AT));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `menus-${uid()}`;
  await createSpace(ctx, {
    spaceId,
    name: 'Menus',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
  });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    urlPattern: '/{slug}',
    fields: [
      field({ apiId: 'title', type: 'Symbol', localized: true }),
      field({ apiId: 'slug', type: 'Slug', position: 1 }),
    ],
  });
  await publishContentType(ctx, scope, 'page');
  const page = async (slug: string, publish = true) => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': `Title ${slug}`, de: `Titel ${slug}` }, slug: { 'en-US': slug } },
    });
    if (publish) await publishEntry(ctx, scope, entry.id);
    return entry.id;
  };
  return { ctx, clock, spaceId, scope, page };
}

describe('menus on D1', () => {
  it('stores the item tree whole and reads it back, by handle', async () => {
    const { ctx, scope, page } = await harness();
    const about = await page('about');
    const created = await createMenu(ctx, scope, {
      handle: 'main',
      name: 'Main',
      description: 'Header navigation',
      items: [
        {
          label: 'Docs',
          link: { type: 'url', url: '/docs' },
          target: '_blank',
          attrs: { rel: 'noopener', 'data-nav': 'docs' },
          children: [{ link: { type: 'entry', entryId: about } }],
        },
      ],
    });
    await createMenu(ctx, scope, { handle: 'footer', name: 'Footer' });
    expect(await getMenu(ctx, scope, created.id)).toEqual(created);
    expect(await store.menus.getByHandle(scope, 'main')).toEqual(created);
    expect((await listMenus(ctx, scope)).map((m) => [m.handle, m.itemCount])).toEqual([
      ['footer', 0],
      ['main', 2],
    ]);
  });

  it('holds one menu per handle, and keeps each environment’s menus to itself', async () => {
    const { ctx, spaceId, scope } = await harness();
    const main = await createMenu(ctx, scope, { handle: 'main', name: 'Main' });
    const other: Menu = { ...main, id: uid() };
    await expect(store.menus.save(scope, other)).rejects.toBeInstanceOf(ConflictError);
    await createEnvironment(ctx, spaceId, 'staging');
    const staging = { spaceId, environmentId: 'staging' };
    await createMenu(ctx, staging, { handle: 'main', name: 'Staging main' });
    expect((await store.menus.all(staging)).map((m) => m.name)).toEqual(['Staging main']);
    expect(await store.menus.get(staging, main.id)).toBeNull();
  });

  it('refuses a save at a revision someone moved past, at commit and alone', async () => {
    const { ctx, scope } = await harness();
    const menu = await createMenu(ctx, scope, { handle: 'main', name: 'Main' });
    const saved = await updateMenu(ctx, scope, menu.id, { name: 'Renamed', revision: 1 });
    expect(saved.revision).toBe(2);
    // A writer that read revision 1 loses inside a unit…
    await expect(
      store.withTransaction(async (tx) => {
        await tx.menus.save(scope, { ...menu, name: 'Stale', revision: 2 }, 1);
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    // …and outside one.
    await expect(store.menus.delete(scope, menu.id, 1)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    // The use-case says so plainly when the caller named its revision.
    await expect(
      updateMenu(ctx, scope, menu.id, { name: 'x', revision: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await getMenu(ctx, scope, menu.id)).name).toBe('Renamed');
    await deleteMenu(ctx, scope, menu.id, 2);
    expect(await store.menus.get(scope, menu.id)).toBeNull();
  });

  it('reads a menu and its published links in one batch, past the parameter cap', async () => {
    const { ctx, scope, page } = await harness();
    const ids: string[] = [];
    for (let i = 0; i < 110; i++) ids.push(await page(`p${i}`, i !== 3));
    const tag = await createTag(ctx, scope, { name: 'News' });
    const { id } = await createMenu(ctx, scope, {
      handle: 'big',
      name: 'Big',
      items: [
        { link: { type: 'term', termKind: 'tag', termId: tag.id } },
        ...ids.slice(0, 50).map((entryId) => ({
          link: { type: 'entry', entryId },
          children: [{ link: { type: 'entry', entryId: ids[50 + (ids.indexOf(entryId) % 60)] } }],
        })),
      ],
    });
    // Moves keep working on the stored tree.
    await moveMenuItem(ctx, scope, id, {
      itemId: (await getMenu(ctx, scope, id)).items[0]?.id as string,
      parentId: null,
      index: 99,
    });
    const read = await store.delivery.read(scope, { menu: { handle: 'big' } });
    expect(read.menu?.menu.id).toBe(id);
    // Every linked entry that is published: p3 isn't, p100..p109 aren't linked.
    expect(read.menu?.entries).toHaveLength(99);
    expect(read.menu?.tags.map((t) => t.id)).toEqual([tag.id]);
    expect(read.menu?.concepts).toEqual([]);
    expect((await store.delivery.read(scope, { menu: { handle: 'nope' } })).menu).toBeNull();

    const delivered = await getDeliveredMenu(ctx, scope, 'big', { locale: 'de' });
    expect(delivered.items).toHaveLength(51);
    expect(delivered.items[0]).toMatchObject({ label: 'Titel p0', url: '/p0' });
    // p3 is unpublished: its child takes its place.
    expect(delivered.items[3]).toMatchObject({ url: '/p53', label: 'Titel p53' });
    expect(delivered.items.at(-1)).toMatchObject({ label: 'News', term: { slug: 'news' } });
    await unpublishEntry(ctx, scope, ids[0] as string);
    expect((await getDeliveredMenu(ctx, scope, 'big')).items[0]).toMatchObject({ url: '/p50' });
  });

  it('clears the table with its environment', async () => {
    const { ctx, clock, spaceId } = await harness();
    const env = `gone-${uid().slice(0, 8)}`;
    await createEnvironment(ctx, spaceId, env);
    await createMenu(ctx, { spaceId, environmentId: env }, { handle: 'main', name: 'Main' });
    await store.spaces.deleteEnvironment(spaceId, env, [], {
      id: uid(),
      spaceId,
      environmentId: env,
      at: clock.now().toISOString(),
      actor: 'test',
      action: 'environment.deleted',
      status: 200,
    });
    while ((await store.spaces.purgeEnvironmentStep(spaceId, env, 500, clock.now())) > 0) {}
    const n = await testDb
      .prepare('SELECT count(*) AS n FROM menus WHERE space_id = ? AND environment_id = ?')
      .bind(spaceId, env)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
