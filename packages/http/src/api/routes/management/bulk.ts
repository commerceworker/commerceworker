import {
  authorizeBulkJob,
  authorizeBulkJobAccess,
  authorizeSetFieldsJob,
  bulkCreateEntries,
  bulkEntryAction,
  cancelBulkJob,
  clampCount,
  getBulkJob,
  getBulkJobReport,
  listBulkJobs,
  startBulkJob,
  startSetFieldsJob,
} from '@commerceworker/application';
import { assertWritableFields, authorizeContent, SCOPES } from '@commerceworker/domain';
import { type Context, Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as bulkDocs from '../../docs/schemas/bulk';
import {
  bulkEntriesBody,
  bulkJobBody,
  idsBody,
  parseBody,
  setFieldsJobBody,
} from '../../validation';
import { actingCtx, BASE, entryAccess, scopeOf } from './shared';

export function bulkRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const { guardEntry } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- bulk operations ---------------------------------------------------
  app.post(`${BASE}/bulk/entries`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, bulkEntriesBody);
    const principal = c.get('principal');
    for (const item of body.items ?? []) {
      authorizeContent(principal, 'write', item.contentTypeApiId);
      assertWritableFields(principal, item.contentTypeApiId, item.fields ?? {});
    }
    return c.json(
      await bulkCreateEntries(
        actingCtx(ctx, c),
        scopeOf(c),
        (body.items ?? []) as Parameters<typeof bulkCreateEntries>[2],
      ),
      201,
    );
  });
  app.post(`${BASE}/bulk/entries/publish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, idsBody);
    for (const id of body.ids ?? []) await guardEntry(c, id, 'publish');
    return c.json(await bulkEntryAction(actingCtx(ctx, c), scopeOf(c), 'publish', body.ids ?? []));
  });
  app.post(`${BASE}/bulk/entries/unpublish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, idsBody);
    for (const id of body.ids ?? []) await guardEntry(c, id, 'unpublish');
    return c.json(
      await bulkEntryAction(actingCtx(ctx, c), scopeOf(c), 'unpublish', body.ids ?? []),
    );
  });

  // --- bulk jobs (durable, chunked; for id sets beyond the sync routes) ----
  // Granular per-entry RBAC guards are impractical at this cardinality, and a report names
  // entries of every content type, so start, cancel and report take a role that holds the job's
  // actions on every type alike (`authorizeBulkJob`: no per-type grants, or one full `*` grant);
  // an import job goes by what it reached (`authorizeBulkJobAccess`).
  // Job status and list (counts only) stay readable by any content:write key.
  const guardJob = async (c: Context<AuthVars>, access: 'report' | 'cancel') => {
    const job = await getBulkJob(ctx, scopeOf(c), c.req.param('id') ?? '');
    authorizeBulkJobAccess(c.get('principal'), job, access);
  };
  app.post(`${BASE}/bulk/jobs`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, bulkJobBody);
    authorizeBulkJob(c.get('principal'), body.action);
    return c.json(await startBulkJob(actingCtx(ctx, c), scopeOf(c), body), 202);
  });
  // A field edit writes one type's entries, so it goes by that type and the fields it sets, as an
  // edit does (`authorizeSetFieldsJob`), not by a role on every type.
  app.post(
    `${BASE}/bulk/jobs/set-fields`,
    doc('Entries', 'Set fields on many entries as a bulk job', {
      body: setFieldsJobBody,
      ok: bulkDocs.setFieldsJob,
      status: 202,
      description:
        'A resumable bulk job that sets the same values on entries of one content type, each ' +
        'saved as a new draft with the checks an edit makes (field validation and rules, ' +
        'plugins, an entry in the trash refused). Only the fields and locales sent change; null ' +
        'clears a locale. Unknown fields or locales and unique fields are refused before the ' +
        'job starts; an entry that refuses its save, is missing or is of another type is a ' +
        'failure in the report (GET /bulk/jobs/{id}/report), and an entry already holding the ' +
        'values is left as it is. Needs write on the type and on every field sent; the report ' +
        'needs a role with no field rules on the type. At most 100,000 entries, 50 per chunk.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, setFieldsJobBody);
      authorizeSetFieldsJob(c.get('principal'), body.contentTypeApiId, body.fields);
      return c.json(await startSetFieldsJob(actingCtx(ctx, c), scopeOf(c), body), 202);
    },
  );
  // Reads are `content:write`, not `content:publish`: an import job is started
  // with content:write, and someone who can start a job must be able to watch
  // it. Progress and per-item errors describe work the caller could have
  // started themselves, so this widens nothing that matters.
  app.get(`${BASE}/bulk/jobs`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await listBulkJobs(ctx, scopeOf(c), { limit: clampCount(c.req.query('limit'), 50) })),
  );
  app.get(`${BASE}/bulk/jobs/:id`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await getBulkJob(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.get(`${BASE}/bulk/jobs/:id/report`, requireScope(SCOPES.contentWrite), async (c) => {
    await guardJob(c, 'report');
    return c.json(await getBulkJobReport(ctx, scopeOf(c), c.req.param('id')));
  });
  app.post(`${BASE}/bulk/jobs/:id/cancel`, requireScope(SCOPES.contentPublish), async (c) => {
    await guardJob(c, 'cancel');
    return c.json(await cancelBulkJob(ctx, scopeOf(c), c.req.param('id'), blob ? { blob } : {}));
  });

  return app;
}
