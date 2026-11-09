import { describe, expect, it } from 'vitest';
import {
  approvalWait,
  decisionProblem,
  deliveredEventProblem,
  eventDigest,
  eventProblem,
  eventWait,
  flowAwaits,
  heldFor,
  holdProblem,
  MAX_DECISION_NOTE,
  MAX_EVENT_NAME,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_HELD_EVENTS,
  type PendingWait,
} from '../src';

const waits: PendingWait[] = [
  { nodeId: 'mgr', eventType: 'approval-mgr', kind: 'approval', title: 'Manager', since: 1 },
  {
    nodeId: 'pay',
    eventType: 'event-pay',
    kind: 'event',
    title: 'Paid',
    event: 'payment.received',
    since: 2,
  },
];

describe("resuming an order's waits", () => {
  it('takes an approval or rejection with a short note, and nothing else', () => {
    expect(decisionProblem('approved', undefined)).toBeNull();
    expect(decisionProblem('rejected', 'Over budget')).toBeNull();
    expect(decisionProblem('maybe', undefined)).toBe('decision must be approved or rejected');
    expect(decisionProblem('approved', 'x'.repeat(MAX_DECISION_NOTE))).toBeNull();
    expect(decisionProblem('approved', 'x'.repeat(MAX_DECISION_NOTE + 1))).toMatch(/note/);
    expect(decisionProblem('approved', 42)).toMatch(/note/);
  });

  it('takes a named event with an object payload small enough to keep', () => {
    expect(eventProblem('payment.received', {})).toBeNull();
    expect(eventProblem('', {})).toMatch(/event/);
    expect(eventProblem('x'.repeat(MAX_EVENT_NAME + 1), {})).toMatch(/event/);
    expect(eventProblem(7, {})).toMatch(/event/);
    for (const bad of [null, [], 'text', { big: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) }])
      expect(eventProblem('payment.received', bad)).toMatch(/payload/);
  });

  it('finds the wait each resumes, by kind', () => {
    expect(approvalWait(waits, 'mgr')?.eventType).toBe('approval-mgr');
    // A step waiting for an event is not an approval, and the reverse.
    expect(approvalWait(waits, 'pay')).toBeUndefined();
    expect(eventWait(waits, 'payment.received')?.nodeId).toBe('pay');
    expect(eventWait(waits, 'Manager')).toBeUndefined();
  });
});

describe('a delivered event', () => {
  it('refuses a return and any field its source writes, whoever sends it', () => {
    expect(deliveredEventProblem('payment.received', { amount: 5 })).toBeNull();
    expect(deliveredEventProblem('payment.received', undefined)).toBeNull();
    expect(deliveredEventProblem('return.requested', {})).toMatch(/order page/);
    expect(deliveredEventProblem('x', { by: 'me', source: 'stripe', ok: 1 })).toBe(
      "payload can't set by, source: the delivery records who sent it",
    );
  });
});

describe('the order inbox', () => {
  const flow = {
    nodes: [
      { type: 'trigger.manual', config: {} },
      { type: 'control.wait_event', config: { event: 'goods.received' } },
    ],
  };
  const held = (id: number, event: string, at: number, payload = {}) => ({
    id,
    event,
    payload,
    at,
  });
  const running = { running: true, flowAwaits: true };

  it('holds an event only for a running order whose flow waits for it', () => {
    expect(flowAwaits(flow, 'goods.received')).toBe(true);
    expect(flowAwaits(flow, 'payment.received')).toBe(false);
    expect(flowAwaits(null, 'goods.received')).toBe(false);
    expect(holdProblem([], running, 'goods.received', {})).toBeNull();
    expect(holdProblem([], { running: false, flowAwaits: true }, 'goods.received', {})).toBe(
      'the order has finished',
    );
    expect(holdProblem([], { running: true, flowAwaits: false }, 'x', {})).toBe(
      "no step of this order's flow waits for x",
    );
  });

  it('takes a resend as already held, and holds at most MAX_HELD_EVENTS', () => {
    const one = [held(1, 'seller.responded', 1, { sellerId: 'a' })];
    expect(holdProblem(one, running, 'seller.responded', { sellerId: 'a' })).toBe('already held');
    expect(holdProblem(one, running, 'seller.responded', { sellerId: 'b' })).toBeNull();
    const full = Array.from({ length: MAX_HELD_EVENTS }, (_, i) => held(i, 'e', i, { i }));
    expect(holdProblem(full, running, 'e', { i: 'new' })).toBe(
      `the order already holds ${MAX_HELD_EVENTS} events`,
    );
  });

  it('refuses to hold a resend of an event already delivered, whatever its key order', () => {
    const delivered = new Set([
      eventDigest('seller.responded', { sellerId: 'a', decision: 'accepted' }),
    ]);
    expect(
      holdProblem([], { ...running, delivered }, 'seller.responded', {
        decision: 'accepted',
        sellerId: 'a',
      }),
    ).toBe('already delivered');
    expect(
      holdProblem([], { ...running, delivered }, 'seller.responded', {
        sellerId: 'b',
        decision: 'accepted',
      }),
    ).toBeNull();
  });

  it('gives a retried open the event it already took, never the next one', () => {
    const inbox = [
      { ...held(1, 'seller.responded', 10, { sellerId: 'a' }), takenBy: 'event-w1' },
      held(2, 'seller.responded', 20, { sellerId: 'b' }),
    ];
    const wait = (eventType: string) =>
      ({
        nodeId: 'n',
        eventType,
        kind: 'event',
        title: '',
        event: 'seller.responded',
        since: 0,
      }) as never;
    expect(heldFor(inbox, wait('event-w1'))?.id).toBe(1);
    // Another wait for the same event skips the one already spoken for.
    expect(heldFor(inbox, wait('event-w2'))?.id).toBe(2);
  });

  it('gives a wait that opens the oldest event held for it', () => {
    const inbox = [
      held(3, 'seller.responded', 30, { sellerId: 'c' }),
      held(1, 'goods.received', 10),
      held(2, 'seller.responded', 20, { sellerId: 'b' }),
    ];
    const wait = (event: string, kind: 'event' | 'approval' = 'event') =>
      ({ nodeId: 'n', eventType: 't', kind, title: '', event, since: 0 }) as never;
    expect(heldFor(inbox, wait('seller.responded'))?.id).toBe(2);
    expect(heldFor(inbox, wait('goods.received'))?.id).toBe(1);
    expect(heldFor(inbox, wait('payment.received'))).toBeUndefined();
    expect(heldFor(inbox, wait('goods.received', 'approval'))).toBeUndefined();
  });
});
