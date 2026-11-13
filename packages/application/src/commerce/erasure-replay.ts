/**
 * Replays the erasures a restore undid. A restore (D1 Time Travel, a promoted backup, a Durable
 * Object or object restore, a KV import) brings back people who were erased after its point, and
 * nothing else erases them again. Every erasure is audited (`personal_data.erased`), but only by a
 * hash of the address (`subjectTarget`), so the log itself keeps nothing to erase. This reads the
 * erasures recorded since a time, from the database's audit log and from the R2 copies of it (a
 * restore can roll the database's log back too), hashes the addresses the stores hold to find who
 * they were, and erases each again with `eraseDataSubject`. A restore of an order's agent or of the
 * documents bucket leaves the D1 index as it is (the order still reads erased) and brings back its
 * state or files, which no address finds: the orders marked erased since are checked directly.
 * Erasing is idempotent, so a second run finds nobody left. Time comes in as `since`.
 */

import {
  type ErasureCounts,
  type ErasureReplay,
  eraseOrderState,
  subjectEmail,
  subjectTarget,
} from '@commerceworker/core';
import type { AuditArchive, AuditLog } from '@commerceworker/ports/commerce';
import { ERASE_BATCH, eraseDataSubject, type SubjectPorts } from './subjects';

/** Audit events read a page at a time. */
const AUDIT_PAGE = 500;
/** Addresses read from the stores a page at a time. */
const ADDRESS_PAGE = 500;
/** Addresses one replay hashes before it stops looking, and says so. */
export const REPLAY_SCAN_MAX = 500_000;
/** Orders read to see whether a person ordered again after their erasure. */
const RETURNED_CHECK = 1000;
/** Orders marked erased since the restore point one replay looks at. */
export const REPLAY_ORDERS_MAX = 2000;
/** Batches of one person's orders one replay erases (`ERASE_BATCH` each) before it says `done: false`. */
export const REPLAY_ROUNDS = 20;

export type ReplayPorts = SubjectPorts & {
  readonly audit: AuditLog;
  readonly archive: AuditArchive;
};

/**
 * What a copy of the data can't know: people erased after it was made are in it. Written into the
 * evidence of the restore drill and the report of an objects restore, so whoever restores or
 * promotes from one is told the last step.
 */
export const replayReminder = (since: string) =>
  `People erased after ${since} are still in this copy: after restoring or promoting it, run \`node scripts/fleet.ts replay-erasures <id> ${since}\`.`;

type Erased = { target: string; at: number; database: boolean };

/** The people erased since `since`, by their audit target, read from the database and the archive. */
async function erasuresSince(ports: ReplayPorts, since: number) {
  const found = new Map<string, Erased>();
  const note = (row: { at: number; [column: string]: unknown }, from: 'db' | 'r2') => {
    const { action, target } = row;
    if (action !== 'personal_data.erased' || typeof target !== 'string' || row.at < since) return;
    const had = found.get(target);
    found.set(target, {
      target,
      at: Math.min(row.at, had?.at ?? row.at),
      database: (had?.database ?? false) || from === 'db',
    });
  };

  // Newest first, back to `since`. A page ends at a time, and another event at that millisecond
  // would be skipped by `before`, so each page starts one past the last and a repeat is dropped.
  const seen = new Set<string>();
  for (let before: number | undefined; ; ) {
    const page = await ports.audit.list({ group: 'personal_data', before, limit: AUDIT_PAGE });
    const fresh = page.filter((e) => !seen.has(e.id));
    for (const e of fresh) {
      seen.add(e.id);
      note(e, 'db');
    }
    const last = page.at(-1);
    if (!last || !fresh.length || page.length < AUDIT_PAGE || last.at < since) break;
    before = last.at + 1;
  }
  const database = new Set(found.keys());

  // The daily copies: a restore of the database drops its newest events, never these.
  for (const copy of await ports.archive.copies())
    for (const row of await ports.archive.read(copy.key)) note(row, 'r2');

  return {
    erased: [...found.values()].sort((a, b) => a.at - b.at || (a.target < b.target ? -1 : 1)),
    database: database.size,
    archive: found.size - database.size,
  };
}

/**
 * Erases again each person erased since `since` that the stores hold. With `dryRun`, reports who
 * would be erased and erases nobody. A person with orders still running is named in `blocked`;
 * one the stores hold nothing about, in `clean`.
 */
export async function replayErasures(
  ports: ReplayPorts,
  input: { since: number; dryRun?: boolean },
  now: number,
): Promise<ErasureReplay> {
  const { erased, database, archive } = await erasuresSince(ports, input.since);
  const result: ErasureReplay = {
    since: input.since,
    dryRun: !!input.dryRun,
    // `archive` is what only the R2 copies hold: the events a restore took from the database.
    events: { total: erased.length, database, archive },
    scanned: 0,
    erased: [],
    orders: { checked: 0, erased: 0, documents: 0, running: [] },
    blocked: [],
    clean: [],
  };
  if (erased.length) await replayPeople(ports, input, erased, result, now);
  await replayOrders(ports, input, result);
  return result;
}

