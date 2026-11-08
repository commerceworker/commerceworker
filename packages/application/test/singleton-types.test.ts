import {
  ConflictError,
  NotFoundError,
  type Principal,
  SCOPES,
  singletonClaim,
} from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approvePromotion,
  bulkCreateEntries,
  cancelBulkJob,
  cloneEnvironment,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  deleteContentType,
  deleteContentTypeWithEntries,
  duplicateEntry,
  exportSnapshot,
  getContentType,
  getDeliveredSingleton,
  getPreviewSingleton,
  importSnapshot,
  mergeEnvironments,
  publishContentType,
  publishEntry,
  requestPromotion,
  restoreEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };
const qa = { spaceId: 'site', environmentId: 'qa' };
const ada: Principal = {
  spaceId: 'site',
  kind: 'user',
  subject: 'ada',
  scopes: [SCOPES.contentPublish, SCOPES.contentManage],
};
const grace: Principal = { ...ada, subject: 'grace' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx, store };
}
type Harness = ReturnType<typeof setup>;

const symbol = (apiId: string, position: number, extra: Record<string, unknown> = {}) => ({
  apiId,
  name: apiId,
  type: 'Symbol' as const,
  localized: false,
  required: false,
  position,
  ...extra,
});

async function settingsType(h: Harness, s = scope, singleton = true) {
  await createContentType(h.ctx, SYSTEM_CALLER, s, {
    apiId: 'settings',
    name: 'Site settings',
    displayField: 'title',
    fields: [
      symbol('title', 0),
      symbol('code', 1, { unique: true }),
      {
        apiId: 'home',
        name: 'Home',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 2,
      },
    ],
    singleton,
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(h.ctx, s, 'settings');
}

async function pageType(h: Harness, s = scope) {
  await createContentType(h.ctx, SYSTEM_CALLER, s, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [symbol('title', 0)],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(h.ctx, s, 'page');
}

const settings = (h: Harness, title: string, s = scope) =>
  createEntry(h.ctx, s, { contentTypeApiId: 'settings', fields: { title: { 'en-US': title } } });

describe('singleton types', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await settingsType(h);
  });

  it('stores the flag only when set, and keeps it through a revision that leaves it out', async () => {
    expect((await getContentType(h.ctx, scope, 'settings')).singleton).toBe(true);
    await pageType(h);
    expect('singleton' in (await getContentType(h.ctx, scope, 'page'))).toBe(false);

    const revised = await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'settings', {
      name: 'Settings',
    });
    expect(revised.singleton).toBe(true);
  });

  it('refuses a second entry on create, bulk create and duplicate, naming the one it has', async () => {
    const first = await settings(h, 'Site');

    const second = settings(h, 'Another');
    await expect(second).rejects.toBeInstanceOf(ConflictError);
    await expect(second).rejects.toThrow(first.entry.id);

    const bulk = await bulkCreateEntries(h.ctx, scope, [
      { contentTypeApiId: 'settings', fields: { title: { 'en-US': 'Bulk' } } },
    ]);
    expect(bulk.failed).toBe(1);
    expect(bulk.results[0]?.error).toContain('singleton');

    await expect(duplicateEntry(h.ctx, scope, first.entry.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    // Editing the one entry is never refused by its own claim.
    await updateEntry(h.ctx, scope, first.entry.id, { title: { 'en-US': 'Site, edited' } });
    expect((await h.store.entries.list(scope, { contentTypeApiId: 'settings' })).length).toBe(1);
  });

  it('refuses the second of two racing creates through the claim, when its read saw no entry', async () => {
    const first = await settings(h, 'A');
    // The race: the second create's read ran before the first committed, so it saw nothing.
    const list = h.store.entries.list;
    h.store.entries.list = async () => [];
    try {
      await expect(settings(h, 'B')).rejects.toBeInstanceOf(ConflictError);
    } finally {
      h.store.entries.list = list;
    }
    const left = await h.store.entries.list(scope, { contentTypeApiId: 'settings' });
    expect(left.map((e) => e.entry.id)).toEqual([first.entry.id]);
  });

  it('still refuses a second entry when the one it has lost its claim (written by an older release)', async () => {
    const first = await settings(h, 'Site');
    // What a rollback leaves: the entry saved by code that knew nothing of the claim.
    await h.store.entries.releaseUniqueClaims(scope, first.entry.id);
    await expect(settings(h, 'Another')).rejects.toThrow(first.entry.id);
  });

  it('frees the singleton when its entry goes to the trash, and refuses to restore it beside a new one', async () => {
    const first = await settings(h, 'Old');
    await trashEntry(h.ctx, scope, first.entry.id);
    const second = await settings(h, 'New');

    const restore = restoreEntry(h.ctx, scope, first.entry.id);
    await expect(restore).rejects.toBeInstanceOf(ConflictError);
    await expect(restore).rejects.toThrow(second.entry.id);

    // With the new one trashed in turn, the old one comes back.
    await trashEntry(h.ctx, scope, second.entry.id);
    await restoreEntry(h.ctx, scope, first.entry.id);
  });

  it('refuses turning the flag on for a type with more than one entry, naming them', async () => {
    await pageType(h);
    const ids: string[] = [];
    for (const title of ['a', 'b', 'c']) {
      ids.push(
        (
          await createEntry(h.ctx, scope, {
            contentTypeApiId: 'page',
            fields: { title: { 'en-US': title } },
          })
        ).entry.id,
      );
    }
    const turn = updateContentType(h.ctx, SYSTEM_CALLER, scope, 'page', { singleton: true });
    await expect(turn).rejects.toBeInstanceOf(ConflictError);
    await expect(turn).rejects.toThrow(ids[0] as string);
    expect('singleton' in (await getContentType(h.ctx, scope, 'page'))).toBe(false);

    // Trashed entries don't count: with two in the trash, the one left makes it a singleton.
    await trashEntry(h.ctx, scope, ids[1] as string);
    await trashEntry(h.ctx, scope, ids[2] as string);
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'page', { singleton: true });
    const held = await h.store.entries.findUniqueConflicts(scope, [singletonClaim('page')]);
    expect(held.map((c) => c.entryId)).toEqual([ids[0]]);
    await expect(
      createEntry(h.ctx, scope, { contentTypeApiId: 'page', fields: { title: { 'en-US': 'd' } } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('gives the claim back when the flag is turned off, keeping the entry’s unique values', async () => {
    const first = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'settings',
      fields: { title: { 'en-US': 'Site' }, code: { 'en-US': 'x1' } },
    });
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'settings', { singleton: false });
    expect('singleton' in (await getContentType(h.ctx, scope, 'settings'))).toBe(false);
    await settings(h, 'Second');
    expect(await h.store.entries.findUniqueConflicts(scope, [singletonClaim('settings')])).toEqual(
      [],
    );
    // Its `code` claim survived the rebuild.
    const code = { contentTypeApiId: 'settings', fieldApiId: 'code', locale: 'en-US', value: 'x1' };
    expect(
      (await h.store.entries.findUniqueConflicts(scope, [code])).map((c) => c.entryId),
    ).toEqual([first.entry.id]);
  });

  it('serves the published entry from Delivery, by locale and with links included', async () => {
    await pageType(h);
    const home = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Home' } },
    });
    await publishEntry(h.ctx, scope, home.entry.id);
    const one = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'settings',
      fields: {
        title: { 'en-US': 'Site' },
        home: { 'en-US': { id: home.entry.id, linkType: 'Entry' } },
      },
    });

    // Not published yet: nothing to serve, though Preview has it.
    await expect(getDeliveredSingleton(h.ctx, scope, 'settings')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const draft = await getPreviewSingleton(h.ctx, scope, 'settings', { locale: 'en-US' });
    expect(draft).toMatchObject({ id: one.entry.id, status: 'draft', fields: { title: 'Site' } });

    await publishEntry(h.ctx, scope, one.entry.id);
    const served = await getDeliveredSingleton(h.ctx, scope, 'settings', {
      locale: 'en-US',
      include: 1,
    });
    expect(served.id).toBe(one.entry.id);
    expect(served.fields.title).toBe('Site');
    expect((served.fields.home as { fields: { title: string } }).fields.title).toBe('Home');
    // Without include the link stays a link.
    const shallow = await getDeliveredSingleton(h.ctx, scope, 'settings', { locale: 'en-US' });
    expect(shallow.fields.home).toEqual({ id: home.entry.id, linkType: 'Entry' });
  });

  it('is not found for an ordinary type, an unknown one, or a singleton with no entry', async () => {
    await pageType(h);
    const page = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'p' } },
    });
    await publishEntry(h.ctx, scope, page.entry.id);
    for (const apiId of ['page', 'nope', 'settings']) {
      await expect(getDeliveredSingleton(h.ctx, scope, apiId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(getPreviewSingleton(h.ctx, scope, apiId)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('keeps one entry per environment', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await settingsType(h, staging);
    await settings(h, 'Main');
    await settings(h, 'Staging', staging);
    await expect(settings(h, 'Again', staging)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses an environment merge that would give the target a second entry', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await settingsType(h, staging);
    const fromStaging = await settings(h, 'Staging', staging);
    await settings(h, 'Main');
    await expect(
      mergeEnvironments(h.ctx, 'site', 'staging', 'main', { entries: [fromStaging.entry.id] }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await h.store.entries.list(scope, { contentTypeApiId: 'settings' })).length).toBe(1);
  });

  it('refuses a merge that turns a target type with several entries into a singleton', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await settingsType(h, staging);
    // Main has the same type as an ordinary one, with two entries.
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'settings', { singleton: false });
    await settings(h, 'A');
    await settings(h, 'B');
    await expect(
      mergeEnvironments(h.ctx, 'site', 'staging', 'main', { contentTypes: ['settings'] }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect('singleton' in (await getContentType(h.ctx, scope, 'settings'))).toBe(false);
  });
});

describe('singleton types across environments', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await settingsType(h);
    await settings(h, 'Site');
    await createEnvironment(h.ctx, 'site', 'staging');
  });

  it('keeps the flag through a clone, an export and import, and a promotion back', async () => {
    await cloneEnvironment(h.ctx, scope, staging);
    expect((await getContentType(h.ctx, staging, 'settings')).singleton).toBe(true);
    // The rule holds in the clone: its one entry came with it.
    await expect(settings(h, 'Second', staging)).rejects.toBeInstanceOf(ConflictError);

    await createEnvironment(h.ctx, 'site', 'qa');
    await importSnapshot(h.ctx, qa, await exportSnapshot(h.ctx, scope));
    expect((await getContentType(h.ctx, qa, 'settings')).singleton).toBe(true);

    // Promoted back after an edit, production's type stays a singleton.
    await updateContentType(h.ctx, SYSTEM_CALLER, staging, 'settings', {
      name: 'Settings (renamed)',
    });
    const requested = await requestPromotion(h.ctx, ada, 'site', {
      source: 'staging',
      target: 'main',
      contentTypes: ['settings'],
    });
    await approvePromotion(h.ctx, grace, 'site', requested.id);
    const promoted = await getContentType(h.ctx, scope, 'settings');
    expect(promoted.name).toBe('Settings (renamed)');
    expect(promoted.singleton).toBe(true);
  });

  it('refuses, when it is requested, a promotion that would give a singleton a second entry', async () => {
    await settingsType(h, staging);
    const other = await settings(h, 'Staging', staging);
    const refused = requestPromotion(h.ctx, ada, 'site', {
      source: 'staging',
      target: 'main',
      entries: [other.entry.id],
    });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(/singleton/);
    expect(await h.store.promotions.list('site')).toEqual([]);
  });

  it('claims a merged new entry’s unique values, the singleton’s among them', async () => {
    await settingsType(h, staging);
    // Main's entry goes to the trash, so the singleton is free for the staging one.
    const [mainEntry] = await h.store.entries.list(scope, { contentTypeApiId: 'settings' });
    await trashEntry(h.ctx, scope, mainEntry?.entry.id ?? '');
    const fromStaging = await createEntry(h.ctx, staging, {
      contentTypeApiId: 'settings',
      fields: { title: { 'en-US': 'Staging' }, code: { 'en-US': 'k1' } },
    });
    await mergeEnvironments(h.ctx, 'site', 'staging', 'main', { entries: [fromStaging.entry.id] });

    const held = await h.store.entries.findUniqueConflicts(scope, [
      singletonClaim('settings'),
      { contentTypeApiId: 'settings', fieldApiId: 'code', locale: 'en-US', value: 'k1' },
    ]);
    expect(held.map((c) => [c.fieldApiId, c.entryId])).toEqual([
      ['$singleton', fromStaging.entry.id],
      ['code', fromStaging.entry.id],
    ]);
  });

  it('announces a merged published definition that changes the flag, so Delivery purges', async () => {
    await settingsType(h, staging, false);
    const before = h.store.allEvents().length;
    // Main's settings is a published singleton with one entry; staging's is an ordinary one.
    await mergeEnvironments(h.ctx, 'site', 'staging', 'main', { contentTypes: ['settings'] });
    const announced = h.store
      .allEvents()
      .slice(before)
      .filter((e) => e.type === 'content_type.published');
    expect(announced.map((e) => e.scope.environmentId)).toEqual(['main']);
  });
});

