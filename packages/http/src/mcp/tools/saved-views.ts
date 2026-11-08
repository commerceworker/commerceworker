import {
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  MAX_PAGE_LIMIT,
  runSavedView,
  updateSavedView,
} from '@commerceworker/application';
import {
  FILTER_OPS,
  MAX_VIEW_COLUMNS,
  MAX_VIEW_FILTERS,
  MAX_VIEW_NAME_LENGTH,
  MAX_VIEW_ORDER,
  SCOPES,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/**
 * Saved views, on the use-cases the REST routes call, with the same rules: `preview:read` to
 * read, run and keep personal views; the use-case asks `content:manage` of anything shared. Each
 * call is the caller's own: another person's personal view, or one this role can't see, is "not
 * found".
 */
export function registerSavedViewTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard, principal, auditTarget } = t;
  const query = z
    .object({
      filters: z
        .array(
          z.object({
            field: z.string().describe('field apiId, a component path (seo.title) or sys.*'),
            op: z.enum(FILTER_OPS),
            value: z
              .any()
              .optional()
              .describe('a list for in, nin, refIn; [low, high] for between'),
          }),
        )
        .max(MAX_VIEW_FILTERS)
        .optional(),
      where: z
        .any()
        .optional()
        .describe('AND/OR groups of filters: {"and": [...]} or {"or": [...]}, nestable'),
      order: z
        .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }))
        .max(MAX_VIEW_ORDER)
        .optional(),
      search: z.string().optional(),
      extra: z
        .record(z.string(), z.any())
        .optional()
        .describe('query keys to keep verbatim that this version does not read'),
    })
    .describe('The structured query, as entries_query takes it');
  const columns = z
    .array(z.string())
    .max(MAX_VIEW_COLUMNS)
    .nullable()
    .optional()
    .describe('Columns besides the display field: sys.status, sys.updatedAt or field apiIds');
  const visibility = z
    .enum(['personal', 'shared'])
    .describe('personal (yours alone, the default) or shared with the space (content:manage)');

  server.registerTool(
    'views_list',
    {
      description:
        'List the saved views you can use: the space’s shared views and your own personal ones, ' +
        'each with its stored query and columns. contentType narrows to that type’s views and ' +
        'the views over every type.',
      inputSchema: toolSchema('views_list', () =>
        z.object({ contentType: z.string().optional(), ...scopeArgs }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const items = await listSavedViews(ctx, scopeOf(args), principal, {
        ...(args.contentType ? { contentTypeApiId: args.contentType } : {}),
      });
      return ok({ items, total: items.length });
    },
  );

  server.registerTool(
    'views_get',
    {
      description: 'Get one saved view by id: its query, columns, visibility and revision.',
      inputSchema: toolSchema('views_get', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getSavedView(ctx, scopeOf(args), principal, args.id));
    },
  );

  server.registerTool(
    'views_run',
    {
      description:
        'Run a saved view: one page of its entries through the same query as entries_query, ' +
        'with your own grants and hidden fields applied (never the creator’s). Pass nextCursor ' +
        'back as cursor for the next page. ignored names kept query keys it did not apply; ' +
        'typeMissing says the view’s content type is not in this environment.',
      inputSchema: toolSchema('views_run', () =>
        z.object({
          id: z.string(),
          limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
          locale: z.string().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await runSavedView(ctx, scopeOf(args), principal, args.id, {
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.locale ? { locale: args.locale } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'views_create',
    {
      description:
        'Save a named entries query (filters, where, order, search) and the columns to show, ' +
        'for one content type or (contentType omitted) every type. Checked as strictly as a ' +
        'live where. Personal unless visibility is shared, which needs content:manage.',
      inputSchema: toolSchema('views_create', () =>
        z.object({
          name: z.string().max(MAX_VIEW_NAME_LENGTH),
          contentType: z.string().optional(),
          visibility: visibility.optional(),
          query: query.optional(),
          columns,
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const view = await createSavedView(ctx, scopeOf(args), principal, {
        name: args.name,
        contentTypeApiId: args.contentType ?? null,
        ...(args.visibility ? { visibility: args.visibility } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.columns !== undefined ? { columns: args.columns } : {}),
      });
      auditTarget.set(args, view.id);
      return ok(view);
    },
  );

  server.registerTool(
    'views_update',
    {
      description:
        'Change a saved view: name, query (replaced whole), columns (null for the default) or ' +
        'visibility. Pass the revision you read to be refused rather than overwrite a save made ' +
        'since. Anything shared needs content:manage, and only the view’s creator can stop ' +
        'sharing it; anyone else can save a copy with views_create.',
      inputSchema: toolSchema('views_update', () =>
        z.object({
          id: z.string(),
          name: z.string().max(MAX_VIEW_NAME_LENGTH).optional(),
          visibility: visibility.optional(),
          query: query.optional(),
          columns,
          revision: z.int().min(1).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      const { space: _s, environment: _e, id, ...patch } = args;
      return ok(await updateSavedView(ctx, scopeOf(args), principal, id, patch));
    },
  );

  server.registerTool(
    'views_delete',
    {
      description: 'Delete a saved view: your own personal one, or a shared one (content:manage).',
      inputSchema: toolSchema('views_delete', () =>
        z.object({ id: z.string(), revision: z.int().min(1).optional(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      await deleteSavedView(ctx, scopeOf(args), principal, args.id, args.revision);
      return ok({ deleted: args.id });
    },
  );
}
