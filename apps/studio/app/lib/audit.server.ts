/**
 * The admin audit log: who signed in or failed to, and who changed people, single sign-on, SCIM or
 * the workspace's settings. (Content changes are the api's per-space `audit_log`.) Each event is
 * sealed into the hash chain (`appendAudit`) and logged as one JSON line,
 * `{"type":"audit_event",…}`, which Logpush can carry to a SIEM. Writing never throws, so a logging
 * problem can't block the action it records; a failure is logged as
 * `{"type":"audit_write_failed",…}` to alert on. The vocabulary is `audit.ts`.
 */

import type { AuditAction, AuditGroup } from './audit';
import { type AuditActor, auditRow, sealAuditRow, verifyAuditChain } from './audit-chain';
import { newId } from './ids';
import type { Principal } from './roles';
import { adminAuditLog } from './wire.server';

export const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'local';

/** Who acted, as the audit trail names them. */
export const actorName = (p: Principal) => p.email ?? p.name;

export async function audit(
  request: Request,
  action: AuditAction,
  e: { actor?: AuditActor | null; target?: string | null; detail?: Record<string, unknown> } = {},
) {
  const row = auditRow(newId('aud'), action, { ...e, ip: clientIp(request) });
  try {
    const sealed = await adminAuditLog().append((head) => sealAuditRow(row, head));
    console.log(JSON.stringify({ type: 'audit_event', ...sealed }));
  } catch (err) {
    console.error(JSON.stringify({ type: 'audit_write_failed', action, error: String(err) }));
  }
}

export type AuditRow = Awaited<ReturnType<typeof listAudit>>[number];

/**
 * Newest first, `limit` at a time; `group` filters by action prefix. `before` and `beforeId` page
 * back from a row: several events can share a millisecond, so the id settles their order and the
 * next page starts exactly after that row. `before` alone, from a link made before ids were part
 * of the cursor, starts at the next older millisecond. With `after` (a `seq`), sealed events after
 * it, oldest first: the cursor an export or a SIEM pulls by.
 */
export async function listAudit(
  f: {
    group?: AuditGroup;
    before?: number;
    beforeId?: string;
    after?: number;
    limit?: number;
  } = {},
) {
  const rows = await adminAuditLog().list({
    ...f,
    limit: Math.min(Math.max(f.limit ?? 100, 1), 500),
  });
  return rows.map((r) => ({
    ...r,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}

/** Sealed events checked per call; `next` continues from where one stopped. */
const VERIFY_BATCH = 2000;

/**
 * Checks from just after `after` (a sequence), or the oldest event still kept.
 * `next` continues a full verification batch.
 */
export async function verifyAudit(after?: number) {
  const log = adminAuditLog();
  const anchor = after === undefined ? undefined : await log.link(after);
  if (after !== undefined && !anchor?.hash)
    return { ok: false as const, checked: 0, brokenAt: after, reason: `no event ${after}` };
  const rows = await log.sealedAfter(after, VERIFY_BATCH);
  const check = await verifyAuditChain(rows, anchor);
  const next = check.ok && rows.length === VERIFY_BATCH ? check.last?.seq : undefined;
  return { ...check, ...(next ? { next } : {}) };
}
