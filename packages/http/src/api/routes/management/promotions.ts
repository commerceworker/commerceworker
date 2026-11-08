import {
  approvePromotion,
  getPromotion,
  listPromotions,
  rejectPromotion,
  requestPromotion,
} from '@commerceworker/application';
import {
  authorize,
  PROMOTION_STATUSES,
  type PromotionStatus,
  SCOPES,
} from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import { parseBody, promotionBody } from '../../validation';
import { actingCtx } from './shared';

export function promotionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- promotions (environment → environment, with approval) -------------
  app.post(
    '/spaces/:space/promotions',
    doc('Spaces & environments', 'Promote content from one environment to another', {
      body: promotionBody,
      status: 201,
      description:
        'Pins the entries to copy (what is live in the source goes live in the target; a draft ' +
        'goes as a draft) and runs a risk check. With nothing to stop it, it applies at once ' +
        '(`completed`). A promotion into `main` or an aliased environment, one that would remove ' +
        'or retype a field, or one the risk check flags waits as `awaiting_approval` for someone ' +
        'else to approve. Omit `contentTypes` and `entries` to promote everything that differs ' +
        '(at most 200 entries).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      // It can publish, so it needs both.
      authorize(c.get('principal'), SCOPES.contentPublish, c.req.param('space'));
      const body = await parseBody(c, promotionBody);
      return c.json(
        await requestPromotion(actingCtx(ctx, c), c.get('principal'), c.req.param('space'), body),
        201,
      );
    },
  );
  app.get(
    '/spaces/:space/promotions',
    doc('Spaces & environments', 'List promotions, newest first'),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const status = c.req.query('status');
      return c.json({
        items: await listPromotions(ctx, c.req.param('space'), {
          ...(status && (PROMOTION_STATUSES as readonly string[]).includes(status)
            ? { status: status as PromotionStatus }
            : {}),
        }),
      });
    },
  );
  app.get(
    '/spaces/:space/promotions/:id',
    doc('Spaces & environments', 'Get a promotion, with its risk check and result'),
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await getPromotion(ctx, c.req.param('space'), c.req.param('id'))),
  );
  app.post(
    '/spaces/:space/promotions/:id/approve',
    doc('Spaces & environments', 'Approve a waiting promotion and apply it', {
      description: 'By someone other than whoever requested it (403 otherwise).',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(
        await approvePromotion(
          actingCtx(ctx, c),
          c.get('principal'),
          c.req.param('space'),
          c.req.param('id'),
        ),
      ),
  );
  app.post(
    '/spaces/:space/promotions/:id/reject',
    doc('Spaces & environments', 'Reject a waiting promotion'),
    requireScope(SCOPES.contentPublish),
    async (c) =>
      c.json(
        await rejectPromotion(ctx, c.get('principal'), c.req.param('space'), c.req.param('id')),
      ),
  );

  return app;
}
