import { analyzeSpaceExport, startSpaceExportImport } from '@commerceworker/application';
import {
  authorize,
  authorizeEveryContentType,
  SCOPES,
  ValidationError,
} from '@commerceworker/domain';
import { type Context, Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import { parseBody, spaceExportImportBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function spaceExportRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const app = new Hono<AuthVars>();

  // --- importing a whole space from the JSON space export format -------------
  // Environment-wide, like a snapshot import (it writes the content model), so the same scope.
  // Analyze reports; the second call writes the model and runs the rest as jobs.
  const spaceExport = (
    c: Context<AuthVars>,
    body: { payload: string; publish?: boolean; addLocales?: boolean },
  ) => {
    if (!deps.spaceExportReader) {
      throw new ValidationError([
        { field: 'payload', message: 'This deployment cannot read space exports' },
      ]);
    }
    // Adding locales changes the space for every environment: a space admin's call.
    if (body.addLocales)
      authorize(c.get('principal'), SCOPES.spaceAdmin, c.req.param('space') as string);
    // It writes (and publishes) entries of every type the export defines: a role limited to some
    // types or fields is refused, at analyze too, which stands in for the import.
    authorizeEveryContentType(
      c.get('principal'),
      body.publish !== false ? ['write', 'publish'] : ['write'],
    );
    return {
      reader: deps.spaceExportReader,
      input: {
        payload: body.payload,
        ...(body.publish !== undefined ? { publish: body.publish } : {}),
        ...(body.addLocales ? { addLocales: true } : {}),
      },
    };
  };
  app.post(
    `${BASE}/imports/space-export/analyze`,
    doc('Spaces & environments', 'Analyze a space export without writing', {
      body: spaceExportImportBody,
      description:
        'Reads a JSON space export (`contentTypes`, `entries`, `assets`, `locales`, `tags`) and ' +
        'reports what importing it here would do: counts, the fields and validations with no ' +
        'equivalent, links whose target is not coming along, entries that would fail validation, ' +
        'and `problems` that stop the import as a whole (`executable: false`). Writes nothing. ' +
        '`addLocales` (needs `space:admin`) lets the import add the locales the space lacks.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const { reader, input } = spaceExport(c, await parseBody(c, spaceExportImportBody));
      return c.json(await analyzeSpaceExport(ctx, scopeOf(c), reader, input));
    },
  );
  app.post(
    `${BASE}/imports/space-export`,
    doc('Spaces & environments', 'Import a space export', {
      body: spaceExportImportBody,
      status: 202,
      description:
        'Requires an environment with no content types. Checks everything the analysis does, ' +
        'then adds locales (with `addLocales`), writes the content model and tags, and starts a ' +
        'job (202: `{ report, job, publishJobId }`) that copies each asset file from its URL ' +
        'into storage and creates the assets and entries with new ids, every link remapped. ' +
        'When it completes with no failures, `publishJobId` publishes what the export marks ' +
        "published (unless `publish: false`). Follow both at this environment's `bulk/jobs/:id`.",
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const { reader, input } = spaceExport(c, await parseBody(c, spaceExportImportBody));
      if (!blob) {
        throw new ValidationError([
          {
            field: 'payload',
            message: 'This deployment has no object storage to stage an import in',
          },
        ]);
      }
      return c.json(
        await startSpaceExportImport(actingCtx(ctx, c), blob, scopeOf(c), reader, input),
        202,
      );
    },
  );

  return app;
}
