import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import type { ResolvedEntry } from '@commerceworker/ports';
import {
  GraphQLList,
  type GraphQLObjectType,
  GraphQLUnionType,
  graphql,
  printSchema,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildDeliverySchema, type DeliveryContext } from '../src/index';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId'>): FieldDefinition =>
  ({
    name: over.apiId,
    type: 'Symbol',
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const landingPage: ContentType = {
  apiId: 'landingPage',
  name: 'Landing page',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title' }),
    field({
      apiId: 'body',
      type: 'Array',
      position: 1,
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'hero',
            name: 'Hero',
            fields: [
              field({ apiId: 'heading', required: true }),
              field({ apiId: 'image', type: 'Link', linkType: 'Asset', position: 1 }),
            ],
          },
          {
            apiId: 'cta',
            name: 'Call to action',
            fields: [
              field({ apiId: 'label' }),
              field({ apiId: 'target', type: 'Link', linkType: 'Entry', position: 1 }),
            ],
          },
        ],
      },
    }),
  ],
};

const entry: ResolvedEntry = {
  id: 'e1',
  contentType: 'landingPage',
  publishedAt: 'now',
  fields: {
    title: 'Launch',
    body: [
      { _type: 'hero', _key: 'k1', heading: 'Big', image: { id: 'a1', url: 'https://m/a1' } },
      { _type: 'cta', _key: 'k2', label: 'Read', target: { id: 'e2', title: 'Linked' } },
      // A block of a variant since removed: left out, not a failed query.
      { _type: 'gone', _key: 'k3' },
    ],
  },
};

const contextValue = {
  resolvers: {
    entry: async (_ct: string, id: string) => (id === 'e1' ? entry : null),
    collection: async () => [entry],
    asset: async () => null,
    localize: async () => null,
    search: async () => [],
  },
} as unknown as DeliveryContext;

describe('a blocks field becomes a union', () => {
  const schema = buildDeliverySchema([landingPage]);

  it('of one object type per variant, named for the field and the variant', () => {
    const union = schema.getType('LandingPageBody');
    expect(union).toBeInstanceOf(GraphQLUnionType);
    expect((union as GraphQLUnionType).getTypes().map((t) => t.name)).toEqual([
      'LandingPageBodyHero',
      'LandingPageBodyCta',
    ]);
    const body = (schema.getType('LandingPage') as GraphQLObjectType).getFields().body;
    expect(body?.type).toBeInstanceOf(GraphQLList);
    expect(String(body?.type)).toBe('[LandingPageBody]');
  });

  it('names its members the same way on every build', () => {
    expect(printSchema(buildDeliverySchema([landingPage]))).toBe(printSchema(schema));
  });

  it("gives each member _type, _key and its variant's fields", async () => {
    const printed = printSchema(schema);
    expect(printed).toContain('union LandingPageBody = LandingPageBodyHero | LandingPageBodyCta');
    expect(printed).toMatch(/type LandingPageBodyHero \{\n {2}"""[^"]+"""\n {2}_type: String!/);
  });

  it('resolves each block to its member by _type, and skips unknown ones', async () => {
    const r = await graphql({
      schema,
      contextValue,
      source: `{ landingPage(id: "e1") { body {
        __typename
        ... on LandingPageBodyHero { _key heading image }
        ... on LandingPageBodyCta { _key label target }
      } } }`,
    });
    expect(r.errors).toBeUndefined();
    expect((r.data as { landingPage: { body: unknown[] } }).landingPage.body).toEqual([
      {
        __typename: 'LandingPageBodyHero',
        _key: 'k1',
        heading: 'Big',
        image: { id: 'a1', url: 'https://m/a1' },
      },
      {
        __typename: 'LandingPageBodyCta',
        _key: 'k2',
        label: 'Read',
        target: { id: 'e2', title: 'Linked' },
      },
    ]);
  });

  it('suffixes a member name a content type already holds', () => {
    const taken: ContentType = {
      ...landingPage,
      apiId: 'landingPageBodyHero',
      fields: [field({ apiId: 'title' })],
    };
    const s = buildDeliverySchema([landingPage, taken]);
    expect(
      (s.getType('LandingPageBody') as GraphQLUnionType).getTypes().map((t) => t.name),
    ).toEqual(['LandingPageBodyHero2', 'LandingPageBodyCta']);
  });
});
