import {
  actingAs,
  authenticate,
  clampCount,
  getPreviewAsset,
  getPreviewEntry,
  getPreviewSingleton,
  listPreviewAssets,
  listPreviewEntryPage,
  parseEntryQuery,
  principalFromPreviewToken,
  SUGGEST_DEFAULT_LIMIT,
  SUGGEST_MAX_LIMIT,
  secureTokenEqual,
  suggestEntries,
} from '@commerceworker/application';
import {
  assertAuthorIdQuery,
  assertQueryRespectsFieldRules,
  authorize,
  authorizeContent,
  canAccessContentType,
  maskDeniedFields,
  type Principal,
  SCOPES,
  type Scope,
  scopesForKind,
  ValidationError,
  withAuthorIdsFor,
} from '@commerceworker/domain';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type AuthDeps,
  type AuthVars,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
  resolveWebPrincipal,
  throttleAuth,
} from '../auth';
import { doc } from '../docs/openapi';
import { deliveredAsset, deliveredAssetPage } from '../docs/schemas/assets';
import { previewEntry, previewEntryPage } from '../docs/schemas/entries';
import { parseDeliveredAssetQuery } from '../query';

const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

const BASE = '/preview/:space/:env';

const ADMIN: Principal = {
  spaceId: '*',
  kind: 'admin',
  scopes: [...scopesForKind('cma')],
};

async function resolvePreviewPrincipal(
  deps: AuthDeps,
  c: Context<AuthVars>,
  entryId: string,
): Promise<Principal> {
  const previewToken = c.req.query('preview_token');
  if (previewToken) {
    const fromToken = await principalFromPreviewToken(
      deps.ctx,
      deps.hasher,
      scopeOf(c),
      entryId,
      previewToken,
    );
    if (!fromToken) {
      throw new HTTPException(401, { message: 'Invalid or expired preview token' });
    }
    return fromToken;
  }

  const web = await resolveWebPrincipal(deps, c);
  if (web) return web;
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (deps.adminToken && secureTokenEqual(token, deps.adminToken)) return ADMIN;
  return authenticate(deps.ctx, deps.hasher, token);
}

