import {
  diffVersions,
  getEntry,
  getVersion,
  listVersions,
  parseVersionRef,
  restoreVersion,
  visibleDiff,
} from '@commerceworker/application';
import {
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
  SCOPES,
  ValidationError,
  withAuthorIdsFor,
} from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as versionDocs from '../../docs/schemas/versions';
import { actingCtx, BASE, entryAccess, expectedVersionOf, scopeOf } from './shared';

const VERSION_REF = 'A version number (1 or more), draft or published';

export function versionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const { authorizeEntryRead } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- entry version history ---------------------------------------------
  // Version snapshots carry raw field values, so every read authorizes the
  // entry's content type and masks denied fields — matching GET /entries/:id. Who saved each
  // version is left out for a principal that doesn't see author ids (a preview key).
  app.get(`${BASE}/entries/:id/versions`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const principal = c.get('principal');
    const items = (await listVersions(ctx, scopeOf(c), c.req.param('id'))).map((v) =>
      withAuthorIdsFor(principal, { ...v, fields: maskDeniedFields(principal, type, v.fields) }),
    );
    return c.json({ items });
  });
  // A readable diff between two versions, or a version and the current draft or published one.
  app.get(
    `${BASE}/entries/:id/versions/diff`,
    doc('Entries', 'Compare two versions', {
      description:
        'Per field and locale: what was added, removed or changed, with detail by field type ' +
        '(word-level text, link targets, list elements matched by key with moves, rich text ' +
        'by block). Fields the caller may not read are left out; `hiddenChanges` counts the ones ' +
        'that changed.',
      query: {
        from: 'The baseline: a version number, `draft` or `published`',
        to: 'The version compared against it: a version number, `draft` or `published`',
      },
      ok: versionDocs.versionDiff,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const from = parseVersionRef(c.req.query('from'));
      const to = parseVersionRef(c.req.query('to'));
      const issues = [
        ...(from === null ? [{ field: 'from', message: VERSION_REF }] : []),
        ...(to === null ? [{ field: 'to', message: VERSION_REF }] : []),
      ];
      if (from === null || to === null) throw new ValidationError(issues);
      await authorizeEntryRead(c, c.req.param('id'));
      const diff = await diffVersions(ctx, scopeOf(c), c.req.param('id'), from, to);
      return c.json(visibleDiff(c.get('principal'), diff));
    },
  );
  app.get(`${BASE}/entries/:id/versions/:version`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const version = await getVersion(
      ctx,
      scopeOf(c),
      c.req.param('id'),
      Number(c.req.param('version')),
    );
    const principal = c.get('principal');
    return c.json(
      withAuthorIdsFor(principal, {
        ...version,
        fields: maskDeniedFields(principal, type, version.fields),
      }),
    );
  });
  // Restore copies an old version's fields into a NEW draft version. It must pass
  // the same write authorization as a normal edit, so a role with denied/
  // read-only fields can't resurrect them by restoring, or write an ungranted type.
  app.post(
    `${BASE}/entries/:id/versions/:version/restore`,
    doc('Entries', 'Restore a version', {
      description: "Copies the version's fields into a new draft version.",
      query: {
        expectedVersion:
          "The entry's currentVersion as the caller read it; 409 if it has changed since",
      },
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const principal = c.get('principal');
      const { entry } = await getEntry(ctx, scopeOf(c), c.req.param('id'));
      authorizeContent(principal, 'write', entry.contentTypeApiId);
      const target = await getVersion(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        Number(c.req.param('version')),
      );
      assertWritableFields(principal, entry.contentTypeApiId, target.fields);
      return c.json(
        await restoreVersion(
          actingCtx(ctx, c),
          scopeOf(c),
          c.req.param('id'),
          Number(c.req.param('version')),
          expectedVersionOf(c),
        ),
      );
    },
  );

  return app;
}
