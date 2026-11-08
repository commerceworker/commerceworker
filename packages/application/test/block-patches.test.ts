import {
  ConflictError,
  type FieldDefinition,
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  ValidationError,
} from '@commerceworker/domain';
import type { HookResult } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  BLOCK_PATCH_MAX_OPS,
  type BlockOpInput,
  checkEntryBlocks,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  getEntry,
  outlineEntryBlocks,
  patchEntryBlocks,
  publishContentType,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
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

const hero = { apiId: 'hero', name: 'Hero', fields: [field({ apiId: 'heading', type: 'Symbol' })] };
const cta = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [field({ apiId: 'label', type: 'Symbol', required: true })],
};

let store: InMemoryContentStore;
let ctx: AppContext;

const defineLanding = async (at = scope) => {
  await createContentType(ctx, SYSTEM_CALLER, at, {
    apiId: 'landing',
    name: 'Landing',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      field({
        apiId: 'body',
        type: 'Array',
        position: 1,
        items: { type: 'Component', variants: [hero, cta] },
      }),
      field({
        apiId: 'aside',
        type: 'Array',
        position: 2,
        items: { type: 'Component', variants: [cta] },
      }),
    ],
  });
  await publishContentType(ctx, at, 'landing');
};

/** A landing page with a hero and a call to action; returns its id and the keys they were given. */
const landing = async (at = scope) => {
  const { entry, fields } = await createEntry(ctx, at, {
    contentTypeApiId: 'landing',
    fields: {
      title: { 'en-US': 'Home' },
      body: {
        'en-US': [
          { _type: 'hero', heading: 'Welcome' },
          { _type: 'cta', label: 'Sign up' },
        ],
      },
    },
  });
  const [h, c] = ((fields.body?.['en-US'] ?? []) as { _key: string }[]).map((b) => b._key);
  return { id: entry.id, version: entry.currentVersion, hero: h as string, cta: c as string };
};

const versions = async (id: string, at = scope) =>
  (await store.entries.listVersions(at, id)).length;

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
};

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('t') };
  await createSpace(ctx, {
    spaceId: 'site',
    name: 'Site',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
  });
  await defineLanding();
});

