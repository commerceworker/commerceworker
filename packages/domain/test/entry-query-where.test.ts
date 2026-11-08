import { describe, expect, it } from 'vitest';
import {
  assertPathFilterBudget,
  assertQueryRespectsFieldRules,
  type EntryFields,
  ForbiddenError,
  MAX_FILTER_VALUES,
  MAX_PATH_FILTERS,
  MAX_WHERE_CONDITIONS,
  MAX_WHERE_DEPTH,
  type Principal,
  parseQueryWhere,
  type QueryFilter,
  type QueryNode,
  queryFilterIssues,
  runEntryQuery,
  ValidationError,
} from '../src/index';

// Richer queries: startsWith and between, AND/OR groups, component paths.

interface Row {
  readonly id: string;
  readonly fields: EntryFields;
}

const row = (id: string, f: Record<string, unknown>): Row => ({
  id,
  fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { 'en-US': v }])),
});

const ROWS: Row[] = [
  row('alpha', {
    title: 'Alpha guide',
    views: 10,
    seo: { title: 'Alpha SEO', rank: 3 },
    blocks: [{ _type: 'hero', heading: 'Welcome' }],
    tags: ['news', 'tech'],
  }),
  row('beta', { title: 'beta notes', views: 50, seo: { title: 'Beta SEO', rank: 1 } }),
  row('gamma', {
    title: 'Gamma',
    views: 100,
    blocks: [
      { _type: 'hero', heading: 'Hello' },
      { _type: 'cta', label: 'Go' },
    ],
  }),
  row('delta', { title: 'Delta', views: 5, tags: ['sport'] }),
];

const run = (q: { filters?: QueryFilter[]; where?: QueryNode; order?: [] }) =>
  runEntryQuery(
    ROWS,
    { ...q, locale: 'en-US' },
    (r) => r.fields,
    (r) => ({ id: r.id }),
  ).map((r) => r.id);

describe('startsWith and between', () => {
  it('startsWith is a case-insensitive prefix, and a list matches by any element', () => {
    expect(run({ filters: [{ field: 'title', op: 'startsWith', value: 'BETA' }] })).toEqual([
      'beta',
    ]);
    expect(run({ filters: [{ field: 'title', op: 'startsWith', value: 'guide' }] })).toEqual([]);
    expect(run({ filters: [{ field: 'tags', op: 'startsWith', value: 'te' }] })).toEqual(['alpha']);
  });

  it('between is inclusive at both ends and coerces string bounds to the field type', () => {
    expect(run({ filters: [{ field: 'views', op: 'between', value: ['10', '50'] }] })).toEqual([
      'alpha',
      'beta',
    ]);
    expect(run({ filters: [{ field: 'views', op: 'between', value: [51, 99] }] })).toEqual([]);
  });

  it('between never matches a missing field', () => {
    expect(run({ filters: [{ field: 'nothing', op: 'between', value: [0, 1000] }] })).toEqual([]);
  });
});

describe('component paths', () => {
  it('reads a component member', () => {
    expect(run({ filters: [{ field: 'seo.title', op: 'eq', value: 'Beta SEO' }] })).toEqual([
      'beta',
    ]);
    expect(run({ filters: [{ field: 'seo.rank', op: 'lt', value: 2 }] })).toEqual(['beta']);
  });

  it('reads through a list of components, matching when any element does', () => {
    expect(run({ filters: [{ field: 'blocks.heading', op: 'eq', value: 'Hello' }] })).toEqual([
      'gamma',
    ]);
    expect(run({ filters: [{ field: 'blocks.label', op: 'exists', value: true }] })).toEqual([
      'gamma',
    ]);
  });

  it('orders by a component member', () => {
    const ordered = runEntryQuery(
      ROWS,
      {
        filters: [{ field: 'seo.rank', op: 'exists', value: true }],
        order: [{ field: 'seo.rank', direction: 'asc' }],
      },
      (r) => r.fields,
      (r) => ({ id: r.id }),
    );
    expect(ordered.map((r) => r.id)).toEqual(['beta', 'alpha']);
  });
});

describe('AND and OR groups', () => {
  it('OR keeps a row any branch matches; AND inside it needs every branch', () => {
    const where = parseQueryWhere({
      or: [
        { field: 'fields.title', op: 'startsWith', value: 'gam' },
        {
          and: [
            { field: 'views', op: 'between', value: [1, 20] },
            { field: 'tags', op: 'eq', value: 'sport' },
          ],
        },
      ],
    });
    expect(run({ where })).toEqual(['gamma', 'delta']);
  });

  it('ANDs a where tree with the top-level filters', () => {
    const where = parseQueryWhere({ or: [{ field: 'views', op: 'gte', value: 50 }] });
    expect(run({ filters: [{ field: 'title', op: 'match', value: 'a' }], where })).toEqual([
      'beta',
      'gamma',
    ]);
  });

  it('takes a lone predicate as the whole tree, eq by default', () => {
    expect(run({ where: parseQueryWhere({ field: 'title', value: 'Delta' }) })).toEqual(['delta']);
  });
});

