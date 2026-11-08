import type { AppContext } from '@commerceworker/application';
import {
  createContentType,
  createEntry,
  createSpace,
  publishEntry,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { Clock, EntryQuery, IdGenerator } from '@commerceworker/ports';
import { InMemoryContentStore } from '@commerceworker/test-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

const uuidv7 = () => crypto.randomUUID();

/**
 * D1 ≡ in-memory equivalence for field-level queries.
 *
 * The D1 adapter pushes SUPERSET prefilters into SQL and lets the domain
 * engine decide exactly; the in-memory store runs the engine over everything.
 * Both must therefore return identical results for every query shape — this
 * suite is what proves a prefilter never dropped a row it shouldn't have.
 */

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
/**
 * Deterministic per-store sequence: both stores mint identical entry ids for
 * the same fixture order, so results compare row-for-row. The prefix carries a
 * full random uuid because these ids also become outbox event ids (a globally
 * unique key, not scoped per space).
 */
const seqIds = (prefix: string): IdGenerator => {
  let n = 0;
  return { newId: () => `${prefix}-${++n}` };
};

/** Rows chosen to exercise the engine's tricky semantics: mixed value types,
 *  string/number coercion, arrays, missing fields, multiple locales. */
const FIXTURES = [
  { title: 'Alpha guide', tag: 'red', views: 10, live: true, locales: { de: 'Alpha Anleitung' } },
  { title: 'Beta guide', tag: 'blue', views: 5, live: false },
  { title: 'Gamma handbook', tag: 'red', views: 100, live: true },
  { title: 'delta lowercase', tag: 'green', views: 0, live: false },
  { title: 'Epsilon', tag: 'blue', views: 7 }, // `live` absent → exists:false
  { title: 'Zeta guide', tag: 'red', views: 5, live: true },
  // Literal LIKE metacharacters — these rows only match if the pattern
  // treats the needle as a literal substring.
  { title: 'path a\\b backslash', tag: 'meta', views: 1, live: true },
  { title: 'discount 50% off', tag: 'meta', views: 2, live: true },
  { title: 'snake a_b case', tag: 'meta', views: 3, live: true },
  { title: 'decoy aXb noise', tag: 'meta', views: 4, live: true },
  // Non-ASCII: SQLite's LIKE folds ASCII only while the engine uses JS Unicode
  // folding. If the pattern didn't widen those characters the prefilter could
  // drop a row — these rows are the canary.
  { title: 'ÄPFEL und Birnen', tag: 'uni', views: 20, live: true },
  { title: 'Straße groß', tag: 'uni', views: 21, live: true },
  { title: 'İstanbul Turkish', tag: 'uni', views: 22, live: true },
  { title: 'naïve café', tag: 'uni', views: 23, live: true },
];

const QUERIES: { name: string; q: EntryQuery }[] = [
  { name: 'eq on string field', q: { filters: [{ field: 'tag', op: 'eq', value: 'red' }] } },
  { name: 'eq on number field', q: { filters: [{ field: 'views', op: 'eq', value: 5 }] } },
  {
    name: 'eq number as string (coercion)',
    q: { filters: [{ field: 'views', op: 'eq', value: '5' }] },
  },
  {
    name: 'eq boolean as string (coercion)',
    q: { filters: [{ field: 'live', op: 'eq', value: 'true' }] },
  },
  { name: 'in on strings', q: { filters: [{ field: 'tag', op: 'in', value: ['red', 'green'] }] } },
  { name: 'ne (not pushed down)', q: { filters: [{ field: 'tag', op: 'ne', value: 'red' }] } },
  { name: 'nin (not pushed down)', q: { filters: [{ field: 'tag', op: 'nin', value: ['red'] }] } },
  { name: 'gt on number', q: { filters: [{ field: 'views', op: 'gt', value: 6 }] } },
  { name: 'lte on number', q: { filters: [{ field: 'views', op: 'lte', value: 7 }] } },
  { name: 'exists true', q: { filters: [{ field: 'live', op: 'exists', value: true }] } },
  { name: 'exists false', q: { filters: [{ field: 'live', op: 'exists', value: false }] } },
  {
    name: 'match substring case-insensitive',
    q: { filters: [{ field: 'title', op: 'match', value: 'GUIDE' }] },
  },
  {
    name: 'match mid-word substring',
    q: { filters: [{ field: 'title', op: 'match', value: 'amm' }] },
  },
  { name: 'search substring', q: { search: 'guide' } },
  { name: 'search mid-word (FTS would miss)', q: { search: 'amm' } },
  { name: 'search uppercase', q: { search: 'ALPHA' } },
  {
    name: 'multiple filters combined',
    q: {
      filters: [
        { field: 'tag', op: 'eq', value: 'red' },
        { field: 'views', op: 'gt', value: 6 },
      ],
    },
  },
  {
    name: 'filter + search',
    q: { filters: [{ field: 'tag', op: 'eq', value: 'red' }], search: 'guide' },
  },
  { name: 'order asc by field', q: { order: [{ field: 'views', direction: 'asc' }] } },
  { name: 'order desc by field', q: { order: [{ field: 'views', direction: 'desc' }] } },
  { name: 'order by string field', q: { order: [{ field: 'title', direction: 'asc' }] } },
  {
    name: 'filter + order + limit',
    q: {
      filters: [{ field: 'tag', op: 'eq', value: 'red' }],
      order: [{ field: 'views', direction: 'desc' }],
      limit: 2,
    },
  },
  {
    name: 'sys.contentType eq',
    q: { filters: [{ field: 'sys.contentType', op: 'eq', value: 'doc' }] },
  },
  { name: 'select projection', q: { select: ['title'] } },
  { name: 'no match at all', q: { filters: [{ field: 'tag', op: 'eq', value: 'nonexistent' }] } },
  {
    name: 'localized value only in non-default locale',
    q: { filters: [{ field: 'title', op: 'eq', value: 'Alpha Anleitung' }] },
  },
  // LIKE-metacharacter needles: these must stay literal substrings. `%`/`_`
  // only widen the SQL prefilter (safe), but a backslash would narrow it.
  {
    name: 'match needle with backslash',
    q: { filters: [{ field: 'title', op: 'match', value: 'a\\b' }] },
  },
  {
    name: 'match needle with percent',
    q: { filters: [{ field: 'title', op: 'match', value: '50%' }] },
  },
  {
    name: 'match needle with underscore',
    q: { filters: [{ field: 'title', op: 'match', value: 'a_b' }] },
  },
  { name: 'search needle with backslash', q: { search: 'a\\b' } },
  { name: 'search needle with percent', q: { search: '50%' } },
  {
    name: 'match on a locale-only value',
    q: { filters: [{ field: 'title', op: 'match', value: 'Anleitung' }] },
  },
  {
    name: 'explicit locale resolves that locale',
    q: { locale: 'de', filters: [{ field: 'title', op: 'eq', value: 'Alpha Anleitung' }] },
  },
  {
    name: 'match non-ASCII lowercase needle',
    q: { filters: [{ field: 'title', op: 'match', value: 'äpfel' }] },
  },
  {
    name: 'match non-ASCII uppercase needle',
    q: { filters: [{ field: 'title', op: 'match', value: 'ÄPFEL' }] },
  },
  { name: 'match sharp-s', q: { filters: [{ field: 'title', op: 'match', value: 'straße' }] } },
  {
    name: 'match dotted capital I (Turkish)',
    q: { filters: [{ field: 'title', op: 'match', value: 'istanbul' }] },
  },
  { name: 'match accented', q: { filters: [{ field: 'title', op: 'match', value: 'CAFÉ' }] } },
  { name: 'search non-ASCII', q: { search: 'äpfel' } },
  {
    name: 'eq non-ASCII exact',
    q: { filters: [{ field: 'title', op: 'eq', value: 'naïve café' }] },
  },
  {
    name: 'explicit locale + fallback chain',
    q: {
      locale: 'de',
      fallbackLocales: ['en-US'],
      filters: [{ field: 'tag', op: 'eq', value: 'red' }],
    },
  },
];

describe('D1 ≡ in-memory query equivalence', { timeout: 60_000 }, () => {
  let d1: ReturnType<typeof createD1Store>;
  let d1Ctx: AppContext;
  let memCtx: AppContext;
  const spaceId = `q-${uuidv7()}`;
  const scope = { spaceId, environmentId: 'main' };

  beforeAll(async () => {
    d1 = createD1Store(testDb);
    const mem = new InMemoryContentStore();
    const runId = uuidv7();
    d1Ctx = { store: d1, clock, ids: seqIds(`e-${runId}`) };
    memCtx = { store: mem, clock, ids: seqIds(`e-${runId}`) };

    for (const ctx of [d1Ctx, memCtx]) {
      await createSpace(ctx, {
        spaceId,
        name: 'Q',
        defaultLocale: 'en-US',
        locales: ['en-US', 'de'],
      });
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId: 'doc',
        name: 'Doc',
        displayField: 'title',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: true,
            required: true,
            position: 0,
          },
          {
            apiId: 'tag',
            name: 'Tag',
            type: 'Symbol',
            localized: false,
            required: false,
            position: 1,
          },
          {
            apiId: 'views',
            name: 'Views',
            type: 'Integer',
            localized: false,
            required: false,
            position: 2,
          },
          {
            apiId: 'live',
            name: 'Live',
            type: 'Boolean',
            localized: false,
            required: false,
            position: 3,
          },
        ],
      });
      // Identical ids in both stores so results compare directly.
      for (const f of FIXTURES) {
        const fields: Record<string, Record<string, unknown>> = {
          title: { 'en-US': f.title, ...(f.locales ? { de: f.locales.de } : {}) },
          tag: { 'en-US': f.tag },
          views: { 'en-US': f.views },
        };
        if (f.live !== undefined) fields.live = { 'en-US': f.live };
        const created = await createEntry(ctx, scope, {
          contentTypeApiId: 'doc',
          fields: fields as never,
        });
        await publishEntry(ctx, scope, created.entry.id);
      }
    }
  });

  for (const { name, q } of QUERIES) {
    it(`listPublished matches in-memory: ${name}`, async () => {
      const [a, b] = await Promise.all([
        d1Ctx.store.entries.listPublished(scope, q),
        memCtx.store.entries.listPublished(scope, q),
      ]);
      // Compare the full ordered projection — ids, order, and field payloads.
      const shape = (rows: Awaited<typeof a>) =>
        rows.map((r) => ({ id: r.entryId, fields: r.fields }));
      expect(shape(a)).toEqual(shape(b));
    });
    it(`list (drafts) matches in-memory: ${name}`, async () => {
      const [a, b] = await Promise.all([
        d1Ctx.store.entries.list(scope, q),
        memCtx.store.entries.list(scope, q),
      ]);
      const shape = (rows: Awaited<typeof a>) =>
        rows.map((r) => ({ id: r.entry.id, fields: r.fields }));
      expect(shape(a)).toEqual(shape(b));
    });
  }

  it('countPublished matches in-memory, scoped and per content type', async () => {
    for (const q of [undefined, { contentType: 'article' }, { contentType: 'nothing' }]) {
      const [a, b] = await Promise.all([
        d1Ctx.store.entries.countPublished(scope, q),
        memCtx.store.entries.countPublished(scope, q),
      ]);
      // The count is the point: it must be the whole population, not a page of
      // it, and the two backends must agree on what that population is.
      expect(a).toBe(b);
    }
  });

  it('countByStatus matches in-memory, and sees nothing of another scope', async () => {
    const [a, b] = await Promise.all([
      d1Ctx.store.entries.countByStatus(scope),
      memCtx.store.entries.countByStatus(scope),
    ]);
    const sorted = (rows: Awaited<typeof a>) =>
      [...rows].sort(
        (x, y) => x.contentType.localeCompare(y.contentType) || x.status.localeCompare(y.status),
      );
    expect(a.length).toBeGreaterThan(0);
    expect(sorted(a)).toEqual(sorted(b));
    const elsewhere = { spaceId: `${scope.spaceId}-other`, environmentId: scope.environmentId };
    expect(await d1Ctx.store.entries.countByStatus(elsewhere)).toEqual([]);
  });

  it('raises QueryTooBroadError instead of silently truncating', async () => {
    const tiny = createD1Store(testDb, { queryScanLimit: 2 });
    // `exists:true` on `views` matches every fixture > the limit of 2.
    await expect(
      tiny.entries.listPublished(scope, {
        filters: [{ field: 'views', op: 'exists', value: true }],
      }),
    ).rejects.toMatchObject({ code: 'query_too_broad' });
    // Selective predicates are narrowed in SQL, so they fit under the same cap
    // (proves the prefilters push down, not just that they are safe).
    for (const q of [
      { filters: [{ field: 'tag', op: 'eq' as const, value: 'green' }] },
      { filters: [{ field: 'views', op: 'in' as const, value: [100, '0'] }] },
      { filters: [{ field: 'title', op: 'match' as const, value: 'handbook' }] },
      { filters: [{ field: 'live', op: 'eq' as const, value: 'false' }], search: 'delta' },
      { search: 'äpfel' },
    ]) {
      await expect(tiny.entries.listPublished(scope, q)).resolves.toBeDefined();
      await expect(tiny.entries.list(scope, q)).resolves.toBeDefined();
    }
    expect(await tiny.entries.searchPublished(scope, 'gamma handbook', { topK: 5 })).toHaveLength(
      1,
    );
    // The draft path and the built-in text search share the cap.
    await expect(
      tiny.entries.list(scope, { filters: [{ field: 'views', op: 'exists', value: true }] }),
    ).rejects.toMatchObject({ code: 'query_too_broad' });
    await expect(tiny.entries.searchPublished(scope, 'e', { topK: 5 })).rejects.toMatchObject({
      code: 'query_too_broad',
    });
  });
});

