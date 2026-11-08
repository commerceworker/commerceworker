import {
  createAIAction,
  deleteAIAction,
  listAIActions,
  runAIAction,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { createAiActionBody, parseBody, runAiActionBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function aiActionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, ai } = deps;
  const app = new Hono<AuthVars>();

  // --- AI Actions (templated, governed AI operations) --------------------
  app.get(`${BASE}/ai-actions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAIActions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/ai-actions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createAIAction(ctx, scopeOf(c), await parseBody(c, createAiActionBody)), 201),
  );
  app.delete(`${BASE}/ai-actions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteAIAction(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post(`${BASE}/ai-actions/:id/run`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await runAIAction(
        actingCtx(ctx, c),
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, runAiActionBody),
      ),
    ),
  );

  return app;
}
