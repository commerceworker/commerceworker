import {
  AGENT_WORKFLOWS,
  countPendingApprovals,
  createAgentSchedule,
  decideAgentReview,
  deleteAgentSchedule,
  getAgentReview,
  getPreviewEntry,
  listAgentReviews,
  listAgentSchedules,
  updateAgentSchedule,
} from '@commerceworker/application';
import {
  assertWritableFields,
  authorizeContent,
  principalActorId,
  SCOPES,
  type Scope,
} from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, READ_ONLY, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerAgentTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { deps, ctx, principal, guard } = t;
  // --- agent schedules (recurring agent jobs) ------------------------------
  server.registerTool(
    'agent_schedule_create',
    {
      description:
        'Create a recurring agent job: on a cron cadence (UTC), run one agent ' +
        'workflow over entries published since the previous run.',
      inputSchema: toolSchema('agent_schedule_create', () =>
        z.object({
          workflow: z.enum(AGENT_WORKFLOWS),
          cron: z.string().describe('5-field cron expression, evaluated in UTC'),
          contentTypeApiId: z.string().optional(),
          enabled: z.boolean().optional(),
          autoApply: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await createAgentSchedule(ctx, scopeOf(args), {
          workflow: args.workflow,
          cron: args.cron,
          contentTypeApiId: args.contentTypeApiId,
          enabled: args.enabled,
          autoApply: args.autoApply,
        }),
      );
    },
  );

  server.registerTool(
    'agent_schedule_list',
    {
      description: 'List the recurring agent jobs configured for a space environment.',
      inputSchema: toolSchema('agent_schedule_list', () => z.object({ ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok({ items: await listAgentSchedules(ctx, scopeOf(args)) });
    },
  );

  server.registerTool(
    'agent_schedule_update',
    {
      description:
        'Update a recurring agent job (cron cadence, enabled, autoApply, content-type filter).',
      inputSchema: toolSchema('agent_schedule_update', () =>
        z.object({
          id: z.string(),
          cron: z.string().optional(),
          enabled: z.boolean().optional(),
          autoApply: z.boolean().optional(),
          contentTypeApiId: z.string().nullable().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await updateAgentSchedule(ctx, scopeOf(args), args.id, {
          cron: args.cron,
          enabled: args.enabled,
          autoApply: args.autoApply,
          contentTypeApiId: args.contentTypeApiId,
        }),
      );
    },
  );

  // --- agent reviews (human-in-the-loop) -----------------------------------
  server.registerTool(
    'agent_review_list',
    {
      description: 'List agent proposals awaiting (or past) human review.',
      inputSchema: toolSchema('agent_review_list', () =>
        z.object({
          status: z.enum(['pending', 'approved', 'rejected']).optional(),
          entryId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      // Role-bound principals see only reviews of types they read, with denied fields masked
      // (a review whose entry is gone is skipped rather than leak an unmaskable proposal).
      const items = await listAgentReviews(
        ctx,
        scopeOf(args),
        { status: args.status, entryId: args.entryId },
        principal,
      );
      return ok({ items });
    },
  );

  server.registerTool(
    'approvals_count',
    {
      description:
        'Count what waits on a human decision (pending workflow tasks and agent proposals), ' +
        'without listing it. Items on content types you can’t read are left out.',
      inputSchema: toolSchema('approvals_count', () => z.object({ ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.previewRead, s);
      return ok(await countPendingApprovals(ctx, s, principal));
    },
  );

  // Granular RBAC for a review decision: role-bound principals need write on
  // the entry's content type and every proposed field must be writable.
  const guardReviewDecision = async (s: Scope, reviewId: string) => {
    if (!principal.contentGrants) return;
    const review = await getAgentReview(ctx, s, reviewId);
    try {
      const entry = await getPreviewEntry(ctx, s, review.entryId);
      authorizeContent(principal, 'write', entry.contentType);
      assertWritableFields(principal, entry.contentType, review.proposed);
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') return; // entry gone
      throw err;
    }
  };

  server.registerTool(
    'agent_review_approve',
    {
      description:
        'Approve a pending agent proposal: its field values are applied as a new draft version (exactly once).',
      inputSchema: toolSchema('agent_review_approve', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardReviewDecision(scopeOf(args), args.id);
      return ok(
        await decideAgentReview(
          ctx,
          scopeOf(args),
          args.id,
          { approve: true, decidedBy: principalActorId(principal) },
          { signalReview: deps.signalReview },
        ),
      );
    },
  );

  server.registerTool(
    'agent_review_reject',
    {
      description: 'Reject a pending agent proposal (nothing is applied).',
      inputSchema: toolSchema('agent_review_reject', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      await guardReviewDecision(scopeOf(args), args.id);
      return ok(
        await decideAgentReview(
          ctx,
          scopeOf(args),
          args.id,
          { approve: false, decidedBy: principalActorId(principal) },
          { signalReview: deps.signalReview },
        ),
      );
    },
  );

  server.registerTool(
    'agent_schedule_delete',
    {
      description: 'Delete a recurring agent job.',
      inputSchema: toolSchema('agent_schedule_delete', () =>
        z.object({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      await deleteAgentSchedule(ctx, scopeOf(args), args.id);
      return ok({ deleted: true });
    },
  );
}
