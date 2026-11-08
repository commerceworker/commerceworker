import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  MAX_PAGE_LIMIT,
  resendWebhookDelivery,
  sendWebhookTest,
  updateWebhook,
} from '@commerceworker/application';
import { SCOPES, type Webhook } from '@commerceworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { updateWebhookBody, webhookBody } from '../../api/validation';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerWebhookTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard, requestedEnvironment } = t;
  // --- webhooks (admin) ----------------------------------------------------
  // The REST routes' twins: the same use-cases, the same space-admin check, the same body schemas,
  // and the same projection (never the signing secret or the headers, which may carry credentials).
  // A hook is scoped to one environment or, with allEnvironments, space-wide (environmentId null).
  const webhookView = (h: Webhook) => ({
    id: h.id,
    url: h.url,
    topics: h.topics,
    active: h.active,
    environmentId: h.environmentId,
  });

  server.registerTool(
    'webhooks_list',
    {
      description:
        "List an environment's webhooks and every space-wide one (environmentId null). " +
        'Secrets and headers are never returned.',
      inputSchema: toolSchema('webhooks_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok({ items: (await listWebhooks(ctx, scopeOf(args))).map(webhookView) });
    },
  );

  server.registerTool(
    'webhook_create',
    {
      description:
        'Register a webhook: signed POSTs of the events matching topics ("*" for all) to url. ' +
        "It receives only the given environment's events, or every environment's with " +
        'allEnvironments: true. Named through an alias it is space-wide (allEnvironments: false is ' +
        'refused). secret is yours to choose and is never returned.',
      inputSchema: toolSchema('webhook_create', () => webhookBody.extend(scopeArgs)),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const { space: _s, environment: _e, ...input } = args;
      return ok(
        webhookView(
          await createWebhook(ctx, scopeOf(args), input as Parameters<typeof createWebhook>[2], {
            requestedEnvironment: requestedEnvironment.get(args),
          }),
        ),
      );
    },
  );

  server.registerTool(
    'webhook_update',
    {
      description:
        'Change a webhook; omitted fields are kept. allEnvironments: true makes it space-wide, ' +
        'false scopes it to the given environment (refused for an alias); omitted, its scope is ' +
        'unchanged.',
      inputSchema: toolSchema('webhook_update', () =>
        updateWebhookBody.extend({ id: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const { id, space: _s, environment: _e, ...changes } = args;
      return ok(
        webhookView(
          await updateWebhook(
            ctx,
            scopeOf(args),
            id,
            changes as Parameters<typeof updateWebhook>[3],
            { requestedEnvironment: requestedEnvironment.get(args) },
          ),
        ),
      );
    },
  );

  server.registerTool(
    'webhook_delete',
    {
      description: 'Delete a webhook by id.',
      inputSchema: toolSchema('webhook_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      await deleteWebhook(ctx, scopeOf(args), args.id);
      return ok({ deleted: args.id });
    },
  );

  server.registerTool(
    'webhook_deliveries',
    {
      description: "A webhook's recent delivery attempts, newest first (default 50, at most 100).",
      inputSchema: toolSchema('webhook_deliveries', () =>
        z.object({
          id: z.string(),
          limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const items = await listWebhookDeliveries(ctx, scopeOf(args), args.id, {
        limit: args.limit,
      });
      return ok({ items });
    },
  );

  // A test and a resend go through the outbox and the engine like every delivery: the tool returns
  // what was queued, and the attempt shows up in webhook_deliveries under the returned eventId.
  server.registerTool(
    'webhook_test',
    {
      description:
        'Queue a signed webhook.test event for one webhook, whatever its topics and even while it ' +
        'is paused. One attempt, never retried; its result appears in webhook_deliveries under ' +
        'the returned eventId.',
      inputSchema: toolSchema('webhook_test', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await sendWebhookTest(ctx, scopeOf(args), args.id));
    },
  );

  server.registerTool(
    'webhook_resend',
    {
      description:
        'Resend a stored delivery (deliveryId from webhook_deliveries) to its webhook: the same ' +
        'event id, signed afresh with the time it is sent (a bulk chunk from its entries as ' +
        'published now), recorded as a new attempt whose resendOf names the original. One ' +
        'attempt, never retried. Refused (conflict) once the event has passed the event retention ' +
        '(7 days by default), which can be a little before the delivery leaves the log.',
      inputSchema: toolSchema('webhook_resend', () =>
        z.object({
          id: z.string().describe('the webhook id'),
          deliveryId: z.number().int().min(1),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await resendWebhookDelivery(ctx, scopeOf(args), args.id, args.deliveryId));
    },
  );
}
