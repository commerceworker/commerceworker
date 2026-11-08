import {
  cloneEnvironment,
  type EnvironmentSnapshot,
  exportSnapshot,
  importSnapshot,
  startEnvironmentClone,
  startSnapshotImport,
} from '@commerceworker/application';
import { authorize, authorizeEveryContentType, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import { cloneBody, parseBody, snapshotBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function snapshotsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const app = new Hono<AuthVars>();

  // --- environment snapshots (export / import / clone) ---------------------
  app.get(
    `${BASE}/export`,
    doc('Spaces & environments', 'Export an environment as a snapshot', {
      description:
        'Portable JSON: content model, entries, taxonomy, workflows, and asset METADATA. ' +
        'Never includes credentials (API keys, OAuth clients, webhook secrets) or asset binaries.',
    }),
    // Reads the whole environment in one response, so it needs the same
    // authority as managing the model, not merely reading drafts.
    requireScope(SCOPES.contentManage),
    async (c) => {
      // Every entry of every type, every field: a role limited to some types or fields can't.
      authorizeEveryContentType(c.get('principal'), ['read']);
      const limit = c.req.query('limit');
      return c.json(
        await exportSnapshot(ctx, scopeOf(c), {
          limit: limit ? Number(limit) : undefined,
        }),
      );
    },
  );
  app.post(
    `${BASE}/import`,
    doc('Spaces & environments', 'Import a snapshot into this environment', {
      body: snapshotBody,
      description:
        'Replays the snapshot through the normal use-cases, so validation, the reference ' +
        'graph and the delivery read model all end up consistent. Requires an environment ' +
        'with no content types. Everything is checked before anything is written; then the ' +
        'content model, taxonomy and workflows are written and the assets and entries run as ' +
        "a job (202: `{ report, job, publishJobId }`; follow it at this environment's " +
        '`bulk/jobs/:id`, then the publishing job, which starts once it completes with no ' +
        'failures). `?dryRun=true` reports without writing (200).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const snapshot = (await parseBody(c, snapshotBody)) as unknown as EnvironmentSnapshot;
      const options = {
        dryRun: c.req.query('dryRun') === 'true',
        publish: c.req.query('publish') !== 'false',
        // Run inline (no blob store): the imported assets go through ingest once written.
        reindexAssets: Boolean(deps.assetIngest),
      };
      // It writes entries of every type the snapshot defines (and publishes them), so the role
      // must hold that on every type alike; one limited to some types or fields is refused.
      authorizeEveryContentType(
        c.get('principal'),
        options.publish ? ['write', 'publish'] : ['write'],
      );
      if (options.dryRun || !blob) {
        const report = await importSnapshot(actingCtx(ctx, c), scopeOf(c), snapshot, options);
        return c.json(report, report.dryRun ? 200 : 201);
      }
      return c.json(
        await startSnapshotImport(actingCtx(ctx, c), blob, scopeOf(c), snapshot, options),
        202,
      );
    },
  );
  app.post(
    `${BASE}/clone`,
    doc('Spaces & environments', 'Clone this environment into another', {
      body: cloneBody,
      status: 202,
      description:
        'Export plus import with no file in between. The target may be in another space, ' +
        'which is the case environment merge does not cover. Runs entirely as jobs (202: ' +
        '`{ job, createJobId, publishJobId }`): `job` exports the source, checks it (a ' +
        'refused snapshot fails it, its report naming the problems) and starts `createJobId`, ' +
        'whose clean completion starts `publishJobId` (when anything is published). All ' +
        'belong to the target environment: follow them at its `bulk/jobs/:id`.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, cloneBody);
      // The target space is authorized separately: cloning into a space the
      // caller cannot manage would be a tenancy hole.
      authorize(
        c.get('principal'),
        SCOPES.contentManage,
        body.targetSpaceId ?? c.req.param('space'),
      );
      const target = {
        spaceId: body.targetSpaceId ?? (c.req.param('space') as string),
        environmentId: body.targetEnvironmentId,
      };
      const options = { publish: body.publish !== false, reindexAssets: Boolean(deps.assetIngest) };
      // An export of the source and an import into the target: both halves' authority, on every
      // content type alike.
      authorizeEveryContentType(
        c.get('principal'),
        options.publish ? ['read', 'write', 'publish'] : ['read', 'write'],
      );
      if (!blob)
        return c.json(await cloneEnvironment(actingCtx(ctx, c), scopeOf(c), target, options), 201);
      return c.json(
        await startEnvironmentClone(actingCtx(ctx, c), scopeOf(c), target, options),
        202,
      );
    },
  );

  return app;
}
