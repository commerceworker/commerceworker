import {
  analyzeRedirectSet,
  collapseRedirects,
  createRedirect,
  deleteRedirect,
  getRedirect,
  importRedirects,
  listRedirects,
  MAX_PAGE_LIMIT,
  resolveRedirect,
  updateRedirect,
} from '@commerceworker/application';
import {
  MAX_REDIRECT_IMPORT,
  MAX_REDIRECT_LENGTH,
  MAX_REDIRECT_NOTE_LENGTH,
  SCOPES,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerRedirectTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { ctx, guard } = t;
  // --- redirects ---------------------------------------------------------
  const redirectArgs = {
    source: z
      .string()
      .max(MAX_REDIRECT_LENGTH)
      .describe('A path: /old, /blog/[slug] (one segment), /docs/[...rest] (one or more, last)'),
    destination: z
      .string()
      .max(MAX_REDIRECT_LENGTH)
      .describe('A path (may have ?query#fragment) or an https:// URL; [slug]/[...rest] insert'),
    status: z
      .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
      .optional()
      .describe('default 301'),
    locale: z.string().nullable().optional().describe('one locale only; null for every locale'),
    enabled: z.boolean().optional(),
    note: z.string().max(MAX_REDIRECT_NOTE_LENGTH).nullable().optional(),
  };

  server.registerTool(
    'redirects_list',
    {
      description:
        "List an environment's redirects by source (paged), optionally searching source, " +
        'destination and note.',
      inputSchema: toolSchema('redirects_list', () =>
        z.object({
          q: z.string().max(256).optional(),
          limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
          cursor: z.string().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await listRedirects(ctx, scopeOf(args), {
          ...(args.q ? { q: args.q } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'redirects_get',
    {
      description: 'Get one redirect by id.',
      inputSchema: toolSchema('redirects_get', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getRedirect(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'redirects_create',
    {
      description:
        'Create a redirect. Refused when the source is already redirected for that locale, ' +
        'when it would close a loop, or past the cap; a chain it makes is allowed and returned ' +
        'in `chains` (redirects_collapse_chains straightens them).',
      inputSchema: toolSchema('redirects_create', () =>
        z.object({ ...redirectArgs, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      const { space: _s, environment: _e, ...input } = args;
      return ok(await createRedirect(ctx, scopeOf(args), input));
    },
  );

  server.registerTool(
    'redirects_update',
    {
      description:
        'Change a redirect (e.g. enabled: false to switch it off). Fields left out keep their ' +
        'value; null clears locale or note.',
      inputSchema: toolSchema('redirects_update', () =>
        z.object({ id: z.string(), ...z.object(redirectArgs).partial().shape, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      const { space: _s, environment: _e, id, ...patch } = args;
      return ok(await updateRedirect(ctx, scopeOf(args), id, patch));
    },
  );

  server.registerTool(
    'redirects_delete',
    {
      description: 'Delete a redirect.',
      inputSchema: toolSchema('redirects_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      await deleteRedirect(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );

  server.registerTool(
    'redirects_import',
    {
      description:
        `Import up to ${MAX_REDIRECT_IMPORT} redirects from CSV (header: source, destination, ` +
        'status, locale, enabled, note) or a JSON array, all or nothing. A source already ' +
        'redirected is updated. dryRun reports without writing.',
      inputSchema: toolSchema('redirects_import', () =>
        z.object({
          format: z.enum(['csv', 'json']),
          data: z.string().max(1_000_000).describe('the CSV text, or the JSON array as text'),
          dryRun: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await importRedirects(ctx, scopeOf(args), {
          format: args.format,
          data: args.data,
          ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'redirects_resolve',
    {
      description:
        'Resolve a request path against the enabled redirects: the redirect, its status and the ' +
        'location (captures filled in), or null. What Delivery answers a front end.',
      inputSchema: toolSchema('redirects_resolve', () =>
        z.object({ path: z.string().max(4096), locale: z.string().optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await resolveRedirect(ctx, scopeOf(args), args.path, args.locale));
    },
  );

  server.registerTool(
    'redirects_analyze',
    {
      description:
        'Check the whole redirect set: loops, chains (with where each ends) and duplicate sources.',
      inputSchema: toolSchema('redirects_analyze', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await analyzeRedirectSet(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'redirects_collapse_chains',
    {
      description: 'Point every redirect that ends a chain straight at where its chain ends.',
      inputSchema: toolSchema('redirects_collapse_chains', () => z.object(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await collapseRedirects(ctx, scopeOf(args)));
    },
  );
}