describe('patching an entry’s blocks', () => {
  it('saves the ops as one new draft version, with keys from ctx.ids and the refs’ keys', async () => {
    const page = await landing();
    const saved = await patchEntryBlocks(ctx, scope, page.id, {
      expectedVersion: page.version,
      ops: [
        {
          op: 'insert',
          field: 'body',
          after: page.hero,
          block: { _type: 'cta', label: 'Docs' },
          ref: 'docs',
        },
        { op: 'update', field: 'body', key: page.hero, set: { heading: 'Hello' } },
      ],
    });
    expect(saved.entry.currentVersion).toBe(page.version + 1);
    const docsKey = saved.keys.docs as string;
    expect(docsKey).toMatch(/^t-\d+$/);
    expect(saved.fields.body?.['en-US']).toEqual([
      { _type: 'hero', _key: page.hero, heading: 'Hello' },
      { _type: 'cta', _key: docsKey, label: 'Docs' },
      { _type: 'cta', _key: page.cta, label: 'Sign up' },
    ]);
    // What was answered is what was stored, and every other field kept its value.
    expect((await getEntry(ctx, scope, page.id)).fields).toEqual(saved.fields);
    expect(saved.fields.title).toEqual({ 'en-US': 'Home' });
    expect(await versions(page.id)).toBe(2);
  });

  it('answers the ops that undo it, which a second patch can apply', async () => {
    const page = await landing();
    const before = (await getEntry(ctx, scope, page.id)).fields;
    const saved = await patchEntryBlocks(ctx, scope, page.id, {
      expectedVersion: page.version,
      ops: [
        { op: 'duplicate', field: 'body', key: page.hero },
        { op: 'remove', field: 'body', key: page.cta },
      ],
    });
    expect(saved.inverse).not.toBeNull();
    const undone = await patchEntryBlocks(ctx, scope, page.id, {
      expectedVersion: saved.entry.currentVersion,
      ops: saved.inverse ?? [],
    });
    expect(undone.fields).toEqual(before);
  });

  it('offers no undo when a beforeSave plugin rewrote the blocks it saved', async () => {
    const page = await landing();
    type Saving = { fields: Record<string, Record<string, unknown>> };
    const relabel = (fields: Saving['fields']) => ({
      ...fields,
      body: {
        'en-US': ((fields.body?.['en-US'] ?? []) as Record<string, unknown>[]).map((b) =>
          b._type === 'cta' ? { ...b, label: 'Rewritten' } : b,
        ),
      },
    });
    const hooked: AppContext = {
      ...ctx,
      hooks: {
        async dispatch<T>(hook: string, payload: T): Promise<HookResult<T>> {
          if (hook !== 'entry:beforeSave') return { payload };
          const saving = payload as unknown as Saving;
          return { payload: { ...saving, fields: relabel(saving.fields) } as unknown as T };
        },
      },
    };
    const saved = await patchEntryBlocks(hooked, scope, page.id, {
      expectedVersion: page.version,
      ops: [{ op: 'insert', field: 'body', block: { _type: 'cta', label: 'More' } }],
    });
    // The plugin's labels are what was stored; an undo built from the patch would not restore them.
    expect(
      ((saved.fields.body?.['en-US'] ?? []) as { label?: string }[]).map((b) => b.label),
    ).toEqual([undefined, 'Rewritten', 'Rewritten']);
    expect(saved.inverse).toBeNull();
    // A plugin that leaves the blocks alone keeps the undo.
    const plain = await patchEntryBlocks(
      { ...ctx, hooks: { dispatch: async <T>(_h: string, payload: T) => ({ payload }) } },
      scope,
      page.id,
      {
        expectedVersion: saved.entry.currentVersion,
        ops: [{ op: 'update', field: 'body', key: page.hero, set: { heading: 'Hi' } }],
      },
    );
    expect(plain.inverse).toEqual([
      {
        op: 'update',
        field: 'body',
        locale: 'en-US',
        key: page.hero,
        set: { heading: 'Welcome' },
      },
    ]);
  });

  it('refuses a patch built on a version that is no longer current, saving nothing', async () => {
    const page = await landing();
    await patchEntryBlocks(ctx, scope, page.id, {
      expectedVersion: page.version,
      ops: [{ op: 'remove', field: 'body', key: page.cta }],
    });
    const err = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'remove', field: 'body', key: page.hero }],
      }),
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).details).toEqual({ currentVersion: 2, expectedVersion: 1 });
    expect(await versions(page.id)).toBe(2);
  });

  it('loses a race for the version as a 409, not as a save over the other one', async () => {
    const page = await landing();
    // D1 refuses a second save of the same version number; the in-memory store doesn't, so stand
    // in for the writer that got there first.
    const save = store.entries.saveVersion;
    store.entries.saveVersion = async () => {
      throw new ConflictError('Version 2 was saved by another writer');
    };
    const err = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'remove', field: 'body', key: page.cta }],
      }),
    );
    store.entries.saveVersion = save;
    expect(err).toBeInstanceOf(ConflictError);
    expect(await versions(page.id)).toBe(1);
  });

  it('refuses an op on a field the caller may not write, before applying anything', async () => {
    const page = await landing();
    const err = await refusal(
      patchEntryBlocks(
        ctx,
        scope,
        page.id,
        {
          expectedVersion: page.version,
          ops: [
            { op: 'insert', field: 'aside', block: { _type: 'cta', label: 'x' } },
            { op: 'remove', field: 'body', key: page.cta },
          ],
        },
        { unwritable: ['body'] },
      ),
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toContain('content:write:landing.body');
    expect(await versions(page.id)).toBe(1);
  });

  it('is all-or-nothing: an op that can’t apply refuses the patch with its index', async () => {
    const page = await landing();
    const err = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [
          { op: 'remove', field: 'body', key: page.hero },
          { op: 'insert', field: 'body', block: { _type: 'section' } },
        ],
      }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toEqual([
      {
        op: 1,
        field: 'ops[1]',
        locale: 'en-US',
        code: 'type_not_allowed',
        message: 'A "section" block can’t go here (one of: hero, cta)',
      },
    ]);
    expect(await versions(page.id)).toBe(1);
    expect((await getEntry(ctx, scope, page.id)).fields.body?.['en-US']).toHaveLength(2);
  });

  it('holds the result to the content model, as any save does', async () => {
    const page = await landing();
    const err = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'update', field: 'body', key: page.cta, unset: ['label'] }],
      }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues[0]).toMatchObject({
      field: 'body[1].label',
      message: 'Field is required',
      // The block it falls in, by key: positions say nothing once a patch moves blocks.
      block: { key: page.cta, type: 'cta', path: 'label' },
    });
    expect(await versions(page.id)).toBe(1);
  });

  it('says what it refused: a read-only field by name, fields the caller can’t read by count', async () => {
    const page = await landing();
    const readOnly = await refusal(
      patchEntryBlocks(
        ctx,
        scope,
        page.id,
        {
          expectedVersion: page.version,
          ops: [{ op: 'remove', field: 'body', key: page.cta }],
        },
        { unwritable: ['body'] },
      ),
    );
    expect((readOnly as ForbiddenError).details).toEqual({ reason: 'read_only', field: 'body' });
    const hidden = await refusal(
      patchEntryBlocks(
        ctx,
        scope,
        page.id,
        {
          expectedVersion: page.version,
          ops: [
            { op: 'remove', field: 'body', key: page.cta },
            { op: 'insert', field: 'aside', block: { _type: 'cta', label: 'x' } },
          ],
        },
        { unwritable: ['body', 'aside'], unreadable: ['aside'] },
      ),
    );
    // Counted, never named: the caller can't read it.
    expect((hidden as ForbiddenError).details).toEqual({ reason: 'hidden', hidden: 1 });
    expect((hidden as Error).message).not.toContain('aside');
    expect(await versions(page.id)).toBe(1);
  });

  it('defaults the locale and refuses one the field can’t hold', async () => {
    const page = await landing();
    const err = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [
          { op: 'remove', field: 'body', locale: 'fr', key: page.cta },
          { op: 'remove', field: 'body', locale: 'de', key: page.cta },
        ],
      }),
    );
    expect((err as ValidationError).issues).toEqual([
      {
        op: 0,
        field: 'ops[0]',
        locale: 'fr',
        code: 'bad_locale',
        message: '"fr" is not one of this space’s locales',
      },
      {
        op: 1,
        field: 'ops[1]',
        locale: 'de',
        code: 'bad_locale',
        message: '"body" is not localized; only en-US is allowed',
      },
    ]);
  });

  it('caps a patch at 100 ops and 64KB', async () => {
    const page = await landing();
    const remove: BlockOpInput = { op: 'remove', field: 'body', key: page.cta };
    const many = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: Array.from({ length: BLOCK_PATCH_MAX_OPS + 1 }, () => remove),
      }),
    );
    expect((many as ValidationError).issues).toEqual([
      { field: 'ops', message: 'At most 100 ops per patch' },
    ]);
    const large = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'insert', field: 'body', block: { _type: 'cta', label: 'x'.repeat(70_000) } }],
      }),
    );
    expect((large as ValidationError).issues).toEqual([
      { field: 'ops', message: 'Ops exceed 65536 bytes' },
    ]);
    const none = await refusal(
      patchEntryBlocks(ctx, scope, page.id, { expectedVersion: page.version, ops: [] }),
    );
    expect((none as ValidationError).issues).toEqual([
      { field: 'ops', message: 'No ops to apply' },
    ]);
  });

  it('refuses an entry in the trash', async () => {
    const page = await landing();
    const trashed = await trashEntry(ctx, scope, page.id);
    const err = await refusal(
      patchEntryBlocks(ctx, scope, page.id, {
        expectedVersion: trashed.currentVersion,
        ops: [{ op: 'remove', field: 'body', key: page.cta }],
      }),
    );
    expect(err).toBeInstanceOf(InvalidStateError);
  });

  it('never reaches an entry of another environment', async () => {
    await createEnvironment(ctx, 'site', 'staging');
    const page = await landing();
    const err = await refusal(
      patchEntryBlocks(ctx, staging, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'remove', field: 'body', key: page.cta }],
      }),
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(await versions(page.id)).toBe(1);
    await expect(outlineEntryBlocks(ctx, staging, page.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a refusal about fields the caller can’t read', () => {
  /** A memo whose `notes` the caller's role denies, stored empty, then made required. */
  const memo = async () => {
    const def = (required: boolean) => [
      field({ apiId: 'title', type: 'Symbol' }),
      field({
        apiId: 'body',
        type: 'Array',
        position: 1,
        items: { type: 'Component', variants: [hero, cta] },
      }),
      field({ apiId: 'notes', type: 'Symbol', position: 2, required }),
    ];
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'memo',
      name: 'Memo',
      displayField: 'title',
      fields: def(false),
    });
    await publishContentType(ctx, scope, 'memo');
    const { entry, fields } = await createEntry(ctx, scope, {
      contentTypeApiId: 'memo',
      fields: {
        title: { 'en-US': 'Memo' },
        body: { 'en-US': [{ _type: 'cta', label: 'Go' }] },
      },
    });
    // Someone else's rule: the stored entry now fails it in a field this caller can't see.
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'memo', { fields: def(true) });
    await publishContentType(ctx, scope, 'memo');
    const key = ((fields.body?.['en-US'] ?? []) as { _key: string }[])[0]?._key as string;
    return { id: entry.id, version: entry.currentVersion, key };
  };
  const restricted = { unwritable: ['notes'], unreadable: ['notes'] };

  it.each([
    ['the patch', patchEntryBlocks],
    ['its dry run', checkEntryBlocks],
  ] as const)('counts them in %s and never names them', async (_name, run) => {
    const m = await memo();
    const err = await refusal(
      run(
        ctx,
        scope,
        m.id,
        {
          expectedVersion: m.version,
          ops: [{ op: 'update', field: 'body', key: m.key, set: { label: 'Went' } }],
        },
        restricted,
      ),
    );
    expect(err).toBeInstanceOf(ValidationError);
    const issues = (err as ValidationError).issues;
    expect(issues).toEqual([expect.objectContaining({ field: '', code: 'hidden', hidden: 1 })]);
    // Neither the field, its path, nor a block in it.
    expect(JSON.stringify(issues)).not.toContain('notes');
    expect(issues.some((i) => 'block' in i)).toBe(false);
  });

  it('names them to a caller who can read them', async () => {
    const m = await memo();
    const err = await refusal(
      checkEntryBlocks(ctx, scope, m.id, {
        expectedVersion: m.version,
        ops: [{ op: 'update', field: 'body', key: m.key, set: { label: 'Went' } }],
      }),
    );
    expect((err as ValidationError).issues[0]).toMatchObject({ field: 'notes' });
  });
});

