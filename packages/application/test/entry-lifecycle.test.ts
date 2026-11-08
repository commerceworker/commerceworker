import { ConflictError, InvalidStateError, NotFoundError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createTag,
  duplicateEntry,
  getEntry,
  listPreviewEntries,
  publishContentType,
  publishEntry,
  purgeEntry,
  restoreEntry,
  SYSTEM_CALLER,
  setEntryMetadata,
  trashEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };

let ctx: AppContext;
let store: InMemoryContentStore;

/** A content type with a display field and one bounded-length title. */
async function seed(titleMax?: number) {
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
        ...(titleMax === undefined ? {} : { validations: { size: { max: titleMax } } }),
      },
      {
        apiId: 'link',
        name: 'Link',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  });
  await publishContentType(ctx, scope, 'article');
}

const article = (title: string) => ({
  contentTypeApiId: 'article',
  fields: { title: { 'en-US': title } },
});

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await seed();
});

describe('trashing an entry', () => {
  it('moves a draft to the trash and hides it from the entries list', async () => {
    const { entry } = await createEntry(ctx, scope, article('Draft'));
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(1);

    const trashed = await trashEntry(ctx, scope, entry.id);
    expect(trashed.status).toBe('archived');
    // Trash is hidden by default — otherwise "delete" leaves it in plain sight.
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(0);
    // ...and shows in the trash view.
    const trash = await listPreviewEntries(ctx, scope, { archived: true });
    expect(trash.map((e) => e.id)).toEqual([entry.id]);
  });

  it('unpublishes a live entry in the same step', async () => {
    const { entry } = await createEntry(ctx, scope, article('Live'));
    await publishEntry(ctx, scope, entry.id);

    const trashed = await trashEntry(ctx, scope, entry.id);
    expect(trashed.status).toBe('archived');
    expect(trashed.publishedVersion).toBeNull();
    // Gone from the delivery read model, not merely flagged.
    expect(await store.entries.getPublished(scope, entry.id)).toBeNull();
  });

  it('emits entry.unpublished so the worker clears cache and embeddings', async () => {
    const { entry } = await createEntry(ctx, scope, article('Live'));
    await publishEntry(ctx, scope, entry.id);
    const before = (await store.outbox.readPending(50)).length;

    await trashEntry(ctx, scope, entry.id);
    const events = await store.outbox.readPending(50);
    expect(events.slice(before).map((e) => e.type)).toContain('entry.unpublished');
  });

  it('is idempotent, so a retried request cannot fail', async () => {
    const { entry } = await createEntry(ctx, scope, article('Draft'));
    await trashEntry(ctx, scope, entry.id);
    await expect(trashEntry(ctx, scope, entry.id)).resolves.toMatchObject({ status: 'archived' });
  });

  it('refuses to edit a trashed entry', async () => {
    const { entry } = await createEntry(ctx, scope, article('Draft'));
    await trashEntry(ctx, scope, entry.id);
    await expect(
      updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'Nope' } }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('404s on an unknown entry', async () => {
    await expect(trashEntry(ctx, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('restoring an entry', () => {
  it('brings it back as a draft, never straight back to published', async () => {
    const { entry } = await createEntry(ctx, scope, article('Live'));
    await publishEntry(ctx, scope, entry.id);
    await trashEntry(ctx, scope, entry.id);

    const restored = await restoreEntry(ctx, scope, entry.id);
    // Re-publishing has to be a deliberate act, not a side effect of undelete.
    expect(restored.status).toBe('draft');
    expect(restored.publishedVersion).toBeNull();
    expect(await store.entries.getPublished(scope, entry.id)).toBeNull();
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(1);
  });

  it('keeps the entry editable again', async () => {
    const { entry } = await createEntry(ctx, scope, article('Draft'));
    await trashEntry(ctx, scope, entry.id);
    await restoreEntry(ctx, scope, entry.id);
    await expect(
      updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'Edited' } }),
    ).resolves.toBeTruthy();
  });

  it('refuses an entry that is not in the trash', async () => {
    const { entry } = await createEntry(ctx, scope, article('Draft'));
    await expect(restoreEntry(ctx, scope, entry.id)).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('purging an entry', () => {
  it('deletes the entry and every version of it', async () => {
    const { entry } = await createEntry(ctx, scope, article('Draft'));
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'v2' } });
    expect(await store.entries.listVersions(scope, entry.id)).toHaveLength(2);

    await trashEntry(ctx, scope, entry.id);
    await purgeEntry(ctx, scope, entry.id);

    await expect(getEntry(ctx, scope, entry.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.entries.listVersions(scope, entry.id)).toHaveLength(0);
    expect(await listPreviewEntries(ctx, scope, { archived: true })).toHaveLength(0);
  });

  it('refuses an entry that has not been trashed first', async () => {
    const { entry } = await createEntry(ctx, scope, article('Draft'));
    // Deleting permanently is always two deliberate steps.
    await expect(purgeEntry(ctx, scope, entry.id)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('refuses while a published entry still links to it, and names it', async () => {
    const { entry: target } = await createEntry(ctx, scope, article('Target'));
    const { entry: linker } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: {
        title: { 'en-US': 'Linker' },
        link: { 'en-US': { id: target.id, linkType: 'Entry' } },
      },
    });
    // Reference edges are written at publish time, so the link only counts
    // once the linking entry is live.
    await publishEntry(ctx, scope, linker.id);
    await trashEntry(ctx, scope, target.id);

    // Delivery resolves links per request, so a silent purge means broken
    // references on live pages.
    const err = await purgeEntry(ctx, scope, target.id).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toMatchObject({ referencedBy: [linker.id] });
  });

  it('is not blocked by a link from an unpublished draft', async () => {
    // Reference edges only exist for published entries, so this is the real
    // boundary of the guard: a draft linking here serves nothing to anyone, and
    // blocking on it would make trash impossible to empty in an active space.
    const { entry: target } = await createEntry(ctx, scope, article('Target'));
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: {
        title: { 'en-US': 'Draft linker' },
        link: { 'en-US': { id: target.id, linkType: 'Entry' } },
      },
    });
    await trashEntry(ctx, scope, target.id);
    await expect(purgeEntry(ctx, scope, target.id)).resolves.toBeUndefined();
  });

  it('deletes anyway when the caller forces it', async () => {
    const { entry: target } = await createEntry(ctx, scope, article('Target'));
    const { entry: linker } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: {
        title: { 'en-US': 'Linker' },
        link: { 'en-US': { id: target.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, linker.id);
    await trashEntry(ctx, scope, target.id);
    await expect(purgeEntry(ctx, scope, target.id, { force: true })).resolves.toBeUndefined();
    await expect(getEntry(ctx, scope, target.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('clears the entry taxonomy metadata', async () => {
    const { entry } = await createEntry(ctx, scope, article('Tagged'));
    const tag = await createTag(ctx, scope, { name: 'news' });
    await setEntryMetadata(ctx, scope, entry.id, { tags: [tag.id], concepts: [] });
    await trashEntry(ctx, scope, entry.id);
    await purgeEntry(ctx, scope, entry.id);

    const meta = await store.taxonomy.getEntryMetadata(scope, entry.id);
    expect(meta?.tags ?? []).toEqual([]);
  });
});

describe('duplicating an entry', () => {
  it('copies the fields into a new draft, marked as a copy', async () => {
    const { entry } = await createEntry(ctx, scope, article('Original'));
    await publishEntry(ctx, scope, entry.id);

    const copy = await duplicateEntry(ctx, scope, entry.id);
    expect(copy.entry.id).not.toBe(entry.id);
    // A copy of a published entry starts as a draft — publishing is deliberate.
    expect(copy.entry.status).toBe('draft');
    expect(copy.fields.title).toEqual({ 'en-US': 'Original (copy)' });
    // The original is untouched.
    expect((await getEntry(ctx, scope, entry.id)).fields.title).toEqual({ 'en-US': 'Original' });
  });

  it('carries taxonomy metadata across', async () => {
    const { entry } = await createEntry(ctx, scope, article('Tagged'));
    const tag = await createTag(ctx, scope, { name: 'news' });
    await setEntryMetadata(ctx, scope, entry.id, { tags: [tag.id], concepts: [] });

    const copy = await duplicateEntry(ctx, scope, entry.id);
    const meta = await store.taxonomy.getEntryMetadata(scope, copy.entry.id);
    expect(meta).toMatchObject({ tags: [tag.id] });
  });

  it('keeps the copy marker within a bounded display field', async () => {
    // A duplicate that failed validation because of the marker *we* added
    // would be our bug, so the title is trimmed to make room.
    store = new InMemoryContentStore();
    store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    await seed(12);

    const { entry } = await createEntry(ctx, scope, article('Abcdefghijkl'));
    const copy = await duplicateEntry(ctx, scope, entry.id);
    const title = (copy.fields.title as Record<string, string>)['en-US'] as string;
    expect(title.length).toBeLessThanOrEqual(12);
    expect(title.endsWith(' (copy)')).toBe(true);
  });

  it('duplicates every locale of a localized field', async () => {
    store = new InMemoryContentStore();
    store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] });
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    await seed();

    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello', 'de-DE': 'Hallo' } },
    });
    const copy = await duplicateEntry(ctx, scope, entry.id);
    expect(copy.fields.title).toEqual({ 'en-US': 'Hello (copy)', 'de-DE': 'Hallo (copy)' });
  });

  it('404s on an unknown entry', async () => {
    await expect(duplicateEntry(ctx, scope, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