/**
 * Adversarial superset probe.
 *
 * The prefilters are only safe if SQL never excludes a row the engine keeps.
 * Rather than reason about that case by case, this seeds deliberately hostile
 * field values (numeric forms, nulls, nested/array values, empty strings,
 * unicode) and runs a broad query matrix against BOTH stores, asserting
 * identical results. Any prefilter that drops a row shows up here as a diff.
 */
describe('prefilter superset property (adversarial)', { timeout: 120_000 }, () => {
  let d1: ReturnType<typeof createD1Store>;
  let d1Ctx: AppContext;
  let memCtx: AppContext;
  const spaceId = `adv-${uuidv7()}`;
  const scope = { spaceId, environmentId: 'main' };

  // Hostile values: each is a `data` field value stored under en-US.
  const VALUES: unknown[] = [
    5,
    5.0,
    5.5,
    '5',
    '5.0',
    0,
    -1,
    9007199254740991, // Number.MAX_SAFE_INTEGER
    '9007199254740993', // beyond double precision, as a string comparand
    true,
    false,
    'true',
    '',
    'plain',
    'MiXeD CaSe',
    'ÄPFEL',
    'a\\b',
    '50%',
    'a_b',
    '"quoted"',
    ['x', 'y'], // array → membership semantics
    [1, 2],
    { nested: 'obj' }, // nested object
    [{ k: 'v' }], // array of objects
    null, // null locale value
  ];

  const PROBES: EntryQuery[] = [
    ...['5', '5.0', 'true', 'false', '', 'plain', 'ÄPFEL', 'a\\b', '50%', 'a_b', 'x', 'nested'].map(
      (v) => ({ filters: [{ field: 'data', op: 'eq' as const, value: v }] }),
    ),
    ...[5, 5.5, 0, -1, true, false].map((v) => ({
      filters: [{ field: 'data', op: 'eq' as const, value: v }],
    })),
    { filters: [{ field: 'data', op: 'in', value: ['5', 'plain', 'x'] }] },
    { filters: [{ field: 'data', op: 'in', value: [5, true, 'MiXeD CaSe'] }] },
    { filters: [{ field: 'data', op: 'exists', value: true }] },
    { filters: [{ field: 'data', op: 'exists', value: false }] },
    ...['plain', 'mixed', 'äpfel', 'a\\b', '50%', 'a_b', 'quoted', 'obj'].map((v) => ({
      filters: [{ field: 'data', op: 'match' as const, value: v }],
    })),
    ...['plain', 'ÄPFEL', 'a\\b', 'nested'].map((v) => ({ search: v })),
    // startsWith shares match's LIKE widening, anchored at the start.
    ...['pl', 'mix', 'äp', 'a\\', '50%', 'a_', '"q', 'tr', '5', 'x'].map((v) => ({
      filters: [{ field: 'data', op: 'startsWith' as const, value: v }],
    })),
    // Component paths walk into the hostile objects and lists of objects.
    ...(['eq', 'match', 'startsWith'] as const).flatMap((op) =>
      ['obj', 'v', 'OB'].map((v) => ({
        filters: [{ field: v === 'v' ? 'data.k' : 'data.nested', op, value: v }],
      })),
    ),
    { filters: [{ field: 'data.nested', op: 'exists', value: true }] },
    { filters: [{ field: 'data.k', op: 'in', value: ['v', 5] }] },
    // An OR of pushable branches is pushed whole; it must still drop nothing.
    {
      where: {
        or: [
          { field: 'data', op: 'eq', value: '5' },
          { field: 'data', op: 'startsWith', value: 'mi' },
          { field: 'data.nested', op: 'eq', value: 'obj' },
        ],
      },
    },
  ];

  beforeAll(async () => {
    d1 = createD1Store(testDb);
    const runId = uuidv7();
    d1Ctx = { store: d1, clock, ids: seqIds(`a-${runId}`) };
    memCtx = { store: new InMemoryContentStore(), clock, ids: seqIds(`a-${runId}`) };
    for (const ctx of [d1Ctx, memCtx]) {
      await createSpace(ctx, { spaceId, name: 'Adv', defaultLocale: 'en-US', locales: ['en-US'] });
      await createContentType(ctx, SYSTEM_CALLER, scope, {
        apiId: 'adv',
        name: 'Adv',
        displayField: 'label',
        fields: [
          {
            apiId: 'label',
            name: 'L',
            type: 'Symbol',
            localized: false,
            required: true,
            position: 0,
          },
          {
            apiId: 'data',
            name: 'D',
            type: 'JSON',
            localized: false,
            required: false,
            position: 1,
          },
        ],
      });
      // Written straight into the published read model: the hostile values
      // include scalars the `JSON` field type would reject at validation, and
      // what is under test is the store's query path, not validation.
      for (let i = 0; i < VALUES.length; i++) {
        await ctx.store.entries.putPublished(scope, {
          entryId: `${runId}-row-${i}`,
          contentTypeApiId: 'adv',
          version: 1,
          fields: { label: { 'en-US': `row-${i}` }, data: { 'en-US': VALUES[i] } } as never,
          publishedAt: clock.now().toISOString(),
        });
      }
    }
  });

  for (const [i, q] of PROBES.entries()) {
    it(`probe ${i}: ${JSON.stringify(q).slice(0, 70)}`, async () => {
      const [a, b] = await Promise.all([
        d1Ctx.store.entries.listPublished(scope, q),
        memCtx.store.entries.listPublished(scope, q),
      ]);
      expect(a.map((r) => r.entryId).sort()).toEqual(b.map((r) => r.entryId).sort());
    });
  }
});
