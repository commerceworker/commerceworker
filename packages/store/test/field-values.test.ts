import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createEntry,
  createSpace,
  listFieldValues,
  SYSTEM_CALLER,
  trashEntry,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import type { Clock, FieldValuesQuery, IdGenerator } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Distinct field values against D1: the grouped read matches the in-memory store row for row
 * (value types, order, counts, list elements, locales, the trash), pages with its cursor past a
 * page of 100, and reads one scope only.
 */

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const seqIds = (prefix: string): IdGenerator => {
  let n = 0;
  return { newId: () => `${prefix}-${String(++n).padStart(4, '0')}` };
};
const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

/** More distinct values than one page holds. */
const MANY = 130;

describe('distinct field values on D1', { timeout: 60_000 }, () => {
  const runId = crypto.randomUUID();
  const scope = { spaceId: `fv-${runId}`, environmentId: 'main' };
  const other = { spaceId: `fv-other-${runId}`, environmentId: 'main' };
  const d1 = createD1Store(testDb);
  const mem = new InMemoryContentStore();
  const d1Ctx: AppContext = { store: d1, clock, ids: seqIds(`fv-${runId}`) };

  async function seed(ctx: AppContext, s: typeof scope) {
    await createSpace(ctx, {
      spaceId: s.spaceId,
      name: 'FV',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de'],
    });
    await createContentType(ctx, SYSTEM_CALLER, s, {
      apiId: 'item',
      name: 'Item',
      displayField: 'name',
      fields: [
        field({ apiId: 'name', type: 'Symbol' }),
        field({ apiId: 'kind', type: 'Symbol', localized: true, position: 1 }),
        field({ apiId: 'score', type: 'Number', position: 2 }),
        field({ apiId: 'on', type: 'Boolean', position: 3 }),
        field({ apiId: 'tags', type: 'Array', items: { type: 'Symbol' }, position: 4 }),
      ],
    });
    const rows: Record<string, Record<string, unknown>>[] = [
      {
        kind: { 'en-US': 'b', de: 'ä' },
        score: { 'en-US': 5 },
        on: { 'en-US': true },
        tags: { 'en-US': ['t1', 't2'] },
      },
      {
        kind: { 'en-US': 'a' },
        score: { 'en-US': 5.0 },
        on: { 'en-US': false },
        tags: { 'en-US': ['t2', 't2'] },
      },
      { kind: { 'en-US': 'B' }, score: { 'en-US': 1.5 }, tags: { 'en-US': [] } },
      { kind: { 'en-US': 'trashed' } },
      ...Array.from({ length: MANY }, (_, i) => ({
        name: { 'en-US': `n-${String(i).padStart(3, '0')}` },
      })),
    ];
    const ids: string[] = [];
    for (const [i, f] of rows.entries()) {
      const e = await createEntry(ctx, s, {
        contentTypeApiId: 'item',
        fields: { name: { 'en-US': `row-${i}` }, ...f } as never,
      });
      ids.push(e.entry.id);
    }
    await trashEntry(ctx, s, ids[3] as string);
  }

  beforeAll(async () => {
    await seed(d1Ctx, scope);
    await seed({ store: mem, clock, ids: seqIds(`fv-${runId}`) }, scope);
    // Another space holding other values of the same field.
    await createSpace(d1Ctx, { spaceId: other.spaceId, name: 'O', defaultLocale: 'en-US' });
    await createContentType(d1Ctx, SYSTEM_CALLER, other, {
      apiId: 'item',
      name: 'Item',
      displayField: 'kind',
      fields: [field({ apiId: 'kind', type: 'Symbol' })],
    });
    await createEntry(d1Ctx, other, {
      contentTypeApiId: 'item',
      fields: { kind: { 'en-US': 'elsewhere' } },
    });
  });

  const base = { contentTypeApiId: 'item', limit: 500 };
  const queries: FieldValuesQuery[] = [
    { ...base, field: 'kind' },
    { ...base, field: 'kind', locale: 'de' },
    { ...base, field: 'score' },
    { ...base, field: 'on' },
    { ...base, field: 'tags' },
    { ...base, field: 'name' },
    { ...base, field: 'name', limit: 3, after: { value: 'n-050' } },
    { ...base, field: 'kind', after: { value: 'B' } },
    { ...base, field: 'score', after: { value: 1.5 } },
    { ...base, field: 'on', after: { value: false } },
    { ...base, field: 'nothing' },
  ];

  it('matches the in-memory store for every field shape', async () => {
    for (const q of queries) {
      const [a, b] = await Promise.all([
        d1.entries.distinctFieldValues(scope, q),
        mem.entries.distinctFieldValues(scope, q),
      ]);
      expect(a, JSON.stringify(q)).toEqual(b);
    }
  });

  it('counts entries, not occurrences, and leaves out the trash and other spaces', async () => {
    expect(await d1.entries.distinctFieldValues(scope, { ...base, field: 'kind' })).toEqual([
      { value: 'B', count: 1 },
      { value: 'a', count: 1 },
      { value: 'b', count: 1 },
      { value: 'ä', count: 1 },
    ]);
    expect(await d1.entries.distinctFieldValues(scope, { ...base, field: 'tags' })).toEqual([
      { value: 't1', count: 1 },
      { value: 't2', count: 2 },
    ]);
    expect(await d1.entries.distinctFieldValues(scope, { ...base, field: 'score' })).toEqual([
      { value: 1.5, count: 1 },
      { value: 5, count: 2 },
    ]);
  });

  it('refuses a type with more entries than the scan cap, as too broad', async () => {
    const tiny = createD1Store(testDb, { queryScanLimit: 2 });
    await expect(
      tiny.entries.distinctFieldValues(scope, { ...base, field: 'kind' }),
    ).rejects.toMatchObject({ code: 'query_too_broad' });
    // At the cap exactly, it answers: the other space's type holds one entry.
    await expect(
      createD1Store(testDb, { queryScanLimit: 1 }).entries.distinctFieldValues(other, {
        ...base,
        field: 'kind',
      }),
    ).resolves.toEqual([{ value: 'elsewhere', count: 1 }]);
  });

  it('pages past 100 values with the use-case’s cursor, each value once', async () => {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listFieldValues(d1Ctx, scope, 'item', 'name', {
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((i) => i.value));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(2);
    // The three named rows left out of the trash, and the many.
    expect(seen).toHaveLength(MANY + 3);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
