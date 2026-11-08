import {
  ConflictError,
  type FieldDefinition,
  NotFoundError,
  type Principal,
  ValidationError,
} from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneEnvironment,
  createConcept,
  createContentType,
  createEntry,
  createEnvironment,
  createMenu,
  createScheme,
  createSpace,
  createTag,
  deleteMenu,
  exportSnapshot,
  getDeliveredMenu,
  getMenu,
  importSnapshot,
  listDeliveredMenus,
  listMenus,
  moveMenuItem,
  previewMenu,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  unpublishEntry,
  updateEntry,
  updateMenu,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const limited = (contentGrants: Principal['contentGrants']): Principal => ({
  spaceId: 'site',
  kind: 'cma',
  scopes: [],
  contentGrants,
});

const refusal = async (p: Promise<unknown>): Promise<string[]> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ValidationError))
    throw new Error(`expected a ValidationError, got ${String(err)}`);
  return err.issues.map((i) => `${i.field}: ${i.message}`);
};

describe('menus', () => {
  let ctx: AppContext;
  let store: InMemoryContentStore;
  /** Creates (and by default publishes) a page at /{slug}. */
  let page: (slug: string, publish?: boolean) => Promise<string>;

  beforeEach(async () => {
    store = new InMemoryContentStore();
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('m') };
    await createSpace(ctx, {
      spaceId: 'site',
      name: 'Site',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de'],
    });
    await createEnvironment(ctx, 'site', 'staging');
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      urlPattern: '/{locale}/{slug}',
      fields: [
        field({ apiId: 'title', type: 'Symbol', localized: true }),
        field({ apiId: 'slug', type: 'Slug', localized: true, position: 1 }),
      ],
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [field({ apiId: 'title', type: 'Symbol' })],
    });
    await publishContentType(ctx, scope, 'page');
    await publishContentType(ctx, scope, 'note');
    page = async (slug, publish = true) => {
      const { entry } = await createEntry(ctx, scope, {
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': `About ${slug}`, de: `Über ${slug}` },
          slug: { 'en-US': slug, de: `${slug}-de` },
        },
      });
      if (publish) await publishEntry(ctx, scope, entry.id);
      return entry.id;
    };
  });

  const changes = () => store.allEvents().filter((e) => e.type === 'menus.changed');

  it('creates, reads, lists, updates and deletes, announcing each change', async () => {
    const menu = await createMenu(ctx, scope, {
      handle: 'main',
      name: ' Main ',
      description: 'Header',
      items: [{ label: 'Home', link: { type: 'url', url: '/' } }],
    });
    expect(menu).toMatchObject({
      handle: 'main',
      name: 'Main',
      description: 'Header',
      revision: 1,
    });
    expect(menu.items[0]?.id).toBeTruthy();
    expect(await getMenu(ctx, scope, menu.id)).toEqual(menu);
    expect(await listMenus(ctx, scope)).toEqual([
      expect.objectContaining({ handle: 'main', itemCount: 1, revision: 1 }),
    ]);

    const renamed = await updateMenu(ctx, scope, menu.id, {
      handle: 'header',
      description: null,
      revision: 1,
    });
    expect(renamed).toMatchObject({ handle: 'header', name: 'Main', revision: 2 });
    expect(renamed.description).toBeUndefined();
    expect(renamed.items).toEqual(menu.items);

    await deleteMenu(ctx, scope, menu.id);
    await expect(getMenu(ctx, scope, menu.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(changes().map((e) => e.type === 'menus.changed' && e.handle)).toEqual([
      'main',
      'header',
      'header',
    ]);
  });

  it('keeps handles unique within an environment, and environments apart', async () => {
    await createMenu(ctx, scope, { handle: 'main', name: 'Main' });
    await expect(createMenu(ctx, scope, { handle: 'main', name: 'Again' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const footer = await createMenu(ctx, scope, { handle: 'footer', name: 'Footer' });
    await expect(updateMenu(ctx, scope, footer.id, { handle: 'main' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await createMenu(ctx, staging, { handle: 'main', name: 'Staging' });
    expect((await listMenus(ctx, staging)).map((m) => m.name)).toEqual(['Staging']);
    await expect(getMenu(ctx, staging, footer.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses links to entries and terms that don’t exist, or an entry with no URL pattern', async () => {
    const { entry: note } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'n' } },
    });
    const issues = await refusal(
      createMenu(ctx, scope, {
        handle: 'main',
        name: 'Main',
        items: [
          { link: { type: 'entry', entryId: 'nope' } },
          { link: { type: 'entry', entryId: note.id } },
          { link: { type: 'term', termKind: 'tag', termId: 'nope' } },
        ],
      }),
    );
    expect(issues).toEqual([
      'items[0].link: Entry nope does not exist',
      expect.stringMatching(/^items\[1\]\.link: Content type note has no URL pattern/),
      'items[2].link: tag nope does not exist',
    ]);
    expect(changes()).toEqual([]);
  });

  it('checks only links a save adds: an old dangling one never blocks the rest', async () => {
    const id = await page('about');
    const menu = await createMenu(ctx, scope, {
      handle: 'main',
      name: 'Main',
      items: [{ link: { type: 'entry', entryId: id } }],
    });
    // The type loses its pattern after the link was made.
    await store.contentTypes.save(scope, {
      ...(await store.contentTypes.get(scope, 'page'))!,
      urlPattern: undefined,
    } as never);
    const saved = await updateMenu(ctx, scope, menu.id, {
      items: [...menu.items, { label: 'Blog', link: { type: 'url', url: '/blog' } }],
    });
    expect(saved.items).toHaveLength(2);
  });

  it('refuses a save made against an older revision, and retries a race it didn’t name', async () => {
    const menu = await createMenu(ctx, scope, { handle: 'main', name: 'Main' });
    await updateMenu(ctx, scope, menu.id, { name: 'Two' });
    await expect(
      updateMenu(ctx, scope, menu.id, { name: 'Stale', revision: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Another writer commits between this write's read and its commit, once.
    const get = store.menus.get.bind(store.menus);
    let raced = false;
    store.menus.get = async (s, id) => {
      const read = await get(s, id);
      if (!raced && read) {
        raced = true;
        await store.menus.save(
          s,
          { ...read, name: 'Other', revision: read.revision + 1 },
          read.revision,
        );
      }
      return read;
    };
    const after = await updateMenu(ctx, scope, menu.id, { description: 'Mine' });
    // The retry read the other writer's menu: both changes stand.
    expect(after).toMatchObject({ name: 'Other', description: 'Mine', revision: 4 });

    // Named, the same race is a conflict rather than an overwrite.
    raced = false;
    await expect(
      updateMenu(ctx, scope, menu.id, { name: 'Late', revision: 4 }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await get(scope, menu.id))?.name).toBe('Other');
  });

  it('gives up after losing every attempt', async () => {
    const menu = await createMenu(ctx, scope, { handle: 'main', name: 'Main' });
    const before = changes().length;
    store.menus.save = async () => {
      throw new TransactionConflictError();
    };
    await expect(updateMenu(ctx, scope, menu.id, { name: 'x' })).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    expect(changes()).toHaveLength(before);
  });

  it('moves an item, subtree and all, as a keyboard reorder does', async () => {
    const menu = await createMenu(ctx, scope, {
      handle: 'main',
      name: 'Main',
      items: [
        { id: 'a', label: 'A', link: { type: 'url', url: '/a' } },
        {
          id: 'b',
          label: 'B',
          link: { type: 'url', url: '/b' },
          children: [{ id: 'b1', label: 'B1', link: { type: 'url', url: '/b1' } }],
        },
      ],
    });
    const up = await moveMenuItem(ctx, scope, menu.id, { itemId: 'b', parentId: null, index: 0 });
    expect(up.items.map((i) => i.id)).toEqual(['b', 'a']);
    const indented = await moveMenuItem(ctx, scope, menu.id, {
      itemId: 'a',
      parentId: 'b',
      index: 1,
      revision: up.revision,
    });
    expect(indented.items[0]?.children.map((i) => i.id)).toEqual(['b1', 'a']);
    await expect(
      moveMenuItem(ctx, scope, menu.id, { itemId: 'b', parentId: 'a', index: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  describe('delivery', () => {
    it('resolves entry links to their published URL and label, per locale', async () => {
      const about = await page('about');
      const tag = await createTag(ctx, scope, { name: 'News', labels: { de: 'Neuigkeiten' } });
      const scheme = await createScheme(ctx, scope, { name: 'Topics' });
      const concept = await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'Guides' });
      await createMenu(ctx, scope, {
        handle: 'main',
        name: 'Main',
        items: [
          {
            id: 'about',
            link: { type: 'entry', entryId: about },
            target: '_blank',
            attrs: { rel: 'noopener' },
          },
          { id: 'custom', label: 'Custom', link: { type: 'entry', entryId: about } },
          { id: 'news', link: { type: 'term', termKind: 'tag', termId: tag.id } },
          { id: 'guides', link: { type: 'term', termKind: 'concept', termId: concept.id } },
          { id: 'mail', label: 'Mail', link: { type: 'url', url: 'mailto:hi@example.com' } },
        ],
      });
      const de = await getDeliveredMenu(ctx, scope, 'main', { locale: 'de' });
      expect(de).toMatchObject({ handle: 'main', name: 'Main', locale: 'de' });
      expect(de.items).toEqual([
        {
          id: 'about',
          label: 'Über about',
          url: '/de/about-de',
          target: '_blank',
          attrs: { rel: 'noopener' },
          entry: { id: about, contentType: 'page' },
          children: [],
        },
        {
          id: 'custom',
          label: 'Custom',
          url: '/de/about-de',
          entry: { id: about, contentType: 'page' },
          children: [],
        },
        {
          id: 'news',
          label: 'Neuigkeiten',
          url: null,
          term: { kind: 'tag', id: tag.id, slug: 'news' },
          children: [],
        },
        {
          id: 'guides',
          label: 'Guides',
          url: null,
          term: { kind: 'concept', id: concept.id, slug: 'guides', schemeId: scheme.id },
          children: [],
        },
        { id: 'mail', label: 'Mail', url: 'mailto:hi@example.com', children: [] },
      ]);
      expect((await getDeliveredMenu(ctx, scope, 'main')).items[0]).toMatchObject({
        label: 'About about',
        url: '/en-US/about',
      });
      expect(await listDeliveredMenus(ctx, scope)).toEqual([{ handle: 'main', name: 'Main' }]);
      await expect(getDeliveredMenu(ctx, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('serves published state only: drafts, unpublished entries and hidden types drop out', async () => {
      const section = await page('docs');
      const child = await page('guide');
      const draft = await page('draft', false);
      await createMenu(ctx, scope, {
        handle: 'main',
        name: 'Main',
        items: [
          {
            id: 'section',
            link: { type: 'entry', entryId: section },
            children: [
              { id: 'child', link: { type: 'entry', entryId: child } },
              { id: 'draft', link: { type: 'entry', entryId: draft } },
            ],
          },
        ],
      });
      const ids = async (opts = {}) =>
        (await getDeliveredMenu(ctx, scope, 'main', opts)).items.map((i) => ({
          [i.id]: i.children.map((c) => c.id),
        }));
      expect(await ids()).toEqual([{ section: ['child'] }]);

      // The section page goes away: its children take its place.
      await unpublishEntry(ctx, scope, section);
      expect(await ids()).toEqual([{ child: [] }]);
      // The draft is published and a slug changes: the menu follows without being saved.
      await publishEntry(ctx, scope, draft);
      await updateEntry(ctx, scope, child, {
        title: { 'en-US': 'Guide' },
        slug: { 'en-US': 'guide-2' },
      });
      await publishEntry(ctx, scope, child);
      const items = (await getDeliveredMenu(ctx, scope, 'main')).items;
      expect(items.map((i) => [i.id, i.url])).toEqual([
        ['child', '/en-US/guide-2'],
        ['draft', '/en-US/draft'],
      ]);
      // A key that can't read pages sees none of them.
      expect(
        await ids({ principal: limited([{ contentTypeApiId: 'note', actions: ['read'] }]) }),
      ).toEqual([]);
    });

    it('applies a caller’s content grants: hidden types and denied fields never shape an item', async () => {
      const about = await page('about');
      const menu = await createMenu(ctx, scope, {
        handle: 'main',
        name: 'Main',
        items: [
          { id: 'about', link: { type: 'entry', entryId: about } },
          { id: 'own', label: 'Ours', link: { type: 'entry', entryId: about } },
        ],
      });
      // The title is denied: the label falls back to the entry's id (or the item's own).
      const noTitle = limited([
        { contentTypeApiId: 'page', actions: ['read'], deniedFields: ['title'] },
      ]);
      const served = await getDeliveredMenu(ctx, scope, 'main', { principal: noTitle });
      expect(served.items.map((i) => [i.label, i.url])).toEqual([
        [about, '/en-US/about'],
        ['Ours', '/en-US/about'],
      ]);
      // The slug its URL is built from is denied: the item is left out, as if unpublished.
      const noSlug = limited([
        { contentTypeApiId: 'page', actions: ['read'], deniedFields: ['slug'] },
      ]);
      expect((await getDeliveredMenu(ctx, scope, 'main', { principal: noSlug })).items).toEqual([]);

      // Management: a caller without pages sees them as hidden, never their titles (the entry id
      // is the menu's own data, which they can already read)…
      const notes = limited([{ contentTypeApiId: 'note', actions: ['read', 'create', 'update'] }]);
      const preview = await previewMenu(ctx, scope, menu.id, undefined, { principal: notes });
      expect(preview.items.map((i) => [i.status, i.label])).toEqual([
        ['hidden', about],
        ['hidden', 'Ours'],
      ]);
      // …and can't learn that a page exists by linking it.
      const other = await page('other', false);
      expect(
        await refusal(
          updateMenu(
            ctx,
            scope,
            menu.id,
            { items: [...menu.items, { link: { type: 'entry', entryId: other } }] },
            { principal: notes },
          ),
        ),
      ).toEqual([`items[2].link: Entry ${other} does not exist`]);
    });

    it('previews each item as Delivery would serve it, and says why one isn’t', async () => {
      const live = await page('live');
      const draft = await page('draft', false);
      const menu = await createMenu(ctx, scope, {
        handle: 'main',
        name: 'Main',
        items: [
          { id: 'live', link: { type: 'entry', entryId: live } },
          { id: 'draft', link: { type: 'entry', entryId: draft } },
          { id: 'home', label: 'Home', link: { type: 'url', url: '/' } },
        ],
      });
      const preview = await previewMenu(ctx, scope, menu.id, 'de');
      expect(preview.items.map((i) => [i.id, i.status, i.label, i.url])).toEqual([
        ['live', 'live', 'Über live', '/de/live-de'],
        ['draft', 'unpublished', 'Über draft', null],
        ['home', 'live', 'Home', '/'],
      ]);
    });
  });

  it('travels with snapshots and clones, term links remapped', async () => {
    const about = await page('about');
    const tag = await createTag(ctx, scope, { name: 'News' });
    await createMenu(ctx, scope, {
      handle: 'main',
      name: 'Main',
      items: [
        { id: 'about', link: { type: 'entry', entryId: about } },
        { id: 'news', link: { type: 'term', termKind: 'tag', termId: tag.id } },
      ],
    });
    const snapshot = await exportSnapshot(ctx, scope);
    expect(snapshot.menus?.map((m) => m.handle)).toEqual(['main']);

    const copy = { spaceId: 'site', environmentId: 'copy' };
    await createEnvironment(ctx, 'site', 'copy');
    await cloneEnvironment(ctx, scope, copy);
    const delivered = await getDeliveredMenu(ctx, copy, 'main');
    expect(delivered.items.map((i) => [i.id, i.label])).toEqual([
      ['about', 'About about'],
      ['news', 'News'],
    ]);

    await createEnvironment(ctx, 'site', 'bad');
    await expect(
      importSnapshot(
        ctx,
        { spaceId: 'site', environmentId: 'bad' },
        {
          ...snapshot,
          menus: [{ ...(snapshot.menus?.[0] as never), handle: 'Not A Handle' }],
        },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
