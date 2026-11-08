import {
  assetSearchDeps,
  assetTransformTarget,
  clampCount,
  type DeliveryReads,
  deliveredSearch,
  deliveredSitemapFile,
  deliveryGraphResolvers,
  deliveryReads,
  getDeliveredAsset,
  getDeliveredCollection,
  getDeliveredConcept,
  getDeliveredMenu,
  getDeliveredSingleton,
  getDeliveredTag,
  getPublishedEntry,
  listDeliveredAssets,
  listDeliveredConcepts,
  listDeliveredMenus,
  listDeliveredRedirects,
  listDeliveredRoutes,
  listDeliveredSitemap,
  listDeliveredTags,
  listPublishedEntries,
  liveEventFor,
  MAX_PAGE_LIMIT,
  MAX_SITEMAP_PAGE,
  maskDeliveredFields,
  parseEntryQuery,
  parseImageTransform,
  resolveDeliveredRedirect,
  searchDeliveredAssets,
  transformPublishedAssetUrl,
  visibleSearchHits,
} from '@commerceworker/application';
import {
  assertQueryRespectsFieldRules,
  authorize,
  authorizeContent,
  canAccessContentType,
  SCOPES,
  type Scope,
} from '@commerceworker/domain';
import { buildDeliverySchema, type DeliveryContext } from '@commerceworker/graphql-gen';
import { LIVE_STREAM_MAX_MS } from '@commerceworker/platform/do/live-access';
import {
  type ASTNode,
  execute,
  type FragmentDefinitionNode,
  GraphQLError,
  type GraphQLSchema,
  NoSchemaIntrospectionCustomRule,
  type OperationDefinitionNode,
  parse,
  specifiedRules,
  type ValidationRule,
  validate,
} from 'graphql';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  type AuthDeps,
  type AuthVars,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '../auth';
import type { DeliveryDocKey } from '../docs/delivery-docs';
import { onError } from '../http';
import { parseAssetSearchQuery, parseDeliveredAssetQuery } from '../query';
import { renderSitemapXml, sitemapBase } from '../sitemap-xml';

/** Max reference-resolution depth a delivery client may request. */
const MAX_INCLUDE_DEPTH = 10;

/** Max GraphQL selection-set nesting accepted (abuse/complexity guard). */
const MAX_GQL_DEPTH = 12;

/** Recursively measures selection-set nesting, following fragments. */
function selectionDepth(
  node: { selectionSet?: { selections: readonly ASTNode[] } },
  fragments: Record<string, FragmentDefinitionNode>,
  depth: number,
): number {
  const selections = node.selectionSet?.selections ?? [];
  let max = depth;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      max = Math.max(max, selectionDepth(sel, fragments, depth + 1));
    } else if (sel.kind === 'InlineFragment') {
      max = Math.max(max, selectionDepth(sel, fragments, depth));
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name.value];
      if (frag) max = Math.max(max, selectionDepth(frag, fragments, depth));
    }
  }
  return max;
}

/** A validation rule rejecting operations whose nesting exceeds `maxDepth`. */
function depthLimitRule(maxDepth: number): ValidationRule {
  return (context) => {
    const fragments: Record<string, FragmentDefinitionNode> = {};
    for (const def of context.getDocument().definitions) {
      if (def.kind === 'FragmentDefinition') fragments[def.name.value] = def;
    }
    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = selectionDepth(node, fragments, 0);
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(`Query exceeds the maximum depth of ${maxDepth}.`, { nodes: [node] }),
          );
        }
      },
    };
  };
}

const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

const BASE = '/delivery/:space/:env';

/** An asset search's facet counts when it has no matches to count. */
const EMPTY_FACETS = { kind: {}, tag: {}, folder: {} };

/** Delivery API (CDA): read-only published content. Requires delivery:read. */
/**
 * The delivery routes as a standalone app, for a Worker that serves them on their own (the
 * delivery Worker's cached entrypoint and gateway). It carries the api's error mapping, so a
 * domain error answers as it does on the api (an unpublished or unknown entry is a 404), never as
 * Hono's bare 500.
 */
export function deliveryApp(routes: Hono<AuthVars>): Hono {
  const app = new Hono();
  app.onError(onError);
  app.route('/', routes);
  return app;
}

