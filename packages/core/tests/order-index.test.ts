import { describe, expect, it } from 'vitest';
import { EMPTY_ORDER_STATE, type OrderState, orderIndexRow } from '../src';

const order = { id: 'o1', total: 42, title: 'Order', customerId: 'cus_1' } as OrderState['order'];
const flow = {
  nodes: [
    { id: 'approve', label: 'Manager approval', type: 'control.approval' },
    { id: 'pause', label: 'Cool off', type: 'control.wait' },
    { id: 'oos', label: 'Out of stock', type: 'control.end' },
  ],
} as never;

const state = (over: Partial<OrderState>) =>
  ({ ...EMPTY_ORDER_STATE, orderId: 'o1', order, ...over }) as OrderState & {
    order: NonNullable<OrderState['order']>;
  };

describe('the orders index row', () => {
  it("reads what an order waits on: a person's approval, by step label", () => {
    const row = orderIndexRow(
      state({
        status: 'waiting',
        waits: [
          {
            kind: 'approval',
            nodeId: 'approve',
            eventType: 'approval:approve#1',
            title: 'Approve the order',
            assignee: 'manager',
            since: 1_000,
            deadline: 5_000,
          } as never,
        ],
      }),
      flow,
    );
    expect(row).toMatchObject({
      status: 'waiting',
      total: 42,
      waitingOn: 'Approve the order',
      waitingAt: 'Manager approval',
      waitingSince: 1_000,
      waitingDue: 5_000,
      waitingFor: 'person:manager',
      stoppedAt: null,
      reason: null,
    });
  });

  it('reads a timer, which has no deadline', () => {
    const row = orderIndexRow(
      state({
        status: 'waiting',
        nodes: { pause: { status: 'waiting', runs: 1, startedAt: 7 } } as never,
      }),
      flow,
    );
    expect(row).toMatchObject({
      waitingAt: 'Cool off',
      waitingSince: 7,
      waitingDue: null,
      waitingFor: 'timer',
    });
  });

  it('names where an order that ended badly stopped, and caps its reason', () => {
    const row = orderIndexRow(
      state({
        status: 'rolled_back',
        reason: 'Supplier cost: Failed query: select * from products',
        nodes: { oos: { status: 'succeeded', runs: 1 } } as never,
      }),
      flow,
    );
    expect(row).toMatchObject({
      stoppedAt: 'Out of stock',
      reason: 'Database error at Supplier cost',
    });
  });
});
