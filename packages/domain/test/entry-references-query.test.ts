import { describe, expect, it } from 'vitest';
import {
  ANY_FIELD,
  assertQueryRespectsFieldRules,
  type ContentType,
  type EntryFields,
  ForbiddenError,
  type Principal,
  type QueryFilter,
  queryFilterIssues,
  runEntryQuery,
} from '../src/index';

// Filtering by referenced entry: `ref`/`refIn` on a field, and `*` (links_to_entry) over all.

const link = (id: string, linkType: 'Entry' | 'Asset' = 'Entry') => ({ id, linkType });

interface Row {
  readonly id: string;
  readonly fields: EntryFields;
}

const ROWS: Row[] = [
  { id: 'by-ann', fields: { author: { 'en-US': link('ann') } } },
  { id: 'by-bob', fields: { author: { 'en-US': link('bob') } } },
  { id: 'related-ann', fields: { related: { 'en-US': [link('cid'), link('ann')] } } },
  {
    id: 'body-embeds-ann',
    fields: {
      body: {
        'en-US': {
          nodeType: 'document',
          data: {},
          content: [
            { nodeType: 'embedded-entry-block', data: { target: link('ann') }, content: [] },
          ],
        },
      },
    },
  },
  { id: 'card-ann', fields: { card: { 'en-US': { heading: 'x', person: link('ann') } } } },
  // An asset with the same id is not an entry link.
  { id: 'asset-ann', fields: { author: { 'en-US': link('ann', 'Asset') } } },
  // Only the German value links to ann: a link in any locale counts, as in the reference edges.
  { id: 'de-ann', fields: { author: { 'en-US': link('bob'), de: link('ann') } } },
  { id: 'none', fields: { title: { 'en-US': 'ann' } } },
];

const run = (filters: QueryFilter[], locale = 'en-US') =>
  runEntryQuery(
    ROWS,
    { filters, locale },
    (r) => r.fields,
    (r) => ({ id: r.id }),
  ).map((r) => r.id);

describe('reference filters in the query engine', () => {
  it('ref matches a link field holding the entry in any locale, and only an Entry link', () => {
    expect(run([{ field: 'author', op: 'ref', value: 'ann' }])).toEqual(['by-ann', 'de-ann']);
  });

  it('refIn matches any of several ids, through lists of links too', () => {
    expect(run([{ field: 'related', op: 'refIn', value: ['ann', 'zed'] }])).toEqual([
      'related-ann',
    ]);
    expect(run([{ field: 'author', op: 'refIn', value: ['ann', 'bob'] }])).toEqual([
      'by-ann',
      'by-bob',
      'de-ann',
    ]);
  });

  it('reads every locale whatever locale the query resolves, as the edges do', () => {
    expect(run([{ field: 'author', op: 'ref', value: 'ann' }], 'de')).toEqual(['by-ann', 'de-ann']);
  });

  it('links_to_entry (*) finds a link in any field: rich text, components, lists', () => {
    expect(run([{ field: ANY_FIELD, op: 'ref', value: 'ann' }])).toEqual([
      'by-ann',
      'related-ann',
      'body-embeds-ann',
      'card-ann',
      'de-ann',
    ]);
  });

  it('never matches a plain string holding the id', () => {
    expect(run([{ field: 'title', op: 'ref', value: 'ann' }])).toEqual([]);
  });
});

