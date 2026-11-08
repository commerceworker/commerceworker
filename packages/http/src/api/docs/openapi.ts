import type { ApiConfig } from '@commerceworker/platform/config';
import { Scalar } from '@scalar/hono-api-reference';
import type { Hono } from 'hono';
import { type DescribeRouteOptions, describeRoute, generateSpecs, resolver } from 'hono-openapi';
import { z } from 'zod';
import { errorResponse } from './schemas/common';

/** Standard-schema (zod) type accepted by hono-openapi's resolver. */
type AnySchema = Parameters<typeof resolver>[0];

/**
 * describeRoute options with the house style baked in: tag, summary, a JSON
 * 200 response when a schema is given, and the standard auth error responses.
 * Routes without an explicit description still appear in the spec via route
 * introspection — this helper is for the ones worth documenting richly.
 */
export function doc(
  tag: string,
  summary: string,
  opts: {
    ok?: AnySchema;
    okDescription?: string;
    status?: number;
    description?: string;
    query?: Record<string, string>;
    /**
     * The schema the route parses its body with.
     *
     * Pass the same zod schema the handler hands to `parseBody`, so the
     * document describes what the route actually accepts rather than a
     * second description of it that can drift.
     */
    body?: z.ZodType;
    bodyDescription?: string;
  } = {},
) {
  const status = opts.status ?? 200;
  const spec: DescribeRouteOptions = {
    tags: [tag],
    summary,
    description: opts.description,
    ...(opts.query
      ? {
          parameters: Object.entries(opts.query).map(([name, description]) => ({
            name,
            in: 'query' as const,
            required: false,
            schema: { type: 'string' as const },
            description,
          })),
        }
      : {}),
    ...(opts.body
      ? {
          requestBody: {
            required: true,
            ...(opts.bodyDescription ? { description: opts.bodyDescription } : {}),
            // Converted here, at route-registration time, rather than lazily:
            // a schema the converter cannot represent then fails at boot
            // instead of producing a document that is quietly missing a body.
            // `io: 'input'` because a body is what the caller sends — for a
            // schema with defaults, the output type would describe what the
            // handler receives, which is not what a client has to provide.
            content: {
              'application/json': {
                schema: z.toJSONSchema(opts.body, {
                  io: 'input',
                  unrepresentable: 'any',
                }) as Record<string, unknown>,
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: opts.okDescription ?? 'Success',
        ...(opts.ok ? { content: { 'application/json': { schema: resolver(opts.ok) } } } : {}),
      },
      401: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: resolver(errorResponse) } },
      },
      403: {
        description: 'Token lacks the required scope for this space',
        content: { 'application/json': { schema: resolver(errorResponse) } },
      },
    },
  };
  return describeRoute(spec);
}

const DOCUMENTED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HIDDEN_PATHS = new Set(['/openapi.json', '/docs']);

/** Hono `:param` syntax → OpenAPI `{param}`. */
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

// ---- Tag taxonomy -----------------------------------------------------------
// Every operation gets exactly one tag: `doc()`-annotated routes declare
// theirs; inventory routes are classified by the path rules below (first
// match wins — specific capabilities before the broad Entries/Spaces
// catch-alls). Scalar renders the two-level nav from x-tagGroups.

