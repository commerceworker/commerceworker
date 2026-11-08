import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentRunner,
  type AgentRunOutcome,
  type AppContext,
  createAgentSchedule,
  createContentType,
  createEntry,
  createSpace,
  deleteAgentSchedule,
  listAgentSchedules,
  publishEntry,
  runDueAgentSchedules,
  SYSTEM_CALLER,
  updateAgentSchedule,
} from '../src/index';

const scope = { spaceId: 'sched', environmentId: 'main' };
const HOUR = 60 * 60 * 1000;

function fakeRunner(outcome?: Partial<AgentRunOutcome>) {
  const calls: { workflow: string; entryId: string; autoApply?: boolean }[] = [];
  const runner: AgentRunner = {
    run: async (workflow, input) => {
      calls.push({ workflow, entryId: input.entryId, autoApply: input.autoApply });
      return {
        status: 'completed',
        decisions: ['ok'],
        usage: { inputTokens: 100, outputTokens: 50 },
        ...outcome,
      };
    },
  };
  return { runner, calls };
}

describe('agent schedules', () => {
  let ctx: AppContext;
  let clock: FixedClock;

  beforeEach(async () => {
    clock = new FixedClock(new Date('2026-03-10T00:30:00.000Z'));
    ctx = {
      store: new InMemoryContentStore(),
      clock,
      ids: new SequenceIdGenerator('s'),
    };
    await createSpace(ctx, { spaceId: 'sched', name: 'Sched', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
      ],
    });
  });

  async function publishArticle(title: string) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  }

  it('creates with a computed next run and validates input', async () => {
    const s = await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 2 * * *' });
    expect(s.nextRunAt).toBe('2026-03-10T02:00:00.000Z');
    expect(s.enabled).toBe(true);
    await expect(
      createAgentSchedule(ctx, scope, { workflow: 'nope', cron: '0 2 * * *' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: 'not cron' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('first due run sets the baseline without processing entries', async () => {
    await publishArticle('pre-existing entry');
    await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 * * * *' });
    const { runner, calls } = fakeRunner();

    clock.advance(HOUR); // past 01:00 next-run
    const summary = await runDueAgentSchedules(ctx, runner);
    expect(summary.schedules).toBe(1);
    expect(summary.entriesProcessed).toBe(0);
    expect(calls).toHaveLength(0);

    const [s] = await listAgentSchedules(ctx, scope);
    expect(s?.lastRunAt).toBe(clock.now().toISOString());
    expect(s?.nextRunAt > clock.now().toISOString()).toBe(true);
  });

  it('processes entries published since the previous run, then advances', async () => {
    await createAgentSchedule(ctx, scope, {
      workflow: 'curate',
      cron: '0 * * * *',
      autoApply: true,
    });
    const { runner, calls } = fakeRunner();
    clock.advance(HOUR);
    await runDueAgentSchedules(ctx, runner); // baseline

    clock.advance(10 * 60 * 1000);
    const a = await publishArticle('new since baseline');
    clock.advance(HOUR);
    const summary = await runDueAgentSchedules(ctx, runner);

    expect(summary.entriesProcessed).toBe(1);
    expect(calls).toEqual([{ workflow: 'curate', entryId: a, autoApply: true }]);
    // Recorded in the agent audit ledger.
    const runs = await ctx.store.agentRuns.list(scope, {});
    expect(runs).toHaveLength(1);
    expect(runs[0]?.workflow).toBe('curate');

    // A third run with nothing new processes nothing.
    clock.advance(HOUR);
    const idle = await runDueAgentSchedules(ctx, runner);
    expect(idle.entriesProcessed).toBe(0);
  });

  it('caps entries per run and resumes the window from the last processed entry', async () => {
    await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 * * * *' });
    const { runner, calls } = fakeRunner();
    clock.advance(HOUR);
    await runDueAgentSchedules(ctx, runner); // baseline

    for (const n of [1, 2, 3]) {
      clock.advance(60 * 1000);
      await publishArticle(`entry ${n}`);
    }
    clock.advance(HOUR);
    const first = await runDueAgentSchedules(ctx, runner, { entriesPerRun: 2 });
    expect(first.entriesProcessed).toBe(2);

    // The window resumed: the next firing picks up the third entry.
    clock.advance(HOUR);
    const second = await runDueAgentSchedules(ctx, runner, { entriesPerRun: 2 });
    expect(second.entriesProcessed).toBe(1);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.entryId)).size).toBe(3);
  });

  it('stops a run once the token ceiling is exceeded, resuming later', async () => {
    await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 * * * *' });
    const { runner, calls } = fakeRunner({ usage: { inputTokens: 900, outputTokens: 100 } });
    clock.advance(HOUR);
    await runDueAgentSchedules(ctx, runner); // baseline
    for (const n of [1, 2, 3]) {
      clock.advance(60 * 1000);
      await publishArticle(`entry ${n}`);
    }
    clock.advance(HOUR);
    // Ceiling of 1000 tokens = exactly one 1000-token run allowed.
    const summary = await runDueAgentSchedules(ctx, runner, { maxRunTokens: 1000 });
    expect(summary.entriesProcessed).toBe(1);
    expect(calls).toHaveLength(1);
    // The remaining two arrive on the next firing.
    clock.advance(HOUR);
    const next = await runDueAgentSchedules(ctx, runner, { maxRunTokens: 10_000 });
    expect(next.entriesProcessed).toBe(2);
  });

  it('a failing run still advances nextRunAt (no hot loop)', async () => {
    await createAgentSchedule(ctx, scope, { workflow: 'moderate', cron: '0 * * * *' });
    const failing: AgentRunner = {
      run: async () => {
        throw new Error('runtime unreachable');
      },
    };
    clock.advance(HOUR);
    await runDueAgentSchedules(ctx, failing); // baseline (no entries → no failure)
    clock.advance(60 * 1000);
    await publishArticle('entry');
    clock.advance(HOUR);
    const summary = await runDueAgentSchedules(ctx, failing);
    expect(summary.failed).toBe(1);
    const [s] = await listAgentSchedules(ctx, scope);
    expect(s && s.nextRunAt > clock.now().toISOString()).toBe(true);
  });

  it('a mid-batch failure defers the remaining window instead of dropping it', async () => {
    await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 * * * *' });
    clock.advance(HOUR);
    const { runner } = fakeRunner();
    await runDueAgentSchedules(ctx, runner); // baseline
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      clock.advance(60 * 1000);
      ids.push(await publishArticle(`entry ${n}`));
    }
    // Fails on the second entry (e.g. the budget window is exhausted).
    let calls = 0;
    const flaky: AgentRunner = {
      run: async (_w, _input) => {
        calls += 1;
        if (calls === 2) throw new Error('budget exhausted');
        return { status: 'completed', decisions: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    clock.advance(HOUR);
    const first = await runDueAgentSchedules(ctx, flaky);
    expect(first.entriesProcessed).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.errors[0]?.message).toMatch(/budget exhausted/);

    // Next firing retries from entry 2 — nothing was dropped.
    clock.advance(HOUR);
    const retry = await runDueAgentSchedules(ctx, flaky);
    expect(retry.entriesProcessed).toBe(2);
    expect(retry.failed).toBe(0);
  });

  it('resumes exactly across same-instant publishes at a truncation boundary', async () => {
    await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 * * * *' });
    const { runner, calls } = fakeRunner();
    clock.advance(HOUR);
    await runDueAgentSchedules(ctx, runner); // baseline
    // Three entries sharing one publish instant (bulk/release publish shape).
    clock.advance(60 * 1000);
    for (const n of [1, 2, 3]) await publishArticle(`same instant ${n}`);
    clock.advance(HOUR);
    await runDueAgentSchedules(ctx, runner, { entriesPerRun: 2 });
    clock.advance(HOUR);
    await runDueAgentSchedules(ctx, runner, { entriesPerRun: 2 });
    // All three processed exactly once despite the shared timestamp.
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.entryId)).size).toBe(3);
  });

  it('claims a firing so concurrent runners never double-run it', async () => {
    const s = await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 * * * *' });
    clock.advance(HOUR);
    const { runner } = fakeRunner();
    await runDueAgentSchedules(ctx, runner); // baseline
    clock.advance(60 * 1000);
    await publishArticle('contended entry');
    clock.advance(HOUR);
    // A racing runner claims the firing first (CAS on nextRunAt).
    const [current] = await listAgentSchedules(ctx, scope);
    const stolen = await ctx.store.agentSchedules.claimNextRun(
      scope,
      s.id,
      current?.nextRunAt ?? '',
      '2027-01-01T00:00:00.000Z',
    );
    expect(stolen).toBe(true);
    const { runner: second, calls } = fakeRunner();
    const summary = await runDueAgentSchedules(ctx, second);
    expect(summary.schedules).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('scopes are isolated: space B cannot touch space A schedules', async () => {
    const otherScope = { spaceId: 'other-space', environmentId: 'main' };
    await createSpace(ctx, { spaceId: 'other-space', name: 'Other', defaultLocale: 'en-US' });
    const s = await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 2 * * *' });

    expect(await listAgentSchedules(ctx, otherScope)).toHaveLength(0);
    await expect(
      updateAgentSchedule(ctx, otherScope, s.id, { enabled: false }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteAgentSchedule(ctx, otherScope, s.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await listAgentSchedules(ctx, scope)).map((x) => x.id)).toContain(s.id);
  });

  it('update recomputes the next run on cron change; disabled schedules never fire', async () => {
    const s = await createAgentSchedule(ctx, scope, { workflow: 'enrich', cron: '0 2 * * *' });
    const updated = await updateAgentSchedule(ctx, scope, s.id, { cron: '30 5 * * *' });
    expect(updated.nextRunAt).toBe('2026-03-10T05:30:00.000Z');

    await updateAgentSchedule(ctx, scope, s.id, { enabled: false });
    clock.advance(24 * HOUR);
    const { runner } = fakeRunner();
    const summary = await runDueAgentSchedules(ctx, runner);
    expect(summary.schedules).toBe(0);

    await deleteAgentSchedule(ctx, scope, s.id);
    expect(await listAgentSchedules(ctx, scope)).toHaveLength(0);
  });
});
