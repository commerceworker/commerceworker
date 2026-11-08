import {
  duplicateEntry,
  getEntry,
  getReverseReferences,
  getTrashSettings,
  purgeEntry,
  restoreEntry,
  setTrashRetention,
  trashEntry,
  updateEntry,
} from '@commerceworker/application';
import {
  assertWritableFields,
  authorizeContent,
  ENTRY_OPERATION_ACTIONS,
  maskDeniedFields,
  SCOPES,
  unwritableFieldsFor,
  withAuthorIdsFor,
} from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as entryDocs from '../../docs/schemas/entries';
import { parseBody, trashSettingsBody, updateEntryBody } from '../../validation';
import { actingCtx, BASE, entryAccess, scopeOf } from './shared';

export function trashRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, blob } = deps;
  const { guardEntry, guardTrash, authorizeEntryRead } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- trash lifecycle ----------------------------------------------------
  // Two deliberate steps: DELETE moves to the trash (recoverable), and only a
  // trashed entry can be permanently deleted.
  app.delete(
    `${BASE}/entries/:id`,
    doc('Entries', 'Move an entry to the trash', {
      status: 200,
      description:
        'Unpublishes the entry first when it is live, so delivery stops serving it. ' +
        'Idempotent. Restore it, or delete it permanently, from the trash. A role needs ' +
        '`write` and `delete` on the type, and `unpublish` too when its grant withholds it ' +
        'and the entry is live.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await guardTrash(c, c.req.param('id'));
      return c.json(await trashEntry(actingCtx(ctx, c), scopeOf(c), c.req.param('id')));
    },
  );
  app.post(
    `${BASE}/entries/:id/restore`,
    doc('Entries', 'Restore an entry from the trash', {
      description: 'Comes back as a draft; re-publishing is a separate action.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'write');
      return c.json(await restoreEntry(actingCtx(ctx, c), scopeOf(c), c.req.param('id')));
    },
  );
  app.delete(
    `${BASE}/entries/:id/permanent`,
    doc('Entries', 'Permanently delete a trashed entry', {
      status: 204,
      description:
        'Irreversible. Refuses with 409 while published entries still link to it, ' +
        'unless ?force=true. Requires content:publish, not merely content:write, and a ' +
        'role needs `publish` and `delete` on the type.',
    }),
    // A harder gate than trashing: this is the only unrecoverable entry action.
    requireScope(SCOPES.contentPublish),
    async (c) => {
      await guardEntry(c, c.req.param('id'), ENTRY_OPERATION_ACTIONS.purge);
      await purgeEntry(ctx, scopeOf(c), c.req.param('id'), {
        force: c.req.query('force') === 'true',
        ...(blob ? { blob } : {}),
      });
      return c.body(null, 204);
    },
  );
  // How long the space keeps trashed entries before the engine's hourly sweep purges them.
  app.get(
    `${BASE}/trash-settings`,
    doc('Entries', 'Read the space’s trash retention', {
      description: '`retentionDays` is null when retention is off (the default).',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getTrashSettings(ctx, scopeOf(c))),
  );
  app.put(
    `${BASE}/trash-settings`,
    doc('Entries', 'Set the space’s trash retention', {
      body: trashSettingsBody,
      description:
        'Entries in the trash longer than `retentionDays` (1 to 3650) are deleted permanently by ' +
        'the engine’s hourly sweep, in every environment of the space, including what is already ' +
        'in the trash. Entries published entries link to are kept. null turns it off. Needs ' +
        '`space:admin`.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, trashSettingsBody);
      return c.json(
        await setTrashRetention(ctx, c.get('principal'), scopeOf(c), body.retentionDays),
      );
    },
  );
  app.post(
    `${BASE}/entries/:id/duplicate`,
    doc('Entries', 'Duplicate an entry', {
      ok: entryDocs.createdEntry,
      status: 201,
      description:
        'Copies fields and taxonomy metadata into a new draft. A role needs read and write on the ' +
        'type; the copy holds every field, and answers without the ones the role may not read.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      // Writing a copy is a write of that content type, not just a read: refused before it exists.
      await guardEntry(c, c.req.param('id'), ['read', 'write']);
      const created = await duplicateEntry(actingCtx(ctx, c), scopeOf(c), c.req.param('id'));
      const principal = c.get('principal');
      return c.json(
        {
          ...created,
          entry: withAuthorIdsFor(principal, created.entry),
          fields: maskDeniedFields(principal, created.entry.contentTypeApiId, created.fields),
        },
        201,
      );
    },
  );

  // "What links here": entries/assets that reference this entry.
  app.get(`${BASE}/entries/:id/reverse-references`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await getReverseReferences(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.put(
    `${BASE}/entries/:id`,
    doc('Entries', 'Save a new draft version', { body: updateEntryBody, ok: entryDocs.entry }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, updateEntryBody);
      const principal = c.get('principal');
      let unwritable: readonly string[] = [];
      if (principal.contentGrants) {
        const { entry } = await getEntry(ctx, scopeOf(c), c.req.param('id'));
        authorizeContent(principal, 'write', entry.contentTypeApiId);
        assertWritableFields(principal, entry.contentTypeApiId, body.fields ?? {});
        unwritable = unwritableFieldsFor(principal, entry.contentTypeApiId);
      }
      const saved = await updateEntry(
        actingCtx(ctx, c),
        scopeOf(c),
        c.req.param('id'),
        body.fields,
        {
          unwritable,
        },
      );
      // The save kept the fields this writer may not write; the ones it may not read stay hidden.
      return c.json({
        ...saved,
        fields: maskDeniedFields(principal, saved.entry.contentTypeApiId, saved.fields),
      });
    },
  );

  return app;
}