export const TAGS: { name: string; description: string }[] = [
  { name: 'System', description: 'Liveness/readiness probes.' },
  {
    name: 'Auth',
    description: 'Principal resolution (web sign-in, API keys), and ending a person’s credentials.',
  },
  {
    name: 'Spaces & environments',
    description: 'Spaces, environments (branches), aliases, compare/merge, and space config.',
  },
  { name: 'Roles & permissions', description: 'Custom roles with content-type + field grants.' },
  { name: 'Audit', description: 'Append-only audit trail of mutating actions.' },
  { name: 'Content types', description: 'The content model: types, fields, publishing.' },
  { name: 'Taxonomy', description: 'Tags, concepts, and concept schemes (SKOS-style).' },
  { name: 'Entries', description: 'Authoring: drafts, publishing, bulk operations, metadata.' },
  { name: 'Versions', description: 'Append-only entry version history, diff, and restore.' },
  {
    name: 'Assets',
    description:
      'The asset library: direct and multipart uploads, hosted video, metadata, rights and ' +
      'embargoes, file versions, folders, collections, bulk jobs, zip downloads, share links, ' +
      'rendition presets and transforms.',
  },
  { name: 'Comments & tasks', description: 'Editorial collaboration on entries.' },
  { name: 'Workflows', description: 'Editorial workflow definitions and entry transitions.' },
  {
    name: 'Saved views',
    description:
      'Named entries-list queries and columns, personal or shared, run with the caller’s own grants.',
  },
  {
    name: 'Releases & scheduling',
    description: 'Grouped releases and scheduled publish/unpublish actions.',
  },
  {
    name: 'Redirects',
    description: 'Redirects as delivery data: paths and patterns a front end applies.',
  },
  {
    name: 'Menus',
    description:
      'Navigation menus as delivery data: named trees of entry, term and URL links a front end renders.',
  },
  { name: 'Webhooks', description: 'Signed event webhooks and delivery logs.' },
  { name: 'Functions', description: 'User-defined HTTP functions invoked on domain events.' },
  { name: 'Apps', description: 'App extensions (custom field editors, sidebars).' },
  {
    name: 'AI & agents',
    description:
      'Generation, translation, moderation, semantic tooling, AI actions, and the agent run ledger.',
  },
  {
    name: 'Guides',
    description:
      "The product's own documentation, served over the API so agents can look up " +
      'conventions with the token they already hold.',
  },
  { name: 'Delivery', description: 'Published content: REST, hybrid search, SSE, GraphQL.' },
  { name: 'Preview', description: 'Draft/current content for previews.' },
];

const TAG_GROUPS = [
  {
    name: 'Platform',
    tags: ['System', 'Auth', 'Spaces & environments', 'Roles & permissions', 'Audit'],
  },
  { name: 'Content model', tags: ['Content types', 'Taxonomy'] },
  {
    name: 'Authoring',
    tags: ['Entries', 'Saved views', 'Versions', 'Assets', 'Comments & tasks', 'Workflows'],
  },
  {
    name: 'Publishing & automation',
    tags: ['Releases & scheduling', 'Redirects', 'Menus', 'Webhooks', 'Functions', 'Apps'],
  },
  { name: 'AI', tags: ['AI & agents'] },
  { name: 'Reference', tags: ['Guides'] },
  { name: 'Delivery', tags: ['Delivery', 'Preview'] },
];

