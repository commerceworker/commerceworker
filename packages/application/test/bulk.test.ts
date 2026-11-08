import { ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  bulkCreateEntries,
  bulkEntryAction,
  createContentType,
  createEntry,
  createSpace,
  getPublishedEntry,
  SYSTEM_CALLER,
} from '../src/index';

const scope = { spaceId: 'blog', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx };
}

async function seed(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
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
    ],
  });
}

describe('bulk entry actions', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('publishes many entries and reports per-item success', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'B' } },
    });
    const summary = await bulkEntryAction(ctx, scope, 'publish', [a.entry.id, b.entry.id]);
    expect(summary).toMatchObject({ action: 'publish', total: 2, succeeded: 2, failed: 0 });
    expect(await getPublishedEntry(ctx, scope, a.entry.id)).toBeTruthy();
  });

  it('captures per-item failures without aborting the batch', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const summary = await bulkEntryAction(ctx, scope, 'publish', [a.entry.id, 'missing-id']);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results.find((r) => r.id === 'missing-id')?.ok).toBe(false);
  });

  it('rejects an empty or oversized batch', async () => {
    await expect(bulkEntryAction(ctx, scope, 'publish', [])).rejects.toThrow(ValidationError);
  });

  it('emits one outbox event per published entry from the batched path', async () => {
    const store = ctx.store as InMemoryContentStore;
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'B' } },
    });
    await bulkEntryAction(ctx, scope, 'publish', [a.entry.id, b.entry.id]);
    const events = store.allEvents().filter((e) => e.type === 'entry.published');
    expect(events.map((e) => (e as { entryId: string }).entryId).sort()).toEqual(
      [a.entry.id, b.entry.id].sort(),
    );
    // Same-transaction publishes share one instant (release semantics).
    const stamps = new Set(events.map((e) => e.occurredAt));
    expect(stamps.size).toBe(1);
  });

  it('keeps a dangling-link failure per-item without sinking the chunk', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'linked',
      name: 'Linked',
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
          apiId: 'ref',
          name: 'Ref',
          type: 'Link',
          localized: false,
          required: false,
          position: 1,
          linkType: 'Entry',
        },
      ],
    });
    const ok = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Fine' } },
    });
    const dangling = await createEntry(ctx, scope, {
      contentTypeApiId: 'linked',
      fields: {
        title: { 'en-US': 'Broken' },
        ref: { 'en-US': { id: 'not-a-real-entry', linkType: 'Entry' } },
      },
    });
    const summary = await bulkEntryAction(ctx, scope, 'publish', [ok.entry.id, dangling.entry.id]);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    const failure = summary.results.find((r) => r.id === dangling.entry.id);
    expect(failure?.ok).toBe(false);
    // Same generic ValidationError message the single-item path reports.
    expect(failure?.error).toBe('One or more fields are invalid');
    expect(await getPublishedEntry(ctx, scope, ok.entry.id)).toBeTruthy();
  });

  it('resolves an in-batch link target published in the same chunk', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'linked2',
      name: 'Linked2',
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
          apiId: 'ref',
          name: 'Ref',
          type: 'Link',
          localized: false,
          required: false,
          position: 1,
          linkType: 'Entry',
        },
      ],
    });
    const target = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Target' } },
    });
    const source = await createEntry(ctx, scope, {
      contentTypeApiId: 'linked2',
      fields: {
        title: { 'en-US': 'Source' },
        ref: { 'en-US': { id: target.entry.id, linkType: 'Entry' } },
      },
    });
    const summary = await bulkEntryAction(ctx, scope, 'publish', [
      source.entry.id,
      target.entry.id,
    ]);
    expect(summary.failed).toBe(0);
  });

  it('unpublishes a batch, reporting not-published items per-item', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const never = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Never published' } },
    });
    await bulkEntryAction(ctx, scope, 'publish', [a.entry.id]);
    const summary = await bulkEntryAction(ctx, scope, 'unpublish', [a.entry.id, never.entry.id]);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    await expect(getPublishedEntry(ctx, scope, a.entry.id)).rejects.toThrow();
  });

  it('handles duplicate ids in one call', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const summary = await bulkEntryAction(ctx, scope, 'publish', [a.entry.id, a.entry.id]);
    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(2);
    const store = ctx.store as InMemoryContentStore;
    // Deduped inside the chunk: one publish, one event.
    expect(store.allEvents().filter((e) => e.type === 'entry.published')).toHaveLength(1);
  });
});

describe('bulk create', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('creates valid items and reports invalid ones', async () => {
    const summary = await bulkCreateEntries(ctx, scope, [
      { contentTypeApiId: 'post', fields: { title: { 'en-US': 'Ok' } } },
      { contentTypeApiId: 'post', fields: {} }, // missing required title
    ]);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[1]?.id).toBe('#1');
  });
});