describe('singleton types, served by their published revision', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await settingsType(h);
    const one = await settings(h, 'Site');
    await publishEntry(h.ctx, scope, one.entry.id);
  });

  it('keeps serving through a draft that turns the flag off, and stops when it is published', async () => {
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'settings', { singleton: false });
    expect((await getDeliveredSingleton(h.ctx, scope, 'settings')).fields.title).toBeDefined();
    await publishContentType(h.ctx, scope, 'settings');
    await expect(getDeliveredSingleton(h.ctx, scope, 'settings')).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // On again as a draft: not served until that is published too.
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'settings', { singleton: true });
    await expect(getDeliveredSingleton(h.ctx, scope, 'settings')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await publishContentType(h.ctx, scope, 'settings');
    expect((await getDeliveredSingleton(h.ctx, scope, 'settings')).fields.title).toBeDefined();
  });
});

describe('a create racing a change to its content type', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await pageType(h);
  });

  /** Runs `fn` with the store's type reads answering `stale`, as a read made before a change. */
  async function withStaleType<T>(stale: unknown, fn: () => Promise<T>): Promise<T> {
    const get = h.store.contentTypes.get;
    h.store.contentTypes.get = async () => stale as Awaited<ReturnType<typeof get>>;
    try {
      return await fn();
    } finally {
      h.store.contentTypes.get = get;
    }
  }
  const page = (title: string) =>
    createEntry(h.ctx, scope, { contentTypeApiId: 'page', fields: { title: { 'en-US': title } } });
  const pages = async () =>
    (await h.store.entries.list(scope, { contentTypeApiId: 'page' })).map((e) => e.entry.id);

  it('is refused (409) when the type was deleted after its read, leaving no orphan', async () => {
    const read = await getContentType(h.ctx, scope, 'page');
    await deleteContentType(h.ctx, scope, 'page');
    const create = withStaleType(read, () => page('Orphan'));
    await expect(create).rejects.toBeInstanceOf(ConflictError);
    await expect(create).rejects.toThrow(/deleted or changed/);
    expect(await pages()).toEqual([]);
  });

  it('keeps the type when the create commits first and the delete’s read saw no entry', async () => {
    const created = await page('First');
    // The delete's reads ran before the create committed: no entries counted.
    const counts = h.store.entries.countByStatus;
    h.store.entries.countByStatus = async () => [];
    try {
      await expect(deleteContentType(h.ctx, scope, 'page')).rejects.toBeInstanceOf(ConflictError);
    } finally {
      h.store.entries.countByStatus = counts;
    }
    expect(await getContentType(h.ctx, scope, 'page')).toBeDefined();
    expect(await pages()).toEqual([created.entry.id]);
  });

  it('is refused (409) when the type became a singleton after its read', async () => {
    const first = await page('First');
    const read = await getContentType(h.ctx, scope, 'page');
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'page', { singleton: true });
    // The create read an ordinary type, so it neither checked for nor staked the singleton.
    await expect(withStaleType(read, () => page('Second'))).rejects.toBeInstanceOf(ConflictError);
    expect(await pages()).toEqual([first.entry.id]);
  });

  it('refuses turning the flag on (409) when a create committed after its read', async () => {
    const first = await page('First');
    const second = await page('Second');
    // The turn's read ran before the second create committed: it saw only the first.
    const list = h.store.entries.list;
    h.store.entries.list = async (s, q) =>
      (await list(s, q)).filter((e) => e.entry.id === first.entry.id);
    try {
      await expect(
        updateContentType(h.ctx, SYSTEM_CALLER, scope, 'page', { singleton: true }),
      ).rejects.toBeInstanceOf(ConflictError);
    } finally {
      h.store.entries.list = list;
    }
    expect('singleton' in (await getContentType(h.ctx, scope, 'page'))).toBe(false);
    expect((await pages()).sort()).toEqual([first.entry.id, second.entry.id].sort());
  });
});

