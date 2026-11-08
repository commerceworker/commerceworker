import {
  getContentType,
  getPreviewEntry,
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
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { entrySeoShape } from '../../api/validation';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerSeoTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal, guard } = t;
  // --- SEO metadata and the sitemap --------------------------------------
  server.registerTool(
    'entries_set_seo',
    {
      description:
        "Change one locale of an entry's SEO metadata (its content type's Seo field: title, " +
        'description, canonicalUrl, noindex, ogImage) and save a new draft version; publish to ' +
        'put it live. Parts left out keep their value; null clears one. Refused when the type has ' +
        'no Seo field (add a field of type Seo to it).',
      inputSchema: toolSchema('entries_set_seo', () =>
        z.object({ id: z.string(), ...entrySeoShape, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const { space: _s, environment: _e, id, locale, ...patch } = args;
      if (principal.contentGrants) {
        const entry = await getPreviewEntry(ctx, scopeOf(args), id);
        authorizeContent(principal, 'write', entry.contentType);
        const field = seoFieldOf(await getContentType(ctx, scopeOf(args), entry.contentType));
        if (field) assertWritableFields(principal, entry.contentType, { [field.apiId]: {} });
      }
      const view = await setEntrySeo(
        ctx,
        scopeOf(args),
        id,
        patch,
        locale !== undefined ? { locale } : {},
      );
      // As the route does: the answer shows only the fields the caller may read.
      return ok({
        ...view,
        fields: maskDeniedFields(principal, view.entry.contentTypeApiId, view.fields),
      });
    },
  );

  server.registerTool(
    'sitemap_list',
    {
      description:
        'A page of the sitemap Delivery serves: published entries of every published content ' +
        'type with a URL pattern, each with its paths per locale and lastmod; noindex pages and ' +
        'pages canonical elsewhere are left out. Pass `next` as `from` for the following page.',
      inputSchema: toolSchema('sitemap_list', () =>
        z.object({
          from: z.string().optional().describe('next from the previous page'),
          limit: z.number().int().min(1).max(MAX_SITEMAP_PAGE).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(
        await listDeliveredSitemap(
          ctx,
          scopeOf(args),
          {
            ...(args.from ? { from: args.from } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          { principal },
        ),
      );
    },
  );
}
