import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  blockVariants,
  type ComponentVariant,
  type ContentType,
  type DeliveredAsset,
  type FieldDefinition,
  type LocalizedValue,
  SEO_FIELDS,
  variantOf,
} from '@commerceworker/domain';
import type { DeliveryResolvers, ResolvedAsset, ResolvedEntry } from '@commerceworker/ports';
import {
  GraphQLBoolean,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
} from 'graphql';

/**
 * Per-request execution context — pass as `contextValue` to graphql execute().
 * Resolvers are deliberately NOT baked into the schema: they carry the caller's
 * principal (RBAC masking, per-type access), so a cached schema must stay
 * shareable across principals whose visible type set matches.
 */
export interface DeliveryContext {
  readonly resolvers: DeliveryResolvers;
}

/** Arbitrary-JSON scalar — used for rich text, JSON, location, and link fields. */
const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value (rich text, JSON, location, or resolved link).',
  serialize: (v) => v,
});

/**
 * What a RichText field holds, since its JSON type says nothing. Clients render the tree
 * themselves, so this is the one place a GraphQL client learns it is never HTML.
 */
const RICH_TEXT_DESCRIPTION =
  'Rich text: a document tree ({ nodeType: "document", content: [...] }), never HTML. Render ' +
  'it by nodeType. An "embed" node is external media (a video, post or track) whose data is ' +
  '{ url, provider, kind?, title?, authorName?, thumbnail?, width?, height?, aspectRatio? }: ' +
  "structured metadata, never the provider's player markup.";

const describeField = (f: { readonly type: string }) =>
  f.type === 'RichText' ? { description: RICH_TEXT_DESCRIPTION } : {};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Mints unique names for the object types components turn into.
 *
 * GraphQL type names are global, and "content type + field path" is not
 * unique — a `Card` component on `Article` and a content type named
 * `ArticleCard` produce the same name. Suffixing on collision is what the SDK
 * codegen already does for the same reason; a schema that fails to build
 * because two unrelated types agreed on a name is a worse answer than a `2`.
 */
class TypeNames {
  #taken = new Set<string>();

