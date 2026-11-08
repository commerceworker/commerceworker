import { ForbiddenError, type Principal, ValidationError } from '@commerceworker/domain';
import type { EmailMessage, EmailSender, EmailSendResult } from '@commerceworker/ports';
import {
  FixedClock,
  InMemoryContentStore,
  RecordingEmailSender,
  SequenceIdGenerator,
} from '@commerceworker/test-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AppContext,
  alertOnSchedulerTick,
  getSchedulerAlerts,
  recordSchedulerTick,
  SCHEDULER_ALERT_LEASE_MS,
  SCHEDULER_ALERT_MAX_ATTEMPTS,
  SCHEDULER_ALERTS_STATE_KEY,
  type ScheduledJob,
  type SchedulerAlertDeps,
  SchedulerTick,
  setSchedulerAlertRecipients,
} from '../src/index';

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: [] };
const spaceAdmin: Principal = { spaceId: 'shop', kind: 'cma', scopes: ['space:admin'] };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const schedule: ScheduledJob[] = [
  { job: 'outbox-relay', everyMs: MINUTE },
  { job: 'event-history-prune', everyMs: HOUR },
];

function setup(start = '2026-11-01T10:00:00.000Z') {
  const store = new InMemoryContentStore();
  const clock = new FixedClock(new Date(start));
  const ctx: AppContext = { store, clock, ids: new SequenceIdGenerator('a') };
  return { ctx, store, clock };
}

/**
 * One cron tick as the engine runs it: the sweeps' outcomes, the heartbeat write, then the
 * alerts. `outcomes` maps a sweep to `ok` or its error; a sweep left out did not run.
 */
async function tick(
  ctx: AppContext,
  deps: SchedulerAlertDeps,
  outcomes: Record<string, 'ok' | string>,
  jobs: readonly ScheduledJob[] = schedule,
) {
  const t = new SchedulerTick(ctx.clock);
  for (const [job, outcome] of Object.entries(outcomes)) {
    if (outcome === 'ok') t.ok(job);
    else t.fail(job, new Error(outcome));
  }
  const before = await ctx.store.schedulerJobs.list();
  await recordSchedulerTick(ctx, t);
  return alertOnSchedulerTick(ctx, deps, { schedule: jobs, before, runs: t.finish() });
}

type Outcomes = Record<string, 'ok' | string>;

/** Ticks once a minute for `n` minutes, as the cron does; `outcomes` may depend on the minute. */
async function minutes(
  ctx: AppContext,
  clock: FixedClock,
  deps: SchedulerAlertDeps,
  n: number,
  outcomes: Outcomes | ((at: Date) => Outcomes),
) {
  for (let i = 0; i < n; i++) {
    clock.advance(MINUTE);
    await tick(ctx, deps, typeof outcomes === 'function' ? outcomes(clock.now()) : outcomes);
  }
}

const subjects = (email: RecordingEmailSender) => email.sent.map((m) => m.subject);