describe('merging entries with unique values', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await createEnvironment(h.ctx, 'site', 'staging');
    for (const s of [scope, staging]) {
      await createContentType(h.ctx, SYSTEM_CALLER, s, {
        apiId: 'product',
        name: 'Product',
        displayField: 'sku',
        fields: [symbol('sku', 0, { unique: true })],
      } as Parameters<typeof createContentType>[3]);
      await publishContentType(h.ctx, s, 'product');
    }
  });

  const product = (s: typeof scope, sku: string, id?: string) =>
    createEntry(h.ctx, s, {
      contentTypeApiId: 'product',
      fields: { sku: { 'en-US': sku } },
      ...(id ? { id } : {}),
    });
  const holder = async (sku: string) =>
    (
      await h.store.entries.findUniqueConflicts(scope, [
        { contentTypeApiId: 'product', fieldApiId: 'sku', locale: 'en-US', value: sku },
      ])
    ).map((c) => c.entryId);

  it('swaps a value: an existing entry gives it up and a new one takes it', async () => {
    const a = await product(scope, 'a', 'prod-a');
    // Staging: A moved on to "b", and a new B took "a".
    await product(staging, 'b', 'prod-a');
    const b = await product(staging, 'a', 'prod-b');
    // Selected new-first: the merge still applies the existing entry first.
    await mergeEnvironments(h.ctx, 'site', 'staging', 'main', {
      entries: [b.entry.id, a.entry.id],
    });
    expect(await holder('a')).toEqual(['prod-b']);
    expect(await holder('b')).toEqual(['prod-a']);
  });

  it('refuses before writing anything when a value is taken outside the merge or twice in it', async () => {
    await product(scope, 'x', 'main-x');
    const ok = await product(staging, 'fresh', 'st-ok');
    const taken = await product(staging, 'x', 'st-taken');
    const before = (await h.store.entries.list(scope, { contentTypeApiId: 'product' })).length;
    const refused = mergeEnvironments(h.ctx, 'site', 'staging', 'main', {
      entries: [ok.entry.id, taken.entry.id],
    });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(/entry st-taken would take sku "x", which entry main-x/);
    expect((await h.store.entries.list(scope, { contentTypeApiId: 'product' })).length).toBe(
      before,
    );
    expect(await h.store.entries.get(scope, ok.entry.id)).toBeNull();

    // Two of the merge's own entries claiming one value (staging's first is in its trash, which
    // released the value there; merged, both would be live in main).
    await product(staging, 'dup', 'st-d1');
    await trashEntry(h.ctx, staging, 'st-d1');
    await product(staging, 'dup', 'st-d2');
    await expect(
      mergeEnvironments(h.ctx, 'site', 'staging', 'main', { entries: ['st-d1', 'st-d2'] }),
    ).rejects.toThrow(/entry st-d2 would take sku "dup", which entry st-d1 holds/);
    expect(await h.store.entries.get(scope, 'st-d1')).toBeNull();
  });

  it('keeps an entry the target holds in its trash there, claiming nothing', async () => {
    await settingsType(h);
    await settingsType(h, staging);
    const first = await settings(h, 'First');
    await trashEntry(h.ctx, scope, first.entry.id);
    const second = await settings(h, 'Second');
    // Staging has its own copy of the trashed one.
    await createEntry(h.ctx, staging, {
      contentTypeApiId: 'settings',
      fields: { title: { 'en-US': 'From staging' } },
      id: first.entry.id,
    });
    await mergeEnvironments(h.ctx, 'site', 'staging', 'main', { entries: [first.entry.id] });
    const merged = await h.store.entries.get(scope, first.entry.id);
    expect(merged?.entry.status).toBe('archived');
    expect(merged?.fields.title).toEqual({ 'en-US': 'From staging' });
    const live = await h.store.entries.list(scope, { contentTypeApiId: 'settings' });
    expect(live.map((e) => e.entry.id)).toEqual([second.entry.id]);
    expect(
      (await h.store.entries.findUniqueConflicts(scope, [singletonClaim('settings')])).map(
        (c) => c.entryId,
      ),
    ).toEqual([second.entry.id]);
  });
});

