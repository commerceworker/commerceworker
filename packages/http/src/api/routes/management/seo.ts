import {
  clampCount,
  getContentType,
  getEntry,
  listDeliveredSitemap,
  MAX_SITEMAP_PAGE,
  setEntrySeo,
} from '@commerceworker/application';
import {
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
  SCOPES,
  seoFieldOf,
} from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as entryDocs from '../../docs/schemas/entries';
import * as seoDocs from '../../docs/schemas/seo';
import { entrySeoBody, parseBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function seoRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- SEO metadata (the entry's Seo field) and the sitemap ---------------------
  app.patch(
    `${BASE}/entries/:id/seo`,
    doc('Entries', 'Change an entry’s SEO metadata', {
      body: entrySeoBody,
      ok: entryDocs.entry,
      description:
        'Changes one locale of the entry’s Seo field and saves a new draft version (publish to ' +
        'put it live). A part left out keeps its value; null clears it. 422 when the content ' +
        'type has no Seo field.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const { locale, ...patch } = await parseBody(c, entrySeoBody);
      const id = c.req.param('id');
      const principal = c.get('principal');
      if (principal.contentGrants) {
        const { entry } = await getEntry(ctx, scopeOf(c), id);
        authorizeContent(principal, 'write', entry.contentTypeApiId);
        const field = seoFieldOf(await getContentType(ctx, scopeOf(c), entry.contentTypeApiId));
        if (field) assertWritableFields(principal, entry.contentTypeApiId, { [field.apiId]: {} });
      }
      const view = await setEntrySeo(
        actingCtx(ctx, c),
        scopeOf(c),
        id,
        patch,
        locale !== undefined ? { locale } : {},
      );
      // The save wrote the whole entry; the answer shows only the fields the caller may read.
      return c.json({
        ...view,
        fields: maskDeniedFields(principal, view.entry.contentTypeApiId, view.fields),
      });
    },
  );
  app.get(
    `${BASE}/sitemap`,
    doc('Entries', 'Get a page of the sitemap', {
      ok: seoDocs.deliveredSitemapPage,
      description:
        'What Delivery’s `sitemap` serves: the published entries of every published content ' +
        'type with a URL pattern, each with its paths, noindex pages and pages canonical ' +
        'elsewhere left out. Page with `next`.',
      query: {
        from: 'next from the previous page',
        limit: `Entries per page, 1..${MAX_SITEMAP_PAGE} (default 1000)`,
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const from = c.req.query('from');
      const limit = clampCount(c.req.query('limit'), MAX_SITEMAP_PAGE, { min: 1 });
      return c.json(
        await listDeliveredSitemap(
          ctx,
          scopeOf(c),
          { ...(from ? { from } : {}), ...(limit !== undefined ? { limit } : {}) },
          { principal: c.get('principal') },
        ),
      );
    },
  );

  return app;
}
