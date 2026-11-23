/**
 * Privacy requests from the admin: exporting what's held about one person, erasing them, and the
 * requests answered so far. The REST API's `/api/v1/data-subjects/*` (api.server.ts) and these
 * reach the same engine calls and write the same audit events, naming the person only by a hash
 * of their address (`subjectTarget`).
 */
import { type AuditActor, type ErasureResult, subjectTarget } from '@commerceworker/core';
import { audit, listAudit } from './audit.server';
import { engine } from './env.server';

/** How many rounds of 100 orders one erase from the screen runs before asking to go on. */
export const ERASE_ROUNDS = 20;

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
 * Erases the person, a round of 100 orders at a time until none are left or `ERASE_ROUNDS` have
 * run, and audits each round as REST does. Refused (and nothing erased) while any of their orders
 * is still running.
 */
export async function eraseSubject(
  request: Request,
  me: AuditActor,
  email: string,
): Promise<
  { ok: true; done: boolean; teamMember: boolean; counts: Counts } | { ok: false; orders: string[] }
> {
  const target = await subjectTarget(email);
  let total: Counts | null = null;
  let teamMember = false;
  for (let round = 0; round < ERASE_ROUNDS; round++) {
    const r = await engine().eraseDataSubject(email);
    if (!r.ok) {
      if (!total) return { ok: false, orders: r.orders };
      // An order started between rounds: what ran stays erased; the rest waits for it.
      return { ok: true, done: false, teamMember, counts: total };
    }
    const { ok: _ok, done, teamMember: member, ...counts } = r;
    await audit(request, 'personal_data.erased', {
      actor: me,
      target,
      detail: { ...counts, done, teamMember: member, via: 'app' },
    });
    teamMember ||= member;
    total = total ? add(total, counts) : counts;
    if (done) return { ok: true, done: true, teamMember, counts: total };
  }
  return { ok: true, done: false, teamMember, counts: total! };
}

const add = (a: Counts, b: Counts): Counts =>
  Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, v + (b[k as keyof Counts] ?? 0)]),
  ) as Counts;

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