const TAG_RULES: [RegExp, string][] = [
  [/^\/(health|ready)$/, 'System'],
  [/^\/guides/, 'Guides'],
  [/^\/auth\//, 'Auth'],
  [/\/api-keys/, 'Auth'],
  [/^\/delivery\//, 'Delivery'],
  [/^\/preview\//, 'Preview'],
  [/\/content-types/, 'Content types'],
  [/\/taxonomy\//, 'Taxonomy'],
  [/\/assets\/\{id\}\/(alt-text|auto-tag)/, 'AI & agents'],
  [/\/assets/, 'Assets'],
  [/\/entries\/\{id\}\/versions/, 'Versions'],
  [/\/entries\/\{id\}\/(comments|tasks)/, 'Comments & tasks'],
  [/\/(comments|tasks)\/\{id\}$/, 'Comments & tasks'],
  [/\/workflow(s|\b)/, 'Workflows'],
  [/\/entries\/(generate|canvas)$/, 'AI & agents'],
  [
    /\/entries\/\{id\}\/(autofill|translate|summarize|suggest-tags|duplicates|related|embedding|moderate)/,
    'AI & agents',
  ],
  [/\/(ai-actions|agent-runs)/, 'AI & agents'],
  [/\/audit(-log)?$/, 'Audit'],
  [/\/(releases|scheduled-actions)/, 'Releases & scheduling'],
  [/\/redirects/, 'Redirects'],
  [/\/menus/, 'Menus'],
  [/\/saved-views/, 'Saved views'],
  [/\/webhooks/, 'Webhooks'],
  [/\/functions/, 'Functions'],
  [/\/app-extensions/, 'Apps'],
  [/\/roles/, 'Roles & permissions'],
  [/\/entries|\/bulk\//, 'Entries'],
  [/^\/spaces/, 'Spaces & environments'],
];

const tagFor = (path: string): string =>
  TAG_RULES.find(([pattern]) => pattern.test(path))?.[1] ?? 'Spaces & environments';

/**
 * Adds a bare operation for every mounted route the spec doesn't already
 * cover — hono-openapi only emits `describeRoute`-annotated routes, but the
 * spec should be a complete inventory. Hono registers each middleware in a
 * handler chain as its own RouterRoute with the same method+path, so `??=`
 * dedupes; `use()`-style wildcard paths and non-HTTP methods are skipped.
 */
function addUndescribedRoutes(app: Hono, paths: Record<string, Record<string, unknown>>): void {
  for (const route of app.routes) {
    if (!DOCUMENTED_METHODS.has(route.method)) continue;
    if (route.path.includes('*')) continue;
    const path = toOpenApiPath(route.path);
    if (HIDDEN_PATHS.has(path) || path.startsWith('/graphiql')) continue;
    const method = route.method.toLowerCase();
    paths[path] ??= {};
    paths[path][method] ??= {
      summary: `${route.method} ${path}`,
      tags: [tagFor(path)],
      parameters: [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      responses: { 200: { description: 'Success' } },
    };
  }
}

/**
 * Mounts GET /openapi.json and GET /docs (Scalar UI). The spec merges the
 * richly-described routes (`doc()` annotations with schemas) with a bare
 * inventory of every other mounted route. Called last in createApp so
 * introspection sees all modules — the spec therefore honestly reflects the
 * ROLE gating of this deployment.
 */
export function mountDocs(app: Hono, config: ApiConfig): void {
  app.get('/openapi.json', async (c) => {
    const spec = await generateSpecs(
      app,
      {
        documentation: {
          info: {
            title: 'CommerceWorker API',
            version: '0.1.0',
            description: `API-first, AI-agentic-first headless CMS. Management (CMA), Delivery (CDA), and Preview (CPA) surfaces — this deployment serves role "${config.role}". Every capability is also exposed as an MCP tool at POST /mcp.`,
          },
          components: {
            securitySchemes: {
              bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                description:
                  'API key (CMA/CDA/CPA, hashed at rest) or the admin token. Keys are minted at ' +
                  'POST /spaces/{space}/api-keys.',
              },
            },
          },
          security: [{ bearerAuth: [] }],
          tags: TAGS,
        },
        exclude: ['/openapi.json', '/docs', /^\/graphiql/],
      },
      c,
    );
    const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
    addUndescribedRoutes(app, paths);
    spec.paths = paths;
    // Scalar/Redoc two-level sidebar. Only list tags this deployment mounts,
    // so a role-gated spec doesn't render empty groups.
    const usedTags = new Set(
      Object.values(paths).flatMap((ops) =>
        Object.values(ops).flatMap((op) => (op as { tags?: string[] }).tags ?? []),
      ),
    );
    spec.tags = TAGS.filter((t) => usedTags.has(t.name));
    (spec as Record<string, unknown>)['x-tagGroups'] = TAG_GROUPS.map((group) => ({
      ...group,
      tags: group.tags.filter((t) => usedTags.has(t)),
    })).filter((group) => group.tags.length > 0);
    return c.json(spec);
  });
  app.get(
    '/docs',
    Scalar({
      url: '/openapi.json',
      pageTitle: 'CommerceWorker API',
      cdn: scalarBundleUrl(config),
      // No fonts from Scalar's own host either, and no "Ask AI" (it sends the spec to Scalar's
      // service): the page makes no third-party requests.
      withDefaultFonts: false,
      agent: { disabled: true },
    }),
  );
}

/**
 * Where /docs loads the Scalar explorer from: the copy the web Worker serves from its own static
 * assets (`apps/studio/scripts/vendor-scalar.mjs`), pinned by the lockfile. Never Scalar's default, an
 * unversioned third-party CDN: /docs is also served on the admin origin, where a script runs with
 * the signed-in person's session. The admin origin is the OAuth issuer's (`OAUTH_ISSUER`, which
 * the fleet sets to it); with none configured, as in local dev, /docs is only reached through the
 * admin origin, so a same-origin path is right.
 */
export function scalarBundleUrl(config: Pick<ApiConfig, 'oauthIssuer'>): string {
  const origin = config.oauthIssuer ? new URL(config.oauthIssuer).origin : '';
  return `${origin}/vendor/scalar/standalone.js`;
}