describe('parseQueryWhere', () => {
  const issuesOf = (raw: unknown) => {
    try {
      parseQueryWhere(raw);
      return [];
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      return (e as ValidationError).issues;
    }
  };

  it('strips the fields. prefix and keeps the operands', () => {
    expect(
      parseQueryWhere({ and: [{ field: 'fields.seo.title', op: 'startsWith', value: 'A' }] }),
    ).toEqual({ and: [{ field: 'seo.title', op: 'startsWith', value: 'A' }] });
  });

  it(`refuses groups nested deeper than ${MAX_WHERE_DEPTH}`, () => {
    let tree: unknown = { field: 'title', op: 'eq', value: 'x' };
    for (let i = 0; i < MAX_WHERE_DEPTH; i++) tree = { and: [tree] };
    expect(issuesOf(tree)).toEqual([]);
    expect(issuesOf({ or: [tree] })[0]?.message).toMatch(/nest at most/);
  });

  it(`refuses more than ${MAX_WHERE_CONDITIONS} predicates`, () => {
    const leaf = { field: 'title', op: 'eq', value: 'x' };
    expect(issuesOf({ or: Array(MAX_WHERE_CONDITIONS).fill(leaf) })).toEqual([]);
    expect(issuesOf({ or: Array(MAX_WHERE_CONDITIONS + 1).fill(leaf) })[0]?.message).toMatch(
      /at most/,
    );
  });

  it('names every problem with its place in the tree', () => {
    const issues = issuesOf({
      or: [
        { field: 'title', op: 'like', value: 'x' },
        { field: 'views', op: 'between', value: [1] },
        { field: 'bad field', op: 'eq', value: 1 },
        { and: [] },
        'nope',
      ],
    });
    expect(issues.map((i) => i.field)).toEqual([
      'where.or[0]',
      'where.or[1]',
      'where.or[2]',
      'where.or[3].and',
      'where.or[4]',
    ]);
  });

  it('refuses a group with other keys, slug filters, and an array at the root', () => {
    expect(issuesOf({ and: [{ field: 'a', value: 1 }], or: [] })).not.toEqual([]);
    expect(issuesOf({ field: 'metadata.tags.slug', op: 'eq', value: 'news' })).not.toEqual([]);
    expect(issuesOf([{ field: 'a', value: 1 }])).not.toEqual([]);
  });

  it('refuses a path segment that could read as an array index, and paths past 4 segments', () => {
    const strict = { strict: true };
    expect(queryFilterIssues({ field: 'blocks.0', op: 'eq', value: 1 }, 'f', strict)).not.toEqual(
      [],
    );
    expect(queryFilterIssues({ field: 'a.b.c.d.e', op: 'eq', value: 1 }, 'f', strict)).not.toEqual(
      [],
    );
    expect(queryFilterIssues({ field: 'a.b.c.d', op: 'eq', value: 1 }, 'f', strict)).toEqual([]);
  });

  it('refuses startsWith without a string and between without two bounds', () => {
    expect(queryFilterIssues({ field: 'a', op: 'startsWith', value: '' }, 'f')).not.toEqual([]);
    expect(queryFilterIssues({ field: 'a', op: 'between', value: [1, 2, 3] }, 'f')).not.toEqual([]);
  });
});

describe('what was accepted before stays accepted', () => {
  it('checks the filters the API always took only loosely: an empty match, a long in list', () => {
    const long = Array.from({ length: MAX_FILTER_VALUES + 50 }, (_, i) => `v${i}`);
    expect(queryFilterIssues({ field: 'title', op: 'match', value: '' }, 'f')).toEqual([]);
    expect(queryFilterIssues({ field: 'sys.id', op: 'in', value: long }, 'f')).toEqual([]);
    // Inside a where tree, which is new, they are checked strictly.
    expect(() => parseQueryWhere({ field: 'title', op: 'match', value: '' })).toThrow(
      ValidationError,
    );
    expect(() => parseQueryWhere({ field: 'sys.id', op: 'in', value: long })).toThrow(
      ValidationError,
    );
  });

  it('an empty match still means "has a value"', () => {
    expect(run({ filters: [{ field: 'seo', op: 'match', value: '' }] })).toEqual(['alpha', 'beta']);
  });
});

describe('the cost of a where tree', () => {
  it('stops reading a huge tree at the condition cap', () => {
    const leaves = Array.from({ length: 10_000 }, () => ({ field: 'title', value: 'x' }));
    const message = (raw: unknown) => {
      try {
        parseQueryWhere(raw);
        return '';
      } catch (e) {
        return (e as ValidationError).issues.map((i) => i.message).join('; ');
      }
    };
    const started = Date.now();
    expect(message({ or: leaves })).toMatch(/at most 20 conditions/);
    expect(message({ and: [{ or: leaves.slice(0, 15) }, { or: leaves.slice(0, 15) }] })).toMatch(
      /at most 20 conditions/,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it(`refuses more than ${MAX_PATH_FILTERS} component paths inside where only`, () => {
    const path = (i: number): QueryFilter => ({ field: `seo.f${i}`, op: 'eq', value: 1 });
    const four = Array.from({ length: MAX_PATH_FILTERS }, (_, i) => path(i));
    expect(() => assertPathFilterBudget({ where: { and: four } })).not.toThrow();
    expect(() => assertPathFilterBudget({ where: { and: [...four, path(9)] } })).toThrow(
      ValidationError,
    );
  });
});

describe('where and field rules', () => {
  const restricted: Principal = {
    spaceId: 's1',
    kind: 'cda',
    scopes: ['delivery:read'],
    contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['salary'] }],
  };

  it('refuses a hidden field named anywhere in the tree, or as a path root', () => {
    for (const where of [
      { or: [{ field: 'title', value: 'x' }, { and: [{ field: 'salary', op: 'gt', value: 1 }] }] },
      { field: 'salary.amount', op: 'gt', value: 1 },
    ]) {
      expect(() =>
        assertQueryRespectsFieldRules(restricted, {
          contentTypeApiId: 'post',
          where: parseQueryWhere(where),
        }),
      ).toThrow(ForbiddenError);
    }
  });
});
