import {
  clampCount,
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  MAX_PAGE_LIMIT,
  resendWebhookDelivery,
  sendWebhookTest,
  updateWebhook,
} from '@commerceworker/application';
import { NotFoundError, SCOPES } from '@commerceworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as webhookDocs from '../../docs/schemas/webhooks';
import { parseBody, updateWebhookBody, webhookBody } from '../../validation';
import { BASE, scopeOf, webhookSummary } from './shared';

export function webhooksRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- webhooks (admin) ---------------------------------------------------
  // A hook is scoped to one environment (`environmentId`) or space-wide (`null`). Under an
  // environment, every route sees that environment's hooks and the space-wide ones; a hook scoped to
  // another environment is a 404 here. The raw `:env` goes to the use-case so a hook is never pinned
  // to an alias's current target.
  app.get(
    `${BASE}/webhooks`,
    doc('Webhooks', 'List webhooks', {
      description:
        "The environment's own webhooks and every space-wide one (`environmentId: null`). " +
        'Signing secrets and headers are never returned.',
      ok: webhookDocs.webhookList,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const hooks = await listWebhooks(ctx, scopeOf(c));
      return c.json({ items: hooks.map(webhookSummary) });
    },
  );
  app.post(
    `${BASE}/webhooks`,
    doc('Webhooks', 'Create a webhook', {
      description:
        "Receives only the path environment's events, or every environment's with " +
        '`allEnvironments: true`. Under an alias it is space-wide, and `allEnvironments: false` is ' +
        'refused (422). The URL must be http(s) and not a loopback, link-local or private address.',
      body: webhookBody,
      ok: webhookDocs.webhook,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        webhookSummary(
          await createWebhook(
            ctx,
            scopeOf(c),
            (await parseBody(c, webhookBody)) as Parameters<typeof createWebhook>[2],
            { requestedEnvironment: c.req.param('env') },
          ),
        ),
        201,
      ),
  );
  app.put(
    `${BASE}/webhooks/:id`,
    doc('Webhooks', 'Update a webhook', {
      description:
        'Omitted fields are kept. `allEnvironments: true` makes the hook space-wide, `false` ' +
        "scopes it to the path's environment (422 under an alias); omitted, its scope is unchanged.",
      body: updateWebhookBody,
      ok: webhookDocs.webhook,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) =>
      c.json(
        webhookSummary(
          await updateWebhook(
            ctx,
            scopeOf(c),
            c.req.param('id'),
            (await parseBody(c, updateWebhookBody)) as Parameters<typeof updateWebhook>[3],
            { requestedEnvironment: c.req.param('env') },
          ),
        ),
      ),
  );
  app.delete(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteWebhook(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(
    `${BASE}/webhooks/:id/deliveries`,
    doc('Webhooks', "List a webhook's deliveries", {
      description: 'Recent delivery attempts, newest first (`?limit=`, default 50, at most 100).',
      ok: webhookDocs.webhookDeliveryList,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const limit = c.req.query('limit');
      const items = await listWebhookDeliveries(ctx, scopeOf(c), c.req.param('id'), {
        limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
      });
      return c.json({ items });
    },
  );
  // A test and a resend are queued through the outbox, so the engine sends them as it sends every
  // delivery (202): each is one attempt, recorded in the deliveries above, never retried.
  app.post(
    `${BASE}/webhooks/:id/test`,
    doc('Webhooks', 'Send a test delivery', {
      description:
        'Queues a `webhook.test` event for this webhook alone, whatever its topics and even while ' +
        "it is paused. It is signed like every delivery and appears in the webhook's deliveries " +
        'with the returned `eventId`. One attempt, never retried.',
      ok: webhookDocs.queuedWebhookDelivery,
      status: 202,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => c.json(await sendWebhookTest(ctx, scopeOf(c), c.req.param('id')), 202),
  );
  app.post(
    `${BASE}/webhooks/:id/deliveries/:deliveryId/resend`,
    doc('Webhooks', 'Resend a delivery', {
      description:
        "Queues the delivery's event for this webhook again: the same event id, signed afresh " +
        'with the time it is sent (a bulk chunk from its entries as published now). The new ' +
        'attempt names this one in `resendOf`. One attempt, never retried. 409 once the event ' +
        'has passed the event retention (7 days by default), which can be a little before the ' +
        'delivery itself leaves the log.',
      ok: webhookDocs.queuedWebhookDelivery,
      status: 202,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const raw = c.req.param('deliveryId');
      const deliveryId = Number(raw);
      if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) {
        throw new NotFoundError('WebhookDelivery', raw);
      }
      return c.json(
        await resendWebhookDelivery(ctx, scopeOf(c), c.req.param('id'), deliveryId),
        202,
      );
    },
  );

  return app;
}
