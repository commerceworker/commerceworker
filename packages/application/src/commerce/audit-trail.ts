/**
 * Reading the audit trail: the events, and whether its hash chain holds. The REST route and the
 * MCP tools both call these, so the two transports show the same thing.
 */
import {
  type AuditAnchor,
  type AuditChainCheck,
  type BusinessAuditAction,
  verifyAuditChain,
} from '@commerceworker/core';
import type { AuditAnchors, AuditEvent, AuditLog } from '@commerceworker/ports/commerce';

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
 * more to check. With `anchors`, the chain is also held to the newest hourly anchor: the event
 * the anchor names must still be there with the hash it recorded, which a rewritten chain or a
 * restore that dropped events cannot satisfy.
 */
export async function verifyAuditTrail(
  ports: { audit: AuditLog; anchors?: AuditAnchors },
  after?: number,
  now = Date.now(),
): Promise<AuditChainCheck & { next?: number }> {
  const anchor = after === undefined ? undefined : await ports.audit.link(after);
  if (after !== undefined && !anchor)
    return { ok: false, checked: 0, brokenAt: after, reason: `no event ${after}` };
  const rows = await ports.audit.sealedAfter(after, VERIFY_BATCH);
  const check = await verifyAuditChain(rows, anchor);
  if (!check.ok) return check;
  const disagreement = ports.anchors && (await checkAnchor(ports.audit, ports.anchors, now));
  if (disagreement) return { ok: false, checked: check.checked, ...disagreement };
  const next = rows.length === VERIFY_BATCH ? check.last?.seq : undefined;
  return { ...check, ...(next ? { next } : {}) };
}

/** Why the chain disagrees with the newest anchor, or undefined when it agrees (or has none). */
async function checkAnchor(audit: AuditLog, anchors: AuditAnchors, now: number) {
  const anchor = await anchors.latest(now);
  if (!anchor) return undefined;
  const when = new Date(anchor.anchoredAt).toISOString();
  const link = await audit.link(anchor.seq);
  if (link) {
    if (link.hash === anchor.hash) return undefined;
    return {
      brokenAt: anchor.seq,
      reason: `event ${anchor.seq} does not match the anchor written ${when}: the chain was rewritten`,
    };
  }
  // Not there: pruned by retention if the chain has moved past it, dropped if it hasn't.
  const head = await audit.head();
  if (!head || head.seq < anchor.seq)
    return {
      brokenAt: anchor.seq,
      reason: `the anchor written ${when} names event ${anchor.seq}, but the chain ends at ${head?.seq ?? 0}: events were lost`,
    };
  return undefined;
}

/**
 * Writes the chain's head to the anchors (hourly): its seq and hash, and the head event's id and
 * time. Nothing before the first event. Returns the anchor, or null when there is none to write
 * or this hour's is already there.
 */
export async function anchorAudit(
  ports: { audit: AuditLog; anchors: AuditAnchors },
  now: number,
): Promise<AuditAnchor | null> {
  const head = await ports.audit.head();
  if (!head) return null;
  const anchor = {
    seq: head.seq,
    hash: head.hash,
    eventId: head.id,
    eventAt: head.at,
    anchoredAt: now,
  };
  return (await ports.anchors.write(anchor)) ? anchor : null;
}