/** Preview API (CPA): read draft/current content. Requires preview:read. */
export function previewRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/suggest`,
    doc('Preview', 'Suggest entries for a chooser', {
      description:
        'Entries whose display field matches `q`, resolved server-side. A chooser cannot be ' +
        'built by listing entries and filtering in the browser: the list endpoint is capped, ' +
        'so entries past one page are not slow to find but impossible to pick.',
      query: {
        q: 'What has been typed so far; empty returns recent entries',
        content_type: 'Restrict to one content type',
        locale: 'Locale the title is resolved in',
        limit: `Max results (default ${SUGGEST_DEFAULT_LIMIT}, max ${SUGGEST_MAX_LIMIT})`,
      },
    }),
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const principal = c.get('principal');
      const items = await suggestEntries(ctx, scopeOf(c), {
        q: c.req.query('q'),
        contentTypeApiId: c.req.query('content_type'),
        locale: c.req.query('locale'),
        limit: clampCount(c.req.query('limit'), SUGGEST_MAX_LIMIT, { min: 1 }),
      });
      // Same content gate as any other read: a chooser must not reveal the
      // existence of types the caller cannot read.
      return c.json({
        items: items.filter((i) => canAccessContentType(principal, 'read', i.contentType)),
      });
    },
  );

  app.get(
    `${BASE}/entries`,
    doc('Preview', 'List draft/current entries', {
      ok: previewEntryPage,
      description:
        'One page of entries as they are now, drafts included (the trash with trashed=true). ' +
        'Page with the response’s nextCursor (skip is refused): it walks the list’s own order ' +
        '(order, or least recently changed first, where an entry edited between two pages is ' +
        'never skipped).',
      query: {
        content_type: 'Filter by content type apiId',
        locale: 'Resolve one locale',
        limit: 'Page size (at most 100)',
        cursor: 'nextCursor from the previous page, with the same filters and order',
        order: 'Sort keys, e.g. -sys.updatedAt,fields.title or -sys.firstPublishedAt',
        'sys.createdBy':
          'Who created it; me is the caller (also sys.updatedBy, with [in] and [ne])',
        query: 'Full-text search across text fields',
        where: 'AND/OR groups of predicates as JSON (as on Delivery)',
        links_to_entry: 'Entries whose current version links to this entry id in any field',
        trashed: 'true lists the trash',
      },
    }),
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.previewRead),
    async (c) => {
      // A cursor walks keys, not offsets: a `skip` is refused rather than quietly ignored, so a
      // client paging by offset hears it instead of reading the first page forever.
      const { skip, ...query } = parseEntryQuery(new URL(c.req.url).searchParams);
      if (skip !== undefined)
        throw new ValidationError([
          {
            field: 'skip',
            message: 'The preview list pages with cursor (its nextCursor), not skip',
          },
        ]);
      const principal = c.get('principal');
      assertQueryRespectsFieldRules(principal, query);
      assertAuthorIdQuery(principal, query);
      const cursor = c.req.query('cursor');
      const page = await listPreviewEntryPage(
        // Acting as the caller, so `sys.createdBy=me` names them.
        actingAs(ctx, principal),
        scopeOf(c),
        { ...query, ...(cursor ? { cursor } : {}) },
        {
          locale: c.req.query('locale'),
          ...(principal.contentGrants
            ? { readable: (t: string) => canAccessContentType(principal, 'read', t) }
            : {}),
        },
      );
      // The grant already narrowed the query; this is the belt to that, and masks denied fields.
      const visible = page.items
        .filter((e) => canAccessContentType(principal, 'read', e.contentType))
        .map((e) =>
          withAuthorIdsFor(principal, {
            ...e,
            fields: maskDeniedFields(principal, e.contentType, e.fields),
          }),
        );
      return c.json({
        items: visible,
        total: visible.length,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    },
  );

  // Assets as they are now, drafts included, in Delivery's shape. Every URL is signed and
  // short-lived (15 minutes at least): a draft's file must not outlive the read that showed it.
  app.get(
    `${BASE}/assets`,
    doc('Preview', 'List draft/current assets', {
      ok: deliveredAssetPage,
      description:
        'The library as it is now (archived assets left out), in the shape Delivery serves, with ' +
        'short-lived signed URLs. Page with the response’s nextCursor.',
      query: {
        limit: 'Page size',
        cursor: 'nextCursor from the previous page',
        kind: 'image | video | audio | document | other',
        tag: 'A taxonomy tag id',
        folder: 'A folder id, or root for assets in no folder',
        locale: 'Resolve title, description and alt text for one locale',
      },
    }),
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.previewRead),
    async (c) => {
      // As on Delivery: a key with content grants reads no assets.
      if (c.get('principal').contentGrants) return c.json({ items: [], total: 0 });
      const { skip: _skip, ...query } = parseDeliveredAssetQuery(c.req.query());
      const locale = c.req.query('locale');
      const page = await listPreviewAssets(
        ctx,
        deps.blob,
        scopeOf(c),
        query,
        locale !== undefined ? { locale } : {},
      );
      return c.json({ ...page, total: page.items.length });
    },
  );

  app.get(
    `${BASE}/assets/:id`,
    doc('Preview', 'Get a draft/current asset', {
      ok: deliveredAsset,
      query: { locale: 'Resolve title, description and alt text for one locale' },
    }),
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.previewRead),
    async (c) => {
      if (c.get('principal').contentGrants) return c.body(null, 403);
      const locale = c.req.query('locale');
      return c.json(
        await getPreviewAsset(
          ctx,
          deps.blob,
          scopeOf(c),
          c.req.param('id'),
          locale !== undefined ? { locale } : {},
        ),
      );
    },
  );

  app.get(
    `${BASE}/singletons/:apiId`,
    doc('Preview', 'Get a singleton’s draft/current entry', {
      ok: previewEntry,
      description:
        'The entry of a singleton content type as it is now, a draft included, by the type’s ' +
        'apiId. 404 when the type is not a singleton or has no entry outside the trash.',
      query: { locale: 'Resolve one locale' },
    }),
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const principal = c.get('principal');
      const apiId = c.req.param('apiId');
      authorizeContent(principal, 'read', apiId);
      const entry = await getPreviewSingleton(ctx, scopeOf(c), apiId, {
        locale: c.req.query('locale'),
      });
      return c.json(
        withAuthorIdsFor(principal, {
          ...entry,
          fields: maskDeniedFields(principal, entry.contentType, entry.fields),
        }),
      );
    },
  );

  // Shareable preview links use ?preview_token= instead of a bearer header.
  app.get(
    `${BASE}/entries/:id`,
    doc('Preview', 'Get a draft/current entry', {
      description: 'Accepts a bearer token or a shareable ?preview_token= minted from the entry.',
      query: { locale: 'Resolve one locale', preview_token: 'Shareable preview token' },
    }),
    environmentMiddleware(deps),
    async (c) => {
      const entryId = c.req.param('id');
      // Throttle credential resolution so preview-token / bearer guessing on this
      // route is bounded by the same failed-auth budget as the bearer middleware.
      const principal = await throttleAuth(deps, c, () =>
        resolvePreviewPrincipal(deps, c, entryId),
      );
      authorize(principal, SCOPES.previewRead, scopeOf(c).spaceId);

      const entry = await getPreviewEntry(ctx, scopeOf(c), entryId, {
        locale: c.req.query('locale'),
      });
      authorizeContent(principal, 'read', entry.contentType);
      return c.json(
        withAuthorIdsFor(principal, {
          ...entry,
          fields: maskDeniedFields(principal, entry.contentType, entry.fields),
        }),
      );
    },
  );

  return app;
}
