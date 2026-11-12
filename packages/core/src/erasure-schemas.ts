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
