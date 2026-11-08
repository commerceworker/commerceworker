import {
  addEntryToRelease,
  cancelScheduledAction,
  createRelease,
  deleteRelease,
  getRelease,
  listReleases,
  listScheduledActions,
  publishRelease,
  removeEntryFromRelease,
  scheduleAction,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as releaseDocs from '../../docs/schemas/releases';
import { createReleaseBody, parseBody, releaseItemBody, scheduleBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function releasesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- releases -----------------------------------------------------------
  // Bundle entries and ship them atomically. Authoring (create/add/remove) is a
  // write; shipping the bundle requires publish.
  app.get(
    `${BASE}/releases`,
    doc('Releases & scheduling', 'List releases', {
      description:
        'Every release, newest first, each with `itemCount` (its members, from one grouped ' +
        'count), so a list never fetches each release for its size.',
      ok: releaseDocs.releaseList,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listReleases(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/releases`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await createRelease(ctx, scopeOf(c), await parseBody(c, createReleaseBody)), 201),
  );
  app.get(`${BASE}/releases/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getRelease(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/releases/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteRelease(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post(`${BASE}/releases/:id/items`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await addEntryToRelease(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, releaseItemBody),
        { principal: c.get('principal') },
      ),
    ),
  );
  app.delete(`${BASE}/releases/:id/items/:entityId`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await removeEntryFromRelease(ctx, scopeOf(c), c.req.param('id'), c.req.param('entityId')),
    ),
  );
  app.post(`${BASE}/releases/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(
      await publishRelease(actingCtx(ctx, c), scopeOf(c), c.req.param('id'), {
        principal: c.get('principal'),
      }),
    ),
  );

  // --- scheduled actions --------------------------------------------------
  app.get(`${BASE}/scheduled-actions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({
      items: await listScheduledActions(ctx, scopeOf(c), { status: c.req.query('status') }),
    }),
  );
  app.post(`${BASE}/scheduled-actions`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(
      await scheduleAction(ctx, scopeOf(c), await parseBody(c, scheduleBody), {
        principal: c.get('principal'),
      }),
      201,
    ),
  );
  app.delete(`${BASE}/scheduled-actions/:id`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await cancelScheduledAction(ctx, scopeOf(c), c.req.param('id'))),
  );

  return app;
}