describe('scheduler stale alerts', () => {
  it('emails once when a sweep keeps failing, and once when it recovers', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, [' Ops@Example.com ', 'ops@example.com']);
    const email = new RecordingEmailSender();
    const deps = { email };

    await tick(ctx, deps, { 'outbox-relay': 'ok' });
    // Failing for five minutes is not yet stale; the sixth is.
    await minutes(ctx, clock, deps, 5, { 'outbox-relay': 'queue send failed' });
    expect(email.sent).toHaveLength(0);
    await minutes(ctx, clock, deps, 1, { 'outbox-relay': 'queue send failed' });
    expect(subjects(email)).toEqual(['commerceworker: scheduled job outbox-relay is stale']);
    expect(email.sent[0]?.to).toEqual(['ops@example.com']);
    expect(email.sent[0]?.text).toContain('Last error: queue send failed');

    // Still failing: the same episode, no second email.
    await minutes(ctx, clock, deps, 10, { 'outbox-relay': 'queue send failed' });
    expect(email.sent).toHaveLength(1);
    const during = await getSchedulerAlerts(ctx, admin);
    expect(during.open).toHaveLength(1);
    expect(during.open[0]).toMatchObject({
      job: 'outbox-relay',
      lastError: 'queue send failed',
      staleNotice: { state: 'sent', attempts: 1 },
    });

    await minutes(ctx, clock, deps, 1, { 'outbox-relay': 'ok' });
    expect(subjects(email)).toEqual([
      'commerceworker: scheduled job outbox-relay is stale',
      'commerceworker: scheduled job outbox-relay recovered',
    ]);
    await minutes(ctx, clock, deps, 3, { 'outbox-relay': 'ok' });
    expect(email.sent).toHaveLength(2);

    const after = await getSchedulerAlerts(ctx, admin);
    expect(after.open).toEqual([]);
    expect(after.recent[0]).toMatchObject({
      job: 'outbox-relay',
      resolution: 'recovered',
      recoveryNotice: { state: 'sent' },
    });
    // The read never shows a tick's lease.
    expect(JSON.stringify(after)).not.toContain('leaseUntil');
  });

  it('writes nothing on a tick where nothing changed', async () => {
    const { ctx, clock, store } = setup();
    const deps = { email: new RecordingEmailSender() };
    await tick(ctx, deps, { 'outbox-relay': 'ok' });
    const version = (await store.settings.get(SCHEDULER_ALERTS_STATE_KEY))?.version;
    await minutes(ctx, clock, deps, 5, { 'outbox-relay': 'ok' });
    expect((await store.settings.get(SCHEDULER_ALERTS_STATE_KEY))?.version).toBe(version);
  });

  it('gives an hourly sweep two runs before calling it stale', async () => {
    const { ctx, clock } = setup('2026-11-01T10:00:00.000Z');
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const email = new RecordingEmailSender();
    await tick(ctx, { email }, { 'outbox-relay': 'ok', 'event-history-prune': 'ok' });
    // It runs at the top of each hour; from 11:00 on it fails.
    const hourly = (at: Date): Record<string, string> =>
      at.getUTCMinutes() === 0
        ? { 'outbox-relay': 'ok', 'event-history-prune': 'D1 overloaded' }
        : { 'outbox-relay': 'ok' };
    await minutes(ctx, clock, { email }, 120, hourly);
    expect(email.sent).toHaveLength(0);
    await minutes(ctx, clock, { email }, 1, hourly);
    expect(subjects(email)).toEqual(['commerceworker: scheduled job event-history-prune is stale']);
    expect(email.sent[0]?.text).toContain('due every 60 minutes');
    expect(email.sent[0]?.text).toContain('Last error: D1 overloaded');
  });

  it('measures a sweep that never succeeded from when alerting began', async () => {
    const { ctx, clock } = setup('2026-11-01T10:30:00.000Z');
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const email = new RecordingEmailSender();
    await tick(ctx, { email }, { 'outbox-relay': 'ok' });
    // The hourly sweep has not run at all yet (it is failing at the top of the hour): two
    // hours' grace from the first evaluation, then stale.
    const relay = (at: Date): Record<string, string> =>
      at.getUTCMinutes() === 0
        ? { 'outbox-relay': 'ok', 'event-history-prune': 'no such table' }
        : { 'outbox-relay': 'ok' };
    await minutes(ctx, clock, { email }, 120, relay);
    expect(email.sent).toHaveLength(0);
    await minutes(ctx, clock, { email }, 1, relay);
    expect(subjects(email)).toEqual(['commerceworker: scheduled job event-history-prune is stale']);
    expect(email.sent[0]?.text).toContain('since alerting began');
  });

  it('says the cron is back after a gap, without calling the sweeps it skipped stale', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const email = new RecordingEmailSender();
    await tick(ctx, { email }, { 'outbox-relay': 'ok', 'event-history-prune': 'ok' });
    // Three hours without a tick (the uptime check's to report), then the cron comes back.
    clock.advance(3 * HOUR);
    const outcome = await tick(ctx, { email }, { 'outbox-relay': 'ok' });
    expect(outcome.resolved.map((e) => e.job)).toEqual(['tick']);
    expect(subjects(email)).toEqual(['commerceworker: the scheduler is ticking again']);
    expect(email.sent[0]?.text).toContain('(3 hours)');
    // The hourly sweep missed its runs because nothing ran: measured afresh from the restart.
    expect((await getSchedulerAlerts(ctx, admin)).open).toEqual([]);
  });

  it('logs only, and sends nothing later, when no one is configured to hear it', async () => {
    const { ctx, clock } = setup();
    const email = new RecordingEmailSender();
    await tick(ctx, { email }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, { email }, 5, { 'outbox-relay': 'boom' });
    clock.advance(MINUTE);
    const outcome = await tick(ctx, { email }, { 'outbox-relay': 'boom' });
    expect(outcome.opened.map((e) => e.job)).toEqual(['outbox-relay']);
    expect(outcome.notices).toEqual([
      expect.objectContaining({
        kind: 'stale',
        state: 'skipped',
        error: 'no recipients configured',
      }),
    ]);
    // Without a sender too.
    await minutes(ctx, clock, {}, 1, { 'outbox-relay': 'ok' });
    expect(email.sent).toHaveLength(0);
    const view = await getSchedulerAlerts(ctx, admin);
    // No stale email went out, so there is no recovery email to send either.
    expect(view.recent[0]).toMatchObject({ job: 'outbox-relay', resolution: 'recovered' });
    expect(view.recent[0]?.recoveryNotice).toBeUndefined();
  });

  it('retries an undelivered notice on the next ticks, then gives up as failed', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const bounced = new RecordingEmailSender({ delivered: false, error: 'E_RATE_LIMITED' });
    await tick(ctx, { email: bounced }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, { email: bounced }, 6, { 'outbox-relay': 'boom' });
    await minutes(ctx, clock, { email: bounced }, 10, { 'outbox-relay': 'boom' });
    expect(bounced.sent).toHaveLength(SCHEDULER_ALERT_MAX_ATTEMPTS);
    const view = await getSchedulerAlerts(ctx, admin);
    expect(view.open[0]?.staleNotice).toMatchObject({
      state: 'failed',
      attempts: SCHEDULER_ALERT_MAX_ATTEMPTS,
      error: 'E_RATE_LIMITED',
    });
  });

  it('drops a stale notice still waiting to go when the sweep recovers first', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const bounced = new RecordingEmailSender({ delivered: false, error: 'E_RATE_LIMITED' });
    await tick(ctx, { email: bounced }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, { email: bounced }, 6, { 'outbox-relay': 'boom' });
    const email = new RecordingEmailSender();
    await minutes(ctx, clock, { email }, 1, { 'outbox-relay': 'ok' });
    expect(email.sent).toHaveLength(0);
    const recent = (await getSchedulerAlerts(ctx, admin)).recent[0];
    expect(recent?.staleNotice).toMatchObject({
      state: 'skipped',
      error: 'resolved before it was sent',
    });
    expect(recent?.recoveryNotice).toBeUndefined();
  });

  it('sends one email when two overlapping ticks evaluate the same episode', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const email = new RecordingEmailSender();
    await tick(ctx, { email }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, { email }, 5, { 'outbox-relay': 'boom' });
    clock.advance(MINUTE);
    const t = new SchedulerTick(ctx.clock);
    t.fail('outbox-relay', new Error('boom'));
    const before = await ctx.store.schedulerJobs.list();
    await recordSchedulerTick(ctx, t);
    const input = { schedule, before, runs: t.finish() };
    const [a, b] = await Promise.all([
      alertOnSchedulerTick(ctx, { email }, input),
      alertOnSchedulerTick(ctx, { email }, input),
    ]);
    expect([a.lost, b.lost].sort()).toEqual([false, true]);
    expect(email.sent).toHaveLength(1);
    expect((await getSchedulerAlerts(ctx, admin)).open).toHaveLength(1);
  });

  it('leaves a claimed notice to its tick until the lease runs out, then sends it again', async () => {
    const { ctx, clock, store } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const email = new RecordingEmailSender();
    await tick(ctx, { email }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, { email }, 5, { 'outbox-relay': 'boom' });
    clock.advance(MINUTE);
    // The tick claims and sends, then dies before it records the send.
    const put = store.settings.put;
    let puts = 0;
    store.settings.put = async (key, value, version) => {
      if (key === SCHEDULER_ALERTS_STATE_KEY && ++puts === 2) throw new Error('isolate evicted');
      return put(key, value, version);
    };
    await expect(tick(ctx, { email }, { 'outbox-relay': 'boom' })).rejects.toThrow('evicted');
    store.settings.put = put;
    expect(email.sent).toHaveLength(1);

    await minutes(ctx, clock, { email }, 1, { 'outbox-relay': 'boom' });
    expect(email.sent).toHaveLength(1);
    clock.advance(SCHEDULER_ALERT_LEASE_MS);
    await tick(ctx, { email }, { 'outbox-relay': 'boom' });
    // At least once: the unrecorded send goes again rather than not at all.
    expect(email.sent).toHaveLength(2);
    expect((await getSchedulerAlerts(ctx, admin)).open[0]?.staleNotice?.state).toBe('sent');
  });

  it('closes an episode whose sweep the deployment stopped running', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const email = new RecordingEmailSender();
    await tick(ctx, { email }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, { email }, 6, { 'outbox-relay': 'boom' });
    clock.advance(MINUTE);
    await tick(ctx, { email }, {}, [{ job: 'event-history-prune', everyMs: HOUR }]);
    expect(subjects(email)).toEqual([
      'commerceworker: scheduled job outbox-relay is stale',
      'commerceworker: scheduled job outbox-relay no longer runs',
    ]);
  });

  it('keeps a send error redacted, as the heartbeat keeps sweep errors', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const leaky: EmailSender = {
      send: async (): Promise<EmailSendResult> => ({
        delivered: false,
        error: 'relay refused at https://user:s3cret@smtp.example',
      }),
    };
    await tick(ctx, { email: leaky }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, {}, 5, { 'outbox-relay': 'boom' });
    clock.advance(MINUTE);
    const outcome = await tick(ctx, { email: leaky }, { 'outbox-relay': 'boom' });
    expect(JSON.stringify(outcome.notices)).not.toContain('s3cret');
    const stored = JSON.stringify(await getSchedulerAlerts(ctx, admin));
    expect(stored).toContain('relay refused');
    expect(stored).not.toContain('s3cret');
  });

  it('records a sender that throws as an undelivered try', async () => {
    const { ctx, clock } = setup();
    await setSchedulerAlertRecipients(ctx, admin, ['ops@example.com']);
    const throwing: EmailSender = {
      send: async (_m: EmailMessage): Promise<EmailSendResult> => {
        throw new Error('binding unavailable');
      },
    };
    await tick(ctx, { email: throwing }, { 'outbox-relay': 'ok' });
    await minutes(ctx, clock, {}, 5, { 'outbox-relay': 'boom' });
    clock.advance(MINUTE);
    const outcome = await tick(ctx, { email: throwing }, { 'outbox-relay': 'boom' });
    expect(outcome.notices).toEqual([
      expect.objectContaining({ state: 'pending', error: 'binding unavailable' }),
    ]);
  });
});

