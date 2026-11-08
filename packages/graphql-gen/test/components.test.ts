import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { GraphQLList, GraphQLObjectType, type GraphQLSchema, printSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildDeliverySchema } from '../src/index';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId'>): FieldDefinition =>
  ({
    name: over.apiId,
    type: 'Symbol',
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const type = (apiId: string, fields: FieldDefinition[]): ContentType => ({
  apiId,
  name: apiId,
  displayField: fields[0]?.apiId ?? '',
  version: 1,
  status: 'published',
  fields,
});

const CARD: FieldDefinition[] = [
  field({ apiId: 'heading', required: true }),
  field({ apiId: 'body', type: 'Text', position: 1 }),
];

/** The named type, if the schema declares one. */
const named = (schema: GraphQLSchema, name: string) => schema.getType(name);

describe('a component becomes an object type', () => {
  const schema = buildDeliverySchema([
    type('article', [
      field({ apiId: 'title' }),
      field({ apiId: 'hero', type: 'Component', fields: CARD, position: 1 }),
    ]),
  ]);

  it('is named for the content type and the field that holds it', () => {
    // Components were JSON until now: truthful, but a client could read the
    // value and learn nothing about its shape from the schema.
    expect(named(schema, 'ArticleHero')).toBeInstanceOf(GraphQLObjectType);
  });

  it('exposes each nested field with its own type', () => {
    const hero = named(schema, 'ArticleHero') as GraphQLObjectType;
    const fields = hero.getFields();
    expect(Object.keys(fields).sort()).toEqual(['body', 'heading']);
    expect(String(fields.heading?.type)).toBe('String');
  });

  it('is what the entry type points at', () => {
    const article = named(schema, 'Article') as GraphQLObjectType;
    expect(String(article.getFields().hero?.type)).toBe('ArticleHero');
  });

  it('resolves a nested value out of the plain object it arrives as', () => {
    const hero = named(schema, 'ArticleHero') as GraphQLObjectType;
    const resolve = hero.getFields().heading?.resolve;
    expect(resolve?.({ heading: 'Hello' }, {}, {}, {} as never)).toBe('Hello');
    // A missing component must read as absent, not throw mid-query.
    expect(resolve?.(undefined as never, {}, {}, {} as never)).toBeUndefined();
  });
});

describe('a Seo field becomes an object type of its fixed parts', () => {
  const schema = buildDeliverySchema([
    type('article', [field({ apiId: 'title' }), field({ apiId: 'seo', type: 'Seo', position: 1 })]),
  ]);

  it('types each part, so a query selects them', () => {
    const seo = named(schema, 'ArticleSeo') as GraphQLObjectType;
    const fields = seo.getFields();
    expect(Object.keys(fields)).toEqual([
      'title',
      'description',
      'canonicalUrl',
      'noindex',
      'ogImage',
    ]);
    expect(String(fields.noindex?.type)).toBe('Boolean');
    expect(String((named(schema, 'Article') as GraphQLObjectType).getFields().seo?.type)).toBe(
      'ArticleSeo',
    );
  });
});

describe('a repeater becomes a list of them', () => {
  const schema = buildDeliverySchema([
    type('page', [
      field({ apiId: 'name' }),
      field({
        apiId: 'cards',
        type: 'Array',
        items: { type: 'Component', fields: CARD },
        position: 1,
      }),
    ]),
  ]);

  it('is a list, not a JSON blob', () => {
    const page = named(schema, 'Page') as GraphQLObjectType;
    expect(page.getFields().cards?.type).toBeInstanceOf(GraphQLList);
    expect(String(page.getFields().cards?.type)).toBe('[PageCards]');
  });
});

describe('nesting', () => {
  it('names a component inside a component by its path', () => {
    const inner = field({ apiId: 'cta', type: 'Component', fields: [field({ apiId: 'label' })] });
    const schema = buildDeliverySchema([
      type('article', [
        field({ apiId: 'title' }),
        field({ apiId: 'hero', type: 'Component', fields: [...CARD, inner], position: 1 }),
      ]),
    ]);
    expect(named(schema, 'ArticleHeroCta')).toBeInstanceOf(GraphQLObjectType);
  });
});

describe('names are global, so collisions have to be handled', () => {
  it('never takes a name a content type needs', () => {
    // The entry types are what clients query by; renaming one to make room for
    // a nested shape would be backwards.
    const schema = buildDeliverySchema([
      type('article', [
        field({ apiId: 'title' }),
        field({ apiId: 'hero', type: 'Component', fields: CARD, position: 1 }),
      ]),
      type('articleHero', [field({ apiId: 'title' })]),
    ]);
    // The content type keeps `ArticleHero`; the component takes the suffix.
    expect((named(schema, 'ArticleHero') as GraphQLObjectType).getFields().title).toBeTruthy();
    expect(named(schema, 'ArticleHero2')).toBeInstanceOf(GraphQLObjectType);
  });

  it('separates two components that would otherwise agree on a name', () => {
    const schema = buildDeliverySchema([
      type('article', [
        field({ apiId: 'title' }),
        field({ apiId: 'hero', type: 'Component', fields: CARD, position: 1 }),
      ]),
      type('a', [
        field({ apiId: 'title' }),
        field({ apiId: 'rticleHero', type: 'Component', fields: CARD, position: 1 }),
      ]),
    ]);
    // A schema that fails to build because two unrelated types agreed on a
    // name is a worse answer than a "2".
    expect(() => printSchema(schema)).not.toThrow();
  });

  it('leaves a shapeless component as JSON', () => {
    // An object type with no fields is not a legal schema.
    const schema = buildDeliverySchema([
      type('article', [
        field({ apiId: 'title' }),
        field({ apiId: 'hero', type: 'Component', position: 1 }),
      ]),
    ]);
    const article = named(schema, 'Article') as GraphQLObjectType;
    expect(String(article.getFields().hero?.type)).toBe('JSON');
  });
});

describe('the schema still builds', () => {
  it('prints without error for a model using every component shape', () => {
    const schema = buildDeliverySchema([
      type('article', [
        field({ apiId: 'title' }),
        field({ apiId: 'hero', type: 'Component', fields: CARD, position: 1 }),
        field({
          apiId: 'cards',
          type: 'Array',
          items: { type: 'Component', fields: CARD },
          position: 2,
        }),
        field({ apiId: 'meta', type: 'JSON', position: 3 }),
        field({ apiId: 'author', type: 'Link', linkType: 'Entry', position: 4 }),
      ]),
    ]);
    const printed = printSchema(schema);
    expect(printed).toContain('type ArticleHero');
    expect(printed).toContain('cards: [ArticleCards]');
  });
});
