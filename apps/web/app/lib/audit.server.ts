/**
 * The audit log: who signed in or failed to, who changed the team or its tokens, and who did what
 * to orders, approvals, flows and webhooks (the engine writes the same rows for what the
 * assistant, MCP, A2A and the order page's socket do). Each event is sealed into the hash chain
 * (`appendAudit`) and logged as one JSON line, `{"type":"audit_event",…}`, which Logpush can carry
 * to a SIEM. Writing never throws, so a logging problem can't block the action it records; a
 * failure is logged as `{"type":"audit_write_failed",…}` to alert on. The engine's daily sweep
 * archives and prunes old events. The vocabulary is `audit.ts`.
 */

import { listAuditEvents, verifyAuditTrail } from '@commerceworker/application/commerce';
import {
  type AuditActor,
  auditRow,
  newId,
  type Principal,
  sealAuditRow,
} from '@commerceworker/core';
import type { AuditAction, AuditGroup } from './audit';
import { auditLog } from './wire.server';

export const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'local';

/** Who acted, as the audit trail names them. */
export const actorName = (p: Principal) => p.email ?? p.name;

export async function audit(
  request: Request,
  action: AuditAction,
  e: { actor?: AuditActor | null; target?: string | null; detail?: Record<string, unknown> } = {},
) {
  // An OAuth app's request is named by its grant and client, as MCP's actions are.
  const detail = e.actor?.grant
    ? {
        ...e.detail,
        grant: e.actor.grant,
        ...(e.actor.client ? { client: e.actor.client } : {}),
      }
    : e.detail;
  const row = auditRow(newId('aud'), action, { ...e, detail, ip: clientIp(request) });
  try {
    const sealed = await auditLog().append((head) => sealAuditRow(row, head));
    console.log(JSON.stringify({ type: 'audit_event', ...sealed }));
  } catch (err) {
    console.error(JSON.stringify({ type: 'audit_write_failed', action, error: String(err) }));
  }
}

export type AuditRow = Awaited<ReturnType<typeof listAudit>>[number];

/** The audit use-cases (`listAuditEvents`, `verifyAuditTrail`) over the app's log. */
export const listAudit = (
  f: { group?: AuditGroup; before?: number; after?: number; limit?: number } = {},
) => listAuditEvents({ audit: auditLog() }, f);

export const verifyAudit = (after?: number) => verifyAuditTrail({ audit: auditLog() }, after);