describe('scheduler alert settings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('audits who set the recipients, with the count and never the addresses', async () => {
    const { ctx } = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setSchedulerAlertRecipients(ctx, admin, ['a@example.com', 'b@example.com']);
    const lines = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((l) => l.type === 'deployment_audit');
    expect(lines).toEqual([
      {
        type: 'deployment_audit',
        at: '2026-11-01T10:00:00.000Z',
        action: 'scheduler.alerts.recipients_set',
        actor: 'admin-token',
        count: 2,
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('example.com');
  });

  it('audits nothing when the change is refused', async () => {
    const { ctx } = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(setSchedulerAlertRecipients(ctx, spaceAdmin, ['a@example.com'])).rejects.toThrow();
    await expect(setSchedulerAlertRecipients(ctx, admin, ['nope'])).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it('are for deployment administrators only', async () => {
    const { ctx } = setup();
    await expect(getSchedulerAlerts(ctx, spaceAdmin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setSchedulerAlertRecipients(ctx, spaceAdmin, ['ops@example.com']),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses addresses that are not, and too many', async () => {
    const { ctx } = setup();
    await expect(
      setSchedulerAlertRecipients(ctx, admin, ['ops@example.com', 'not an address']),
    ).rejects.toBeInstanceOf(ValidationError);
    const many = Array.from({ length: 51 }, (_, i) => `ops${i}@example.com`);
    await expect(setSchedulerAlertRecipients(ctx, admin, many)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('replaces the list, and an empty one turns the emails off', async () => {
    const { ctx } = setup();
    expect((await getSchedulerAlerts(ctx, admin)).recipients).toEqual([]);
    await setSchedulerAlertRecipients(ctx, admin, ['a@example.com', 'b@example.com']);
    const view = await setSchedulerAlertRecipients(ctx, admin, ['b@example.com']);
    expect(view.recipients).toEqual(['b@example.com']);
    expect((await setSchedulerAlertRecipients(ctx, admin, [])).recipients).toEqual([]);
  });
});
