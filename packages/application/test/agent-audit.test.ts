import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppContext, agentUsage, listAgentRuns, recordAgentRun } from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };

describe('P8b: agent audit + cost ledger', () => {
  let ctx: AppContext;
  let clock: FixedClock;
  beforeEach(() => {
    clock = new FixedClock();
    ctx = { store: new InMemoryContentStore(), clock, ids: new SequenceIdGenerator('r') };
  });

  it('records runs and lists them newest-first', async () => {
    await recordAgentRun(ctx, scope, {
      workflow: 'enrich',
      entryId: 'e1',
      status: 'completed',
      decisions: ['enriched summary'],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    clock.advance(1000);
    await recordAgentRun(ctx, scope, {
      workflow: 'moderate',
      entryId: 'e2',
      status: 'held',
      decisions: ['flagged: hate'],
      usage: { inputTokens: 50, outputTokens: 5 },
    });

    const runs = await listAgentRuns(ctx, scope, {});
    expect(runs).toHaveLength(2);
    expect(runs[0]?.entryId).toBe('e2'); // newest first
    expect(runs[0]?.status).toBe('held');

    const enrichOnly = await listAgentRuns(ctx, scope, { workflow: 'enrich' });
    expect(enrichOnly).toHaveLength(1);
    expect(enrichOnly[0]?.entryId).toBe('e1');
  });

  it('aggregates token usage as a cost ledger', async () => {
    await recordAgentRun(ctx, scope, {
      workflow: 'enrich',
      entryId: 'e1',
      status: 'completed',
      decisions: [],
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    await recordAgentRun(ctx, scope, {
      workflow: 'enrich',
      entryId: 'e2',
      status: 'completed',
      decisions: [],
      usage: { inputTokens: 200, outputTokens: 30 },
    });
    await recordAgentRun(ctx, scope, {
      workflow: 'moderate',
      entryId: 'e3',
      status: 'completed',
      decisions: [],
      usage: { inputTokens: 40, outputTokens: 4 },
    });

    const all = await agentUsage(ctx, scope, {});
    expect(all).toEqual({ runs: 3, inputTokens: 340, outputTokens: 54 });

    const enrich = await agentUsage(ctx, scope, { workflow: 'enrich' });
    expect(enrich).toEqual({ runs: 2, inputTokens: 300, outputTokens: 50 });
  });

  it('scopes runs per space', async () => {
    await recordAgentRun(ctx, scope, {
      workflow: 'enrich',
      entryId: 'e1',
      status: 'completed',
      decisions: [],
      usage: { inputTokens: 10, outputTokens: 1 },
    });
    const other = await listAgentRuns(ctx, { spaceId: 'other', environmentId: 'main' }, {});
    expect(other).toHaveLength(0);
  });
});
