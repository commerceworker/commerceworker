import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import {
  type FieldDefinition,
  MAX_WHERE_CONDITIONS,
  parseQueryWhere,
  type QueryFilter,
} from '@commerceworker/domain';
import type { Clock, EntryQuery, IdGenerator } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Richer queries against D1: startsWith, between, component paths and AND/OR `where` trees.
 * Each must answer exactly as the in-memory engine does on the published and draft paths, push
 * down what it can (an OR only when every branch does), and keep the statement under D1's
 * 100-parameter cap at the largest tree the domain accepts.
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

const ROWS: Record<string, unknown>[] = [
  { title: 'Apple pie', views: 10, seo: { title: 'Apples', rank: 1 }, tags: ['food', 'sweet'] },
  { title: 'apricot jam', views: 30, seo: { title: 'Jam', rank: 2 } },
  {
    title: 'Banana bread',
    views: 50,
    blocks: [
      { _type: 'hero', heading: 'Bake it' },
      { _type: 'cta', label: 'Buy' },
    ],
  },
  { title: 'Cherry tart', views: 70, seo: { title: 'Tarts', rank: 3 }, tags: ['sweet'] },
  { title: 'Äpfel Strudel', views: 90, blocks: [{ _type: 'hero', heading: 'Ofen' }] },
  { title: '50% off', views: 5 },
  { title: 'İstanbul', views: 7 },
];

const QUERIES: { name: string; q: EntryQuery }[] = [
  { name: 'startsWith', q: { filters: [{ field: 'title', op: 'startsWith', value: 'AP' }] } },
  {
    name: 'startsWith mid-word',
    q: { filters: [{ field: 'title', op: 'startsWith', value: 'pie' }] },
  },
  {
    name: 'startsWith non-ASCII',
    q: { filters: [{ field: 'title', op: 'startsWith', value: 'äp' }] },
  },
  {
    name: 'startsWith dotted I',
    q: { filters: [{ field: 'title', op: 'startsWith', value: 'is' }] },
  },
  {
    name: 'startsWith literal %',
    q: { filters: [{ field: 'title', op: 'startsWith', value: '50%' }] },
  },
  {
    name: 'startsWith on a list',
    q: { filters: [{ field: 'tags', op: 'startsWith', value: 'swe' }] },
  },
  { name: 'between', q: { filters: [{ field: 'views', op: 'between', value: ['10', '50'] }] } },
  { name: 'path eq', q: { filters: [{ field: 'seo.title', op: 'eq', value: 'Jam' }] } },
  { name: 'path range', q: { filters: [{ field: 'seo.rank', op: 'gte', value: 2 }] } },
  { name: 'path match', q: { filters: [{ field: 'seo.title', op: 'match', value: 'TART' }] } },
  {
    name: 'path through blocks',
    q: { filters: [{ field: 'blocks.heading', op: 'eq', value: 'Ofen' }] },
  },
  { name: 'path exists', q: { filters: [{ field: 'blocks.label', op: 'exists', value: true }] } },
  { name: 'path order', q: { order: [{ field: 'seo.rank', direction: 'desc' }] } },
  {
    name: 'more component paths than SQL takes: the rest stay with the engine',
    q: {
      filters: [
        { field: 'seo.title', op: 'exists', value: true },
        { field: 'seo.rank', op: 'gte', value: 1 },
        { field: 'seo.title', op: 'match', value: 'a' },
        { field: 'blocks.heading', op: 'exists', value: false },
        { field: 'seo.rank', op: 'lte', value: 2 },
        { field: 'seo.title', op: 'startsWith', value: 'j' },
      ],
    },
  },
  {
    name: 'OR of pushable branches',
    q: {
      where: parseQueryWhere({
        or: [
          { field: 'title', op: 'startsWith', value: 'ch' },
          { field: 'seo.title', op: 'eq', value: 'Apples' },
        ],
      }),
    },
  },
  {
    name: 'OR with a branch left to the engine',
    q: {
      where: parseQueryWhere({
        or: [
          { field: 'title', op: 'eq', value: 'Banana bread' },
          { field: 'views', op: 'lt', value: 8 },
        ],
      }),
    },
  },
  {
    name: 'AND of OR groups, with filters',
    q: {
      filters: [{ field: 'views', op: 'gte', value: 10 }],
      where: parseQueryWhere({
        and: [
          {
            or: [
              { field: 'tags', value: 'sweet' },
              { field: 'blocks.label', op: 'exists' },
            ],
          },
          {
            or: [
              { field: 'title', op: 'match', value: 'a' },
              { field: 'seo.rank', op: 'eq', value: 9 },
            ],
          },
        ],
      }),
    },
  },
];

