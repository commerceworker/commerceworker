import {
  deleteWorkflow,
  getEntryWorkflowState,
  getWorkflow,
  listWorkflows,
  transitionEntry,
} from '@commerceworker/application';
import { SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as workflowDocs from '../../docs/schemas/workflows';
import { parseBody, transitionBody } from '../../validation';
import { workflowRoutes } from '../workflows';
import { BASE, entryAccess, scopeOf } from './shared';

export function workflowManagementRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const { authorizeEntryRead } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- workflows ---------------------------------------------------------
  app.get(
    `${BASE}/workflows`,
    doc('Workflows', 'List workflows', {
      description:
        'Every workflow with its draft `graph`, plus how its latest PUBLISHED version starts: ' +
        '`publishedTrigger`, and `startsAlongside`, the other published workflows that start on ' +
        'the same trigger for an overlapping content type. Both are null until it is published.',
      ok: workflowDocs.workflowList,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listWorkflows(ctx, scopeOf(c)) }),
  );
  // Graph workflows: create, drafts, versions, validation, copilot, runs, tasks, settings.
  app.route('/', workflowRoutes(deps));
  app.get(`${BASE}/workflows/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getWorkflow(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/workflows/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteWorkflow(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/entries/:id/workflow`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json(await getEntryWorkflowState(ctx, scopeOf(c), c.req.param('id')));
  });
  // The transition's required scope is data-driven by the target step, so the
  // base guard is only previewRead; transitionEntry enforces the step's scope.
  app.post(
    `${BASE}/entries/:id/workflow/transition`,
    requireScope(SCOPES.previewRead),
    async (c) => {
      const body = await parseBody(c, transitionBody);
      return c.json(
        await transitionEntry(
          ctx,
          scopeOf(c),
          { entryId: c.req.param('id'), workflowId: body.workflowId, toStepId: body.toStepId },
          c.get('principal').scopes,
        ),
      );
    },
  );

  return app;
}
