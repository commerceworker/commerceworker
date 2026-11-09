import { describe, expect, it } from 'vitest';
import {
  approvalWait,
  decisionProblem,
  deliveredEventProblem,
  eventProblem,
  eventWait,
  MAX_DECISION_NOTE,
  MAX_EVENT_NAME,
  MAX_EVENT_PAYLOAD_BYTES,
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