describe('richer queries on D1', { timeout: 60_000 }, () => {
  const runId = crypto.randomUUID();
  const scope = { spaceId: `w-${runId}`, environmentId: 'main' };
  const d1 = createD1Store(testDb);
  const mem = new InMemoryContentStore();

  beforeAll(async () => {
    for (const store of [d1, mem]) {
      const ctx: AppContext = { store, clock, ids: seqIds(`w-${runId}`) };
      await createSpace(ctx, { spaceId: scope.spaceId, name: 'W', defaultLocale: 'en-US' });
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId: 'page',
        name: 'Page',
        displayField: 'title',
        fields: [
          field({ apiId: 'title', type: 'Symbol' }),
          field({ apiId: 'views', type: 'Integer', position: 1 }),
          field({
            apiId: 'seo',
            type: 'Component',
            position: 2,
            fields: [
              field({ apiId: 'title', type: 'Symbol' }),
              field({ apiId: 'rank', type: 'Integer', position: 1 }),
            ],
          }),
          field({
            apiId: 'blocks',
            type: 'Array',
            position: 3,
            items: {
              type: 'Component',
              variants: [
                {
                  apiId: 'hero',
                  name: 'Hero',
                  fields: [field({ apiId: 'heading', type: 'Symbol' })],
                },
                { apiId: 'cta', name: 'CTA', fields: [field({ apiId: 'label', type: 'Symbol' })] },
              ],
            },
          }),
          field({ apiId: 'tags', type: 'Array', position: 4, items: { type: 'Symbol' } }),
        ],
      });
      await publishContentType(ctx, scope, 'page');
      for (const row of ROWS) {
        const e = await createEntry(ctx, scope, {
          contentTypeApiId: 'page',
          fields: Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, { 'en-US': v }]),
          ) as never,
        });
        await publishEntry(ctx, scope, e.entry.id);
      }
    }
  });

  for (const { name, q } of QUERIES) {
    it(`matches in-memory: ${name}`, async () => {
      const [a, b] = await Promise.all([
        d1.entries.listPublished(scope, q),
        mem.entries.listPublished(scope, q),
      ]);
      expect(a.map((r) => r.entryId)).toEqual(b.map((r) => r.entryId));
      const [c, d] = await Promise.all([d1.entries.list(scope, q), mem.entries.list(scope, q)]);
      expect(c.map((r) => r.entry.id)).toEqual(d.map((r) => r.entry.id));
    });
  }

  it('narrows in SQL: startsWith, paths and an all-pushable OR fit a scan cap', async () => {
    const tiny = createD1Store(testDb, { queryScanLimit: 2 });
    const broad: EntryQuery = { filters: [{ field: 'views', op: 'exists', value: true }] };
    await expect(tiny.entries.listPublished(scope, broad)).rejects.toMatchObject({
      code: 'query_too_broad',
    });
    for (const q of [QUERIES[0], QUERIES[7], QUERIES[10], QUERIES[14]]) {
      await expect(tiny.entries.listPublished(scope, q?.q as EntryQuery)).resolves.not.toHaveLength(
        0,
      );
      await expect(tiny.entries.list(scope, q?.q as EntryQuery)).resolves.not.toHaveLength(0);
    }
    // An OR with a branch SQL cannot test is not pushed at all: it scans, and says so.
    await expect(
      tiny.entries.listPublished(scope, QUERIES[15]?.q as EntryQuery),
    ).rejects.toMatchObject({ code: 'query_too_broad' });
  });

  it('stays under the parameter cap at the largest where and many filters', async () => {
    const leaf = (i: number): QueryFilter => ({
      field: i % 2 ? 'seo.title' : 'title',
      op: i % 3 ? 'match' : 'eq',
      value: `needle-${i}`,
    });
    const leaves = Array.from({ length: MAX_WHERE_CONDITIONS }, (_, i) => leaf(i));
    const where = parseQueryWhere({ and: leaves });
    const filters = Array.from({ length: 60 }, (_, i) => leaf(i + 100));
    // Unbudgeted, the filters alone would bind over 150 parameters. Every predicate matches
    // nothing, and one left to the engine still decides; what is under test is that D1 accepts
    // the statement.
    for (const q of [
      { where },
      { filters },
      { where, filters },
      { where: parseQueryWhere({ or: leaves }) },
    ] as EntryQuery[]) {
      await expect(d1.entries.listPublished(scope, q)).resolves.toEqual([]);
      await expect(d1.entries.list(scope, q)).resolves.toEqual([]);
    }
  });
});
