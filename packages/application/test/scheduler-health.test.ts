import { ForbiddenError, type Principal } from '@commerceworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  getSchedulerStatus,
  recordSchedulerTick,
  SCHEDULER_ERROR_MAX_CHARS,
  SCHEDULER_STALE_AFTER_MS,
  SchedulerTick,
  schedulerState,
} from '../src/index';

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: [] };
const spaceManager: Principal = { spaceId: 'shop', kind: 'cma', scopes: ['space:admin'] };

function setup() {
  const store = new InMemoryContentStore();
  const clock = new FixedClock(new Date('2026-11-01T10:00:00.000Z'));
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('s') };
  return { ctx, store, clock };
}

describe('scheduler heartbeat', () => {
  it('is stale before the cron has ever ticked, and ok right after a tick', async () => {
    const { ctx } = setup();
    expect(await schedulerState(ctx)).toBe('stale');
    const tick = new SchedulerTick(ctx.clock);
    tick.ok('outbox-relay');
    await recordSchedulerTick(ctx, tick);
    expect(await schedulerState(ctx)).toBe('ok');
  });

  it('turns stale once the last tick is more than five minutes old', async () => {
    const { ctx, clock } = setup();
    await recordSchedulerTick(ctx, new SchedulerTick(ctx.clock));
    clock.advance(SCHEDULER_STALE_AFTER_MS);
    expect(await schedulerState(ctx)).toBe('ok');
    clock.advance(1);
    expect(await schedulerState(ctx)).toBe('stale');
    // The next tick brings it back.
    await recordSchedulerTick(ctx, new SchedulerTick(ctx.clock));
    expect(await schedulerState(ctx)).toBe('ok');
  });

  it('reports unknown, never throws, when the heartbeat cannot be read', async () => {
    const { ctx, store } = setup();
    store.schedulerJobs.list = async () => {
      throw new Error('D1_ERROR: database unavailable');
    };
    expect(await schedulerState(ctx)).toBe('unknown');
  });

  it('keeps a failed sweep’s redacted, bounded error alongside its last success', async () => {
    const { ctx, clock } = setup();
    const first = new SchedulerTick(ctx.clock);
    first.ok('scheduled-actions');
    await recordSchedulerTick(ctx, first);
    const okAt = clock.now().toISOString();

    clock.advance(60_000);
    const second = new SchedulerTick(ctx.clock);
    second.fail(
      'scheduled-actions',
      new Error(`fetch https://user:hunter2@hooks.example/x failed ${'x'.repeat(2000)}`),
    );
    await recordSchedulerTick(ctx, second);

    const status = await getSchedulerStatus(ctx, admin);
    expect(status.scheduler).toBe('ok');
    expect(status.lastTickAt).toBe(clock.now().toISOString());
    expect(status.staleAfterSeconds).toBe(300);
    // The tick itself is the probe's business, not a job.
    expect(status.jobs.map((j) => j.job)).toEqual(['scheduled-actions']);
    const [job] = status.jobs;
    expect(job?.lastSuccessAt).toBe(okAt);
    expect(job?.lastErrorAt).toBe(clock.now().toISOString());
    expect(job?.lastError).not.toContain('hunter2');
    expect(job?.lastError?.length).toBeLessThanOrEqual(SCHEDULER_ERROR_MAX_CHARS);
  });

  it('shows per-job status to deployment administrators only', async () => {
    const { ctx } = setup();
    await recordSchedulerTick(ctx, new SchedulerTick(ctx.clock));
    await expect(getSchedulerStatus(ctx, spaceManager)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
