/**
 * Erasing again, after a restore (`replay_erasures`, REST's twin: `POST /api/v1/erasures/replay`).
 * A restore brings back people erased after its point; this runs each erasure the audit log
 * recorded since then against what is stored now (`replayErasures`, @commerceworker/application).
 * The card is the dry run: who is held, who is left alone. Running it is idempotent, and records
 * what it did: each person whose erasure a restore dropped from the database's log is recorded
 * again (`wasErased` reads it), and one summary for the run. A person proves it's them
 * (`stepUpNeeded`); an admin's API token may run it, as a runbook does.
 */

import {
  type ActionPreview,
  boundText,
  type Principal,
  type ToolInput,
} from '@commerceworker/core';
import { recordAudit } from '../audit';
import { replayErasures } from '../subjects';
import { stepUpNeeded } from './admin';
import { Refused } from './data';

type Trail = Record<string, unknown>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/** A restore point in the future erases nobody: refuse it before reading anything. */
const future = (since: number) => (since > Date.now() ? 'That time has not come yet.' : undefined);

export async function previewReplayErasures(
  env: Env,
  p: Principal,
  i: ToolInput<'replay_erasures'>,
  roleBlock?: string,
): Promise<ActionPreview> {
  const title = `Erase again everyone erased since ${day(i.since)} UTC`;
  const block = roleBlock ?? future(i.since);
  if (block) return { title, consequences: [], blocked: block };
  // The dry run is the preview: nothing is erased to show it.
  const r = await replayErasures(env, { since: i.since, dryRun: true });
  const orders = r.erased.reduce((n, e) => n + e.orders, 0);
  return {
    title,
    consequences: [
      `${plural(r.events.total, 'person')} erased since then, read from the audit log${r.events.archive ? ` (${r.events.archive} only in its R2 copies: a restore dropped them from the database)` : ''}`,
      r.erased.length
        ? `${plural(r.erased.length, 'person')} still held in the stores (${plural(orders, 'order')}): their orders, accounts, documents and messages are erased again, as the first erasure did`
        : 'Nobody is held in the stores: nothing to erase',
      `Of ${plural(r.orders.checked, 'order')} already marked erased since, ${r.orders.erased} hold in their agent what an erasure removes and are erased again; their files are deleted again${r.orders.running.length ? `; ${plural(r.orders.running.length, 'order')} running again wait until they end` : ''}`,
      ...(r.blocked.length
        ? [
            `${plural(r.blocked.length, 'person')} left alone: orders still running, or ordered again since they were erased`,
          ]
        : []),
      'Running it again changes nothing',
    ],
    ...((await stepUpNeeded(env, p, 'replay_erasures', i)) ? { stepUp: true as const } : {}),
  };
}

export async function runReplayErasures(
  env: Env,
  p: Principal,
  i: ToolInput<'replay_erasures'>,
  trail: Trail,
) {
  const early = future(i.since);
  if (early) throw new Refused(early);
  const r = await replayErasures(env, i);
  if (i.dryRun)
    return {
      done: `Dry run: ${plural(r.erased.length, 'person')} and ${plural(r.orders.erased, 'order')} would be erased again; nothing was`,
      ...r,
    };
  // A restore may have dropped the erasure from the database's audit log: record it again, so
  // `wasErased` finds it as it did, and the log says this run did it.
  for (const e of r.erased)
    if (!e.recorded) {
      const { target, at: _at, recorded: _r, done: _d, ...counts } = e;
      await recordAudit(env, 'personal_data.erased', {
        actor: p,
        target,
        detail: { ...counts, ...trail, replayed: true },
      });
    }
  await recordAudit(env, 'personal_data.erasure_replayed', {
    actor: p,
    detail: {
      since: i.since,
      people: r.erased.length,
      orders: r.erased.reduce((n, e) => n + e.orders, 0),
      blocked: r.blocked.length,
      clean: r.clean.length,
      ordersChecked: r.orders.checked,
      ordersErased: r.orders.erased,
      documents: r.orders.documents,
      ...trail,
    },
  });
  return {
    done: `${plural(r.erased.length, 'person')} and ${plural(r.orders.erased, 'order')} erased again${r.blocked.length ? `; ${plural(r.blocked.length, 'person')} left alone (${boundText(r.blocked.map((b) => b.reason).join(', '), 80)})` : ''}`,
    ...r,
  };
}
