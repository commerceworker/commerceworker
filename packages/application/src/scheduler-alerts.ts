import {
  ConflictError,
  ForbiddenError,
  isEmail,
  normalizeEmail,
  type Principal,
  ValidationError,
} from '@commerceworker/domain';
import type { EmailSender, SchedulerJobRun, SchedulerJobStatus } from '@commerceworker/ports';
import { redactCredentials } from '@commerceworker/redaction';
import { auditActor } from './audit';
import type { AppContext } from './context';
import {
  SCHEDULER_ERROR_MAX_CHARS,
  SCHEDULER_STALE_AFTER_MS,
  SCHEDULER_TICK_JOB,
} from './scheduler-health';

/**
 * Telling someone when a cron sweep goes stale.
 *
 * The heartbeat (`scheduler-health.ts`) shows staleness to whoever asks; this tells the deployment's
 * alert recipients once per stale episode, and once more when it recovers. The cron evaluates
 * it at the end of every tick (`alertOnSchedulerTick`, after the heartbeat write), so it adds no
 * trigger and no writer: the cron is already the scheduler tables' only writer, and it writes the
 * alert state only when an episode opens, closes or a notice is sent.
 *
 * A sweep is stale once it has gone {@link schedulerJobStaleAfterMs} without a success: two of its
 * runs for an hourly or daily sweep, five minutes for the every-minute ones (the `/health`
 * window). A sweep that keeps failing is stale the same way; one that fails once and then
 * succeeds is not.
 *
 * The cron can't report its own death: when it stops, nothing here runs. That is the external
 * uptime check's job, against the api's `/health/scheduler` (503 while stale). What the cron can
 * do is say so when it comes back: a tick that finds the previous one more than five minutes old
 * sends a "resumed" notice, closing the outage the uptime check opened.
 *
 * State lives in two deployment settings: the recipients (`scheduler-alerts`, set by a deployment
 * administrator) and the episodes (`scheduler-alerts:state`, the cron's). Each write is a
 * compare-and-set, so two overlapping ticks never both open, or both send, the same notice.
 */

/** Deployment settings key of the recipients (written by an administrator). */
export const SCHEDULER_ALERTS_SETTINGS_KEY = 'scheduler-alerts';
/** Deployment settings key of the episodes and their notices (written by the cron only). */
export const SCHEDULER_ALERTS_STATE_KEY = 'scheduler-alerts:state';

/** Email Sending's per-message cap, which the adapter enforces too. */
export const SCHEDULER_ALERT_MAX_RECIPIENTS = 50;
/** Resolved episodes kept for the status read, newest first. */
export const SCHEDULER_ALERT_HISTORY = 20;
/** Ticks a notice is tried on before it is given up as `failed`. */
export const SCHEDULER_ALERT_MAX_ATTEMPTS = 5;
/** How long a tick that claimed a notice has to send it before another tick may. */
export const SCHEDULER_ALERT_LEASE_MS = 2 * 60_000;

/** A sweep the cron runs on this deployment, and how often it is due. */
export interface ScheduledJob {
  readonly job: string;
  readonly everyMs: number;
}

/** Two missed runs, and never less than the five minutes `/health` allows the tick itself. */
export const schedulerJobStaleAfterMs = (everyMs: number): number =>
  Math.max(SCHEDULER_STALE_AFTER_MS, 2 * everyMs);

export type SchedulerNoticeState = 'pending' | 'sent' | 'failed' | 'skipped';

/** One email about an episode, and how its delivery went. */
export interface SchedulerNotice {
  readonly state: SchedulerNoticeState;
  readonly attempts: number;
  /** When it was sent, or last tried, or skipped. */
  readonly at?: string;
  /** Why the last try failed, or why it was skipped. */
  readonly error?: string;
  /** Set while a tick sends it: until then no other tick does. */
  readonly leaseUntil?: string;
}

