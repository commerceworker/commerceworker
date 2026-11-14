import {
  cloneEnvironment,
  type EnvironmentSnapshot,
  exportSnapshot,
  importSnapshot,
  startEnvironmentClone,
  startSnapshotImport,
} from '@commerceworker/application';
import { authorizeEveryContentType, SCOPES } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { snapshotBody } from '../../api/validation';
import { ok, scopeArgs, type ToolContext, toolSchema } from './shared';

export function registerSnapshotTools(server: McpServer, t: ToolContext): void {
  const { scopeOf } = t;
  const { deps, ctx, guard, principal } = t;
  // --- environment snapshots ----------------------------------------------
  server.registerTool(
    'environment_export',
    {
      description:
        'Export an environment as a portable snapshot: content model, entries, ' +
        'taxonomy and workflows. Never includes credentials or asset binaries.',
      inputSchema: toolSchema('environment_export', () =>
        z.object({ limit: z.number().int().positive().optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      // Every entry of every type, every field: a role limited to some types or fields can't.
      authorizeEveryContentType(principal, ['read']);
      return ok(await exportSnapshot(ctx, scopeOf(args), { limit: args.limit }));
    },
  );

  server.registerTool(
    'environment_import',
    {
      description:
        'Import a snapshot (as environment_export returns it) into this environment, which ' +
        'must exist and have no content types. Every entry is checked first, and nothing is ' +
        'written if anything would fail. Set dryRun to see the report only. Otherwise the ' +
        'content model is written and the entries and assets are written by a job: the ' +
        'result is `{ report, job, publishJobId }`; follow `job` with bulk_job_status in this ' +
        'environment, then `publishJobId`, which starts once `job` completes with no failures.',
      inputSchema: toolSchema('environment_import', () =>
        z.object({
          snapshot: snapshotBody,
          publish: z.boolean().optional().describe('republish what was published (default true)'),
          dryRun: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      const target = scopeOf(args);
      guard(SCOPES.contentManage, target);
      const snapshot = args.snapshot as unknown as EnvironmentSnapshot;
      const options = {
        dryRun: args.dryRun,
        publish: args.publish,
        reindexAssets: Boolean(deps.assetIngest),
      };
      // As the route: it writes (and publishes) entries of every type the snapshot defines.
      authorizeEveryContentType(
        principal,
        args.publish !== false ? ['write', 'publish'] : ['write'],
      );
      if (args.dryRun || !deps.blob)
        return ok(await importSnapshot(ctx, target, snapshot, options));
      return ok(await startSnapshotImport(ctx, deps.blob, target, snapshot, options));
    },
  );

  server.registerTool(
    'environment_clone',
    {
      description:
        'Copy this environment into another (which may be in another space). The ' +
        'target must exist and have no content types. Set dryRun to see the report first. ' +
        'Otherwise it runs entirely as jobs: the result is `{ job, createJobId, publishJobId }`. ' +
        '`job` exports the source and checks it (a refused snapshot fails it; bulk_job_report ' +
        'names the problems), then starts `createJobId`, whose clean completion starts ' +
        '`publishJobId` (when anything is published). All belong to the TARGET: follow them ' +
        'with bulk_job_status passing `space`=targetSpace and `environment`=targetEnvironment.',
      inputSchema: toolSchema('environment_clone', () =>
        z.object({
          targetSpace: z.string().optional().describe('defaults to the source space'),
          targetEnvironment: z.string(),
          publish: z.boolean().optional().describe('republish what was published (default true)'),
          dryRun: z.boolean().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      const from = scopeOf(args);
      guard(SCOPES.contentManage, from);
      const to = {
        spaceId: args.targetSpace ?? from.spaceId,
        environmentId: args.targetEnvironment,
      };
      // Authorized separately: cloning into a space the caller cannot manage
      // would be a tenancy hole.
      guard(SCOPES.contentManage, to);
      // An export of the source and an import into the target, on every content type alike.
      authorizeEveryContentType(
        principal,
        args.publish !== false ? ['read', 'write', 'publish'] : ['read', 'write'],
      );
      const options = {
        dryRun: args.dryRun,
        publish: args.publish,
        reindexAssets: Boolean(deps.assetIngest),
      };
      if (args.dryRun || !deps.blob) {
        return ok(await cloneEnvironment(ctx, from, to, options));
      }
      return ok(await startEnvironmentClone(ctx, from, to, options));
    },
  );
}
