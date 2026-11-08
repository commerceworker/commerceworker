import {
  analyzeRedirectSet,
  clampCount,
  collapseRedirects,
  createRedirect,
  deleteRedirect,
  exportRedirectsCsv,
  getRedirect,
  importRedirects,
  listRedirects,
  MAX_PAGE_LIMIT,
  type RedirectImport,
  resolveRedirect,
  updateRedirect,
} from '@commerceworker/application';
import { MAX_REDIRECT_IMPORT, NotFoundError, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as redirectDocs from '../../docs/schemas/redirects';
import { parseBody, redirectBody, redirectImportBody, redirectPatchBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function redirectsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- redirects (delivery data: a front end applies them) ----------------
  app.get(
    `${BASE}/redirects`,
    doc('Redirects', 'List redirects', {
      ok: redirectDocs.redirectPage,
      description: 'By source. Page with the response’s nextCursor.',
      query: {
        q: 'Search the source, destination and note',
        limit: `Page size, 1..${MAX_PAGE_LIMIT}`,
        cursor: 'nextCursor from the previous page',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const limit = clampCount(c.req.query('limit'), MAX_PAGE_LIMIT, { min: 1 });
      const cursor = c.req.query('cursor');
      const q = c.req.query('q');
      return c.json(
        await listRedirects(ctx, scopeOf(c), {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(q ? { q } : {}),
        }),
      );
    },
  );
  app.post(
    `${BASE}/redirects`,
    doc('Redirects', 'Create a redirect', {
      body: redirectBody,
      ok: redirectDocs.redirectWrite,
      status: 201,
      description:
        'Refused (422) when its source is already redirected for the same locale, when it would ' +
        'close a loop, or past the environment’s cap. A chain it makes is allowed and reported.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(await createRedirect(ctx, scopeOf(c), await parseBody(c, redirectBody)), 201),
  );
  // Before `/redirects/:id`, which would take these words for an id.
  app.get(
    `${BASE}/redirects/resolve`,
    doc('Redirects', 'Resolve a path against the redirects', {
      ok: redirectDocs.redirectMatch,
      description: 'What Delivery’s `redirects/resolve` answers for it. 404 when nothing does.',
      query: { path: 'A request path, with or without its query', locale: 'The request’s locale' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const path = c.req.query('path') ?? '';
      const match = await resolveRedirect(
        ctx,
        scopeOf(c),
        path,
        c.req.query('locale') || undefined,
      );
      if (!match) throw new NotFoundError('Redirect', path);
      return c.json(match);
    },
  );
  app.get(
    `${BASE}/redirects/analysis`,
    doc('Redirects', 'Check the redirect set', {
      ok: redirectDocs.redirectAnalysis,
      description:
        'Loops, chains (each with where it ends) and duplicate sources across the whole set.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await analyzeRedirectSet(ctx, scopeOf(c))),
  );
  app.get(
    `${BASE}/redirects/export`,
    doc('Redirects', 'Export the redirects as CSV', {
      okDescription: 'text/csv: source, destination, status, locale, enabled, note',
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.body(await exportRedirectsCsv(ctx, scopeOf(c)), 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="redirects.csv"',
      }),
  );
  app.post(
    `${BASE}/redirects/import`,
    doc('Redirects', 'Import redirects from CSV or JSON', {
      body: redirectImportBody,
      ok: redirectDocs.redirectImportReport,
      description:
        `All or nothing, at most ${MAX_REDIRECT_IMPORT} rows: every row and the resulting set ` +
        'are checked first, and a refusal names each bad row (`rows[i].field`). A source ' +
        'already redirected (for the same locale) is updated; the rest are added.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await importRedirects(
          ctx,
          scopeOf(c),
          // Each row's shape is the domain's to check, naming the bad ones.
          (await parseBody(c, redirectImportBody)) as RedirectImport,
        ),
      ),
  );
  app.post(
    `${BASE}/redirects/collapse-chains`,
    doc('Redirects', 'Collapse redirect chains', {
      ok: redirectDocs.redirectCollapse,
      description: 'Points every redirect that ends a chain straight at where its chain ends.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => c.json(await collapseRedirects(ctx, scopeOf(c))),
  );
  app.get(
    `${BASE}/redirects/:id`,
    doc('Redirects', 'Get a redirect', { ok: redirectDocs.redirect }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getRedirect(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.patch(
    `${BASE}/redirects/:id`,
    doc('Redirects', 'Change a redirect', {
      body: redirectPatchBody,
      ok: redirectDocs.redirectWrite,
      description: 'Fields left out keep their value; null clears locale or note.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await updateRedirect(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, redirectPatchBody),
        ),
      ),
  );
  app.delete(
    `${BASE}/redirects/:id`,
    doc('Redirects', 'Delete a redirect', { status: 204 }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      await deleteRedirect(ctx, scopeOf(c), c.req.param('id'));
      return c.body(null, 204);
    },
  );

  return app;
}
