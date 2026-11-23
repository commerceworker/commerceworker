/**
 * Privacy requests from the admin: exporting what's held about one person, erasing them, and the
 * requests answered so far. The REST API's `/api/v1/data-subjects/*` (api.server.ts) and these
 * reach the same engine calls and write the same audit events, naming the person only by a hash
 * of their address (`subjectTarget`).
 */
import { type AuditActor, type ErasureResult, subjectTarget } from '@commerceworker/core';
import { audit, listAudit } from './audit.server';
import { engine } from './env.server';

type Counts = Omit<Extract<ErasureResult, { ok: true }>, 'ok' | 'done' | 'teamMember'>;

/** Everything held about the person, as the file the admin downloads; audited. */
export async function exportSubject(request: Request, me: AuditActor, email: string) {
  const data = await engine().exportDataSubject(email);
  await audit(request, 'personal_data.exported', {
    actor: me,
    target: await subjectTarget(email),
    detail: { orders: data.orders.length, customers: data.customers.length, via: 'app' },
  });
  return data;
}

/**
 * Erases the person, one round of up to 100 orders, as one REST call does, and audits it. A round
 * that leaves orders asks to be run again (`done: false`), so each request erases and audits one
 * round: no more is ever erased unrecorded than a REST call could. Refused while any of their orders
 * is running; a round can find one partway, after erasing others: the refusal then says what it
 * erased (`erased`), which is recorded as any round is.
 */
export async function eraseSubject(
  request: Request,
  me: AuditActor,
  email: string,
): Promise<
  | { ok: true; done: boolean; teamMember: boolean; counts: Counts }
  | { ok: false; orders: string[]; erased: Counts | null }
> {
  const r = await engine().eraseDataSubject(email);
  if (!r.ok) {
    if (r.erased)
      await audit(request, 'personal_data.erased', {
        actor: me,
        target: await subjectTarget(email),
        detail: { ...r.erased, done: false, stopped: 'active_orders', via: 'app' },
      });
    return { ok: false, orders: r.orders, erased: r.erased ?? null };
  }
  const { ok: _ok, done, teamMember, ...counts } = r;
  await audit(request, 'personal_data.erased', {
    actor: me,
    target: await subjectTarget(email),
    detail: { ...counts, done, teamMember, via: 'app' },
  });
  return { ok: true, done, teamMember, counts };
}

/** The privacy requests answered lately, newest first: who, what, when, and the counts. */
export async function recentRequests(limit = 25) {
  return (await listAudit({ group: 'personal_data', limit })).map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    actor: r.actor,
    target: r.target,
    detail: r.detail,
  }));
}
