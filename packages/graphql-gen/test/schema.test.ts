import { defineContentType } from '@commerceworker/domain';
import type { DeliveryResolvers, ResolvedEntry } from '@commerceworker/ports';
import { type GraphQLObjectType, graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildDeliverySchema, type DeliveryContext } from '../src/index';

const article = defineContentType({
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
      apiId: 'wordCount',
      name: 'Words',
      type: 'Integer',
      localized: false,
      required: false,
      position: 1,
    },
    {
      apiId: 'hero',
      name: 'Hero',
      type: 'Link',
      localized: false,
      required: false,
      position: 2,
      linkType: 'Asset',
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'RichText',
      localized: false,
      required: false,
      position: 3,
    },
  ],
});

const settings = defineContentType({
  apiId: 'settings',
  name: 'Settings',
  displayField: 'title',
  singleton: true,
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 0,
    },
  ],
});

const entries: Record<string, ResolvedEntry> = {
  s1: { id: 's1', contentType: 'settings', publishedAt: 'now', fields: { title: 'Site' } },
  e1: {
    id: 'e1',
    contentType: 'article',
    publishedAt: 'now',
    fields: { title: 'Hello', wordCount: 42, hero: { id: 'a1', file: { fileName: 'h.jpg' } } },
  },
};

const resolvers: DeliveryResolvers = {
  entry: async (_ct, id) => entries[id] ?? null,
  singleton: async (ct) => (ct === 'settings' ? (entries.s1 ?? null) : null),
  collection: async (ct) => Object.values(entries).filter((e) => e.contentType === ct),
  asset: async (id) => ({ id, file: { fileName: 'h.jpg' } }),
  search: async () => [{ entryId: 'e1', score: 0.9, snippet: 'Hello' }],
};

describe('@commerceworker/graphql-gen', () => {
  // Resolvers travel per-request as contextValue — never baked into the schema.
  const schema = buildDeliverySchema([article]);
  const contextValue: DeliveryContext = { resolvers };

  it('generates typed object types with scalar + JSON (link) fields', async () => {
    const r = await graphql({
      schema,
      contextValue,
      source: '{ article(id: "e1") { _sys { id contentType } title wordCount hero } }',
    });
    expect(r.errors).toBeUndefined();
    const a = (r.data as { article: Record<string, unknown> }).article;
    expect((a._sys as { id: string }).id).toBe('e1');
    expect(a.title).toBe('Hello');
    expect(a.wordCount).toBe(42);
    // Link field arrives as resolved JSON (the embedded asset).
    expect((a.hero as { id: string }).id).toBe('a1');
  });

  it('types a list of scalars as a list of that scalar, and a list of links as JSON', () => {
    const lists = buildDeliverySchema([
      {
        apiId: 'event',
        name: 'Event',
        displayField: 'title',
        version: 1,
        status: 'published',
        fields: [
          {
            apiId: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: false,
            required: true,
            position: 0,
          },
          ...(
            [
              ['tags', 'Symbol'],
              ['lines', 'Text'],
              ['sizes', 'Integer'],
              ['weights', 'Number'],
              ['days', 'Date'],
              ['links', 'Link'],
            ] as const
          ).map(([apiId, type], i) => ({
            apiId,
            name: apiId,
            type: 'Array' as const,
            localized: false,
            required: false,
            position: i + 1,
            items: { type },
          })),
        ],
      },
    ]);
    const fields = (lists.getType('Event') as GraphQLObjectType).getFields();
    expect(String(fields.tags?.type)).toBe('[String]');
    expect(String(fields.lines?.type)).toBe('[String]');
    expect(String(fields.sizes?.type)).toBe('[Int]');
    expect(String(fields.weights?.type)).toBe('[Float]');
    expect(String(fields.days?.type)).toBe('[String]');
    expect(String(fields.links?.type)).toBe('JSON');
  });

  it('describes a rich-text field as a document tree with structured embeds, never HTML', () => {
    const type = schema.getType('Article') as GraphQLObjectType;
    const description = type.getFields().body?.description ?? '';
    expect(description).toMatch(/document tree/);
    expect(description).toMatch(/never HTML/);
    expect(description).toMatch(/"embed" node/);
    expect(type.getFields().title?.description).toBeUndefined();
  });

  it('exposes a collection root and a search root', async () => {
    const r = await graphql({
      schema,
      contextValue,
      source: '{ articleCollection { _sys { id } } search(query: "x") { entryId score } }',
    });
    expect(r.errors).toBeUndefined();
    const data = r.data as { articleCollection: unknown[]; search: { entryId: string }[] };
    expect(data.articleCollection).toHaveLength(1);
    expect(data.search[0]?.entryId).toBe('e1');
  });

  it('gives a singleton type a root that needs no id, and an ordinary one a root that does', async () => {
    const both = buildDeliverySchema([article, settings]);
    const r = await graphql({
      schema: both,
      contextValue,
      source: '{ settings { _sys { id } title } byId: settings(id: "e1") { _sys { id } } }',
    });
    expect(r.errors).toBeUndefined();
    expect(r.data).toEqual({
      settings: { _sys: { id: 's1' }, title: 'Site' },
      byId: { _sys: { id: 'e1' } },
    });
    const ordinary = await graphql({ schema: both, contextValue, source: '{ article { title } }' });
    expect(ordinary.errors?.[0]?.message).toMatch(/article\(id:\).*is required/);
  });

  it('returns null for a wrong-id query without throwing', async () => {
    const r = await graphql({ schema, contextValue, source: '{ article(id: "nope") { title } }' });
    expect(r.errors).toBeUndefined();
    expect((r.data as { article: unknown }).article).toBeNull();
  });
});