describe('reference filters with the content model', () => {
  // The links the reference edges record: declared Link, list-of-link, rich-text and component
  // fields. A link-shaped value in a JSON field, or in a field the type no longer declares, is not
  // one, so the engine and the store's edge pushdown give the same answer.
  const post = {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    version: 1,
    status: 'published',
    fields: [
      {
        apiId: 'author',
        name: 'a',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 0,
      },
      { apiId: 'data', name: 'd', type: 'JSON', localized: false, required: false, position: 1 },
    ],
  } as unknown as ContentType;
  const rows: Row[] = [
    { id: 'author-ann', fields: { author: { 'en-US': link('ann') } } },
    { id: 'json-ann', fields: { data: { 'en-US': { nested: link('ann') } } } },
    { id: 'undeclared-ann', fields: { legacy: { 'en-US': link('ann') } } },
  ];
  const run = (filters: QueryFilter[], contentTypes?: ContentType[]) =>
    runEntryQuery(
      rows,
      { filters, ...(contentTypes ? { contentTypes } : {}) },
      (r) => r.fields,
      (r) => ({ id: r.id, contentType: 'post' }),
    ).map((r) => r.id);

  it('counts only links in the link-bearing fields the type declares', () => {
    expect(run([{ field: ANY_FIELD, op: 'ref', value: 'ann' }], [post])).toEqual(['author-ann']);
    expect(run([{ field: 'data', op: 'ref', value: 'ann' }], [post])).toEqual([]);
    expect(run([{ field: 'legacy', op: 'ref', value: 'ann' }], [post])).toEqual([]);
  });

  it('matches nothing for a row whose type the model lacks', () => {
    expect(run([{ field: ANY_FIELD, op: 'ref', value: 'ann' }], [])).toEqual([]);
  });

  it('without the model, any link-shaped value counts', () => {
    expect(run([{ field: ANY_FIELD, op: 'ref', value: 'ann' }])).toEqual([
      'author-ann',
      'json-ann',
      'undeclared-ann',
    ]);
  });
});

describe('reference filter validation', () => {
  it('accepts one id for ref, a list for refIn, and * for both', () => {
    expect(queryFilterIssues({ field: 'author', op: 'ref', value: 'ann' }, 'f')).toEqual([]);
    expect(queryFilterIssues({ field: '*', op: 'refIn', value: ['a', 'b'] }, 'f')).toEqual([]);
  });

  it('refuses a missing id, an empty or oversized list, * on another op, a sys field', () => {
    for (const f of [
      { field: 'author', op: 'ref', value: '' },
      { field: 'author', op: 'ref', value: ['a'] },
      { field: 'author', op: 'refIn', value: [] },
      { field: 'author', op: 'refIn', value: Array.from({ length: 101 }, (_, i) => `e${i}`) },
      { field: 'author', op: 'refIn', value: [1] },
      { field: '*', op: 'eq', value: 'a' },
      { field: 'sys.id', op: 'ref', value: 'a' },
      // A component path: the edges name the top-level field only.
      { field: 'card.person', op: 'ref', value: 'a' },
      // Ids whose JSON form needs escaping: the store looks for the quoted id in stored JSON.
      { field: 'author', op: 'ref', value: 'a"b' },
      { field: 'author', op: 'refIn', value: ['a\\b'] },
    ] as QueryFilter[]) {
      expect(queryFilterIssues(f, 'f').length, JSON.stringify(f)).toBeGreaterThan(0);
    }
  });
});

describe('reference filters and field rules', () => {
  it('refuses links_to_entry nested in a where tree, as at the top level', () => {
    const restrictedKey: Principal = {
      spaceId: 's1',
      kind: 'cda',
      scopes: ['delivery:read'],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['secret'] }],
    };
    expect(() =>
      assertQueryRespectsFieldRules(restrictedKey, {
        contentTypeApiId: 'post',
        where: {
          or: [
            { field: 'title', op: 'eq', value: 'x' },
            { field: ANY_FIELD, op: 'ref', value: 'a' },
          ],
        },
      }),
    ).toThrow(ForbiddenError);
  });

  const restricted: Principal = {
    spaceId: 's1',
    kind: 'cda',
    scopes: ['delivery:read'],
    contentGrants: [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['secret'] }],
  };

  it('refuses links_to_entry where a field is hidden: it would look inside that field too', () => {
    expect(() =>
      assertQueryRespectsFieldRules(restricted, {
        contentTypeApiId: 'post',
        filters: [{ field: ANY_FIELD }],
      }),
    ).toThrow(ForbiddenError);
  });

  it('refuses ref on a hidden field and allows it on a readable one', () => {
    expect(() =>
      assertQueryRespectsFieldRules(restricted, {
        contentTypeApiId: 'post',
        filters: [{ field: 'secret' }],
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      assertQueryRespectsFieldRules(restricted, {
        contentTypeApiId: 'post',
        filters: [{ field: 'author' }],
      }),
    ).not.toThrow();
  });
});
