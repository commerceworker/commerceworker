import { HookRejectedError, ValidationError } from '@commerceworker/domain';
import type { HookDispatcher, HookName, HookResult } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  publishContentType,
  publishEntry,
  purgeEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };

/** Records every dispatch, and optionally answers one hook. */
function recorder(
  answer?: (hook: HookName, payload: unknown) => HookResult<unknown> | undefined,
): HookDispatcher & { calls: { hook: HookName; payload: unknown }[] } {
  const calls: { hook: HookName; payload: unknown }[] = [];
  return {
    calls,
    async dispatch<T>(hook: HookName, payload: T): Promise<HookResult<T>> {
      calls.push({ hook, payload });
      return (answer?.(hook, payload) as HookResult<T>) ?? { payload };
    },
  };
}

let store: InMemoryContentStore;

function ctxWith(hooks?: HookDispatcher): AppContext {
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e'), hooks };
}

async function seed(ctx: AppContext) {
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
      { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: false, position: 1 },
    ],
  } as Parameters<typeof createContentType>[3]);
  await publishContentType(ctx, scope, 'article');
}

const article = (title: string, extra: Record<string, unknown> = {}) => ({
  contentTypeApiId: 'article',
  fields: { title: { 'en-US': title }, ...extra },
});

beforeEach(() => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
});

describe('with no dispatcher configured', () => {
  it('leaves the write path untouched', async () => {
    const ctx = ctxWith();
    await seed(ctx);
    // The absence of hooks must cost nothing at all — not an empty dispatch.
    await expect(createEntry(ctx, scope, article('One'))).resolves.toBeTruthy();
  });
});

describe('entry:beforeSave', () => {
  it('fires on create and on update', async () => {
    const hooks = recorder();
    const ctx = ctxWith(hooks);
    await seed(ctx);
    const { entry } = await createEntry(ctx, scope, article('One'));
    await updateEntry(ctx, scope, entry.id, { title: { 'en-US': 'Two' } });

    const saves = hooks.calls.filter((c) => c.hook === 'entry:beforeSave');
    expect(saves).toHaveLength(2);
    // The update carries the entry id; the create cannot.
    expect(saves[1]?.payload).toMatchObject({ entryId: entry.id });
  });

  it('lets a hook rewrite fields, and still normalizes what it wrote', async () => {
    const ctx = ctxWith(
      recorder((hook, payload) =>
        hook === 'entry:beforeSave'
          ? {
              payload: {
                ...(payload as Record<string, unknown>),
                fields: {
                  ...((payload as { fields: Record<string, unknown> }).fields ?? {}),
                  slug: { 'en-US': 'Hello World' },
                },
              },
            }
          : undefined,
      ),
    );
    await seed(ctx);
    const { fields } = await createEntry(ctx, scope, article('One'));
    // The hook wrote unnormalized text; normalization runs after it.
    expect(fields.slug).toEqual({ 'en-US': 'hello-world' });
  });

  it('still validates whatever a hook produced', async () => {
    const ctx = ctxWith(
      recorder((hook, payload) =>
        hook === 'entry:beforeSave'
          ? { payload: { ...(payload as Record<string, unknown>), fields: {} } }
          : undefined,
      ),
    );
    await seed(ctx);
    // Title is required; a hook must not be able to store an invalid entry.
    await expect(createEntry(ctx, scope, article('One'))).rejects.toBeInstanceOf(ValidationError);
  });

  it('turns a veto with field issues into a ValidationError', async () => {
    const ctx = ctxWith(
      recorder(() => ({
        veto: { hook: 'linter', reason: 'no', issues: [{ field: 'title', message: 'too shouty' }] },
      })),
    );
    await seed(ctx);
    const err = await createEntry(ctx, scope, article('ONE')).catch((e) => e);
    // A hook's complaint about a field reaches the editor like a built-in one.
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toEqual([{ field: 'title', message: 'too shouty' }]);
  });

  it('turns a veto without issues into a HookRejectedError naming the hook', async () => {
    const ctx = ctxWith(
      recorder(() => ({ veto: { hook: 'moderation', reason: 'failed policy check' } })),
    );
    await seed(ctx);
    const err = await createEntry(ctx, scope, article('One')).catch((e) => e);
    expect(err).toBeInstanceOf(HookRejectedError);
    expect((err as HookRejectedError).hook).toBe('moderation');
    expect((err as Error).message).toBe('failed policy check');
  });

  it('writes nothing when the hook vetoes', async () => {
    const ctx = ctxWith(recorder(() => ({ veto: { hook: 'x', reason: 'no' } })));
    await seed(ctx);
    await createEntry(ctx, scope, article('One')).catch(() => {});
    const listed = await store.entries.list(scope, {});
    expect(listed).toHaveLength(0);
  });
});

