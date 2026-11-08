import { env } from 'cloudflare:workers';
import {
  type AppContext,
  getSchedulerStatus,
  SCHEDULER_STALE_AFTER_MS,
  schedulerState,
} from '@commerceworker/application';
import type { Principal } from '@commerceworker/domain';
import { createD1Store } from '@commerceworker/store';
import { FixedClock, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { CRON_JOBS, finishTick, startTick, sweep } from '../src/heartbeat';

/**
 * The cron's heartbeat on D1: what the scheduled handler records for each sweep and for the tick,
 * and what the api's /health and the admin's scheduler status then read. The file has one database
 * to itself, so each test starts its clock after the previous test's ticks.
 */
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: [] };
let hour = 0;
function setup(): { ctx: AppContext; clock: FixedClock } {
  hour += 1;
  const clock = new FixedClock(new Date(Date.UTC(2026, 10, 1, hour)));
  return { ctx: { store: createD1Store(env.DB), clock, ids: new SequenceIdGenerator('h') }, clock };
}

describe('scheduler heartbeat', () => {
  it('records each sweep and the tick; a failing sweep neither stops the tick nor throws', async () => {
    const { ctx, clock } = setup();
    const tick = startTick(ctx);
    const logged: unknown[] = [];
    const ran: string[] = [];
    await sweep(
      tick,
      CRON_JOBS.scheduledActions,
      async () => {
        throw new Error('D1_ERROR: no such table at https://u:p4ss@example.com');
      },
      (err) => logged.push(err),
    );
    await sweep(
      tick,
      CRON_JOBS.relay,
      async () => ran.push('relay'),
      (err) => logged.push(err),
    );
    expect(ran).toEqual(['relay']);
    expect(logged).toHaveLength(1);
    expect(await finishTick(ctx, tick)).toBe(true);

    expect(await schedulerState(ctx)).toBe('ok');
    const status = await getSchedulerStatus(ctx, admin);
    expect(status.lastTickAt).toBe(clock.now().toISOString());
    const byJob = Object.fromEntries(status.jobs.map((j) => [j.job, j]));
    expect(byJob[CRON_JOBS.relay]?.lastSuccessAt).toBe(clock.now().toISOString());
    expect(byJob[CRON_JOBS.scheduledActions]?.lastSuccessAt).toBeUndefined();
    expect(byJob[CRON_JOBS.scheduledActions]?.lastError).toContain('no such table');
    expect(byJob[CRON_JOBS.scheduledActions]?.lastError).not.toContain('p4ss');
  });

  it('goes stale when ticks stop, and recovers keeping the last error', async () => {
    const { ctx, clock } = setup();
    const failing = startTick(ctx);
    await sweep(
      failing,
      CRON_JOBS.relay,
      async () => {
        throw new Error('queue send failed');
      },
      () => {},
    );
    await finishTick(ctx, failing);
    const failedAt = clock.now().toISOString();

    clock.advance(SCHEDULER_STALE_AFTER_MS + 1);
    expect(await schedulerState(ctx)).toBe('stale');

    const recovered = startTick(ctx);
    await sweep(
      recovered,
      CRON_JOBS.relay,
      async () => {},
      () => {},
    );
    await finishTick(ctx, recovered);
    // The tick is written again (a retried invocation): nothing moves or doubles.
    await finishTick(ctx, recovered);

    expect(await schedulerState(ctx)).toBe('ok');
    const relay = (await getSchedulerStatus(ctx, admin)).jobs.find(
      (j) => j.job === CRON_JOBS.relay,
    );
    expect(relay).toMatchObject({
      lastRunAt: clock.now().toISOString(),
      lastSuccessAt: clock.now().toISOString(),
      lastErrorAt: failedAt,
      lastError: 'queue send failed',
    });
  });

  it('logs, and never throws, when the heartbeat cannot be written', async () => {
    const { ctx } = setup();
    const broken: AppContext = {
      ...ctx,
      store: {
        ...ctx.store,
        schedulerJobs: {
          record: async () => {
            throw new Error('D1_ERROR: overloaded');
          },
          list: ctx.store.schedulerJobs.list,
        },
      },
    };
    expect(await finishTick(broken, startTick(broken))).toBe(false);
  });
});
