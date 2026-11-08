import { auditEntry, moderateEntry } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { auditBody, parseBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function agentActionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, ai, agents } = deps;
  const app = new Hono<AuthVars>();

  // --- agent actions (audit → work packages) -----------------------------
  app.post(`${BASE}/entries/:id/audit`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await auditEntry(
        actingCtx(ctx, c),
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, auditBody),
      ),
    ),
  );
  // On-demand moderation: classify the entry's text; a flagged result is a
  // recorded hold (`flagged: true`), not a state change — callers decide.
  app.post(`${BASE}/entries/:id/moderate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await moderateEntry(actingCtx(ctx, c), agents, scopeOf(c), c.req.param('id'))),
  );

  return app;
}