/** Documents a route (the api's OpenAPI); the delivery Worker passes nothing and bundles none. */
type Describe = (key: DeliveryDocKey) => MiddlewareHandler;
const undocumented: Describe = () => async (_c, next) => {
  await next();
};

export function deliveryRoutes(deps: AuthDeps, describe: Describe = undocumented): Hono<AuthVars> {
  const { ctx, rag, bus } = deps;
  const app = new Hono<AuthVars>();
  app.use(`${BASE}/*`, principalMiddleware(deps));
  app.use(`${BASE}/*`, environmentMiddleware(deps));

  // Hybrid (semantic + full-text, RRF-fused) by default; ?mode=semantic or
  // ?mode=lexical selects a single leg.
  app.get(`${BASE}/search`, describe('search'), requireScope(SCOPES.searchRead), async (c) => {
    const q = c.req.query('q') ?? '';
    const mode = c.req.query('mode');
    const scope = scopeOf(c);
    // Over the locales the space delivers only: an undelivered one neither matches nor is quoted.
    let hits = await deliveredSearch(rag, ctx, scope, q, {
      topK: clampCount(c.req.query('top_k'), MAX_PAGE_LIMIT, { min: 1 }),
      mode: mode === 'semantic' || mode === 'lexical' ? mode : 'hybrid',
    });
    hits = await visibleSearchHits(ctx, scope, c.get('principal'), hits);
    return c.json({ hits });
  });

  app.get(
    `${BASE}/entries`,
    describe('listEntries'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const query = parseEntryQuery(new URL(c.req.url).searchParams);
      // Filters, ordering and search over a field the caller can't read would reveal it.
      assertQueryRespectsFieldRules(c.get('principal'), query);
      const items = await listPublishedEntries(ctx, scopeOf(c), query, {
        locale: c.req.query('locale'),
        include: clampCount(c.req.query('include'), MAX_INCLUDE_DEPTH, { min: 0 }),
      });
      // Granular RBAC: drop entries of ungranted types, mask denied fields.
      const principal = c.get('principal');
      const visible = items
        .filter((e) => canAccessContentType(principal, 'read', e.contentType))
        .map((e) => ({ ...e, fields: maskDeliveredFields(principal, e.contentType, e.fields) }));
      return c.json({ items: visible, total: visible.length });
    },
  );

  app.get(
    `${BASE}/entries/:id`,
    describe('getEntry'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const entry = await getPublishedEntry(ctx, scopeOf(c), c.req.param('id'), {
        locale: c.req.query('locale'),
        include: clampCount(c.req.query('include'), MAX_INCLUDE_DEPTH, { min: 0 }),
      });
      const principal = c.get('principal');
      authorizeContent(principal, 'read', entry.contentType);
      return c.json({
        ...entry,
        fields: maskDeliveredFields(principal, entry.contentType, entry.fields),
      });
    },
  );

  app.get(
    `${BASE}/singletons/:apiId`,
    describe('getSingleton'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const principal = c.get('principal');
      const apiId = c.req.param('apiId');
      // Before the read: a type the key can't read answers as the entry route would.
      authorizeContent(principal, 'read', apiId);
      const entry = await getDeliveredSingleton(ctx, scopeOf(c), apiId, {
        locale: c.req.query('locale'),
        include: clampCount(c.req.query('include'), MAX_INCLUDE_DEPTH, { min: 0 }),
      });
      return c.json({
        ...entry,
        fields: maskDeliveredFields(principal, entry.contentType, entry.fields),
      });
    },
  );

  app.get(
    `${BASE}/assets`,
    describe('listAssets'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const principal = c.get('principal');
      const searching = c.req.query('q') !== undefined;
      // ?q= is a search, so it takes search:read as well, as /search does.
      if (searching) authorize(principal, SCOPES.searchRead, c.req.param('space') ?? '*');
      if (principal.contentGrants) {
        // A key with content grants reads no assets; a search still answers in its own shape.
        return c.json(
          searching ? { items: [], total: 0, facets: EMPTY_FACETS } : { items: [], total: 0 },
        );
      }
      const locale = c.req.query('locale');
      // ?q= searches published assets (hybrid, with facets) instead of listing them. A read like
      // the listing: nothing is written, so the cached entrypoint caches it by URL.
      if (searching) {
        const { filters, ...query } = parseAssetSearchQuery(c.req.query());
        const { status: _status, ...published } = filters ?? {};
        return c.json(
          await searchDeliveredAssets(
            ctx,
            deps.assetSearch ?? assetSearchDeps(rag),
            scopeOf(c),
            { ...query, filters: published },
            locale !== undefined ? { locale } : {},
          ),
        );
      }
      const page = await listDeliveredAssets(
        ctx,
        scopeOf(c),
        parseDeliveredAssetQuery(c.req.query()),
        locale !== undefined ? { locale } : {},
      );
      return c.json({ ...page, total: page.items.length });
    },
  );

  app.get(
    `${BASE}/collections/:id`,
    describe('getCollection'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      // As for assets: a key with content grants reads none.
      if (c.get('principal').contentGrants) return c.body(null, 403);
      const locale = c.req.query('locale');
      const limit = clampCount(c.req.query('limit'), MAX_PAGE_LIMIT, { min: 1 });
      const cursor = c.req.query('cursor');
      return c.json(
        await getDeliveredCollection(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          { ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) },
          locale !== undefined ? { locale } : {},
        ),
      );
    },
  );

  app.get(
    `${BASE}/assets/:id`,
    describe('getAsset'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      if (c.get('principal').contentGrants) {
        return c.body(null, 403);
      }
      const locale = c.req.query('locale');
      return c.json(
        await getDeliveredAsset(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          locale !== undefined ? { locale } : {},
        ),
      );
    },
  );

  // --- taxonomy: archive pages -------------------------------------------
  // Terms with slugs, localized labels and published usage counts. Counts leave out the content
  // types the key may not read, so they never reveal how much content of the others exists.
  const termOpts = (c: Context<AuthVars>) => {
    const principal = c.get('principal');
    const locale = c.req.query('locale');
    const contentType = c.req.query('content_type');
    return {
      ...(locale !== undefined ? { locale } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      ...(principal.contentGrants
        ? { readable: (t: string) => canAccessContentType(principal, 'read', t) }
        : {}),
    };
  };
  const schemeOf = (c: Context<AuthVars>) => {
    const scheme = c.req.query('scheme');
    return scheme !== undefined ? { schemeId: scheme } : {};
  };
  app.get(
    `${BASE}/taxonomy/tags`,
    describe('listTags'),
    requireScope(SCOPES.deliveryRead),
    async (c) => c.json({ items: await listDeliveredTags(ctx, scopeOf(c), termOpts(c)) }),
  );
  app.get(
    `${BASE}/taxonomy/tags/:slug`,
    describe('getTag'),
    requireScope(SCOPES.deliveryRead),
    async (c) => c.json(await getDeliveredTag(ctx, scopeOf(c), c.req.param('slug'), termOpts(c))),
  );
  app.get(
    `${BASE}/taxonomy/concepts`,
    describe('listConcepts'),
    requireScope(SCOPES.deliveryRead),
    async (c) =>
      c.json({
        items: await listDeliveredConcepts(ctx, scopeOf(c), { ...termOpts(c), ...schemeOf(c) }),
      }),
  );
  app.get(
    `${BASE}/taxonomy/concepts/:slug`,
    describe('getConcept'),
    requireScope(SCOPES.deliveryRead),
    async (c) =>
      c.json(
        await getDeliveredConcept(ctx, scopeOf(c), c.req.param('slug'), {
          ...termOpts(c),
          ...schemeOf(c),
        }),
      ),
  );
  // Redirects are site data, not content: any delivery key reads them, content grants or not.
  // Cached and purged like every read here (`redirects.changed`, and a publish's slug change).
  app.get(
    `${BASE}/redirects`,
    describe('listRedirects'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const items = await listDeliveredRedirects(ctx, scopeOf(c));
      return c.json({ items, total: items.length });
    },
  );
  app.get(
    `${BASE}/redirects/resolve`,
    describe('resolveRedirect'),
    requireScope(SCOPES.deliveryRead),
    async (c) =>
      c.json(
        await resolveDeliveredRedirect(
          ctx,
          scopeOf(c),
          c.req.query('path') ?? '',
          c.req.query('locale') || undefined,
        ),
      ),
  );
  // Menus are site data a front end renders: any delivery key reads them, resolved against
  // published entries only, and an entry link to a type the key can't read is dropped as if
  // unpublished. Cached and purged like every read here (`menus.changed`, and the entry events).
  app.get(`${BASE}/menus`, describe('listMenus'), requireScope(SCOPES.deliveryRead), async (c) => {
    const items = await listDeliveredMenus(ctx, scopeOf(c));
    return c.json({ items, total: items.length });
  });
  app.get(
    `${BASE}/menus/:handle`,
    describe('getMenu'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const principal = c.get('principal');
      // The key's grants apply as on its entry reads: types it can't read, and fields it is
      // denied, never shape what it's served.
      return c.json(
        await getDeliveredMenu(ctx, scopeOf(c), c.req.param('handle'), {
          ...(c.req.query('locale') ? { locale: c.req.query('locale') } : {}),
          principal,
        }),
      );
    },
  );
  // Where each published type's entries live on the site, for a front end that routes pages from
  // the model. Unlike redirects these are content: a key limited to some types sees only theirs.
  // Cached and purged like every read here (`content_type.published`).
  app.get(
    `${BASE}/routes`,
    describe('listRoutes'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const principal = c.get('principal');
      const items = await listDeliveredRoutes(
        ctx,
        scopeOf(c),
        principal.contentGrants
          ? { readable: (t: string) => canAccessContentType(principal, 'read', t) }
          : {},
      );
      return c.json({ items, total: items.length });
    },
  );

  // The sitemap: every published entry's URLs from its type's URL pattern, with noindex pages and
  // pages whose canonical copy is elsewhere left out. JSON for a front end, paged by entry id;
  // `sitemap.xml` for crawlers, which a site serves at its own /sitemap.xml by proxying here with
  // `base` set to itself (a Delivery key never reaches a crawler). Like routes, a key limited to
  // some types sees only theirs. Cached and purged like every read here: a publish, unpublish or
  // URL pattern change purges the scope's tag.
  app.get(
    `${BASE}/sitemap`,
    describe('getSitemap'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const base = c.req.query('base');
      const from = c.req.query('from');
      const limit = clampCount(c.req.query('limit'), MAX_SITEMAP_PAGE, { min: 1 });
      return c.json(
        await listDeliveredSitemap(
          ctx,
          scopeOf(c),
          { ...(from ? { from } : {}), ...(limit !== undefined ? { limit } : {}) },
          {
            principal: c.get('principal'),
            ...(base !== undefined ? { site: sitemapBase(base) } : {}),
          },
        ),
      );
    },
  );
  app.get(
    `${BASE}/sitemap.xml`,
    describe('getSitemapXml'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const site = sitemapBase(c.req.query('base'));
      const file = await deliveredSitemapFile(ctx, scopeOf(c), c.req.query('page') || undefined, {
        principal: c.get('principal'),
        site,
      });
      return c.body(renderSitemapXml(file, site.base), 200, {
        'content-type': 'application/xml; charset=utf-8',
      });
    },
  );

  // Live Content API: an SSE stream of published-content changes for this scope.
  // Optional ?types=entry.published,entry.unpublished filters the event types.
  app.get(`${BASE}/live`, describe('live'), requireScope(SCOPES.deliveryRead), (c) => {
    const scope = scopeOf(c);
    const types = (c.req.query('types') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const principal = c.get('principal');
    return streamSSE(c, async (stream) => {
      const sub = bus.subscribe('*', async (event) => {
        if (event.scope.spaceId !== scope.spaceId) return;
        if (event.scope.environmentId !== scope.environmentId) return;
        if (types.length > 0 && !types.includes(event.type)) return;
        // Only published-content facts, and only what this principal may read (as LiveHubDO).
        const visible = liveEventFor(principal, event);
        if (!visible) return;
        await stream.writeSSE({
          event: visible.type,
          id: visible.id,
          data: JSON.stringify(visible),
        });
      });
      stream.onAbort(() => void sub.close());
      // Heartbeat so proxies keep the connection open, until the client leaves or the stream's
      // lifetime ends (the client reconnects and is authorized again, as with LiveHubDO).
      const until = Date.now() + LIVE_STREAM_MAX_MS;
      while (!stream.aborted && Date.now() < until) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15000);
      }
      await sub.close();
    });
  });

  // Deprecated: a delivered asset carries its srcset and renditions. With a media origin this is
  // a permanent, cacheable redirect to the media URL of the next width step up (or the named
  // rendition); without one, the earlier signed transform URL, redirected for this request only.
  app.get(
    `${BASE}/assets/:id/transform`,
    describe('transform'),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      if (c.get('principal').contentGrants) return c.body(null, 403);
      if (ctx.mediaPublicUrl && ctx.mediaPaths) {
        const w = c.req.query('w');
        const rendition = c.req.query('rendition');
        const url = await assetTransformTarget(ctx, scopeOf(c), c.req.param('id'), {
          ...(w ? { width: Number(w) } : {}),
          ...(rendition ? { rendition } : {}),
        });
        return c.redirect(url, 301);
      }
      const { url } = await transformPublishedAssetUrl(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        parseImageTransform(c.req.query()),
      );
      return c.redirect(url, 302);
    },
  );

  // --- GraphQL Delivery ---------------------------------------------------
  // Schema is generated from the published view of the content types the
  // principal may read and cached content-addressed (scope + a digest of what
  // shapes it: each visible type's id, published fields and singleton flag, so
  // a draft of a live type rebuilds nothing, and a merge or promotion that
  // publishes other fields at the same version does). It rebuilds when those
  // change and is
  // shared across principals with the same visible shape. The schema holds NO
  // principal state — resolvers travel per-request via the GraphQL
  // contextValue (a cached schema serving another caller's closures would be
  // an RBAC bypass: field-level masking belongs to the principal, not the
  // shape). Bounded FIFO eviction keeps many-space isolates flat.
  const schemaCache = new Map<string, GraphQLSchema>();
  const MAX_SCHEMA_CACHE = 100;

  async function schemaFor(
    scope: Scope,
    principal: AuthVars['Variables']['principal'],
    reads: DeliveryReads,
  ): Promise<GraphQLSchema> {
    // The space config rides along: every field the query resolves needs its default locale, so
    // reading it here saves the resolvers a round trip of their own.
    const { contentTypes: types = [] } = await reads.read(scope, {
      contentTypes: true,
      config: true,
    });
    const grantedTypes = principal.contentGrants
      ? types.filter((t) => canAccessContentType(principal, 'read', t.apiId))
      : types;
    const shape = grantedTypes
      // The singleton flag changes a root's shape on a publish that keeps the version, and a merge
      // or promotion can publish other fields at a version already served: only the fields say.
      .map((t) => `${t.apiId}${t.singleton ? ':singleton' : ''}:${JSON.stringify(t.fields)}`)
      .sort()
      .join('\n');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shape));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = `${scope.spaceId}:${scope.environmentId}:${hex}`;
    const cached = schemaCache.get(key);
    if (cached) return cached;
    const schema = buildDeliverySchema(grantedTypes);
    if (schemaCache.size >= MAX_SCHEMA_CACHE) {
      const oldest = schemaCache.keys().next().value;
      if (oldest !== undefined) schemaCache.delete(oldest);
    }
    schemaCache.set(key, schema);
    return schema;
  }

  // In-browser GraphQL explorer. Registered OUTSIDE the guarded BASE/* prefix so
  // the page loads without a token; the user sets the bearer in GraphiQL's header
  // editor and the /graphql POST it issues is what gets scope-checked.
  app.get('/graphiql/:space/:env', (c) =>
    c.html(graphiqlHtml(`/delivery/${c.req.param('space')}/${c.req.param('env')}/graphql`)),
  );

  app.all(`${BASE}/graphql`, requireScope(SCOPES.deliveryRead), async (c) => {
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : {};
    const source = (body as { query?: string }).query ?? c.req.query('query');
    if (!source) return c.json({ errors: [{ message: 'No GraphQL query provided' }] }, 400);
    const scope = scopeOf(c);
    const principal = c.get('principal');
    // One request's reads: what the schema read, the resolvers reuse (never across requests).
    const reads = deliveryReads(ctx);
    const schema = await schemaFor(scope, principal, reads);

    let document: ReturnType<typeof parse>;
    try {
      document = parse(source);
    } catch (err) {
      const message = err instanceof GraphQLError ? err.message : 'Invalid GraphQL query';
      return c.json({ errors: [{ message }] }, 400);
    }

    // Bound query depth (a single request can otherwise fan out unboundedly) and,
    // in production, forbid introspection so the per-space schema isn't exposed.
    const rules: ValidationRule[] = [...specifiedRules, depthLimitRule(MAX_GQL_DEPTH)];
    if (process.env.NODE_ENV === 'production') rules.push(NoSchemaIntrospectionCustomRule);
    const errors = validate(schema, document, rules);
    if (errors.length > 0) return c.json({ errors }, 400);

    const result = await execute({
      schema,
      document,
      // Data access is bound to THIS caller here — never inside the cached
      // schema (see schemaFor).
      contextValue: {
        resolvers: deliveryGraphResolvers(ctx, scope, principal, { rag, reads }),
      } satisfies DeliveryContext,
      variableValues: (body as { variables?: Record<string, unknown> }).variables,
      operationName: (body as { operationName?: string }).operationName,
    });
    // In production, redact resolver/library error messages so internal details
    // (SQL, stack fragments) don't leak; keep the path so clients can still locate
    // the failing field.
    if (result.errors && process.env.NODE_ENV === 'production') {
      return c.json({
        ...result,
        errors: result.errors.map((e) => ({ message: 'Internal error', path: e.path })),
      });
    }
    return c.json(result);
  });

  return app;
}

