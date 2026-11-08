import { NotFoundError, type Principal } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  diffVersions,
  getVersion,
  listVersions,
  parseVersionRef,
  publishContentType,
  publishEntry,
  restoreVersion,
  SYSTEM_CALLER,
  updateEntry,
  visibleDiff,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
}

async function seedArticleType(ctx: AppContext) {
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
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
    ],
  });
  await publishContentType(ctx, scope, 'article');
}

describe('entry version history', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = makeContext();
    await seedArticleType(ctx);
  });

  it('records a version per save, newest first, with timestamps', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'v1' } },
    });
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'v2' } });
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'v3' } });

    const versions = await listVersions(ctx, scope, entry.id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.every((v) => typeof v.createdAt === 'string')).toBe(true);
    expect((await getVersion(ctx, scope, entry.id, 1)).fields).toEqual({
      title: { 'en-US': 'v1' },
    });
  });

  it('diffs two versions per field and locale, labelled from the content type', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' } },
    });
    await updateEntry(ctx, scope, entry.id, {
      title: { 'en-US': 'Hello world' },
      body: { 'en-US': 'New body' },
    });

    const diff = await diffVersions(ctx, scope, entry.id, 1, 2);
    expect(diff).toMatchObject({ entryId: entry.id, contentType: 'article', from: 1, to: 2 });
    expect(diff.changes.map((c) => [c.field, c.name, c.kind])).toEqual([
      ['title', 'Title', 'changed'],
      ['body', 'Body', 'added'],
    ]);
    expect(diff.changes[0]?.locales[0]?.detail).toEqual({
      type: 'text',
      segments: [
        { kind: 'unchanged', text: 'Hello' },
        { kind: 'added', text: ' world' },
      ],
    });
  });

  it('resolves draft and published to the versions they name now', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'one' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'two' } });
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'three' } });

    const diff = await diffVersions(ctx, scope, entry.id, 'published', 'draft');
    expect([diff.from, diff.to]).toEqual([1, 3]);
    expect(diff.changes[0]?.locales[0]).toMatchObject({ before: 'one', after: 'three' });
    expect((await diffVersions(ctx, scope, entry.id, 2, 'draft')).from).toBe(2);
    // Reading a diff writes nothing: the entry is where it was.
    expect((await listVersions(ctx, scope, entry.id)).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('refuses published on an entry never published, and unknown versions or entries', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'x' } },
    });
    await expect(diffVersions(ctx, scope, entry.id, 'published', 'draft')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(diffVersions(ctx, scope, entry.id, 1, 9)).rejects.toBeInstanceOf(NotFoundError);
    await expect(diffVersions(ctx, scope, 'ghost', 1, 'draft')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('keeps a diff inside its scope', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'x' } },
    });
    const other = { spaceId: 'space-1', environmentId: 'staging' };
    await expect(diffVersions(ctx, other, entry.id, 1, 'draft')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('reads version references from strings and numbers', () => {
    expect(parseVersionRef('3')).toBe(3);
    expect(parseVersionRef(4)).toBe(4);
    expect(parseVersionRef('draft')).toBe('draft');
    expect(parseVersionRef('published')).toBe('published');
    for (const bad of ['0', '-1', '1.5', '', 'latest', undefined, null]) {
      expect(parseVersionRef(bad)).toBeNull();
    }
  });

  it('restores an older version as a new draft (history preserved)', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'original' } },
    });
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'edited' } });

    const restored = await restoreVersion(ctx, scope, entry.id, 1);
    // A NEW version is appended (v3), carrying v1's fields — nothing is rewritten.
    expect(restored.entry.currentVersion).toBe(3);
    expect(restored.fields).toEqual({ title: { 'en-US': 'original' } });
    expect((await listVersions(ctx, scope, entry.id)).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('rejects reading an unknown version or entry', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'x' } },
    });
    await expect(getVersion(ctx, scope, entry.id, 99)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listVersions(ctx, scope, 'ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('restore re-validates against the current model', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'keep' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'changed' } });
    // Restoring v1 is valid and produces a fresh draft version.
    const restored = await restoreVersion(ctx, scope, entry.id, 1);
    expect(restored.fields).toEqual({ title: { 'en-US': 'keep' } });
  });
});

describe('a diff as one principal reads it', () => {
  const field = (name: string, kind: 'changed' | 'unchanged') =>
    ({ field: name, kind, locales: [{ locale: 'en-US', kind }] }) as const;
  const diff = {
    entryId: 'e1',
    contentType: 'post',
    from: 1,
    to: 2,
    changes: [field('title', 'changed'), field('notes', 'changed'), field('owner', 'unchanged')],
  };
  const principal = (deniedFields?: string[]): Principal => ({
    spaceId: 's1',
    kind: 'cma',
    scopes: [],
    ...(deniedFields
      ? { contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields }] }
      : {}),
  });

  it('counts a denied field that changed, and only that', () => {
    const seen = visibleDiff(principal(['notes', 'owner']), diff);
    expect(seen.changes.map((c) => c.field)).toEqual(['title']);
    expect(seen.hiddenChanges).toBe(1);
  });

  it('counts a denied field named as an object’s own property would be', () => {
    const named = { ...diff, changes: [field('constructor', 'changed')] };
    const seen = visibleDiff(principal(['constructor']), named);
    expect(seen.changes).toEqual([]);
    expect(seen.hiddenChanges).toBe(1);
  });

  it('hides nothing from a principal denied nothing', () => {
    const seen = visibleDiff(principal(), diff);
    expect(seen.changes).toHaveLength(3);
    expect(seen.hiddenChanges).toBe(0);
  });
});