/** One stretch of a sweep not succeeding (or, for `tick`, of the cron not ticking). */
export interface SchedulerAlertEpisode {
  readonly id: string;
  /** The sweep, or `tick` for a gap in the cron itself. */
  readonly job: string;
  /** The last success before the episode (for `tick`, the last tick before the gap). */
  readonly lastSuccessAt?: string;
  /** When the cron noticed. */
  readonly detectedAt: string;
  readonly lastError?: string;
  readonly resolvedAt?: string;
  /** `recovered`: it succeeded again; `unscheduled`: the deployment stopped running it. */
  readonly resolution?: 'recovered' | 'unscheduled';
  /** The "stale" email. Absent for `tick`, whose outage the uptime check reports. */
  readonly staleNotice?: SchedulerNotice;
  /** The "recovered" email, only when a stale one went out (or might have). */
  readonly recoveryNotice?: SchedulerNotice;
}

/** What the cron keeps between ticks. */
export interface SchedulerAlertState {
  /** Since when the cron has evaluated without a gap: a sweep never ran is measured from here. */
  readonly evaluatingSince: string;
  readonly open: readonly SchedulerAlertEpisode[];
  /** Resolved episodes, newest first, at most {@link SCHEDULER_ALERT_HISTORY}. */
  readonly recent: readonly SchedulerAlertEpisode[];
}

export interface SchedulerAlertSettings {
  readonly recipients: readonly string[];
}

// ---- settings ----------------------------------------------------------------------------------

function onlyDeploymentAdmins(principal: Principal): void {
  if (principal.spaceId !== '*') throw new ForbiddenError('Deployment administrators only');
}

