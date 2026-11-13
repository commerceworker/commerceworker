/**
 * Erasing again after a restore (`replay_erasures`, the same tool over MCP and REST): a restore
 * brings back people erased after its point, and the audit log names them only by a hash. The
 * replay hashes the addresses the stores hold to find them, in the database's audit log or, when
 * the restore rolled that back too, in the R2 copies of it (`audit/chain/`).
 */
import { env } from 'cloudflare:workers';
import {
  auditRow,
  operationCall,
  type Role,
  type RpcActor,
  STEP_UP_NEEDED,
  sealAuditRow,
  subjectTarget,
} from '@commerceworker/core';
import { auditEvents, createDb, customers, orders } from '@commerceworker/db';
import { and, eq, like, lt } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EngineApi } from '../src/api';
import { previewAction } from '../src/assistant/data';
import { ensureTemplates } from '../src/flows';
import { copyAuditEvents } from '../src/retention';
import { auditLog, subjectStore } from '../src/wire';
import { signedActor } from './principal';

const db = () => createDb(env.DB);
const api = () => new EngineApi({ waitUntil() {}, passThroughOnException() {} } as never, env);
const actor = (role: Role, person?: true): RpcActor =>
  ({
    kind: 'staff',
    id: `usr_replay_${role}`,
    name: `${role}@example.com`,
    role,
    person,
  }) as RpcActor;
const run = async (input: unknown, who: RpcActor) =>
  api().runOperation(
    'replay_erasures',
    input,
    await signedActor(who, await operationCall('replay_erasures', input)),
  );

/** The restore point, and the erasure after it (both long before the orders' own clock). */
const SINCE = 1_000;
const ERASED_AT = 5_000;

beforeAll(async () => {
  await ensureTemplates(env);
});

afterEach(async () => {
  // Only the erasures a test wrote, long ago: the trail keeps what is younger than 90 days.
  await db().delete(auditEvents).where(lt(auditEvents.at, 100_000));
  await db().delete(orders).where(like(orders.id, 'ord_replay_%'));
  await db().delete(customers).where(like(customers.id, 'cus_replay_%'));
  const listed = await env.DOCS.list({ prefix: 'audit/chain/' });
  // The locked prefix isn't enforced by the local bucket.
  if (listed.objects.length) await env.DOCS.delete(listed.objects.map((o) => o.key));
});

/** Rita is held again, as a restore brings her back: an account, an order and its file. */
async function restored(email: string, id: string) {
  await db()
    .insert(customers)
    .values({ id: `cus_replay_${id}`, name: `${id} Example Ltd`, email: email.toUpperCase() });
  await db()
    .insert(orders)
    .values({
      id: `ord_replay_${id}`,
      model: 'b2b',
      status: 'completed',
      contactEmail: email,
      customerId: `cus_replay_${id}`,
      flowId: 'tpl-b2b-order',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    });
  await env.DOCS.put(`orders/ord_replay_${id}/invoice.html`, 'Rita Example, 1 Dock Rd');
}

/** The erasure as the web app's REST handler records it. */
const erased = async (email: string, at = ERASED_AT) => {
  const row = auditRow(
    'aud_replay',
    'personal_data.erased',
    { target: await subjectTarget(email) },
    at,
  );
  await auditLog(env).append((head) => sealAuditRow(row, head));
};
const audited = async (action: string, target?: string) =>
  db()
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.action, action), target ? eq(auditEvents.target, target) : undefined),
    );

