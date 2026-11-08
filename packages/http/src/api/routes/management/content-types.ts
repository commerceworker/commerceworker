import {
  authorizeBulkJob,
  clampCount,
  cloneContentType,
  contentTypeDependents,
  countEntriesByContentType,
  createContentType,
  deleteContentType,
  deleteContentTypeWithEntries,
  getContentType,
  getLocaleSettings,
  listContentTypes,
  listFieldValues,
  MAX_FIELD_VALUES_PAGE,
  publishContentType,
  setLocaleSettings,
} from '@commerceworker/application';
import {
  assertQueryRespectsFieldRules,
  authorize,
  authorizeContent,
  canAccessContentType,
  SCOPES,
} from '@commerceworker/domain';
import { generateTypes } from '@commerceworker/sdk-codegen';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as contentTypeDocs from '../../docs/schemas/content-types';
import {
  cloneContentTypeBody,
  contentTypeBody,
  localeSettingsBody,
  parseBody,
} from '../../validation';
import { BASE, scopeOf } from './shared';

export function contentTypesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- space config (locales) --------------------------------------------
  // Each locale's settings come resolved: whether Delivery serves it, and its text direction.
  app.get(`${BASE}/space-config`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getLocaleSettings(ctx, scopeOf(c))),
  );
  app.put(
    `${BASE}/locale-settings`,
    doc('Content types', 'Set the space’s locale settings', {
      body: localeSettingsBody,
      description:
        'Per locale: `delivered` (false keeps it out of Delivery: a request naming it is 404, ' +
        'fallback chains skip it, all-locale responses and the sitemap’s alternates leave it ' +
        'out; editors still write and preview it) and `direction` (`ltr` or `rtl`, the `dir` of ' +
        'its inputs in the admin). A locale left out keeps its settings. The default locale is ' +
        'always delivered. Answers the space config, every locale resolved. Applies to every ' +
        'environment of the space. Needs `space:admin`.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, localeSettingsBody);
      return c.json(
        await setLocaleSettings(ctx, c.get('principal'), scopeOf(c), body.localeSettings),
      );
    },
  );

  // --- content types ------------------------------------------------------
  app.get(
    `${BASE}/content-types`,
    doc('Content types', 'List content types', {
      description:
        '`?format=typescript` returns the content model as a TypeScript module instead of ' +
        'JSON — the same output the codegen CLI produces, served from the live model so CI ' +
        'and coding agents need nothing installed to type against it.',
      query: { format: 'json (default) | typescript' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const types = await listContentTypes(ctx, scopeOf(c));
      if (c.req.query('format') !== 'typescript') return c.json({ items: types });

      // Served as text/plain rather than a TypeScript media type: browsers and
      // `curl` show it, and nothing downstream tries to execute it.
      return c.text(
        generateTypes(types as unknown as Parameters<typeof generateTypes>[0], {
          banner: `Generated from ${scopeOf(c).spaceId}/${scopeOf(c).environmentId} at ${ctx.clock
            .now()
            .toISOString()}. Do not edit by hand.`,
        }),
        200,
        { 'content-type': 'text/plain; charset=utf-8' },
      );
    },
  );
  app.post(
    `${BASE}/content-types`,
    doc('Content types', 'Create a content type', {
      body: contentTypeBody,
      ok: contentTypeDocs.contentType,
      status: 201,
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const ct = await createContentType(
        ctx,
        // A preview URL decides where the type's preview tokens go: read on the type is needed too.
        c.get('principal'),
        scopeOf(c),
        (await parseBody(c, contentTypeBody)) as unknown as Parameters<typeof createContentType>[3],
      );
      return c.json(ct, 201);
    },
  );
  // Before `/content-types/:apiId`, which would take "entry-counts" for an apiId (apiIds have no
  // hyphens, so no real type is shadowed).
  app.get(
    `${BASE}/content-types/entry-counts`,
    doc('Content types', 'Count entries per content type', {
      description:
        'Entries per content type by status (`draft`, `changed`, `published`, and `archived` ' +
        'for the trash), from one grouped count. `total` is the live entries, without the ' +
        'trash. Types the caller cannot read are left out.',
      ok: contentTypeDocs.contentTypeEntryCounts,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const principal = c.get('principal');
      const counts = await countEntriesByContentType(ctx, scopeOf(c));
      return c.json({
        items: counts.filter((n) => canAccessContentType(principal, 'read', n.contentType)),
      });
    },
  );
  app.get(
    `${BASE}/content-types/:apiId`,
    doc('Content types', 'Get a content type', { ok: contentTypeDocs.contentType }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );
  app.get(
    `${BASE}/content-types/:apiId/fields/:field/values`,
    doc('Content types', 'List a field’s distinct values', {
      ok: contentTypeDocs.fieldValuesPage,
      description:
        'The distinct values a field holds across the type’s entries (current versions, the trash ' +
        'left out), each with how many entries hold it: booleans, then numbers, then strings, ' +
        'ascending. A list of Symbols contributes each element. Only short scalar fields (not ' +
        'Text) and lists of Symbols have values to list (422 otherwise), and a type with more ' +
        'entries than the query scan cap is refused as too broad. ' +
        `At most ${MAX_FIELD_VALUES_PAGE} per page; page with the response’s nextCursor.`,
      query: {
        locale: 'Only this locale’s values (every locale’s by default)',
        limit: `Page size (at most ${MAX_FIELD_VALUES_PAGE})`,
        cursor: 'nextCursor from the previous page',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const apiId = c.req.param('apiId');
      const field = c.req.param('field');
      const principal = c.get('principal');
      authorizeContent(principal, 'read', apiId);
      // A field the caller may not read has no values to show it either.
      assertQueryRespectsFieldRules(principal, { contentTypeApiId: apiId, select: [field] });
      const limit = clampCount(c.req.query('limit'), MAX_FIELD_VALUES_PAGE, { min: 1 });
      const locale = c.req.query('locale');
      const cursor = c.req.query('cursor');
      return c.json(
        await listFieldValues(ctx, scopeOf(c), apiId, field, {
          ...(limit !== undefined ? { limit } : {}),
          ...(locale ? { locale } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      );
    },
  );
  app.get(
    `${BASE}/content-types/:apiId/dependents`,
    doc('Content types', 'What depends on a content type', {
      description:
        'Why deleting it would be refused: its entries (live and in the trash), other types ' +
        'whose links are restricted to it (in components and blocks too), menus and slug ' +
        'redirects naming its entries, and its URL pattern.',
      ok: contentTypeDocs.contentTypeDependents,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      // It counts and names the type's entries: a role restricted to other types may not see them.
      authorizeContent(c.get('principal'), 'read', c.req.param('apiId'));
      return c.json(await contentTypeDependents(ctx, scopeOf(c), c.req.param('apiId')));
    },
  );
  app.delete(
    `${BASE}/content-types/:apiId`,
    doc('Content types', 'Delete a content type', {
      description:
        'Refused (409, with `details.dependents`) while anything depends on it: entries, the ' +
        'trash included, other types linking to it, menus or redirects naming its entries, its ' +
        'URL pattern. `?purge_entries=true` deletes its entries too, as a resumable bulk job ' +
        '(202 with the job): each is trashed, then purged, and the type goes when the job ' +
        'completes cleanly. That takes `content:write` and `content:publish` too (entries are ' +
        'trashed and purged, live ones unpublished) and a role that holds them on every content ' +
        'type. The job’s `config.typeDeletion` says what became of the type once decided: ' +
        '`{ deleted: true }`, or `{ deleted: false, reason }`. Emits `content_type.deleted`.',
      query: { purge_entries: 'true to delete its entries first, as a job' },
      ok: contentTypeDocs.contentTypeDeletion,
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const apiId = c.req.param('apiId');
      if (c.req.query('purge_entries') !== 'true') {
        await deleteContentType(ctx, scopeOf(c), apiId);
        return c.json({ deleted: true });
      }
      const principal = c.get('principal');
      authorize(principal, SCOPES.contentWrite, scopeOf(c).spaceId);
      authorize(principal, SCOPES.contentPublish, scopeOf(c).spaceId);
      authorizeBulkJob(principal, 'content_type_delete');
      const done = await deleteContentTypeWithEntries(ctx, scopeOf(c), apiId);
      return c.json(done, done.deleted ? 200 : 202);
    },
  );
  app.post(
    `${BASE}/content-types/:apiId/clone`,
    doc('Content types', 'Clone a content type', {
      description:
        'Copies the definition (fields, display field, singleton, group, description, icon, ' +
        'agent instructions, layout, preview URL) under a new apiId and name, as a draft with no ' +
        'entries. Not its URL pattern. ' +
        '409 when the apiId is taken.',
      body: cloneContentTypeBody,
      ok: contentTypeDocs.contentType,
      status: 201,
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, cloneContentTypeBody);
      return c.json(
        await cloneContentType(
          ctx,
          c.get('principal'),
          scopeOf(c),
          c.req.param('apiId'),
          body.apiId,
          body.name,
        ),
        201,
      );
    },
  );
  app.post(
    `${BASE}/content-types/:apiId/published`,
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await publishContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );

  return app;
}