describe('checking a block patch without saving it', () => {
  it('answers the fields the save would store, the applied ops and the refs’ keys, and writes nothing', async () => {
    const page = await landing();
    const checked = await checkEntryBlocks(ctx, scope, page.id, {
      expectedVersion: page.version,
      ops: [
        { op: 'insert', field: 'body', block: { _type: 'cta', label: 'Docs' }, ref: 'docs' },
        { op: 'move', field: 'body', key: 'docs', to: { index: 0 } },
      ],
    });
    const key = checked.keys.docs as string;
    expect(checked.fields.body?.['en-US']).toEqual([
      { _type: 'cta', _key: key, label: 'Docs' },
      { _type: 'hero', _key: page.hero, heading: 'Welcome' },
      { _type: 'cta', _key: page.cta, label: 'Sign up' },
    ]);
    // Resolved as the save resolves them: the default locale, keys for refs.
    expect(checked.applied[1]).toEqual({
      op: 'move',
      field: 'body',
      locale: 'en-US',
      key,
      to: { index: 0 },
    });
    expect(await versions(page.id)).toBe(1);
  });

  it('refuses what the save refuses: a moved draft, an unwritable field, a bad locale, a model rule', async () => {
    const page = await landing();
    const remove: BlockOpInput = { op: 'remove', field: 'body', key: page.cta };
    expect(
      await refusal(checkEntryBlocks(ctx, scope, page.id, { expectedVersion: 9, ops: [remove] })),
    ).toBeInstanceOf(ConflictError);
    expect(
      await refusal(
        checkEntryBlocks(
          ctx,
          scope,
          page.id,
          { expectedVersion: page.version, ops: [remove] },
          { unwritable: ['body'] },
        ),
      ),
    ).toBeInstanceOf(ForbiddenError);
    const locale = await refusal(
      checkEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [{ ...remove, locale: 'fr' }],
      }),
    );
    expect((locale as ValidationError).issues[0]).toMatchObject({ op: 0, locale: 'fr' });
    // The content model's own rule, judged as a save judges it.
    const invalid = await refusal(
      checkEntryBlocks(ctx, scope, page.id, {
        expectedVersion: page.version,
        ops: [{ op: 'update', field: 'body', key: page.cta, unset: ['label'] }],
      }),
    );
    expect((invalid as ValidationError).issues[0]).toMatchObject({ field: 'body[1].label' });
    expect(await versions(page.id)).toBe(1);
  });
});

describe('outlining an entry’s blocks', () => {
  it('answers each blocks field’s tree with the version a patch passes back', async () => {
    const page = await landing();
    expect(await outlineEntryBlocks(ctx, scope, page.id, { field: 'body' })).toEqual({
      entryId: page.id,
      version: page.version,
      fields: {
        body: {
          'en-US': [
            { key: page.hero, type: 'hero', name: 'Hero', label: 'Welcome', path: 'body[0]' },
            {
              key: page.cta,
              type: 'cta',
              name: 'Call to action',
              label: 'Sign up',
              path: 'body[1]',
            },
          ],
        },
      },
    });
  });
});
