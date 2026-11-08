import { createFunction, deleteFunction, listFunctions } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { createFunctionBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function functionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- functions (event-triggered, HTTP-invoked) -------------------------
  app.get(`${BASE}/functions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listFunctions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/functions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createFunction(ctx, scopeOf(c), await parseBody(c, createFunctionBody)), 201),
  );
  app.delete(`${BASE}/functions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteFunction(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