  claim(preferred: string): string {
    let name = preferred;
    let n = 2;
    while (this.#taken.has(name)) name = `${preferred}${n++}`;
    this.#taken.add(name);
    return name;
  }

  reserve(name: string): void {
    this.#taken.add(name);
  }
}

/**
 * The object type a component's nested fields become.
 *
 * Components were JSON until now, which was truthful but unhelpful: a client
 * could read the value and learn nothing about its shape from the schema.
 * Nested apiIds are already constrained to `[a-zA-Z][a-zA-Z0-9_]*`, which is
 * exactly GraphQL's name rule, so they need no mangling.
 */
function componentType(
  names: TypeNames,
  preferredName: string,
  nested: readonly FieldDefinition[] | undefined,
  extra: GraphQLFieldConfigMap<Record<string, unknown>, unknown> = {},
): GraphQLOutputType {
  if (!nested || nested.length === 0) return JSONScalar;
  const name = names.claim(preferredName);
  return new GraphQLObjectType({
    name,
    fields: () => {
      const fields: GraphQLFieldConfigMap<Record<string, unknown>, unknown> = { ...extra };
      for (const f of nested) {
        fields[f.apiId] = {
          type: typeFor(names, `${name}${cap(f.apiId)}`, f),
          ...describeField(f),
          // Values arrive as a plain object keyed by nested apiId, so the
          // default resolver would do — spelled out to survive a rename.
          resolve: (value) => servedValue(f, value?.[f.apiId]),
        };
      }
      return fields;
    },
  });
}

/** What every block carries besides its variant's fields. */
const BLOCK_FIELDS: GraphQLFieldConfigMap<Record<string, unknown>, unknown> = {
  [BLOCK_TYPE_KEY]: {
    type: new GraphQLNonNull(GraphQLString),
    description: "The block's variant apiId",
    resolve: (value) => value?.[BLOCK_TYPE_KEY],
  },
  [BLOCK_KEY]: {
    type: GraphQLString,
    description: 'Stable identity of the block within its field value',
    resolve: (value) => value?.[BLOCK_KEY],
  },
};

/**
 * A blocks field becomes a union with one object type per variant, picked by
 * each element's `_type`. The union takes the name a component in the same
 * place would (`LandingPageBody`), and each member appends its variant
 * (`LandingPageBodyHero`), claimed in declaration order so names are stable
 * from one schema build to the next.
 */
function blocksType(
  names: TypeNames,
  preferredName: string,
  variants: readonly ComponentVariant[],
): GraphQLUnionType {
  const name = names.claim(preferredName);
  const members = new Map<string, GraphQLObjectType>();
  for (const v of variants) {
    const member = componentType(names, `${name}${cap(v.apiId)}`, v.fields, BLOCK_FIELDS);
    // Variants are refused without fields, so this is always an object type.
    if (member instanceof GraphQLObjectType) members.set(v.apiId, member);
  }
  return new GraphQLUnionType({
    name,
    types: [...members.values()],
    resolveType: (value: Record<string, unknown>) =>
      members.get(String(value?.[BLOCK_TYPE_KEY]))?.name,
  });
}

/**
 * A field's value as the schema serves it. A blocks element whose `_type`
 * names no variant (one removed while a stale snapshot still held it) is left
 * out rather than failing the whole query: the union has no member to type it.
 */
function servedValue(field: FieldDefinition, value: unknown): unknown {
  const variants = blockVariants(field);
  if (!variants || !Array.isArray(value)) return value;
  return value.filter((item) => variantOf(variants, item) !== undefined);
}

/** The GraphQL type for one field, recursing into components. */
function typeFor(
  names: TypeNames,
  preferredName: string,
  field: FieldDefinition,
): GraphQLOutputType {
  if (field.type === 'Component') return componentType(names, preferredName, field.fields);
  // A Seo field is a component of fixed shape: typed the same way, so a query selects its parts.
  if (field.type === 'Seo') return componentType(names, preferredName, SEO_FIELDS);
  if (field.type === 'Array' && field.items?.type === 'Component') {
    const variants = field.items.variants;
    if (variants && variants.length > 0) {
      return new GraphQLList(blocksType(names, preferredName, variants));
    }
    return new GraphQLList(componentType(names, preferredName, field.items.fields));
  }
  // A list of scalars is a list of that scalar. A list of links stays JSON (links arrive resolved).
  const itemType = field.type === 'Array' ? field.items?.type : undefined;
  if (itemType && itemType !== 'Link' && itemType !== 'Component') {
    return new GraphQLList(scalarFor({ ...field, type: itemType }));
  }
  return scalarFor(field);
}

function scalarFor(field: FieldDefinition): GraphQLOutputType {
  switch (field.type) {
    case 'Integer':
      return GraphQLInt;
    case 'Number':
      return GraphQLFloat;
    case 'Boolean':
      return GraphQLBoolean;
    case 'Symbol':
    case 'Slug':
    case 'Text':
    case 'Date':
      return GraphQLString;
    default:
      // RichText, Location, JSON, Link, Array → JSON. Links arrive
      // resolved/embedded. Components are handled by `typeFor` before reaching
      // here; one with no declared shape falls through to JSON, since an object
      // type with no fields is not a legal schema.
      return JSONScalar;
  }
}

/**
 * Builds a GraphQL Delivery schema from the types as Delivery reads them (the
 * published view: a live type as last published, a never-published draft as it
 * stands). Each content type becomes an object type (scalar fields typed; rich/link fields as
 * JSON), with `<type>` and `<type>Collection` root queries plus `asset` and
 * `search`. A singleton type's `<type>` takes no `id` to read its one entry. Field values come from the resolver-rendered entry, so locale
 * flattening and reference resolution are reused, not reimplemented.
 */
export function buildDeliverySchema(contentTypes: readonly ContentType[]): GraphQLSchema {
  // Content-type names are reserved first, so a component never takes a name a
  // content type is going to need — the entry types are what clients query by,
  // and renaming one to make room for a nested shape would be backwards.
  const names = new TypeNames();
  for (const reserved of ['Sys', 'SearchHit', 'Query', 'JSON', ...ASSET_TYPE_NAMES]) {
    names.reserve(reserved);
  }
  for (const ct of contentTypes) names.reserve(cap(ct.apiId));

  const sysType = new GraphQLObjectType({
    name: 'Sys',
    fields: {
      id: { type: new GraphQLNonNull(GraphQLID), resolve: (s: ResolvedEntry) => s.id },
      contentType: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (s: ResolvedEntry) => s.contentType,
      },
      publishedAt: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: (s: ResolvedEntry) => s.publishedAt,
      },
      // Null when unknown (first published before it was recorded).
      firstPublishedAt: {
        type: GraphQLString,
        resolve: (s: ResolvedEntry) => s.firstPublishedAt ?? null,
      },
    },
  });

  const searchHitType = new GraphQLObjectType({
    name: 'SearchHit',
    fields: {
      entryId: { type: new GraphQLNonNull(GraphQLID) },
      score: { type: new GraphQLNonNull(GraphQLFloat) },
      snippet: { type: new GraphQLNonNull(GraphQLString) },
    },
  });

  const localeArg = { locale: { type: GraphQLString } };
  const query: GraphQLFieldConfigMap<unknown, DeliveryContext> = {};

  for (const ct of contentTypes) {
    const fields: GraphQLFieldConfigMap<ResolvedEntry, unknown> = {
      _sys: { type: new GraphQLNonNull(sysType), resolve: (s) => s },
    };
    for (const f of ct.fields) {
      fields[f.apiId] = {
        type: typeFor(names, `${cap(ct.apiId)}${cap(f.apiId)}`, f),
        ...describeField(f),
        resolve: (s) => servedValue(f, s.fields[f.apiId]),
      };
    }
    const objectType = new GraphQLObjectType<ResolvedEntry>({ name: cap(ct.apiId), fields });

    // A singleton's root needs no id: without one it is the type's one published entry.
    query[ct.apiId] = ct.singleton
      ? {
          type: objectType,
          args: { id: { type: GraphQLID }, ...localeArg },
          resolve: (_root, args: { id?: string | null; locale?: string }, ctx: DeliveryContext) =>
            args.id
              ? ctx.resolvers.entry(ct.apiId, args.id, args.locale)
              : ctx.resolvers.singleton(ct.apiId, args.locale),
        }
      : {
          type: objectType,
          args: { id: { type: new GraphQLNonNull(GraphQLID) }, ...localeArg },
          resolve: (_root, args: { id: string; locale?: string }, ctx: DeliveryContext) =>
            ctx.resolvers.entry(ct.apiId, args.id, args.locale),
        };
    query[`${ct.apiId}Collection`] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
      args: {
        ...localeArg,
        limit: { type: GraphQLInt },
        skip: { type: GraphQLInt },
        where: { type: JSONScalar },
        order: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
        search: { type: GraphQLString },
      },
      resolve: (
        _root,
        args: {
          locale?: string;
          limit?: number;
          skip?: number;
          where?: Record<string, unknown>;
          order?: readonly string[];
          search?: string;
        },
        ctx: DeliveryContext,
      ) => ctx.resolvers.collection(ct.apiId, args),
    };
  }

  query.asset = {
    type: assetType(),
    args: { id: { type: new GraphQLNonNull(GraphQLID) }, ...localeArg },
    resolve: (_root, args: { id: string; locale?: string }, ctx: DeliveryContext) =>
      ctx.resolvers.asset(args.id, args.locale),
  };
  query.search = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(searchHitType))),
    args: { query: { type: new GraphQLNonNull(GraphQLString) }, topK: { type: GraphQLInt } },
    resolve: (_root, args: { query: string; topK?: number }, ctx: DeliveryContext) =>
      ctx.resolvers.search(args.query, args.topK),
  };

  return new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: query }) });
}