async function readSettings(ctx: AppContext): Promise<SchedulerAlertSettings> {
  const stored = await ctx.store.settings.get(SCHEDULER_ALERTS_SETTINGS_KEY);
  const recipients = (stored?.value as { recipients?: unknown } | undefined)?.recipients;
  return {
    recipients: Array.isArray(recipients)
      ? recipients.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

/**
 * Sets who is emailed. Replaces the list (empty turns the emails off; the log lines stay).
 * Addresses are trimmed, lowercased and deduplicated.
 */
export async function setSchedulerAlertRecipients(
  ctx: AppContext,
  principal: Principal,
  recipients: readonly string[],
): Promise<SchedulerAlertsView> {
  onlyDeploymentAdmins(principal);
  const next = [...new Set(recipients.map(normalizeEmail))];
  const bad = next.filter((r) => !isEmail(r) || r.length > 320);
  if (bad.length > 0) {
    throw new ValidationError([
      { field: 'recipients', message: `Not an email address: ${bad.slice(0, 3).join(', ')}` },
    ]);
  }
  if (next.length > SCHEDULER_ALERT_MAX_RECIPIENTS) {
    throw new ValidationError([
      { field: 'recipients', message: `At most ${SCHEDULER_ALERT_MAX_RECIPIENTS} recipients` },
    ]);
  }
  const value: SchedulerAlertSettings = { recipients: next };
  for (let attempt = 0; attempt < 5; attempt++) {
    const stored = await ctx.store.settings.get(SCHEDULER_ALERTS_SETTINGS_KEY);
    if (
      await ctx.store.settings.put(SCHEDULER_ALERTS_SETTINGS_KEY, value, stored?.version ?? null)
    ) {
      auditRecipientsSet(ctx, principal, next.length);
      return getSchedulerAlerts(ctx, principal);
    }
  }
  throw new ConflictError('Scheduler alert settings changed concurrently; try again');
}

/**
 * Records who changed the recipients. One structured log line (`deployment_audit`, which Logpush
 * carries like `invite_audit`): the api has no deployment-wide audit log, and the setting belongs
 * to no space. The count only, never the addresses.
 */
function auditRecipientsSet(ctx: AppContext, principal: Principal, count: number): void {
  console.log(
    JSON.stringify({
      type: 'deployment_audit',
      at: ctx.clock.now().toISOString(),
      action: 'scheduler.alerts.recipients_set',
      actor: auditActor(principal),
      count,
    }),
  );
}

// ---- the read ----------------------------------------------------------------------------------

export interface SchedulerAlertsView {
  readonly recipients: readonly string[];
  /** Absent until the cron has evaluated once. */
  readonly evaluatingSince?: string;
  /** Sweeps stale now. */
  readonly open: readonly SchedulerAlertEpisode[];
  /** The last resolved episodes, newest first. */
  readonly recent: readonly SchedulerAlertEpisode[];
}

const withoutLease = (n: SchedulerNotice | undefined): SchedulerNotice | undefined => {
  if (!n) return undefined;
  const { leaseUntil: _lease, ...rest } = n;
  return rest;
};

const viewOf = (e: SchedulerAlertEpisode): SchedulerAlertEpisode => {
  const { staleNotice, recoveryNotice, ...rest } = e;
  return {
    ...rest,
    ...(staleNotice ? { staleNotice: withoutLease(staleNotice) } : {}),
    ...(recoveryNotice ? { recoveryNotice: withoutLease(recoveryNotice) } : {}),
  };
};

/**
 * Who is emailed, what is stale now and the last episodes. Deployment administrators only, like
 * the scheduler status: the errors describe the deployment, not any one space. A read: it writes
 * nothing.
 */
export async function getSchedulerAlerts(
  ctx: AppContext,
  principal: Principal,
): Promise<SchedulerAlertsView> {
  onlyDeploymentAdmins(principal);
  const [settings, stored] = await Promise.all([
    readSettings(ctx),
    ctx.store.settings.get(SCHEDULER_ALERTS_STATE_KEY),
  ]);
  const state = parseState(stored?.value);
  return {
    recipients: settings.recipients,
    ...(state ? { evaluatingSince: state.evaluatingSince } : {}),
    open: (state?.open ?? []).map(viewOf),
    recent: (state?.recent ?? []).map(viewOf),
  };
}

function parseState(value: unknown): SchedulerAlertState | undefined {
  const v = value as Partial<SchedulerAlertState> | null | undefined;
  if (!v || typeof v.evaluatingSince !== 'string') return undefined;
  return {
    evaluatingSince: v.evaluatingSince,
    open: Array.isArray(v.open) ? v.open : [],
    recent: Array.isArray(v.recent) ? v.recent : [],
  };
}

// ---- the cron's half ---------------------------------------------------------------------------

export interface SchedulerAlertInput {
  /** The sweeps this deployment runs, with how often each is due. */
  readonly schedule: readonly ScheduledJob[];
  /** The heartbeat as it stood before this tick's write. */
  readonly before: readonly SchedulerJobStatus[];
  /** This tick's outcomes (`SchedulerTick.finish()`). */
  readonly runs: readonly SchedulerJobRun[];
}

export interface SchedulerAlertDeps {
  /** Absent when the deployment sends no email: notices are then `skipped`, and only logged. */
  readonly email?: EmailSender;
}

export interface SchedulerNoticeOutcome {
  readonly episodeId: string;
  readonly job: string;
  readonly kind: 'stale' | 'recovered';
  readonly state: SchedulerNoticeState;
  readonly error?: string;
}

/** What one tick did, for the engine's log lines. */
export interface SchedulerAlertOutcome {
  /** Episodes this tick opened. */
  readonly opened: readonly SchedulerAlertEpisode[];
  /** Episodes this tick resolved (a `tick` one when the cron came back from a gap). */
  readonly resolved: readonly SchedulerAlertEpisode[];
  /** Notices this tick sent, failed or skipped. */
  readonly notices: readonly SchedulerNoticeOutcome[];
  /** Another tick wrote the state first: this one did nothing, and the next evaluates again. */
  readonly lost: boolean;
}

type Kind = SchedulerNoticeOutcome['kind'];
const noticeKey = (kind: Kind) => (kind === 'stale' ? 'staleNotice' : 'recoveryNotice');
const pending = (): SchedulerNotice => ({ state: 'pending', attempts: 0 });
const KINDS: readonly Kind[] = ['stale', 'recovered'];

/**
 * Evaluates one tick: opens an episode for each sweep that went stale, resolves those that
 * succeeded again, then sends what is due. Called by the cron after the heartbeat write; it
 * throws only when the store does, and the caller logs that and carries on.
 */
export async function alertOnSchedulerTick(
  ctx: AppContext,
  deps: SchedulerAlertDeps,
  input: SchedulerAlertInput,
): Promise<SchedulerAlertOutcome> {
  const now = ctx.clock.now();
  const [stored, settings] = await Promise.all([
    ctx.store.settings.get(SCHEDULER_ALERTS_STATE_KEY),
    readSettings(ctx),
  ]);
  const previous = parseState(stored?.value);
  const planned = plan(previous, input, now.getTime(), () => ctx.ids.newId());

  // Claim what is due. Without a way to send, a notice is skipped rather than retried forever.
  const email = deps.email;
  const unsendable = !email
    ? 'email sending is not configured'
    : settings.recipients.length === 0
      ? 'no recipients configured'
      : undefined;
  const claimed: { episode: SchedulerAlertEpisode; kind: Kind }[] = [];
  const skipped: SchedulerNoticeOutcome[] = [];
  const next = mapNotices(planned.state, (episode, kind, notice) => {
    if (notice.state !== 'pending') return notice;
    if (notice.leaseUntil && Date.parse(notice.leaseUntil) > now.getTime()) return notice;
    if (unsendable) {
      skipped.push({
        episodeId: episode.id,
        job: episode.job,
        kind,
        state: 'skipped',
        error: unsendable,
      });
      return {
        state: 'skipped',
        attempts: notice.attempts,
        at: now.toISOString(),
        error: unsendable,
      };
    }
    claimed.push({ episode, kind });
    return {
      ...notice,
      attempts: notice.attempts + 1,
      leaseUntil: new Date(now.getTime() + SCHEDULER_ALERT_LEASE_MS).toISOString(),
    };
  });

  const nothing = { opened: [], resolved: [], notices: [], lost: false };
  if (stored && JSON.stringify(stored.value) === JSON.stringify(next)) return nothing;
  if (!(await ctx.store.settings.put(SCHEDULER_ALERTS_STATE_KEY, next, stored?.version ?? null))) {
    return { ...nothing, lost: true };
  }

  const scheduleOf = new Map(input.schedule.map((j) => [j.job, j]));
  const sent: SchedulerNoticeOutcome[] = [];
  for (const { episode, kind } of claimed) {
    if (!email) break; // never: nothing is claimed without a sender
    const message = noticeMessage(episode, kind, scheduleOf.get(episode.job));
    let result: { delivered: boolean; error?: string };
    try {
      result = await email.send({ to: settings.recipients, ...message });
    } catch (err) {
      result = { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Kept in the state and shown to admins: redacted and bounded, as the heartbeat keeps errors.
    if (!result.delivered) {
      const error = redactCredentials(result.error ?? 'not delivered');
      result = { delivered: false, error: error.slice(0, SCHEDULER_ERROR_MAX_CHARS) || 'failed' };
    }
    sent.push({
      episodeId: episode.id,
      job: episode.job,
      kind,
      state: result.delivered ? 'sent' : 'pending',
      ...(result.delivered ? {} : { error: result.error ?? 'not delivered' }),
    });
  }
  const settled = sent.length > 0 ? await settle(ctx, sent) : [];
  return {
    opened: planned.opened,
    resolved: planned.resolved,
    notices: [...skipped, ...settled],
    lost: false,
  };
}

/**
 * Records how the claimed notices went: `sent`, or back to `pending` for the next tick, or
 * `failed` after {@link SCHEDULER_ALERT_MAX_ATTEMPTS}. Re-read and retried on a lost
 * compare-and-set; if it keeps losing, the lease runs out and a later tick sends again (a
 * duplicate email, never a missing one).
 */
async function settle(
  ctx: AppContext,
  results: readonly SchedulerNoticeOutcome[],
): Promise<SchedulerNoticeOutcome[]> {
  const at = ctx.clock.now().toISOString();
  const byKey = new Map(results.map((r) => [`${r.episodeId}:${r.kind}`, r]));
  const final = new Map<string, SchedulerNoticeOutcome>();
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await ctx.store.settings.get(SCHEDULER_ALERTS_STATE_KEY);
    const state = parseState(stored?.value);
    if (!stored || !state) break;
    const next = mapNotices(state, (episode, kind, notice) => {
      const r = byKey.get(`${episode.id}:${kind}`);
      if (!r) return notice;
      const { leaseUntil: _lease, error: _error, ...rest } = notice;
      const outcome: SchedulerNoticeOutcome =
        r.state === 'sent'
          ? r
          : notice.attempts >= SCHEDULER_ALERT_MAX_ATTEMPTS
            ? { ...r, state: 'failed' }
            : r;
      final.set(`${episode.id}:${kind}`, outcome);
      return {
        ...rest,
        state: outcome.state,
        at,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    });
    if (await ctx.store.settings.put(SCHEDULER_ALERTS_STATE_KEY, next, stored.version)) {
      return results.map((r) => final.get(`${r.episodeId}:${r.kind}`) ?? r);
    }
    final.clear();
  }
  return [...results];
}

function mapNotices(
  state: SchedulerAlertState,
  f: (episode: SchedulerAlertEpisode, kind: Kind, notice: SchedulerNotice) => SchedulerNotice,
): SchedulerAlertState {
  const each = (episode: SchedulerAlertEpisode): SchedulerAlertEpisode => {
    let out = episode;
    for (const kind of KINDS) {
      const notice = episode[noticeKey(kind)];
      if (notice) out = { ...out, [noticeKey(kind)]: f(episode, kind, notice) };
    }
    return out;
  };
  return { ...state, open: state.open.map(each), recent: state.recent.map(each) };
}

/** Whether a tick is sending the notice now: it may already have gone. */
const inFlight = (n: SchedulerNotice | undefined) =>
  n?.state === 'pending' && n.leaseUntil !== undefined;

function resolve(
  episode: SchedulerAlertEpisode,
  at: string,
  resolution: 'recovered' | 'unscheduled',
): SchedulerAlertEpisode {
  const stale = episode.staleNotice;
  // A recovery is worth an email only to someone who was told it was stale. A stale notice
  // still waiting to go is dropped instead: it would arrive saying something no longer true.
  const told = stale?.state === 'sent' || inFlight(stale);
  return {
    ...episode,
    resolvedAt: at,
    resolution,
    ...(stale?.state === 'pending' && !told
      ? { staleNotice: { ...stale, state: 'skipped', at, error: 'resolved before it was sent' } }
      : {}),
    ...(told ? { recoveryNotice: pending() } : {}),
  };
}

/** The pure part: the next state from the last one and this tick's heartbeat. */
function plan(
  previous: SchedulerAlertState | undefined,
  input: SchedulerAlertInput,
  nowMs: number,
  newId: () => string,
): {
  state: SchedulerAlertState;
  opened: SchedulerAlertEpisode[];
  resolved: SchedulerAlertEpisode[];
} {
  const now = new Date(nowMs).toISOString();
  const before = new Map(input.before.map((r) => [r.job, r]));
  const ran = new Map(input.runs.map((r) => [r.job, r]));
  const opened: SchedulerAlertEpisode[] = [];
  const resolved: SchedulerAlertEpisode[] = [];

  // A gap in the ticks: the cron stopped and is back. The outage was the uptime check's to
  // report; this tells the same people it is over. Sweeps are measured afresh from here, so one
  // that was merely not run during the gap is not called stale for it.
  const lastTick = before.get(SCHEDULER_TICK_JOB)?.lastRunAt;
  const gap = lastTick !== undefined && nowMs - Date.parse(lastTick) > SCHEDULER_STALE_AFTER_MS;
  if (gap) {
    resolved.push({
      id: newId(),
      job: SCHEDULER_TICK_JOB,
      lastSuccessAt: lastTick,
      detectedAt: now,
      resolvedAt: now,
      resolution: 'recovered',
      recoveryNotice: pending(),
    });
  }
  const evaluatingSince = !previous || gap ? now : previous.evaluatingSince;

  const scheduled = new Set(input.schedule.map((j) => j.job));
  const openByJob = new Map((previous?.open ?? []).map((e) => [e.job, e]));
  const open: SchedulerAlertEpisode[] = [];
  for (const { job, everyMs } of input.schedule) {
    const run = ran.get(job);
    const row = before.get(job);
    const lastSuccessAt = run && run.error === undefined ? run.at : row?.lastSuccessAt;
    const lastError =
      run?.error ??
      (row?.lastErrorAt && (!lastSuccessAt || row.lastErrorAt > lastSuccessAt)
        ? row.lastError
        : undefined);
    const episode = openByJob.get(job);
    if (episode) {
      // Only a success resolves an episode: a gap that reset the clock does not.
      if (lastSuccessAt && lastSuccessAt > episode.detectedAt) {
        resolved.push(resolve(episode, now, 'recovered'));
      } else {
        open.push(lastError ? { ...episode, lastError } : episode);
      }
      continue;
    }
    const since = Math.max(
      lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NEGATIVE_INFINITY,
      Date.parse(evaluatingSince),
    );
    if (nowMs - since > schedulerJobStaleAfterMs(everyMs)) {
      const fresh: SchedulerAlertEpisode = {
        id: newId(),
        job,
        ...(lastSuccessAt ? { lastSuccessAt } : {}),
        detectedAt: now,
        ...(lastError ? { lastError } : {}),
        staleNotice: pending(),
      };
      open.push(fresh);
      opened.push(fresh);
    }
  }
  // A sweep the deployment stopped running (a flag turned off) can't recover: close it.
  for (const episode of previous?.open ?? []) {
    if (!scheduled.has(episode.job)) resolved.push(resolve(episode, now, 'unscheduled'));
  }

  return {
    state: {
      evaluatingSince,
      open,
      recent: [...resolved, ...(previous?.recent ?? [])].slice(0, SCHEDULER_ALERT_HISTORY),
    },
    opened,
    resolved,
  };
}

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
};

/** Plain text: the email is a page for whoever is on call, not content. */
function noticeMessage(
  episode: SchedulerAlertEpisode,
  kind: Kind,
  scheduled: ScheduledJob | undefined,
): { subject: string; text: string } {
  const detail =
    'GET /deployment/scheduler (or the scheduler_status MCP tool) has every sweep; ' +
    'GET /deployment/scheduler/alerts has the episodes.';
  if (episode.job === SCHEDULER_TICK_JOB) {
    const down =
      Date.parse(episode.resolvedAt ?? episode.detectedAt) -
      Date.parse(episode.lastSuccessAt ?? episode.detectedAt);
    return {
      subject: 'commerceworker: the scheduler is ticking again',
      text: [
        `The engine cron recorded no tick from ${episode.lastSuccessAt} to ${episode.resolvedAt} (${minutes(down)}).`,
        'It is ticking again, and the sweeps that were due have run on this tick. A sweep still',
        'failing gets its own email.',
        '',
        detail,
      ].join('\n'),
    };
  }
  if (kind === 'stale') {
    return {
      subject: `commerceworker: scheduled job ${episode.job} is stale`,
      text: [
        `The engine cron's "${episode.job}" sweep has not succeeded ${
          episode.lastSuccessAt ? `since ${episode.lastSuccessAt}` : 'since alerting began'
        }${scheduled ? `; it is due every ${minutes(scheduled.everyMs)}` : ''}.`,
        ...(episode.lastError ? ['', `Last error: ${episode.lastError}`] : []),
        '',
        'You will get one more email when it succeeds again.',
        detail,
      ].join('\n'),
    };
  }
  return episode.resolution === 'unscheduled'
    ? {
        subject: `commerceworker: scheduled job ${episode.job} no longer runs`,
        text: [
          `The "${episode.job}" sweep, stale since ${episode.detectedAt}, no longer runs on this`,
          'deployment (its feature was turned off), so its alert is closed.',
          '',
          detail,
        ].join('\n'),
      }
    : {
        subject: `commerceworker: scheduled job ${episode.job} recovered`,
        text: [
          `The "${episode.job}" sweep, stale since ${episode.detectedAt}, succeeded again at ${episode.resolvedAt}.`,
          '',
          detail,
        ].join('\n'),
      };
}
