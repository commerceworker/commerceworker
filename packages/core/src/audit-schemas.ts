/**
 * The zod schemas for what the audit routes answer (audit.ts): an event as the log lists it, and
 * the result of checking its hash chain. Apart from audit.ts, which stays free of zod;
 * `tests/response-schemas.test.ts` holds them to the types they describe.
 */

import { z } from 'zod';

/** An event as the audit log lists it; `seq` and the hashes are null before the chain began. */
export const auditEventSchema = z.object({
  id: z.string(),
  at: z.number().int().describe('Epoch ms'),
  action: z.string().describe('e.g. `order.started`'),
  actor: z.string().nullable().describe('Who acted: an email, or a machine’s name'),
  actorId: z.string().nullable(),
  actorKind: z.string().nullable(),
  target: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  seq: z.number().int().nullable().describe('Its place in the hash chain'),
  prevHash: z.string().nullable(),
  hash: z.string().nullable(),
});

/** The audit log's events, in the order asked for. */
export const auditEventsSchema = z.object({ events: z.array(auditEventSchema) });

/** The result of checking up to 2000 events of the hash chain. */
export const auditChainCheckSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    checked: z.number().int(),
    last: z
      .object({ seq: z.number().int(), hash: z.string() })
      .nullable()
      .describe('The last event checked'),
    next: z
      .number()
      .int()
      .optional()
      .describe('Pass it as `after` to continue; absent when the whole chain was checked'),
  }),
  z.object({
    ok: z.literal(false),
    checked: z.number().int(),
    brokenAt: z.number().int().describe('The `seq` of the first event that fails'),
    reason: z.string(),
  }),
]);
