import {
  addComment,
  createTask,
  listComments,
  listTasks,
  resolveTask,
  transitionEntry,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerCollaborationTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { ctx, principal, guard } = t;
  // --- collaboration: comments, tasks, workflow --------------------------
  server.registerTool(
    'comments_list',
    {
      description: 'List comments on an entry (oldest first; threaded via parentId).',
      inputSchema: toolSchema('comments_list', () =>
        z.object({ entryId: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listComments(ctx, scopeOf(args), args.entryId));
    },
  );

  server.registerTool(
    'comments_add',
    {
      description: 'Add a comment (or threaded reply) to an entry.',
      inputSchema: toolSchema('comments_add', () =>
        z.object({
          entryId: z.string(),
          body: z.string(),
          author: z.string().optional(),
          parentId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await addComment(ctx, scopeOf(args), {
          entryId: args.entryId,
          body: args.body,
          author: args.author ?? principal.kind,
          parentId: args.parentId,
        }),
      );
    },
  );

  server.registerTool(
    'tasks_list',
    {
      description: 'List tasks on an entry.',
      inputSchema: toolSchema('tasks_list', () => z.object({ entryId: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listTasks(ctx, scopeOf(args), args.entryId));
    },
  );

  server.registerTool(
    'tasks_create',
    {
      description: 'Create an editorial task on an entry, optionally assigned to someone.',
      inputSchema: toolSchema('tasks_create', () =>
        z.object({
          entryId: z.string(),
          body: z.string(),
          assignee: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createTask(ctx, scopeOf(args), {
          entryId: args.entryId,
          body: args.body,
          assignee: args.assignee,
        }),
      );
    },
  );

  server.registerTool(
    'tasks_resolve',
    {
      description: 'Mark a task resolved.',
      inputSchema: toolSchema('tasks_resolve', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(await resolveTask(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'workflow_transition',
    {
      description:
        'Move an entry into a workflow step. The target step may require a scope the ' +
        'caller must hold (enforced from the workflow definition).',
      inputSchema: toolSchema('workflow_transition', () =>
        z.object({
          entryId: z.string(),
          workflowId: z.string(),
          toStepId: z.string(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await transitionEntry(
          ctx,
          scopeOf(args),
          { entryId: args.entryId, workflowId: args.workflowId, toStepId: args.toStepId },
          principal.scopes,
        ),
      );
    },
  );
}
