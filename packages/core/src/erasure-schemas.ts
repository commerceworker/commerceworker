/**
 * The zod schemas for a data subject request's answers (erasure.ts): the export and the erasure
 * tally. Apart from erasure.ts, which stays free of zod; `tests/response-schemas.test.ts` holds
 * each to its type.
 */

import { z } from 'zod';

const records = z.array(z.record(z.string(), z.unknown()));
const count = z.number().int();

/** Everything held about one person, as `POST /api/v1/data-subjects/export` downloads it. */
export const subjectExportSchema = z.object({
  email: z.string(),
  exportedAt: z.number().int().describe('Epoch ms'),
  customers: records,
  orders: records.describe('Up to 500; `truncated` says when there were more'),
  messages: records,
  inboundEmails: records,
  documents: z.array(
    z.object({
      key: z.string(),
      kind: z.string(),
      contentType: z.string(),
      createdAt: z.number().int(),
    }),
  ),
  checkouts: records.describe('Agentic checkout sessions they were the buyer of'),
  carts: records.describe(
    'External carts they were the buyer of, and their accounts’ staff carts that hold a ship-to',
  ),
  taxCertificates: records.describe('Each file’s key, not the file'),
  addresses: records,
  companies: records,
  companyMembers: records,
  purchaseOrders: records,
  quotes: records,
  shopperSignIns: records.describe('Codes sent to the address as a storefront shopper'),
  shopperSessions: records.describe('Where the address is signed in on the storefront'),
  ucpLinks: records.describe('The platforms the address linked its identity to (no tokens)'),
  truncated: z.boolean().describe('There were more orders than one export holds'),
  teamMember: z.boolean().describe('The address also belongs to a person on your team'),
});

/** An erasure pass that ran: what it removed, and whether more orders are left. */
export const erasureDoneSchema = z.object({
  ok: z.literal(true),
  done: z.boolean().describe('False when more orders are left: call again to continue'),
  orders: count,
  customers: count,
  documents: count,
  messages: count,
  inboundEmails: count,
  carts: count,
  taxCertificates: count,
  addresses: count,
  companyMembers: count,
  purchaseOrders: count,
  quotes: count,
  shopperSignIns: count,
  shopperSessions: count,
  ucpLinks: count,
  teamMember: z
    .boolean()
    .describe('The address is also a team member’s; remove them on the team page'),
});

/** An erasure refused: orders still running can't be erased. */
export const erasureRefusedSchema = z.object({
  ok: z.literal(false),
  reason: z.literal('active_orders'),
  orders: z.array(z.string()).describe('The orders in the way'),
});

/** The `409` the REST API answers an erasure refused with: the refusal, and why in words. */
export const erasureRefusalSchema = erasureRefusedSchema.extend({
  error: z.string().describe('Why, in words: cancel their orders or let them finish'),
});

export const erasureResultSchema = z.discriminatedUnion('ok', [
  erasureDoneSchema,
  erasureRefusedSchema,
]);

/** What `replay_erasures` reports (`ErasureReplay`, erasure.ts). */
export const erasureReplaySchema = z.object({
  since: z.number().int().describe('Epoch ms'),
  dryRun: z.boolean().describe('Nothing was erased: `erased` is what a replay would erase'),
  events: z
    .object({
      total: count,
      database: count.describe('Read from the database’s audit log'),
      archive: count.describe('Read from the R2 copies of it, which a restore does not touch'),
    })
    .describe('Distinct people erased since then'),
  scanned: count.describe('Addresses hashed to find them'),
  erased: z
    .array(
      erasureDoneSchema.omit({ ok: true, teamMember: true }).extend({
        target: z.string().describe('The audit log’s name for them: a hash, never the address'),
        at: z.number().int().describe('When they were first erased'),
        recorded: z.boolean().describe('Their erasure is in the database’s audit log'),
      }),
    )
    .describe('People found in the stores and erased again'),
  orders: z
    .object({
      checked: count.describe('Orders marked erased since then'),
      erased: count.describe('Those whose agent held what an erasure removes, erased again'),
      documents: count.describe('Files deleted again from their folders in the documents bucket'),
      running: z
        .array(z.string())
        .describe('Orders a restore left running again: erase them once they end'),
      nextSince: z
        .number()
        .int()
        .optional()
        .describe('Set when more were left than one replay checks: run again with this `since`'),
    })
    .describe('Orders erased since, whose agent state or files a restore brought back'),
  blocked: z
    .array(
      z.object({
        target: z.string(),
        reason: z
          .enum(['active_orders', 'ordered_since'])
          .describe(
            '`active_orders`: cancel them or wait, then replay again. `ordered_since`: they ordered after they were erased, so a person decides',
          ),
        orders: z.array(z.string()),
      }),
    )
    .describe('People left alone, and why'),
  clean: z.array(z.string()).describe('People the stores hold nothing about'),
});
