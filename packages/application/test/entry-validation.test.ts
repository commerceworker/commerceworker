import {
  ConflictError,
  HookRejectedError,
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import type { HookDispatcher, HookDispatchOptions, HookResult } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  publishContentType,
  SYSTEM_CALLER,
  trashEntry,
  updateEntry,
  validateEntry,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const other = { spaceId: 's1', environmentId: 'staging' };

let ctx: AppContext;
let store: InMemoryContentStore;

async function seed(hooks?: HookDispatcher) {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e'), hooks };
  for (const s of [scope, other]) {
    await createContentType(ctx, SYSTEM_CALLER, s, {
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
        {
          apiId: 'slug',
          name: 'Slug',
          type: 'Slug',
          localized: false,
          required: false,
          unique: true,
          position: 1,
        },
        {
          apiId: 'kind',
          name: 'Kind',
          type: 'Symbol',
          localized: false,
          required: false,
          defaultValue: 'news',
          position: 2,
        },
      ],
    } as Parameters<typeof createContentType>[3]);
    await publishContentType(ctx, s, 'article');
  }
}

const article = (title: string, fields: Record<string, unknown> = {}) => ({
  contentTypeApiId: 'article',
  fields: { title: { 'en-US': title }, ...fields },
});

/** Every write the store offers an entry save, watched: a dry run must call none of them. */
function watchWrites() {
  return [
    vi.spyOn(store, 'withTransaction'),
    vi.spyOn(store.entries, 'create'),
    vi.spyOn(store.entries, 'saveVersion'),
    vi.spyOn(store.entries, 'saveAggregate'),
    vi.spyOn(store.entries, 'replaceUniqueClaims'),
  ];
}