/** Finds each erased person among the addresses the stores hold, and erases them again. */
async function replayPeople(
  ports: ReplayPorts,
  input: { since: number; dryRun?: boolean },
  erased: Erased[],
  result: ErasureReplay,
  now: number,
) {
  // Who they were: the stores' own addresses, hashed, since the log kept only the hash.
  const wanted = new Map(erased.map((e) => [e.target, e]));
  const matched = new Map<string, string>();
  let cursor: string | null = null;
  while (matched.size < wanted.size && result.scanned < REPLAY_SCAN_MAX) {
    const page: { emails: string[]; next: string | null } = await ports.subjects.addresses(
      cursor,
      ADDRESS_PAGE,
    );
    for (const raw of page.emails) {
      const email = subjectEmail(raw);
      const target = await subjectTarget(email);
      if (wanted.has(target)) matched.set(target, email);
    }
    result.scanned += page.emails.length;
    if (!page.next) break;
    cursor = page.next;
  }

  for (const e of erased) {
    const email = matched.get(e.target);
    if (!email) {
      result.clean.push(e.target);
      continue;
    }
    const entry = { target: e.target, at: e.at, recorded: e.database };
    const s = await ports.subjects.subject(email);
    const theirs = await ports.subjects.orders(s, { limit: RETURNED_CHECK });
    // Ordered again after being erased (in the time between the restore and this replay): that
    // is theirs to keep. Erasing them again is a person's call, made with eraseDataSubject.
    const later = theirs.filter((o) => o.createdAt > e.at).map((o) => o.id);
    if (later.length) {
      result.blocked.push({ target: e.target, reason: 'ordered_since', orders: later });
      continue;
    }
    if (input.dryRun) {
      result.erased.push({
        ...entry,
        ...zero(),
        done: theirs.length <= ERASE_BATCH,
        orders: theirs.length,
        customers: s.accounts.length,
      });
      continue;
    }
    const total = zero();
    let done = false;
    let blocked: string[] | null = null;
    for (let round = 0; round < REPLAY_ROUNDS && !done && !blocked; round++) {
      const r = await eraseDataSubject(ports, email, now);
      if (!r.ok) {
        blocked = r.orders;
        break;
      }
      for (const k of Object.keys(total) as (keyof ErasureCounts)[]) total[k] += r[k];
      done = r.done;
    }
    if (blocked)
      result.blocked.push({ target: e.target, reason: 'active_orders', orders: blocked });
    else result.erased.push({ ...entry, ...total, done });
  }
}

/**
 * The orders marked erased since `since` (`orders.erased_at`, which a restore of an agent or a
 * bucket doesn't touch): an agent whose state still holds what an erasure removes is erased again
 * (an order that has not ended, as a restore can leave it, waits), and `orders/<id>/` is emptied.
 */
async function replayOrders(
  ports: ReplayPorts,
  input: { since: number; dryRun?: boolean },
  result: ErasureReplay,
) {
  const marked = await ports.subjects.erasedOrders(input.since, REPLAY_ORDERS_MAX + 1);
  const list = marked.slice(0, REPLAY_ORDERS_MAX);
  result.orders.checked = list.length;
  // More are left than one replay checks: run again from just after the last one's time.
  if (marked.length > REPLAY_ORDERS_MAX) result.orders.nextSince = list.at(-1)!.at + 1;
  for (const o of list) {
    const state = await ports.orders.snapshot(o.id);
    // Whether the agent holds what an erasure removes (contact, document text, personal meta).
    if (JSON.stringify(eraseOrderState(state, [])) !== JSON.stringify(state)) {
      if (input.dryRun) result.orders.erased++;
      else if (await ports.orders.erasePersonalData(o.id, [])) result.orders.erased++;
      // A restore can leave an order running again: it can be erased once it ends.
      else {
        result.orders.running.push(o.id);
        continue;
      }
    }
    // The files can't be counted without being deleted: a dry run leaves them.
    if (!input.dryRun) result.orders.documents += await ports.files.deletePrefix(`orders/${o.id}/`);
  }
}

const zero = (): ErasureCounts => ({
  orders: 0,
  customers: 0,
  documents: 0,
  messages: 0,
  inboundEmails: 0,
  carts: 0,
  taxCertificates: 0,
  addresses: 0,
  companyMembers: 0,
  purchaseOrders: 0,
  quotes: 0,
  shopperSignIns: 0,
  shopperSessions: 0,
  ucpLinks: 0,
});
