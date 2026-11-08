import {
  createAppExtension,
  deleteAppExtension,
  listAppExtensions,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { appExtensionBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function appExtensionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- app extensions (admin UI extensions) ------------------------------
  app.get(`${BASE}/app-extensions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAppExtensions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/app-extensions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createAppExtension(ctx, scopeOf(c), await parseBody(c, appExtensionBody)), 201),
  );
  app.delete(`${BASE}/app-extensions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteAppExtension(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
