import {
  getSchedulerAlerts,
  SCHEDULER_ALERT_MAX_RECIPIENTS,
  setSchedulerAlertRecipients,
} from '@commerceworker/application';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, type ToolContext, toolSchema } from './shared';

export function registerSchedulerTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal } = t;
  // --- scheduler alerts (deployment) --------------------------------------
  // The same use-cases as /deployment/scheduler/alerts: deployment administrators only.
  // `scheduler_status` (read.ts) has each sweep's heartbeat; these are who hears about it.
  server.registerTool(
    'scheduler_alerts',
    {
      description:
        'Report the scheduler alerts: who is emailed when an engine cron sweep goes stale, the ' +
        'sweeps stale now and the last resolved episodes, each with how its emails went. A sweep ' +
        'is stale once it has gone two of its runs without a success (five minutes for the ' +
        'every-minute ones). Read-only. Deployment administrators only, like GET ' +
        '/deployment/scheduler/alerts.',
      inputSchema: toolSchema('scheduler_alerts', () => z.object({})),
      annotations: { readOnlyHint: true },
    },
    async () => ok(await getSchedulerAlerts(ctx, principal)),
  );

  server.registerTool(
    'scheduler_alerts_set_recipients',
    {
      description:
        'Set who the scheduler alerts email (replaces the list; an empty list turns the emails ' +
        'off, and the engine still logs every episode). One email when a sweep goes stale, one ' +
        'when it recovers, one when the cron ticks again after a gap. Needs the deployment to ' +
        'send email. Deployment administrators only, like PUT /deployment/scheduler/alerts.',
      inputSchema: toolSchema('scheduler_alerts_set_recipients', () =>
        z.object({
          recipients: z.array(z.string().max(320)).max(SCHEDULER_ALERT_MAX_RECIPIENTS),
        }),
      ),
    },
    async (args) => ok(await setSchedulerAlertRecipients(ctx, principal, args.recipients)),
  );
}
