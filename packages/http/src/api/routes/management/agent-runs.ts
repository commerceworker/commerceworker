import { agentUsage, clampCount, listAgentRuns, MAX_PAGE_LIMIT } from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { BASE, scopeOf } from './shared';

export function agentRunsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- agent runs / cost ledger (admin) ----------------------------------
  app.get(`${BASE}/agent-runs`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAgentRuns(ctx, scopeOf(c), {
      workflow: c.req.query('workflow'),
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });
  app.get(`${BASE}/agent-runs/usage`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      await agentUsage(ctx, scopeOf(c), {
        workflow: c.req.query('workflow'),
        since: c.req.query('since'),
      }),
    ),
  );

  return app;
}