/** Minimal GraphiQL explorer page (CDN-hosted assets) wired to `endpoint`. */
/**
 * The GraphiQL page's scripts, pinned to exact versions with Subresource Integrity, so a changed
 * or compromised CDN file is refused rather than run on a page where people paste their keys.
 * GraphiQL 4 is the last major that ships a browser (UMD) build, and React 18 the last React
 * with one; an unpinned `graphiql` URL now resolves to 5.x, which has none, and broke the page.
 */
const GRAPHIQL_ASSETS = {
  css: {
    href: 'https://unpkg.com/graphiql@4.1.2/graphiql.min.css',
    integrity: 'sha384-1el1QShFBnnXTx9x/Cprg82hZWKt0ry29OAYIXt05swbi0KcZDFoj0CWguMpopJr',
  },
  scripts: [
    {
      src: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
      integrity: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
    },
    {
      src: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
      integrity: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1',
    },
    {
      src: 'https://unpkg.com/graphiql@4.1.2/graphiql.min.js',
      integrity: 'sha384-9XdHu7ajgGJziD4J1zNBKQ842Q/+zZfDv+ib1eMhZWBH6hPAs806x+Jbcf0yNO6B',
    },
  ],
} as const;

/**
 * A value as a JavaScript literal safe inside an inline <script>: JSON with `<` escaped, so a
 * `</script>` in it (the space and environment come from the URL) can't end the element.
 */
const inlineJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function graphiqlHtml(endpoint: string): string {
  const scripts = GRAPHIQL_ASSETS.scripts
    .map(
      (s) => `<script src="${s.src}" integrity="${s.integrity}" crossorigin="anonymous"></script>`,
    )
    .join('\n    ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>CommerceWorker GraphiQL</title>
    <style>body,#graphiql{height:100vh;margin:0}</style>
    <link rel="stylesheet" href="${GRAPHIQL_ASSETS.css.href}" integrity="${GRAPHIQL_ASSETS.css.integrity}" crossorigin="anonymous" />
  </head>
  <body>
    <div id="graphiql">Loading…</div>
    ${scripts}
    <script>
      const fetcher = GraphiQL.createFetcher({ url: ${inlineJson(endpoint)} });
      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, {
          fetcher,
          defaultHeaders: JSON.stringify({ Authorization: 'Bearer <your CDA or CPA key>' }, null, 2),
        }),
      );
    </script>
  </body>
</html>`;
}