describe('entry:beforePublish', () => {
  it('fires inside the transaction, so a veto rolls the publish back', async () => {
    const vetoing = recorder((hook) =>
      hook === 'entry:beforePublish'
        ? { veto: { hook: 'moderation', reason: 'flagged' } }
        : undefined,
    );
    const ctx = ctxWith(vetoing);
    await seed(ctx);
    const { entry } = await createEntry(ctx, scope, article('One'));

    await expect(publishEntry(ctx, scope, entry.id)).rejects.toBeInstanceOf(HookRejectedError);
    // Nothing partially applied: not the read model, not the outbox event.
    expect(await store.entries.getPublished(scope, entry.id)).toBeNull();
    const events = await store.outbox.readPending(50);
    expect(events.some((e) => e.type === 'entry.published')).toBe(false);
    expect((await store.entries.get(scope, entry.id))?.entry.status).toBe('draft');
  });

  it('publishes normally when the hook allows it', async () => {
    const ctx = ctxWith(recorder());
    await seed(ctx);
    const { entry } = await createEntry(ctx, scope, article('One'));
    await expect(publishEntry(ctx, scope, entry.id)).resolves.toMatchObject({
      status: 'published',
    });
  });
});

describe('entry:beforeTrash and entry:beforePurge', () => {
  it('can refuse a trash, leaving the entry alone', async () => {
    const ctx = ctxWith(
      recorder((hook) =>
        hook === 'entry:beforeTrash'
          ? { veto: { hook: 'retention', reason: 'on hold' } }
          : undefined,
      ),
    );
    await seed(ctx);
    const { entry } = await createEntry(ctx, scope, article('One'));
    await expect(trashEntry(ctx, scope, entry.id)).rejects.toBeInstanceOf(HookRejectedError);
    expect((await store.entries.get(scope, entry.id))?.entry.status).toBe('draft');
  });

  it('can refuse a permanent delete, which is the one that cannot be undone', async () => {
    const ctx = ctxWith(
      recorder((hook) =>
        hook === 'entry:beforePurge'
          ? { veto: { hook: 'legal-hold', reason: 'under litigation hold' } }
          : undefined,
      ),
    );
    await seed(ctx);
    const { entry } = await createEntry(ctx, scope, article('One'));
    await trashEntry(ctx, scope, entry.id);

    await expect(purgeEntry(ctx, scope, entry.id)).rejects.toBeInstanceOf(HookRejectedError);
    // Still recoverable.
    expect((await store.entries.get(scope, entry.id))?.entry.status).toBe('archived');
  });

  it('does not fire beforeTrash again for an already-trashed entry', async () => {
    const hooks = recorder();
    const ctx = ctxWith(hooks);
    await seed(ctx);
    const { entry } = await createEntry(ctx, scope, article('One'));
    await trashEntry(ctx, scope, entry.id);
    await trashEntry(ctx, scope, entry.id);
    // Trashing is idempotent, so the second call is a no-op end to end.
    expect(hooks.calls.filter((c) => c.hook === 'entry:beforeTrash')).toHaveLength(1);
  });
});

describe('asset:beforeCreate', () => {
  it('refuses before an upload URL is minted', async () => {
    const getUploadUrl = vi.fn();
    const blob = { getUploadUrl, getDownloadUrl: vi.fn(), delete: vi.fn() };
    const ctx = ctxWith(
      recorder(() => ({ veto: { hook: 'av-scan', reason: 'type not allowed' } })),
    );
    const { createAsset } = await import('../src/assets');

    await expect(
      createAsset(ctx, blob as never, scope, {
        fileName: 'x.exe',
        contentType: 'application/x-msdownload',
      }),
    ).rejects.toBeInstanceOf(HookRejectedError);
    // No signed URL handed out, no key reserved.
    expect(getUploadUrl).not.toHaveBeenCalled();
  });
});
