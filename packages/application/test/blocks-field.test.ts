import { ConflictError, type FieldDefinition, ValidationError } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  getEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const staging = { spaceId: 's1', environmentId: 'staging' };
let ctx: AppContext;
let store: InMemoryContentStore;

const HERO = {
  apiId: 'hero',
  name: 'Hero',
  fields: [
    {
      apiId: 'heading',
      name: 'Heading',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
  ],
};
const CTA = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [
    {
      apiId: 'label',
      name: 'Label',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
  ],
};

const fieldsWith = (variants: readonly unknown[]) =>
  [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      localized: false,
      required: false,
      position: 1,
      items: { type: 'Component', variants },
    },
  ] as FieldDefinition[];

async function defineLanding(s = scope) {
  await createContentType(ctx, SYSTEM_CALLER, s, {
    apiId: 'landing',
    name: 'Landing',
    displayField: 'title',
    fields: fieldsWith([HERO, CTA]),
  });
  await publishContentType(ctx, s, 'landing');
}

const landing = (title: string, body: unknown[]) => ({
  contentTypeApiId: 'landing',
  fields: { title: { 'en-US': title }, body: { 'en-US': body } },
});

const bodyOf = (fields: Record<string, Record<string, unknown>>) =>
  fields.body?.['en-US'] as Record<string, unknown>[];

const dropCta = () =>
  updateContentType(ctx, SYSTEM_CALLER, scope, 'landing', { fields: fieldsWith([HERO]) });

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: 's1',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    environments: ['main', 'staging'],
  });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('id') };
  await defineLanding();
});

describe('block keys', () => {
  it('are assigned on create from the id generator', async () => {
    const { fields } = await createEntry(
      ctx,
      scope,
      landing('Home', [
        { _type: 'hero', heading: 'Hi' },
        { _type: 'cta', label: 'Go' },
      ]),
    );
    const keys = bodyOf(fields).map((b) => b._key);
    expect(keys.every((k) => typeof k === 'string' && k.startsWith('id-'))).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  it('are kept across an update that reorders blocks, and new blocks get one', async () => {
    const created = await createEntry(
      ctx,
      scope,
      landing('Home', [
        { _type: 'hero', heading: 'Hi' },
        { _type: 'cta', label: 'Go' },
      ]),
    );
    const [hero, cta] = bodyOf(created.fields);
    const updated = await updateEntry(ctx, scope, created.entry.id, {
      title: { 'en-US': 'Home' },
      body: { 'en-US': [cta, hero, { _type: 'cta', label: 'More' }] },
    });
    const body = bodyOf(updated.fields);
    expect(body[0]?._key).toBe(cta?._key);
    expect(body[1]?._key).toBe(hero?._key);
    expect(typeof body[2]?._key).toBe('string');
    expect(new Set(body.map((b) => b._key)).size).toBe(3);
  });

  it('keep a key the caller chose', async () => {
    const { fields } = await createEntry(
      ctx,
      scope,
      landing('Home', [{ _type: 'hero', _key: 'top', heading: 'Hi' }]),
    );
    expect(bodyOf(fields)[0]?._key).toBe('top');
  });

  it('refuse a duplicate key within one field value, and nothing is written', async () => {
    const err = await createEntry(
      ctx,
      scope,
      landing('Home', [
        { _type: 'hero', _key: 'same', heading: 'a' },
        { _type: 'cta', _key: 'same', label: 'b' },
      ]),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toEqual([
      { field: 'body[1]', locale: 'en-US', message: 'Duplicate _key "same"' },
    ]);
    expect(await store.entries.list(scope, { contentTypeApiId: 'landing' })).toEqual([]);
  });

  it('refuse a block of an unknown variant', async () => {
    const err = await createEntry(ctx, scope, landing('Home', [{ _type: 'quote' }])).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues[0]?.field).toBe('body[0]');
  });
});

describe('removing a variant', () => {
  it('is refused while an entry uses it, naming the entry', async () => {
    const { entry } = await createEntry(
      ctx,
      scope,
      landing('Home', [{ _type: 'cta', label: 'Go' }]),
    );
    const err = await dropCta().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain(`body: cta (entry ${entry.id})`);
    expect((err as ConflictError).details).toEqual({
      variantsInUse: [{ variant: 'body: cta', entries: [entry.id] }],
    });
    // The type is unchanged.
    const ct = await store.contentTypes.get(scope, 'landing');
    expect(ct?.fields[1]?.items?.variants?.map((v) => v.apiId)).toEqual(['hero', 'cta']);
  });

  it('is allowed once no entry uses it', async () => {
    await createEntry(ctx, scope, landing('Home', [{ _type: 'hero', heading: 'Hi' }]));
    const revised = await dropCta();
    expect(revised.fields[1]?.items?.variants?.map((v) => v.apiId)).toEqual(['hero']);
  });

  it('still counts the published snapshot when the draft no longer uses it', async () => {
    const { entry } = await createEntry(
      ctx,
      scope,
      landing('Home', [{ _type: 'cta', label: 'Go' }]),
    );
    await publishEntry(ctx, scope, entry.id);
    await updateEntry(ctx, scope, entry.id, {
      title: { 'en-US': 'Home' },
      body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] },
    });
    await expect(dropCta()).rejects.toBeInstanceOf(ConflictError);
    // Publishing the edit retires the last copy that used it.
    await publishEntry(ctx, scope, entry.id);
    await expect(dropCta()).resolves.toBeDefined();
  });

  it('counts an entry in the trash, which can be restored', async () => {
    const { entry } = await createEntry(
      ctx,
      scope,
      landing('Home', [{ _type: 'cta', label: 'Go' }]),
    );
    await trashEntry(ctx, scope, entry.id);
    await expect(dropCta()).rejects.toThrow(entry.id);
  });

  it('ignores entries in another environment', async () => {
    await defineLanding(staging);
    await createEntry(ctx, staging, landing('Staged', [{ _type: 'cta', label: 'Go' }]));
    await expect(dropCta()).resolves.toBeDefined();
  });

  it('reads past the first page of entries', async () => {
    for (let i = 0; i < 120; i++) {
      await createEntry(ctx, scope, landing(`P${i}`, [{ _type: 'hero', heading: 'x' }]));
    }
    const { entry } = await createEntry(
      ctx,
      scope,
      landing('Last', [{ _type: 'cta', label: 'Go' }]),
    );
    await expect(dropCta()).rejects.toThrow(entry.id);
  });

  it('leaves adding a variant or an optional field always allowed', async () => {
    await createEntry(ctx, scope, landing('Home', [{ _type: 'cta', label: 'Go' }]));
    const quote = {
      apiId: 'quote',
      name: 'Quote',
      fields: [
        {
          apiId: 'text',
          name: 'Text',
          type: 'Text',
          localized: false,
          required: false,
          position: 0,
        },
      ],
    };
    const ctaPlus = {
      ...CTA,
      fields: [
        ...CTA.fields,
        {
          apiId: 'note',
          name: 'Note',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    };
    await expect(
      updateContentType(ctx, SYSTEM_CALLER, scope, 'landing', {
        fields: fieldsWith([HERO, ctaPlus, quote]),
      }),
    ).resolves.toBeDefined();
    const found = await getEntry(ctx, scope, (await store.entries.list(scope, {}))[0]!.entry.id);
    expect(bodyOf(found.fields)[0]?._type).toBe('cta');
  });
});
