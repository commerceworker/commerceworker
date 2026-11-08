import {
  addEntryToRelease,
  createRelease,
  getRelease,
  listReleases,
  publishRelease,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerReleaseTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;
  // --- releases & scheduling ---------------------------------------------
  server.registerTool(
    'releases_list',
    {
      description:
        'List releases (entry bundles published together) in a space/environment, newest ' +
        'first, each with itemCount (how many members it holds).',
      inputSchema: toolSchema('releases_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listReleases(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'releases_get',
    {
      description: 'Get a release with its member entries.',
      inputSchema: toolSchema('releases_get', () => z.object({ id: z.string(), ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getRelease(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'releases_create',
    {
      description: 'Create an open release to group entries for atomic publishing.',
      inputSchema: toolSchema('releases_create', () =>
        z.object({
          title: z.string(),
          description: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await createRelease(ctx, scopeOf(args), {
          title: args.title,
          description: args.description,
        }),
      );
    },
  );

  server.registerTool(
    'releases_add_entry',
    {
      description:
        "Add an entry to an open release, choosing whether it publishes or unpublishes. Your role must grant read and that action on the entry's type.",
      inputSchema: toolSchema('releases_add_entry', () =>
        z.object({
          releaseId: z.string(),
          entryId: z.string(),
          action: z.enum(['publish', 'unpublish']).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await addEntryToRelease(
          ctx,
          scopeOf(args),
          args.releaseId,
          {
            entityId: args.entryId,
            action: args.action,
          },
          { principal: t.principal },
        ),
      );
    },
  );

  server.registerTool(
    'releases_publish',
    {
      description:
        "Ship a release: publish/unpublish every member atomically in one transaction. Refused whole (publish_gated) when a gated workflow covers a member it publishes, and (forbidden) when your role lacks publish or unpublish on a member's type.",
      inputSchema: toolSchema('releases_publish', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishRelease(ctx, scopeOf(args), args.id, { principal: t.principal }));
    },
  );
}
