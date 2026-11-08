import { env } from 'cloudflare:workers';
import { createCfEmailSender, type SendEmailBinding } from '@commerceworker/adapters/email-cf';
import {
  type AppContext,
  getSchedulerAlerts,
  SCHEDULER_ALERTS_STATE_KEY,
  setSchedulerAlertRecipients,
} from '@commerceworker/application';
import type { Principal } from '@commerceworker/domain';
import { createD1Store } from '@commerceworker/store';
import { FixedClock, SequenceIdGenerator } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  CRON_EVERY,
  CRON_JOBS,
  cronSchedule,
  finishTick,
  startTick,
  sweep,
  type TickAlerts,
} from '../src/heartbeat';

/**
 * The stale alerts as the cron runs them: at the end of each tick, on D1, through the Email
 * Sending adapter over a recording `send_email` binding. The file has one database to itself and
 * the alert state is deployment-wide, so each test starts on a later day and clears the state.
 */
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: [] };
const MINUTE = 60_000;
let day = 0;

async function setup() {
  day += 1;
  const clock = new FixedClock(new Date(Date.UTC(2026, 10, day, 10, 30)));
  const ctx: AppContext = {
    store: createD1Store(env.DB),
    clock,
    ids: new SequenceIdGenerator(`alert${day}`),
  };
  await env.DB.prepare('DELETE FROM deployment_settings WHERE key LIKE ?')
    .bind('scheduler-alerts%')
    .run();
  await env.DB.prepare('DELETE FROM scheduler_jobs').run();
  const sent: { to: string | string[]; subject: string; text?: string }[] = [];
  const binding: SendEmailBinding = {
    send: async (m) => {
      sent.push(m);
      return { messageId: `m${sent.length}` };
    },
  };
  const email = createCfEmailSender(binding, { from: 'alerts@example.com' });
  return { ctx, clock, sent, email };
}

/** One tick: the relay sweep's outcome, then the heartbeat and the alerts, as `scheduled` ends. */
async function relayTick(ctx: AppContext, alerts: TickAlerts, outcome: 'ok' | string) {
  const tick = startTick(ctx);
  await sweep(
    tick,
    CRON_JOBS.relay,
    async () => {
      if (outcome !== 'ok') throw new Error(outcome);
    },
    () => {},
  );
  return finishTick(ctx, tick, alerts);
}

describe('scheduler stale alerts on the cron', () => {
  it('emails the recipients once when a sweep goes stale, and once when it recovers', async () => {
    const { ctx, clock, sent, email } = await setup();
    await setSchedulerAlertRecipients(ctx, admin, ['oncall@example.com']);
    const alerts: TickAlerts = {
      schedule: [{ job: CRON_JOBS.relay, everyMs: CRON_EVERY.relay }],
      email,
    };
    expect(await relayTick(ctx, alerts, 'ok')).toBe(true);
    for (let i = 0; i < 12; i++) {
      clock.advance(MINUTE);
      await relayTick(ctx, alerts, 'queue send failed at https://u:s3cret@q.example');
    }
    expect(sent.map((m) => m.subject)).toEqual([
      'commerceworker: scheduled job outbox-relay is stale',
    ]);
    expect(sent[0]?.to).toBe('oncall@example.com');
    // The heartbeat redacted the error before it reached the email.
    expect(sent[0]?.text).not.toContain('s3cret');

    clock.advance(MINUTE);
    await relayTick(ctx, alerts, 'ok');
    clock.advance(MINUTE);
    await relayTick(ctx, alerts, 'ok');
    expect(sent.map((m) => m.subject)).toEqual([
      'commerceworker: scheduled job outbox-relay is stale',
      'commerceworker: scheduled job outbox-relay recovered',
    ]);
    const view = await getSchedulerAlerts(ctx, admin);
    expect(view.open).toEqual([]);
    expect(view.recent[0]).toMatchObject({
      job: CRON_JOBS.relay,
      staleNotice: { state: 'sent' },
      recoveryNotice: { state: 'sent' },
    });
  });

  it('says so when the cron comes back from a gap', async () => {
    const { ctx, clock, sent, email } = await setup();
    await setSchedulerAlertRecipients(ctx, admin, ['oncall@example.com']);
    const alerts: TickAlerts = {
      schedule: [{ job: CRON_JOBS.relay, everyMs: CRON_EVERY.relay }],
      email,
    };
    await relayTick(ctx, alerts, 'ok');
    clock.advance(45 * MINUTE);
    await relayTick(ctx, alerts, 'ok');
    expect(sent.map((m) => m.subject)).toEqual(['commerceworker: the scheduler is ticking again']);
    expect(sent[0]?.text).toContain('(45 minutes)');
  });

  it('still writes the heartbeat when the alerts cannot be evaluated', async () => {
    const { ctx, email } = await setup();
    const broken: AppContext = {
      ...ctx,
      store: {
        ...ctx.store,
        settings: {
          ...ctx.store.settings,
          get: async () => {
            throw new Error('D1_ERROR: overloaded');
          },
        },
      },
    };
    const alerts: TickAlerts = { schedule: cronSchedule(on), email };
    expect(await relayTick(broken, alerts, 'ok')).toBe(true);
    expect((await ctx.store.schedulerJobs.list()).map((j) => j.job)).toContain(CRON_JOBS.relay);
    expect(await ctx.store.settings.get(SCHEDULER_ALERTS_STATE_KEY)).toBeNull();
  });
});

const on = { queue: true, versionArchive: true, agentSchedules: true };

describe('cronSchedule', () => {
  it('expects every sweep the deployment runs, at its interval', () => {
    const all = cronSchedule(on);
    expect(all.map((j) => j.job).sort()).toEqual(Object.values(CRON_JOBS).sort());
    const every = Object.fromEntries(all.map((j) => [j.job, j.everyMs]));
    expect(every[CRON_JOBS.relay]).toBe(MINUTE);
    expect(every[CRON_JOBS.prune]).toBe(60 * MINUTE);
    expect(every[CRON_JOBS.reseal]).toBe(24 * 60 * MINUTE);
  });

  it('leaves out the sweeps a deployment has turned off, so they never read stale', () => {
    const jobs = cronSchedule({ queue: false, versionArchive: false, agentSchedules: false }).map(
      (j) => j.job,
    );
    expect(jobs).not.toContain(CRON_JOBS.relay);
    expect(jobs).not.toContain(CRON_JOBS.versionArchive);
    expect(jobs).not.toContain(CRON_JOBS.agentSchedules);
    expect(jobs).toContain(CRON_JOBS.scheduledActions);
  });
});
