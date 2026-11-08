import {
  clampCount,
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  MAX_PAGE_LIMIT,
  runSavedView,
  updateSavedView,
} from '@commerceworker/application';
import { SCOPES, ValidationError } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as viewDocs from '../../docs/schemas/saved-views';
import { parseBody, savedViewBody, savedViewPatchBody } from '../../validation';
import { BASE, scopeOf } from './shared';

/** `?revision=` on a delete: absent, or a positive integer. */
function revisionOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError([{ field: 'revision', message: 'A revision is a positive integer' }]);
  }
  return n;
}

const SHARED_NEEDS_MANAGE =
  'A shared view needs content:manage to create, change, share, unshare or delete. ';
const UNSHARE =
  'Only the person who created a shared view can stop sharing it (anyone else gets a 422 and ' +
  'can save a copy). ';
const NOT_YOURS =
  'Another person’s personal view, a view over a type you can’t read, or one naming a field ' +
  'your role hides is a 404.';

/**
 * Saved views of the entries list. They belong to the space: the `:env` in the path is where a
 * run lists entries and where a new view's content type and columns are checked, not where the
 * view lives.
 */
export function savedViewsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/saved-views`,
    doc('Saved views', 'List saved views', {
      ok: viewDocs.savedViewList,
      description:
        'The space’s shared views and your own personal ones, by name. Views over a type you ' +
        'can’t read, or whose query names a field your role hides, are left out.',
      query: { content_type: 'Only this type’s views, and the views over every type' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const type = c.req.query('content_type');
      const items = await listSavedViews(ctx, scopeOf(c), c.get('principal'), {
        ...(type ? { contentTypeApiId: type } : {}),
      });
      return c.json({ items, total: items.length });
    },
  );
  app.post(
    `${BASE}/saved-views`,
    doc('Saved views', 'Create a saved view', {
      body: savedViewBody,
      ok: viewDocs.savedView,
      status: 201,
      description:
        'A named query (filters, a where tree, a sort, a search) and the columns to show. The ' +
        'query is checked as strictly as a live where: 422 naming each bad part. Personal by ' +
        `default; only a person has personal views. ${SHARED_NEEDS_MANAGE}` +
        'A view whose query names a field your role hides is a 403.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        await createSavedView(
          ctx,
          scopeOf(c),
          c.get('principal'),
          await parseBody(c, savedViewBody),
        ),
        201,
      ),
  );
  app.get(
    `${BASE}/saved-views/:id`,
    doc('Saved views', 'Get a saved view', {
      ok: viewDocs.savedView,
      description: `${NOT_YOURS} Columns naming a field your role hides are left out.`,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getSavedView(ctx, scopeOf(c), c.get('principal'), c.req.param('id'))),
  );
  app.get(
    `${BASE}/saved-views/:id/entries`,
    doc('Saved views', 'Run a saved view', {
      ok: viewDocs.savedViewRun,
      description:
        'One page of the view’s entries, as the Preview list answers your own query: your ' +
        'grants narrow the types and your field rules mask the fields, whoever saved the view. ' +
        'Page with nextCursor. Where the view’s content type isn’t in this environment, an ' +
        `empty page with typeMissing: true. ${NOT_YOURS}`,
      query: {
        limit: `Page size (at most ${MAX_PAGE_LIMIT})`,
        cursor: 'nextCursor from the previous page',
        locale: 'Resolve one locale',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const cursor = c.req.query('cursor');
      const locale = c.req.query('locale');
      const limit = clampCount(c.req.query('limit'), MAX_PAGE_LIMIT, { min: 1 });
      const run = await runSavedView(ctx, scopeOf(c), c.get('principal'), c.req.param('id'), {
        ...(cursor ? { cursor } : {}),
        ...(locale ? { locale } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return c.json({ ...run, total: run.items.length });
    },
  );
  app.patch(
    `${BASE}/saved-views/:id`,
    doc('Saved views', 'Change a saved view', {
      body: savedViewPatchBody,
      ok: viewDocs.savedView,
      description:
        'Fields left out keep their value; query replaces the whole query; columns null goes ' +
        'back to the default (and works where the view’s content type is missing, where other ' +
        'columns are a 422); columns your role hides stay where they are. Its content type is ' +
        'fixed. A new visibility must fit the view caps. With revision, a view saved since is ' +
        `a 409. ${SHARED_NEEDS_MANAGE}${UNSHARE}${NOT_YOURS}`,
    }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        await updateSavedView(
          ctx,
          scopeOf(c),
          c.get('principal'),
          c.req.param('id'),
          await parseBody(c, savedViewPatchBody),
        ),
      ),
  );
  app.delete(
    `${BASE}/saved-views/:id`,
    doc('Saved views', 'Delete a saved view', {
      status: 204,
      description: `${SHARED_NEEDS_MANAGE}${NOT_YOURS}`,
      query: { revision: 'The revision read: a view saved since is a 409' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      await deleteSavedView(
        ctx,
        scopeOf(c),
        c.get('principal'),
        c.req.param('id'),
        revisionOf(c.req.query('revision')),
      );
      return c.body(null, 204);
    },
  );

  return app;
}
