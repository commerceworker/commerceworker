/**
 * The behaviour every `OrderRecords` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Order ids start `oc_`, which the D1 runner clears and seeds.
 */
import type { OrderIndexRow } from '@commerceworker/core';
import type { NewOrderRow, NodeRunRecord, OrderRecords } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { OrderRecordsFixture } from './order-records';

export const ORDER_RECORDS_FIXTURE: OrderRecordsFixture = {
  orders: ['oc_order', 'oc_by_ada'],
  startedBy: { oc_by_ada: 'usr_ada' },
  channels: { oc_by_ada: 'email' },
};

const row: OrderIndexRow = {
  status: 'waiting',
  total: 42,
  fxRate: 1,
  customerId: 'cus_1',
  title: 'Order',
  instanceId: 'wf_1',
  generation: 1,
  waitingOn: 'Manager approval',
  waitingAt: 'Approve',
  waitingSince: 1_000,
  waitingDue: 2_000,
  waitingFor: 'person:manager',
  stoppedAt: null,
  reason: null,
};

const run = (nodeId: string, over: Partial<NodeRunRecord> = {}): NodeRunRecord => ({
  orderId: 'oc_order',
  generation: 1,
  nodeId,
  run: 1,
  nodeType: 'commerce.reserve',
  model: 'b2b',
  status: 'succeeded',
  startedAt: 100,
  endedAt: 150,
  ...over,
});

