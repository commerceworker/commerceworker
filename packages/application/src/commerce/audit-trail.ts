/**
 * Reading the audit trail: the events, and whether its hash chain holds. The REST route and the
 * MCP tools both call these, so the two transports show the same thing.
 */
import {
  type AuditChainCheck,
  type BusinessAuditAction,
  verifyAuditChain,
} from '@commerceworker/core';
import type { AuditEvent, AuditLog } from '@commerceworker/ports/commerce';

/**
 * An audit event a use-case asks its caller to record once the change is made: the channel adds
 * who acted and how it got in (`via`), so the REST API and MCP write the same action and detail.
 */
export type AuditDraft = {
  action: BusinessAuditAction;
  target?: string;
  detail: Record<string, unknown>;
};

/** Sealed events checked per call; `next` continues from where one stopped. */
export const VERIFY_BATCH = 2000;

/**
 * Newest first, `limit` at a time (1 to 500, 100 unset); `before` pages back, `group` filters by
 * action prefix. With `after` (a `seq`), sealed events after it, oldest first: the cursor an
 * export or a SIEM pulls by.
 */
export async function listAuditEvents(
  ports: { audit: AuditLog },
  f: { group?: string; before?: number; after?: number; limit?: number } = {},
) {
  const rows = await ports.audit.list({
    group: f.group,
    before: f.before,
    after: f.after,
    limit: Math.min(Math.max(f.limit ?? 100, 1), 500),
  });
  return rows.map((r: AuditEvent) => ({
    ...r,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}

/**
 * Checks the hash chain from just after `after` (a `seq`), or from the oldest event still kept
 * (pruned ones are in the R2 archive, which carries their hashes). `next` is set when there is
 * more to check.
 */
export async function verifyAuditTrail(
  ports: { audit: AuditLog },
  after?: number,
): Promise<AuditChainCheck & { next?: number }> {
  const anchor = after === undefined ? undefined : await ports.audit.link(after);
  if (after !== undefined && !anchor)
    return { ok: false, checked: 0, brokenAt: after, reason: `no event ${after}` };
  const rows = await ports.audit.sealedAfter(after, VERIFY_BATCH);
  const check = await verifyAuditChain(rows, anchor);
  const next = check.ok && rows.length === VERIFY_BATCH ? check.last?.seq : undefined;
  return { ...check, ...(next ? { next } : {}) };
}