/** What a promise rejected with, for comparing a dry run's failure with a save's. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe('validating a new entry', () => {
  beforeEach(() => seed());

  it('answers with the fields a create would store, and writes nothing', async () => {
    const writes = watchWrites();
    const events = store.allEvents().length;

    const result = await validateEntry(
      ctx,
      scope,
      article('Hello', { slug: { 'en-US': 'Hello World' } }),
    );

    expect(result).toEqual({
      valid: true,
      // The default applied and the slug normalized, as a create would.
      fields: {
        title: { 'en-US': 'Hello' },
        slug: { 'en-US': 'hello-world' },
        kind: { 'en-US': 'news' },
      },
      skippedHooks: [],
    });
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(store.allEvents()).toHaveLength(events);
    expect(await store.entries.list(scope, {})).toHaveLength(0);
  });

  it('fails exactly as the create would', async () => {
    const input = { contentTypeApiId: 'article', fields: { slug: { 'en-US': 'x' } } };
    const dry = await failure(validateEntry(ctx, scope, input));
    const real = await failure(createEntry(ctx, scope, input));

    expect(dry).toBeInstanceOf(ValidationError);
    expect((dry as ValidationError).issues).toEqual((real as ValidationError).issues);
  });

  it('reports a unique value another entry holds, as the create would', async () => {
    const holder = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    const input = article('Two', { slug: { 'en-US': 'about' } });

    const dry = await failure(validateEntry(ctx, scope, input));
    const real = await failure(createEntry(ctx, scope, input));
    expect(dry).toBeInstanceOf(ConflictError);
    expect((dry as Error).message).toBe((real as Error).message);
    expect((dry as Error).message).toContain(holder.entry.id);
  });

  it('judges unique values within its own environment only', async () => {
    await createEntry(ctx, other, article('Elsewhere', { slug: { 'en-US': 'about' } }));
    await expect(
      validateEntry(ctx, scope, article('Here', { slug: { 'en-US': 'about' } })),
    ).resolves.toMatchObject({ valid: true });
  });

  it('refuses a content type that does not exist', async () => {
    await expect(
      validateEntry(ctx, scope, { contentTypeApiId: 'nope', fields: {} }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('validating a new version of an entry', () => {
  beforeEach(() => seed());

  it('does not collide with its own unique values, and writes nothing', async () => {
    const { entry } = await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    const writes = watchWrites();

    const result = await validateEntry(ctx, scope, {
      entryId: entry.id,
      fields: { title: { 'en-US': 'One, edited' }, slug: { 'en-US': 'about' } },
    });

    // No defaults on an update: the fields sent are the whole new version.
    expect(result.fields).toEqual({
      title: { 'en-US': 'One, edited' },
      slug: { 'en-US': 'about' },
    });
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect((await store.entries.get(scope, entry.id))?.entry.currentVersion).toBe(1);
  });

  it("reports another entry's unique value, as the update would", async () => {
    await createEntry(ctx, scope, article('One', { slug: { 'en-US': 'about' } }));
    const { entry } = await createEntry(ctx, scope, article('Two', { slug: { 'en-US': 'two' } }));
    const fields = { title: { 'en-US': 'Two' }, slug: { 'en-US': 'about' } };

    const dry = await failure(validateEntry(ctx, scope, { entryId: entry.id, fields }));
    const real = await failure(updateEntry(ctx, scope, entry.id, fields));
    expect(dry).toBeInstanceOf(ConflictError);
    expect((dry as Error).message).toBe((real as Error).message);
  });

  it('refuses an entry in the trash, as the update would', async () => {
    const { entry } = await createEntry(ctx, scope, article('One'));
    await trashEntry(ctx, scope, entry.id);
    await expect(
      validateEntry(ctx, scope, { entryId: entry.id, fields: { title: { 'en-US': 'x' } } }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('refuses an entry of another environment', async () => {
    const { entry } = await createEntry(ctx, other, article('Elsewhere'));
    await expect(
      validateEntry(ctx, scope, { entryId: entry.id, fields: { title: { 'en-US': 'x' } } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('entry:beforeSave on a dry run', () => {
  /** Answers the hook as `answer` says, recording the options each dispatch was given. */
  function hooks(answer: (payload: { fields: Record<string, unknown> }) => HookResult<unknown>) {
    const options: (HookDispatchOptions | undefined)[] = [];
    const dispatcher: HookDispatcher = {
      async dispatch<T>(_hook: string, payload: T, _scope: unknown, o?: HookDispatchOptions) {
        options.push(o);
        return answer(payload as never) as HookResult<T>;
      },
    };
    return { dispatcher, options };
  }

  it('asks for effect-free handlers only, and says which were left out', async () => {
    const h = hooks((p) => ({
      payload: { ...p, fields: { ...p.fields, slug: { 'en-US': 'From Hook' } } },
      skipped: ['com.example.writer'],
    }));
    await seed(h.dispatcher);

    const result = await validateEntry(ctx, scope, article('Hello'));
    expect(h.options).toEqual([{ pureOnly: true }]);
    // What a handler rewrote is normalized and judged, as on a save.
    expect(result.fields.slug).toEqual({ 'en-US': 'from-hook' });
    expect(result.skippedHooks).toEqual(['com.example.writer']);

    // A real save asks for every handler.
    await createEntry(ctx, scope, article('Hello'));
    expect(h.options[1]).toBeUndefined();
  });

  it("raises a handler's field objection as a validation failure", async () => {
    const h = hooks(() => ({
      veto: { hook: 'p', reason: 'no', issues: [{ field: 'title', message: 'Too dull' }] },
    }));
    await seed(h.dispatcher);
    const err = await failure(validateEntry(ctx, scope, article('Hello')));
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toEqual([{ field: 'title', message: 'Too dull' }]);
  });

  it("raises a handler's plain refusal as the save would", async () => {
    const h = hooks(() => ({ veto: { hook: 'p', reason: 'Embargoed' } }));
    await seed(h.dispatcher);
    await expect(validateEntry(ctx, scope, article('Hello'))).rejects.toBeInstanceOf(
      HookRejectedError,
    );
  });
});
