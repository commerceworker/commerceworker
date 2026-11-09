import { describe, expect, it } from 'vitest';
import { EMPTY_ORDER_STATE, foldReport, type ReportedState } from '../src';

const state = (over: Partial<ReportedState> = {}): ReportedState => ({
  ...EMPTY_ORDER_STATE,
  orderId: 'ord_1',
  status: 'running',
  generation: 1,
  seq: 3,
  nodes: { price: { status: 'running', runs: 1 }, ship: { status: 'rolled_back', runs: 1 } },
  ...over,
});
const plan = {
  nodes: {
    price: { status: 'succeeded' as const, runs: 1, branches: ['out'] },
    ship: { status: 'succeeded' as const, runs: 1 },
  },
  edges: { e1: 'active' as const },
};

describe('folding a Workflow report into the order', () => {
  it('takes a newer plan snapshot and drops a stale one', () => {
    const fresh = foldReport(state(), { seq: 4, plan, vars: { a: 1 } }, 10);
    expect(fresh.state).toMatchObject({ seq: 4, vars: { a: 1 }, edges: { e1: 'active' } });
    expect(fresh.state.nodes.price).toMatchObject({ status: 'succeeded', branches: ['out'] });
    // Rollback and failure come from their own reports; a later plan never clears them.
    expect(fresh.state.nodes.ship?.status).toBe('rolled_back');
    const stale = foldReport(state(), { seq: 2, plan, vars: { a: 1 } }, 10);
    expect(stale.state).toMatchObject({ seq: 3, vars: {}, edges: {} });
    expect(stale.state.nodes.price?.status).toBe('running');
    // A later generation starts its sequence again.
    expect(foldReport(state(), { seq: 1, generation: 2, plan }, 10).state.seq).toBe(1);
  });

  it('changes the status once, logging it keyed, never after the order ended', () => {
    const failed = foldReport(state(), { status: 'failed', reason: 'Card declined' }, 10);
    expect(failed.statusChanged).toBe(true);
    expect(failed.state).toMatchObject({
      status: 'failed',
      reason: 'Card declined',
      updatedAt: 10,
    });
    expect(failed.log).toEqual([
      { kind: 'order', message: 'Order failed: Card declined', key: 'status:1:failed' },
    ]);
    // The same status again changes nothing and logs nothing.
    const again = foldReport(failed.state, { status: 'failed' }, 11);
    expect(again).toMatchObject({ statusChanged: false, log: [] });
    const ended = foldReport(state({ status: 'cancelled' }), { status: 'running' }, 10);
    expect(ended.state.status).toBe('cancelled');
    // A long reason is capped as everywhere else shows it.
    const long = foldReport(state(), { status: 'failed', reason: 'x '.repeat(400) }, 10);
    expect(long.state.reason!.length).toBeLessThan(400);
    // A stale snapshot's status is dropped with the rest of it.
    expect(foldReport(state(), { seq: 1, status: 'waiting' }, 10).state.status).toBe('running');
  });

  it("counts a step's run once: the first end of a running step, whatever replays", () => {
    const started = foldReport(state(), { node: { id: 'tax', startedAt: 100 } }, 100);
    expect(started.finished).toBeNull();
    // A retried attempt keeps the run's first start.
    const retried = foldReport(started.state, { node: { id: 'tax', startedAt: 150 } }, 150);
    expect(retried.state.nodes.tax?.startedAt).toBe(100);
    const ended = foldReport(
      retried.state,
      { node: { id: 'tax', endedAt: 200, status: 'succeeded' } },
      200,
    );
    expect(ended.finished).toEqual({
      id: 'tax',
      run: { status: 'succeeded', runs: 0, startedAt: 100, endedAt: 200 },
    });
    // A replay of the end adds nothing; a new run starts afresh.
    expect(foldReport(ended.state, { node: { id: 'tax', endedAt: 200 } }, 201).finished).toBeNull();
    const rerun = foldReport(ended.state, { node: { id: 'tax', startedAt: 300 } }, 300);
    expect(rerun.state.nodes.tax).toMatchObject({ startedAt: 300, endedAt: undefined });
  });

  it('appends a reported timeline line after the status line, and leaves the timeline to the agent', () => {
    const line = { at: 5, kind: 'node' as const, message: 'Priced', nodeId: 'price' };
    const r = foldReport(state({ timeline: [] }), { status: 'waiting', log: line }, 10);
    expect(r.log.map((l) => l.message)).toEqual(['Order waiting', 'Priced']);
    expect(r.state.timeline).toEqual([]);
  });
});