describe('saving a content type over a raced turn of its flag', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await settingsType(h);
  });

  /** Runs `fn` with type reads answering `stale`, as a read made before a change committed. */
  async function stale<T>(read: unknown, fn: () => Promise<T>): Promise<T> {
    const get = h.store.contentTypes.get;
    h.store.contentTypes.get = async () => read as Awaited<ReturnType<typeof get>>;
    try {
      return await fn();
    } finally {
      h.store.contentTypes.get = get;
    }
  }

  it('refuses a revision and a publish that read the flag before a turn off', async () => {
    const read = await getContentType(h.ctx, scope, 'settings');
    await updateContentType(h.ctx, SYSTEM_CALLER, scope, 'settings', { singleton: false });
    await expect(
      stale(read, () =>
        updateContentType(h.ctx, SYSTEM_CALLER, scope, 'settings', { name: 'Renamed' }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      stale(read, () => publishContentType(h.ctx, scope, 'settings')),
    ).rejects.toBeInstanceOf(ConflictError);
    const now = await getContentType(h.ctx, scope, 'settings');
    expect('singleton' in now).toBe(false);
    expect(now.name).toBe('Site settings');
  });

  it('announces a promotion’s published type once', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await settingsType(h, staging);
    await updateContentType(h.ctx, SYSTEM_CALLER, staging, 'settings', { name: 'Settings v2' });
    await publishContentType(h.ctx, staging, 'settings');
    const before = h.store.allEvents().length;
    const requested = await requestPromotion(h.ctx, ada, 'site', {
      source: 'staging',
      target: 'main',
      contentTypes: ['settings'],
    });
    await approvePromotion(h.ctx, grace, 'site', requested.id);
    const published = h.store
      .allEvents()
      .slice(before)
      .filter((e) => e.type === 'content_type.published');
    expect(published.map((e) => e.scope.environmentId)).toEqual(['main']);
    expect((await getContentType(h.ctx, scope, 'settings')).status).toBe('published');
  });
});

describe('a stopped content type delete', () => {
  it('records the outcome even when the stop came without one', async () => {
    const h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await pageType(h);
    await createEntry(h.ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'p' } },
    });
    const started = await deleteContentTypeWithEntries(h.ctx, scope, 'page');
    if (started.deleted) throw new Error('expected a job');
    // A stop that recorded nothing (an older release): the next cancel fills it in.
    await h.store.bulkJobs.finalizeJob(scope, started.job.id, 'cancelled', new Date());
    const again = await cancelBulkJob(h.ctx, scope, started.job.id);
    const recorded = { deleted: false, reason: 'the job was stopped' };
    expect(again.config?.typeDeletion).toEqual(recorded);
    expect((await h.store.bulkJobs.getJob(scope, started.job.id))?.config?.typeDeletion).toEqual(
      recorded,
    );
  });
});