describe('replaying erasures after a restore', () => {
  it('erases again who was erased since the restore point, then finds nobody left', async () => {
    await restored('rita@example.com', 'rita');
    await erased('rita@example.com');
    const r = await run({ since: SINCE }, actor('admin'));
    expect(r).toMatchObject({
      ok: true,
      value: {
        events: { total: 1, database: 1, archive: 0 },
        blocked: [],
        erased: [{ recorded: true, orders: 1, customers: 1, documents: 1 }],
      },
    });
    expect(await env.DOCS.head('orders/ord_replay_rita/invoice.html')).toBeNull();
    expect(
      (await db().select().from(orders).where(eq(orders.id, 'ord_replay_rita')).get())?.erasedAt,
    ).not.toBeNull();
    expect((await subjectStore(env).subject('rita@example.com')).accounts).toEqual([]);
    // Audited once as a replay, naming nobody; her own erasure was already in the log.
    const rita = await subjectTarget('rita@example.com');
    const replayed = await audited('personal_data.erasure_replayed');
    expect(replayed.at(-1)?.detail).toContain('"people":1');
    expect(JSON.stringify(replayed)).not.toMatch(/rita/i);
    expect(await audited('personal_data.erased', rita)).toHaveLength(1);

    const again = await run({ since: SINCE }, actor('admin'));
    expect(again).toMatchObject({
      ok: true,
      value: { erased: [], clean: [await subjectTarget('rita@example.com')] },
    });
  });

  it('reads the R2 copies when the restore took the erasure from the database too', async () => {
    await restored('rita@example.com', 'rita');
    await erased('rita@example.com');
    expect(await copyAuditEvents(env)).toBeGreaterThan(0);
    // The restore: the database's log goes back to before the erasure.
    await db().delete(auditEvents).where(lt(auditEvents.at, 100_000));
    const r = await run({ since: SINCE }, actor('admin'));
    expect(r).toMatchObject({
      ok: true,
      value: { events: { total: 1, database: 0, archive: 1 }, erased: [{ recorded: false }] },
    });
    // Recorded again, so `wasErased` finds her as it did before the restore.
    expect(await subjectStore(env).wasErased(await subjectTarget('rita@example.com'))).toBe(true);
    const [again] = await audited('personal_data.erased', await subjectTarget('rita@example.com'));
    expect(again?.detail).toContain('"replayed":true');
  });

  it('empties the files of an order marked erased that a restore of the bucket brought back', async () => {
    // Marked erased and nobody's address any more, as the retention sweep leaves an order.
    await db().insert(orders).values({
      id: 'ord_replay_swept',
      model: 'b2b',
      status: 'completed',
      contactEmail: null,
      flowId: 'tpl-b2b-order',
      flowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
      erasedAt: ERASED_AT,
    });
    await env.DOCS.put('orders/ord_replay_swept/inbound/po.txt', 'Rita Example, 1 Dock Rd');
    const dry = await run({ since: SINCE, dryRun: true }, actor('admin'));
    expect(dry).toMatchObject({ ok: true, value: { orders: { checked: 1, documents: 0 } } });
    expect(await env.DOCS.head('orders/ord_replay_swept/inbound/po.txt')).not.toBeNull();
    const r = await run({ since: SINCE }, actor('admin'));
    expect(r).toMatchObject({
      ok: true,
      value: { orders: { checked: 1, erased: 0, documents: 1, running: [] } },
    });
    expect(await env.DOCS.head('orders/ord_replay_swept/inbound/po.txt')).toBeNull();
    // Before the restore point it is left alone.
    expect(await run({ since: ERASED_AT + 1 }, actor('admin'))).toMatchObject({
      value: { orders: { checked: 0 } },
    });
  });

  it('with dryRun changes nothing, and reaches a person with a step-up only for the real run', async () => {
    await restored('rita@example.com', 'rita');
    await erased('rita@example.com');
    const dry = await run({ since: SINCE, dryRun: true }, actor('admin', true));
    expect(dry).toMatchObject({ ok: true, value: { dryRun: true, erased: [{ orders: 1 }] } });
    expect(await env.DOCS.head('orders/ord_replay_rita/invoice.html')).not.toBeNull();
    const replays = (await audited('personal_data.erasure_replayed')).length;
    // A person's real run needs a step-up, which REST cannot give; nothing was erased.
    expect(await run({ since: SINCE }, actor('admin', true))).toEqual({
      ok: false,
      error: STEP_UP_NEEDED,
    });
    expect(await env.DOCS.head('orders/ord_replay_rita/invoice.html')).not.toBeNull();
    expect(await audited('personal_data.erasure_replayed')).toHaveLength(replays);
    // An admin's API token may run it (a restore runbook's call).
    expect(await run({ since: SINCE }, actor('admin'))).toMatchObject({ ok: true });
  });

  it('shows a person’s card as needing a step-up, and a token’s not', async () => {
    const input = { since: SINCE };
    const person = { kind: 'user' as const, id: 'usr_a', name: 'Ann', role: 'admin' as const };
    const token = { kind: 'token' as const, id: 'tok_a', name: 'Ops', role: 'admin' as const };
    expect(await previewAction(env, person, 'replay_erasures', input)).toMatchObject({
      title: expect.stringContaining('Erase again everyone erased since'),
      stepUp: true,
    });
    expect(await previewAction(env, token, 'replay_erasures', input)).not.toHaveProperty('stepUp');
    expect(
      await previewAction(env, token, 'replay_erasures', { since: Date.now() + 86_400_000 }),
    ).toMatchObject({ blocked: 'That time has not come yet.' });
  });

  it('is an admin’s, takes a restore point, and refuses a time that has not come', async () => {
    for (const role of ['viewer', 'operator'] as const)
      expect(await run({ since: SINCE }, actor(role))).toEqual({
        ok: false,
        error: 'This needs the Admin role.',
      });
    expect(await run({}, actor('admin'))).toMatchObject({ ok: false, status: 400 });
    expect(await run({ since: Date.now() + 86_400_000 }, actor('admin'))).toEqual({
      ok: false,
      error: 'That time has not come yet.',
    });
  });
});