export function describeOrderRecordsContract(
  name: string,
  make: (fixture: OrderRecordsFixture) => Promise<OrderRecords>,
) {
  describe(`${name}: the order records contract`, () => {
    const fresh = () => make(ORDER_RECORDS_FIXTURE);

    it("writes a started order's index row, and none for an order that hasn't started", async () => {
      const r = await fresh();
      expect(await r.index('oc_order', row)).toBe(true);
      expect(await r.indexed('oc_order')).toEqual(row);
      await r.index('oc_order', { ...row, status: 'completed', waitingOn: null });
      expect(await r.indexed('oc_order')).toMatchObject({ status: 'completed', waitingOn: null });
      // Nothing was written, and the caller is told: a missing row is data loss, not a no-op.
      expect(await r.index('oc_never', row)).toBe(false);
      expect(await r.indexed('oc_never')).toBeUndefined();
    });

    it('says who started an order: a person, nobody (a channel), or no such order', async () => {
      const r = await fresh();
      expect(await r.startedBy('oc_by_ada')).toBe('usr_ada');
      expect(await r.startedBy('oc_order')).toBeNull();
      expect(await r.startedBy('oc_never')).toBeUndefined();
    });

    it('says which channel an order came in on, or none for no such order', async () => {
      const r = await fresh();
      expect(await r.channel('oc_by_ada')).toBe('email');
      expect(await r.channel('oc_order')).toBe('api');
      expect(await r.channel('oc_never')).toBeUndefined();
    });

    it('starts an order once per idempotency key, and finds it by the key', async () => {
      const r = await fresh();
      const start = {
        id: 'oc_new',
        model: 'b2b',
        channel: 'api',
        externalId: null,
        contactEmail: null,
        title: 'New',
        flowId: 'oc_flow',
        flowVersion: 2,
        instanceId: 'oc_wf',
        customerId: null,
        currency: 'USD',
        createdAt: 7,
        idempotencyKey: 'oc_key',
        idempotencyFingerprint: 'fp',
        startedBy: 'usr_ada',
      };
      expect(await r.exists('oc_new')).toBe(false);
      await r.create(start);
      expect(await r.exists('oc_new')).toBe(true);
      expect(await r.startedBy('oc_new')).toBe('usr_ada');
      expect(await r.byIdempotencyKey('oc_key')).toEqual({
        id: 'oc_new',
        status: 'queued',
        flowId: 'oc_flow',
        flowVersion: 2,
        instanceId: 'oc_wf',
        createdAt: 7,
        fingerprint: 'fp',
      });
      await expect(r.create({ ...start, id: 'oc_new2' })).rejects.toThrow();
      expect(await r.byIdempotencyKey('oc_none')).toBeUndefined();
    });

    it('fails an order whose start never got a Workflow, once, and only without a key', async () => {
      const r = await fresh();
      const start = (id: string, over: Partial<NewOrderRow> = {}) =>
        r.create({
          id,
          model: 'b2b',
          channel: 'api',
          externalId: null,
          contactEmail: null,
          title: 'Stale',
          flowId: 'flow_1',
          flowVersion: 1,
          instanceId: `${id}-g1`,
          customerId: null,
          currency: 'USD',
          createdAt: 1_000,
          idempotencyKey: null,
          idempotencyFingerprint: null,
          startedBy: null,
          ...over,
        });
      await start('oc_stale_old');
      await start('oc_stale_new', { createdAt: 9_000 });
      await start('oc_stale_keyed', {
        idempotencyKey: 'oc-stale-key',
        idempotencyFingerprint: 'f',
      });
      const ids = async (before: number) =>
        (await r.staleQueued(before, 50))
          .filter((o) => o.id.startsWith('oc_stale_'))
          .map((o) => o.id);

      // Older than the cutoff, queued and unkeyed: not the newer one, not the keyed one.
      expect(await ids(5_000)).toEqual(['oc_stale_old']);
      expect(await r.staleQueued(5_000, 50)).toContainEqual({
        id: 'oc_stale_old',
        instanceId: 'oc_stale_old-g1',
      });
      expect(await r.failQueued('oc_stale_old', 'It never started.')).toBe(true);
      expect(await r.failQueued('oc_stale_old', 'It never started.')).toBe(false);
      expect(await r.indexed('oc_stale_old')).toMatchObject({
        status: 'failed',
        reason: 'It never started.',
      });
      expect(await ids(5_000)).toEqual([]);
      // An order that moved on is not failed.
      await r.index('oc_stale_new', { ...row, status: 'running', waitingOn: null });
      expect(await r.failQueued('oc_stale_new', 'No.')).toBe(false);
      expect(await r.failQueued('oc_none', 'No.')).toBe(false);
    });

    it('records each run once', async () => {
      const r = await fresh();
      await r.recordRun(run('reserve'));
      await r.recordRun(run('reserve', { endedAt: 999 }));
      await r.recordRun(run('reserve', { run: 2, status: 'failed' }));
      await r.recordRun(run('approve', { generation: 2 }));
      expect(
        (await r.runs('oc_order')).map((x) => [x.generation, x.nodeId, x.run, x.endedAt]),
      ).toEqual([
        [1, 'reserve', 1, 150],
        [1, 'reserve', 2, 150],
        [2, 'approve', 1, 150],
      ]);
    });

    it('keeps who may vote with the approval, and defaults it to any one staff approver', async () => {
      const r = await fresh();
      const base = {
        orderId: 'oc_order',
        nodeId: 'approve',
        title: 'Approve',
        assignee: 'manager',
        amount: 1,
      };
      await r.openApproval({ ...base, id: 'oc_plain', eventType: 'approval:approve#1' });
      await r.openApproval({
        ...base,
        id: 'oc_company',
        eventType: 'approval:approve#2',
        companyId: 'cus_co',
        approvers: 'company:approver',
        mode: 'quorum',
        required: 2,
        eligible: ['mem_a', 'mem_b', 'mem_c'],
      });
      expect(
        (await r.approvals('oc_order')).map((a) => [
          a.companyId,
          a.approvers,
          a.mode,
          a.required,
          a.eligible,
        ]),
      ).toEqual([
        [null, 'staff:approver', 'any', 1, null],
        ['cus_co', 'company:approver', 'quorum', 2, ['mem_a', 'mem_b', 'mem_c']],
      ]);
    });

    it('records a vote once per voter on a wait, and reads them oldest first', async () => {
      const r = await fresh();
      await r.openApproval({
        id: 'oc_v1',
        orderId: 'oc_order',
        nodeId: 'approve',
        eventType: 'approval:approve#1',
        title: 'Approve',
        assignee: 'manager',
        amount: 1,
      });
      const vote = (voterId: string, decision: 'approved' | 'rejected', at: number) => ({
        voterId,
        voterKind: 'member' as const,
        onBehalfBy: 'usr_ada',
        decision,
        note: null,
        at,
      });
      expect(
        await r.recordVote('oc_order', 'approval:approve#1', vote('mem_b', 'approved', 20)),
      ).toBe(true);
      expect(
        await r.recordVote('oc_order', 'approval:approve#1', vote('mem_a', 'approved', 10)),
      ).toBe(true);
      // The same voter again, even with another decision: the first vote stays.
      expect(
        await r.recordVote('oc_order', 'approval:approve#1', vote('mem_b', 'rejected', 30)),
      ).toBe(false);
      // A wait with no approval has nowhere to put a vote.
      expect(await r.recordVote('oc_order', 'approval:gone#1', vote('mem_a', 'approved', 1))).toBe(
        false,
      );
      expect(
        (await r.votes('oc_order', 'approval:approve#1')).map((v) => [
          v.approvalId,
          v.voterId,
          v.voterKind,
          v.onBehalfBy,
          v.decision,
        ]),
      ).toEqual([
        ['oc_v1', 'mem_a', 'member', 'usr_ada', 'approved'],
        ['oc_v1', 'mem_b', 'member', 'usr_ada', 'approved'],
      ]);
      expect(await r.votes('oc_order', 'approval:gone#1')).toEqual([]);
    });

    it('opens an approval once per wait, records the decision, and cancels what is pending', async () => {
      const r = await fresh();
      const open = (id: string, eventType: string) =>
        r.openApproval({
          id,
          orderId: 'oc_order',
          nodeId: 'approve',
          eventType,
          title: 'Manager approval',
          assignee: 'manager',
          amount: 42,
        });
      await open('oc_apr_1', 'approval:approve#1');
      await open('oc_apr_dup', 'approval:approve#1');
      await open('oc_apr_2', 'approval:approve#2');
      await r.decideApproval('oc_order', 'approval:approve#1', {
        status: 'approved',
        decidedBy: 'usr_ada',
        note: 'ok',
      });
      await r.cancelApprovals('oc_order');
      expect(
        (await r.approvals('oc_order')).map((a) => [
          a.id,
          a.status,
          a.decidedBy,
          a.note,
          !!a.decidedAt,
        ]),
      ).toEqual([
        ['oc_apr_1', 'approved', 'usr_ada', 'ok', true],
        ['oc_apr_2', 'cancelled', null, null, true],
      ]);
    });
  });
}