/** The names the asset types take; a content type or component can't have them. */
const ASSET_TYPE_NAMES = [
  'Asset',
  'AssetSource',
  'AssetVideo',
  'AssetRights',
  'AssetPlaceholder',
  'FocalPoint',
];

/**
 * The `Asset` type: the delivered asset, with its URLs chosen by argument. `url(rendition:)`
 * names a rendition, `url(width:)` takes the next width step up; `srcset` is the ladder.
 */
function assetType(): GraphQLObjectType<ResolvedAsset, DeliveryContext> {
  const source = new GraphQLObjectType({
    name: 'AssetSource',
    fields: {
      width: { type: new GraphQLNonNull(GraphQLInt) },
      url: { type: new GraphQLNonNull(GraphQLString) },
    },
  });
  const video = new GraphQLObjectType({
    name: 'AssetVideo',
    fields: {
      status: { type: new GraphQLNonNull(GraphQLString) },
      hlsUrl: { type: GraphQLString },
      dashUrl: { type: GraphQLString },
      thumbnailUrl: { type: GraphQLString },
      durationSeconds: { type: GraphQLFloat },
    },
  });
  const rights = new GraphQLObjectType({
    name: 'AssetRights',
    fields: { credit: { type: GraphQLString }, license: { type: GraphQLString } },
  });
  const placeholder = new GraphQLObjectType({
    name: 'AssetPlaceholder',
    description: 'What to show while a raster image loads, computed by ingest',
    fields: {
      thumbhash: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'ThumbHash of the image (base64), decoded on the client to a blurred preview',
      },
      dominantColor: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The image’s dominant colour, #rrggbb',
      },
    },
  });
  const focal = new GraphQLObjectType({
    name: 'FocalPoint',
    fields: {
      x: { type: new GraphQLNonNull(GraphQLFloat) },
      y: { type: new GraphQLNonNull(GraphQLFloat) },
    },
  });
  const text = (pick: (a: DeliveredAsset) => unknown) => ({
    type: GraphQLString,
    args: { locale: { type: GraphQLString } },
    resolve: (r: ResolvedAsset, args: { locale?: string }, ctx: DeliveryContext) => {
      const value = pick(r.asset);
      if (typeof value === 'string' || value === null) return value;
      return ctx.resolvers.localize(value as LocalizedValue, args.locale ?? r.locale);
    },
  });
  return new GraphQLObjectType<ResolvedAsset, DeliveryContext>({
    name: 'Asset',
    fields: {
      id: { type: new GraphQLNonNull(GraphQLID), resolve: (r) => r.asset.id },
      title: text((a) => a.title),
      description: text((a) => a.description),
      altText: text((a) => a.altText),
      contentType: { type: new GraphQLNonNull(GraphQLString), resolve: (r) => r.asset.contentType },
      kind: { type: new GraphQLNonNull(GraphQLString), resolve: (r) => r.asset.kind },
      size: { type: GraphQLInt, resolve: (r) => r.asset.size },
      width: { type: GraphQLInt, resolve: (r) => r.asset.width },
      height: { type: GraphQLInt, resolve: (r) => r.asset.height },
      focalPoint: { type: focal, resolve: (r) => r.asset.focalPoint },
      url: {
        type: GraphQLString,
        description:
          'The original, a named rendition, or the width step at or above `width` (the largest ' +
          'past it). Null for a rendition the space has none of, or a variant of a non-image.',
        args: { rendition: { type: GraphQLString }, width: { type: GraphQLInt } },
        resolve: (r, args: { rendition?: string | null; width?: number | null }) => {
          const a = r.asset;
          if (args.rendition) return a.renditions[args.rendition] ?? null;
          if (args.width != null) {
            if (a.srcset.length === 0) return null;
            const width = args.width;
            return (a.srcset.find((s) => s.width >= width) ?? a.srcset[a.srcset.length - 1])?.url;
          }
          return a.url;
        },
      },
      srcset: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(source))),
        resolve: (r) => r.asset.srcset,
      },
      renditions: { type: JSONScalar, resolve: (r) => r.asset.renditions },
      placeholder: { type: placeholder, resolve: (r) => r.asset.placeholder },
      video: { type: video, resolve: (r) => r.asset.video ?? null },
      rights: { type: rights, resolve: (r) => r.asset.rights ?? null },
      file: { type: JSONScalar, resolve: (r) => r.asset.file },
    },
  });
}

export { JSONScalar };
