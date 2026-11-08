import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  updateContentType,
} from '@commerceworker/application';
import { ConflictError, type FieldDefinition } from '@commerceworker/domain';
import type { Clock, IdGenerator } from '@commerceworker/ports';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

// Blocks fields against D1: keys survive the round trip through the JSON
// columns, the draft list pages by entry id, and the variant-removal guard reads
// past one page of entries. The file shares one database, so ids are unique.

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };

const variant = (apiId: string, leaf: string) => ({
  apiId,
  name: apiId,
  fields: [
    { apiId: leaf, name: leaf, type: 'Symbol', localized: false, required: true, position: 0 },
  ],
});

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

describe('blocks fields on D1', () => {
  const store = createD1Store(testDb);
  const ctx: AppContext = { store, clock, ids };
  const scope = { spaceId: `b-${crypto.randomUUID()}`, environmentId: 'main' };
  const hero = variant('hero', 'heading');
  const cta = variant('cta', 'label');

  beforeAll(async () => {
    await createSpace(ctx, {
      spaceId: scope.spaceId,
      name: 'Blocks',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'landing',
      name: 'Landing',
      displayField: 'title',
      fields: fieldsWith([hero, cta]),
    });
    await publishContentType(ctx, scope, 'landing');
  });

  it('stores blocks with their _type and server-assigned _key', async () => {
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'landing',
      fields: {
        title: { 'en-US': 'Home' },
        body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] },
      },
    });
    const read = await getEntry(ctx, scope, created.entry.id);
    const [block] = (read.fields.body?.['en-US'] ?? []) as Record<string, unknown>[];
    expect(block?._type).toBe('hero');
    expect(typeof block?._key).toBe('string');
  });

  it('pages the draft list by entry id', async () => {
    const all: string[] = [];
    for (let after = ''; ; ) {
      const page = await store.entries.list(scope, {
        contentTypeApiId: 'landing',
        limit: 2,
        afterEntryId: after,
      });
      all.push(...page.map((e) => e.entry.id));
      if (page.length < 2) break;
      after = page[page.length - 1]?.entry.id ?? after;
    }
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('refuses to remove a variant an entry past the first page still uses', async () => {
    for (let i = 0; i < 105; i++) {
      await createEntry(ctx, scope, {
        contentTypeApiId: 'landing',
        fields: {
          title: { 'en-US': `P${i}` },
          body: { 'en-US': [{ _type: 'hero', heading: 'x' }] },
        },
      });
    }
    const last = await createEntry(ctx, scope, {
      contentTypeApiId: 'landing',
      fields: { title: { 'en-US': 'Last' }, body: { 'en-US': [{ _type: 'cta', label: 'Go' }] } },
    });
    await publishEntry(ctx, scope, last.entry.id);

    const err = await updateContentType(ctx, SYSTEM_CALLER, scope, 'landing', {
      fields: fieldsWith([hero]),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain(last.entry.id);
    expect((await store.contentTypes.get(scope, 'landing'))?.version).toBe(1);
  });
});
