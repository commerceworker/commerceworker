import { z } from 'zod';

export const health = z.object({
  status: z.literal('ok'),
  scheduler: z
    .enum(['ok', 'stale', 'unknown'])
    .describe(
      'Whether the engine cron ticked in the last five minutes: `stale` when it has not (or never ' +
        'has), `unknown` when its heartbeat could not be read',
    ),
});

export const schedulerHealth = z.object({
  scheduler: z
    .enum(['ok', 'stale', 'unknown'])
    .describe('As `/health` says it; the status code is 200 only for `ok` (503 otherwise)'),
});

export const ready = z.object({ status: z.literal('ready'), role: z.string() });

export const schedulerStatus = z.object({
  scheduler: z.enum(['ok', 'stale']),
  lastTickAt: z.iso.datetime().optional().describe('When the cron last ticked; absent if never'),
  staleAfterSeconds: z.number().int(),
  jobs: z.array(
    z.object({
      job: z.string().describe('The sweep (`outbox-relay`, `scheduled-actions`, …)'),
      lastRunAt: z.iso.datetime(),
      lastSuccessAt: z.iso.datetime().optional(),
      lastErrorAt: z.iso.datetime().optional(),
      lastError: z.string().optional().describe('Redacted, at most 500 characters'),
    }),
  ),
});

const schedulerNotice = z.object({
  state: z
    .enum(['pending', 'sent', 'failed', 'skipped'])
    .describe(
      '`skipped` when no recipient or no sender is configured, or the episode resolved before ' +
        'the email went; `failed` after five undelivered tries',
    ),
  attempts: z.number().int(),
  at: z.iso.datetime().optional().describe('When it was sent, last tried or skipped'),
  error: z.string().optional(),
});

const schedulerAlertEpisode = z.object({
  id: z.string(),
  job: z
    .string()
    .describe('The sweep, or `tick` for a gap in the cron itself (resolved when it came back)'),
  lastSuccessAt: z.iso
    .datetime()
    .optional()
    .describe('The last success before the episode (for `tick`, the last tick before the gap)'),
  detectedAt: z.iso.datetime(),
  lastError: z.string().optional().describe('Redacted, at most 500 characters'),
  resolvedAt: z.iso.datetime().optional(),
  resolution: z.enum(['recovered', 'unscheduled']).optional(),
  staleNotice: schedulerNotice.optional(),
  recoveryNotice: schedulerNotice
    .optional()
    .describe('Only when the stale email went out (or may have)'),
});

export const schedulerAlerts = z.object({
  recipients: z.array(z.string()).describe('Who the alert emails go to; empty means log only'),
  evaluatingSince: z.iso
    .datetime()
    .optional()
    .describe('Since when the cron has evaluated without a gap; absent before its first tick'),
  open: z.array(schedulerAlertEpisode).describe('Sweeps stale now'),
  recent: z.array(schedulerAlertEpisode).describe('The last 20 resolved episodes, newest first'),
});
