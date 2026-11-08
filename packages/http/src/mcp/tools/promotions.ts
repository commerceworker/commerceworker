import {
  approvePromotion,
  getPromotion,
  listPromotions,
  rejectPromotion,
  requestPromotion,
} from '@commerceworker/application';
import {
  MAX_PROMOTION_CONTENT_TYPES,
  MAX_PROMOTION_ENTRIES,
  PROMOTION_STATUSES,
  SCOPES,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DEFAULT_ENV, DEFAULT_SPACE, ok, type ToolContext, toolSchema } from './shared';

export function registerPromotionTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal, guard } = t;
  // --- promotions (environment → environment, with approval) -------------
  server.registerTool(
    'promotion_request',
    {
      description:
        'Promote content from one environment to another. Pins the entries to copy (what is live ' +
        'in the source goes live in the target; drafts go as drafts) and runs a risk check. ' +
        'Applies at once when nothing stops it; otherwise it waits as `awaiting_approval` (into ' +
        'main or an aliased environment, a field removed or retyped, or the risk check flagged ' +
        'it), and someone other than you approves it with promotion_approve. Omit contentTypes ' +
        'and entries to promote everything that differs (at most 200 entries).',
      inputSchema: toolSchema('promotion_request', () =>
        z.object({
          source: z.string(),
          target: z.string(),
          contentTypes: z.array(z.string()).max(MAX_PROMOTION_CONTENT_TYPES).optional(),
          entries: z.array(z.string()).max(MAX_PROMOTION_ENTRIES).optional(),
          space: z.string().optional(),
        }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentManage, { spaceId, environmentId: args.target });
      guard(SCOPES.contentPublish, { spaceId, environmentId: args.target });
      return ok(
        await requestPromotion(ctx, principal, spaceId, {
          source: args.source,
          target: args.target,
          ...(args.contentTypes ? { contentTypes: args.contentTypes } : {}),
          ...(args.entries ? { entries: args.entries } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'promotion_list',
    {
      description: 'List promotions, newest first, optionally only those with one status.',
      inputSchema: toolSchema('promotion_list', () =>
        z.object({
          status: z.enum(PROMOTION_STATUSES).optional(),
          space: z.string().optional(),
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await listPromotions(ctx, spaceId, args.status ? { status: args.status } : {}));
    },
  );

  server.registerTool(
    'promotion_get',
    {
      description: 'Get a promotion: what it copies, its risk check and why, and its result.',
      inputSchema: toolSchema('promotion_get', () =>
        z.object({ id: z.string(), space: z.string().optional() }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await getPromotion(ctx, spaceId, args.id));
    },
  );

  server.registerTool(
    'promotion_approve',
    {
      description:
        'Approve a promotion waiting for approval, and apply it. Refused for whoever requested it.',
      inputSchema: toolSchema('promotion_approve', () =>
        z.object({ id: z.string(), space: z.string().optional() }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await approvePromotion(ctx, principal, spaceId, args.id));
    },
  );

  server.registerTool(
    'promotion_reject',
    {
      description: 'Reject a promotion waiting for approval; nothing is copied.',
      inputSchema: toolSchema('promotion_reject', () =>
        z.object({ id: z.string(), space: z.string().optional() }),
      ),
    },
    async (args) => {
      const spaceId = args.space ?? DEFAULT_SPACE;
      guard(SCOPES.contentPublish, { spaceId, environmentId: DEFAULT_ENV });
      return ok(await rejectPromotion(ctx, principal, spaceId, args.id));
    },
  );
}
