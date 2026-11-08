/**
 * The behaviour every `OrderRecords` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Order ids start `oc_`, which the D1 runner clears and seeds.
 */
import type { OrderIndexRow } from '@commerceworker/core';
import type { NodeRunRecord, OrderRecords } from '@commerceworker/ports/commerce';
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
      await r.index('oc_order', row);
      expect(await r.indexed('oc_order')).toEqual(row);
      await r.index('oc_order', { ...row, status: 'completed', waitingOn: null });
      expect(await r.indexed('oc_order')).toMatchObject({ status: 'completed', waitingOn: null });
      await r.index('oc_never', row);
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
