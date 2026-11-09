import { analyzeImport, executeImport, startImportJob } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import { importBody, parseBody } from '../../validation';
import { actingCtx, BASE, importSourceOr400, scopeOf } from './shared';

export function importsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const resolveSource = (id: string) => importSourceOr400(deps.importSources, id);
  const toImportInput = (body: { payload: string; mapping: unknown; sourceOptions?: unknown }) => ({
    payload: body.payload,
    mapping: body.mapping as Parameters<typeof analyzeImport>[4]['mapping'],
    ...(body.sourceOptions ? { sourceOptions: body.sourceOptions as Record<string, unknown> } : {}),
  });
  const app = new Hono<AuthVars>();

  // --- importing content from elsewhere -------------------------------------
  // Two phases: analyze reports, execute writes. Both call the same planner,
  // so the report is not a prediction — it is the run, without the commit.
  app.get(
    `${BASE}/imports/sources`,
    doc('Spaces & environments', 'List import sources', {
      description: 'The external formats this deployment can read.',
    }),
    requireScope(SCOPES.contentWrite),
    (c) =>
      c.json({
        items: Object.values(deps.importSources).map((s) => ({ id: s.id, name: s.name })),
      }),
  );
  app.post(
    `${BASE}/imports/analyze`,
    doc('Spaces & environments', 'Analyze an import without writing', {
      body: importBody,
      description:
        'Reports what the import would create, update and skip — plus the source fields ' +
        'nothing maps to (the data it would throw away) and the records that would fail. ' +
        'Writes nothing.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, importBody);
      return c.json(
        await analyzeImport(
          ctx,
          c.get('principal'),
          scopeOf(c),
          resolveSource(body.source),
          toImportInput(body),
          {
            ...(body.conflicts ? { conflicts: body.conflicts } : {}),
          },
        ),
      );
    },
  );
  app.post(
    `${BASE}/imports`,
    doc('Spaces & environments', 'Run an import', {
      body: importBody,
      status: 201,
      description:
        'Creates entries through the same use-cases as any other write, so validation, ' +
        'uniqueness and the reference graph all apply. Entries arrive as drafts; publishing ' +
        'them is a separate bulk job. Re-analyzes first, so a stale plan cannot be acted on.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, importBody);
      return c.json(
        await executeImport(
          actingCtx(ctx, c),
          c.get('principal'),
          scopeOf(c),
          resolveSource(body.source),
          toImportInput(body),
          {
            ...(body.conflicts ? { conflicts: body.conflicts } : {}),
          },
        ),
        201,
      );
    },
  );

  app.post(
    `${BASE}/imports/job`,
    doc('Spaces & environments', 'Run an import as a durable job', {
      body: importBody,
      status: 202,
      description:
        'Same planner and same report as the synchronous run, but the writing is chunked into a ' +
        'resumable job — so an import survives a crash, a deploy, and a client that hung up. ' +
        'Poll `…/bulk/jobs/:id` for progress and `…/bulk/jobs/:id/report` for per-record failures.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, importBody);
      const started = await startImportJob(
        actingCtx(ctx, c),
        blob,
        c.get('principal'),
        scopeOf(c),
        resolveSource(body.source),
        toImportInput(body),
        { ...(body.conflicts ? { conflicts: body.conflicts } : {}) },
      );
      return c.json(started, 202);
    },
  );

  return app;
}
