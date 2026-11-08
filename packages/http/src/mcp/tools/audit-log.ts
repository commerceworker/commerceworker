import { listAuditLog, listEntryActivity } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  DEFAULT_ENV,
  DEFAULT_SPACE,
  ok,
  scopeArgs,
  scopeOf,
  type ToolContext,
  toolSchema,
} from './shared';

export function registerAuditLogTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;
  // --- audit log (governance) --------------------------------------------
  server.registerTool(
    'audit_log_list',
    {
      description:
        'List a space’s append-only audit trail (mutating actions), newest first. Filters are ' +
        'exact matches and all apply together. Returns one page; pass nextCursor back as cursor, ' +
        'with the same filters, for the next. A row whose action saved entries carries `detail`: ' +
        'each entry’s changed field paths and locales, never a value. Older rows have none.',
      inputSchema: toolSchema('audit_log_list', () =>
        z.object({
          space: z.string().optional(),
          environment: z.string().optional(),
          actor: z.string().optional().describe('A person’s id, admin-token, or the kind of key'),
          action: z
            .string()
            .optional()
            .describe('`<METHOD> <route>` for a REST call, `MCP <tool>` for a tool call'),
          targetType: z
            .string()
            .optional()
            .describe('The kind of thing acted on (entry, release, content_type, …)'),
          targetId: z.string().optional().describe('The id of the thing acted on'),
          from: z
            .string()
            .optional()
            .describe('Earliest time, inclusive: an ISO 8601 date (UTC) or date-time'),
          to: z
            .string()
            .optional()
            .describe('Latest time, inclusive: an ISO 8601 date (to its end, UTC) or date-time'),
          limit: z.number().int().positive().optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.spaceAdmin, { spaceId, environmentId: DEFAULT_ENV });
      const { space: _space, environment, ...query } = args;
      return ok(await listAuditLog(ctx, spaceId, { ...query, environmentId: environment }));
    },
  );

  // --- an entry's activity (the audit log through its entry index) --------
  // REST's GET /entries/:id/activity, with the audit log's rule: a row names who acted and how.
  server.registerTool(
    'entries_list_activity',
    {
      description:
        'List one entry’s history in an environment, newest first: the audit rows that target ' +
        'it, and those that target something else but saved it (an approved agent review, a ' +
        'duplicate made from another entry, a cancelled workflow run’s undo). Same rows and ' +
        'paging as audit_log_list, and the same permission. A row that saved the entry carries ' +
        '`detail` with its changed field paths and locales; older rows have none, which says ' +
        'nothing about what they changed. Returns one page; pass nextCursor back as cursor.',
      inputSchema: toolSchema('entries_list_activity', () =>
        z.object({
          id: z.string().describe('The entry’s id'),
          limit: z.number().int().positive().optional(),
          cursor: z.string().optional().describe('nextCursor from the previous page'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await listEntryActivity(ctx, scopeOf(args), args.id, {
          limit: args.limit,
          cursor: args.cursor,
        }),
      );
    },
  );
}
