import {
  createAgentSchedule,
  decideAgentReview,
  deleteAgentSchedule,
  getAgentReview,
  getEntry,
  listAgentReviews,
  listAgentSchedules,
  updateAgentSchedule,
} from '@commerceworker/application';
import {
  assertWritableFields,
  authorizeContent,
  principalActorId,
  SCOPES,
} from '@commerceworker/domain';
import { type Context, Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { agentScheduleBody, agentSchedulePatchBody, parseBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function agentsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- agent schedules (recurring agent jobs) ------------------------------
  app.get(`${BASE}/agent-schedules`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAgentSchedules(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/agent-schedules`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await createAgentSchedule(ctx, scopeOf(c), await parseBody(c, agentScheduleBody)), 201),
  );
  app.patch(`${BASE}/agent-schedules/:id`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(
      await updateAgentSchedule(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, agentSchedulePatchBody),
      ),
    ),
  );
  app.delete(`${BASE}/agent-schedules/:id`, requireScope(SCOPES.contentPublish), async (c) => {
    await deleteAgentSchedule(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- agent reviews (human-in-the-loop decisions on agent proposals) ------
  const reviewStatus = (raw: string | undefined) =>
    raw === 'pending' || raw === 'approved' || raw === 'rejected' ? raw : undefined;
  // Granular RBAC for a review's proposal: role-bound principals must hold
  // write on the entry's content type, and the proposed fields must all be
  // writable — the same enforcement an equivalent direct update would face.
  const authorizeReviewDecision = async (c: Context<AuthVars>, reviewId: string) => {
    const principal = c.get('principal');
    if (!principal.contentGrants) return;
    const review = await getAgentReview(ctx, scopeOf(c), reviewId);
    const entry = await getEntry(ctx, scopeOf(c), review.entryId).catch(() => null);
    if (!entry) return; // entry gone — the apply will no-op
    authorizeContent(principal, 'write', entry.entry.contentTypeApiId);
    assertWritableFields(principal, entry.entry.contentTypeApiId, review.proposed);
  };
  app.get(`${BASE}/agent-reviews`, requireScope(SCOPES.previewRead), async (c) => {
    // Role-bound principals see only reviews of types they read, with denied fields masked.
    const items = await listAgentReviews(
      ctx,
      scopeOf(c),
      { status: reviewStatus(c.req.query('status')), entryId: c.req.query('entryId') },
      c.get('principal'),
    );
    return c.json({ items });
  });
  app.post(`${BASE}/agent-reviews/:id/approve`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeReviewDecision(c, c.req.param('id'));
    return c.json(
      await decideAgentReview(
        actingCtx(ctx, c),
        scopeOf(c),
        c.req.param('id'),
        { approve: true, decidedBy: principalActorId(c.get('principal')) },
        { signalReview: deps.signalReview },
      ),
    );
  });
  app.post(`${BASE}/agent-reviews/:id/reject`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeReviewDecision(c, c.req.param('id'));
    return c.json(
      await decideAgentReview(
        actingCtx(ctx, c),
        scopeOf(c),
        c.req.param('id'),
        { approve: false, decidedBy: principalActorId(c.get('principal')) },
        { signalReview: deps.signalReview },
      ),
    );
  });

  return app;
}
