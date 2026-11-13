import { durationMs, type WorkflowRunParams } from '@commerceworker/domain';
import type {
  Clock,
  EmailMessage,
  EmailQueue,
  EmailSender,
  EmailSendResult,
  QueuedEmail,
  WorkflowDuration,
  WorkflowEngine,
  WorkflowStepConfig,
  WorkflowStepContext,
  WorkflowStepEvent,
  WorkflowSteps,
} from '@commerceworker/ports';

type Recorded =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/** How a {@link FakeWorkflowSteps.run} pass ended. */
export type FakeRunOutcome<T> =
  | { readonly status: 'complete'; readonly value: T }
  | { readonly status: 'errored'; readonly error: unknown }
  /** Hibernating: every live path waits on a sleep or an event (named here). */
  | { readonly status: 'waiting'; readonly on: readonly string[] };

const toMs = (d: WorkflowDuration | undefined, fallback: number): number =>
  d === undefined ? fallback : typeof d === 'number' ? d : durationMs(d);

// test-kit declares no runtime libs; every JS host has a global setTimeout.
const timers = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown };
const tick = () => new Promise<void>((resolve) => timers.setTimeout(resolve, 0));

/**
 * A deterministic stand-in for Cloudflare Workflows' `WorkflowStep`, for tests.
 *
 * Like the real engine it records every finished step by name and **replays** it: run the same
 * workflow function again over the same instance and finished steps return their recorded result
 * without running, so a test proves replay determinism by running twice and comparing. Retries run
 * immediately (no backoff delay); `attempt` counts as on Workflows.
 *
 * Time and events are explicit. A sleep or `waitForEvent` that can't finish yet suspends the pass
 * (its promise never settles, as an instance hibernates); {@link run} reports `waiting` once the
 * pass is quiet. Advance the injected clock or {@link sendEvent}, then {@link run} again: the
 * workflow replays to where it stopped and carries on. A wait's deadline is fixed when it first
 * waits, so advancing the clock past it times the wait out.
 */
export class FakeWorkflowSteps implements WorkflowSteps {
  /** Finished steps (results and final errors), by name. */
  readonly journal = new Map<string, Recorded>();
  /** Names of steps that ran live (not replayed), in order, one per attempt. */
  readonly executed: string[] = [];
  /** `sleep`/`sleepUntil` wake times and `waitForEvent` deadlines, fixed on first wait (epoch ms). */
  readonly deadlines = new Map<string, number>();
  private readonly inbox: WorkflowStepEvent<unknown>[] = [];
  private suspended: string[] = [];
  private inflight = 0;

  constructor(private readonly clock: Clock) {}

  /** Delivers an event, as `instance.sendEvent` does; a matching wait picks it up on the next pass. */
  sendEvent(type: string, payload: unknown): void {
    this.inbox.push({ type, payload, timestamp: this.clock.now() });
  }

  /** Events delivered but not (yet) consumed by a wait. */
  get pendingEvents(): readonly WorkflowStepEvent<unknown>[] {
    return [...this.inbox];
  }

  /** Runs one pass of `fn` over this instance. */
  async run<T>(fn: () => Promise<T>): Promise<FakeRunOutcome<T>> {
    this.suspended = [];
    let settled: FakeRunOutcome<T> | null = null;
    fn().then(
      (value) => {
        settled = { status: 'complete', value };
      },
      (error: unknown) => {
        settled = { status: 'errored', error };
      },
    );
    let quiet = 0;
    for (let i = 0; i < 100_000; i++) {
      await tick();
      if (settled) return settled;
      if (this.suspended.length > 0 && this.inflight === 0) {
        quiet += 1;
        if (quiet >= 5) return { status: 'waiting', on: [...new Set(this.suspended)] };
      } else {
        quiet = 0;
      }
    }
    throw new Error('FakeWorkflowSteps: the workflow neither finished nor suspended');
  }

  private suspend<T>(name: string): Promise<T> {
    this.suspended.push(name);
    return new Promise<T>(() => {});
  }

  private replay<T>(name: string): { hit: true; value: Promise<T> } | { hit: false } {
    const r = this.journal.get(name);
    if (!r) return { hit: false };
    return {
      hit: true,
      value: r.ok ? Promise.resolve(r.value as T) : Promise.reject(new Error(r.error)),
    };
  }

  do<T>(name: string, fn: (ctx: WorkflowStepContext) => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    fn: (ctx: WorkflowStepContext) => Promise<T>,
  ): Promise<T>;
  async do<T>(
    name: string,
    a: WorkflowStepConfig | ((ctx: WorkflowStepContext) => Promise<T>),
    b?: (ctx: WorkflowStepContext) => Promise<T>,
  ): Promise<T> {
    const replayed = this.replay<T>(name);
    if (replayed.hit) return replayed.value;
    const config = typeof a === 'function' ? {} : a;
    const fn = (typeof a === 'function' ? a : b) as (ctx: WorkflowStepContext) => Promise<T>;
    // Workflows' default: 5 retries.
    const limit = config.retries?.limit ?? 5;
    this.inflight += 1;
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= limit + 1; attempt++) {
        this.executed.push(name);
        try {
          // A step's result is stored as JSON, exactly as Workflows serializes it.
          const value = JSON.parse(JSON.stringify((await fn({ attempt })) ?? null)) as T;
          this.journal.set(name, { ok: true, value });
          return value;
        } catch (err) {
          lastError = err;
        }
      }
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      this.journal.set(name, { ok: false, error: message });
      throw lastError instanceof Error ? lastError : new Error(message);
    } finally {
      this.inflight -= 1;
    }
  }

  async sleep(name: string, duration: WorkflowDuration): Promise<void> {
    if (!this.deadlines.has(name)) {
      this.deadlines.set(name, this.clock.now().getTime() + toMs(duration, 0));
    }
    return this.wake(name);
  }

  async sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    if (!this.deadlines.has(name)) {
      this.deadlines.set(name, typeof timestamp === 'number' ? timestamp : timestamp.getTime());
    }
    return this.wake(name);
  }

  private async wake(name: string): Promise<void> {
    const replayed = this.replay<void>(name);
    if (replayed.hit) return replayed.value;
    if (this.clock.now().getTime() >= (this.deadlines.get(name) ?? 0)) {
      this.journal.set(name, { ok: true, value: null });
      return;
    }
    return this.suspend(name);
  }

  async waitForEvent<T>(
    name: string,
    options: { readonly type: string; readonly timeout?: WorkflowDuration },
  ): Promise<WorkflowStepEvent<T>> {
    const replayed = this.replay<WorkflowStepEvent<T>>(name);
    if (replayed.hit) {
      const ev = await replayed.value;
      return { ...ev, timestamp: new Date(ev.timestamp) };
    }
    if (!this.deadlines.has(name)) {
      // Workflows' default event timeout is 24 hours.
      this.deadlines.set(name, this.clock.now().getTime() + toMs(options.timeout, 86_400_000));
    }
    const i = this.inbox.findIndex((e) => e.type === options.type);
    if (i >= 0) {
      const [ev] = this.inbox.splice(i, 1);
      const stored = JSON.parse(JSON.stringify(ev)) as WorkflowStepEvent<T>;
      this.journal.set(name, { ok: true, value: stored });
      return { ...stored, timestamp: new Date(stored.timestamp) };
    }
    if (this.clock.now().getTime() >= (this.deadlines.get(name) ?? 0)) {
      const error = `waitForEvent ${name} timed out`;
      this.journal.set(name, { ok: false, error });
      throw new Error(error);
    }
    return this.suspend(name);
  }
}

/** An EmailSender that records messages instead of sending them. */
export class RecordingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly result: EmailSendResult = { delivered: true }) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    return this.result.delivered
      ? { ...this.result, id: this.result.id ?? `email-${this.sent.length}` }
      : this.result;
  }
}

/** An EmailQueue that keeps what was enqueued; `failWith` makes the next enqueues throw. */
export class RecordingEmailQueue implements EmailQueue {
  readonly jobs: QueuedEmail[] = [];
  failWith: Error | null = null;

  async enqueue(job: QueuedEmail): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.jobs.push(job);
  }
}

/** A WorkflowEngine that records calls; optional hooks let a test drive instances. */
export class RecordingWorkflowEngine implements WorkflowEngine {
  readonly started: { instanceId: string; params: WorkflowRunParams }[] = [];
  readonly events: { instanceId: string; type: string; payload: Record<string, unknown> }[] = [];
  readonly cancelled: string[] = [];

  constructor(
    private readonly hooks: {
      onStart?: (instanceId: string, params: WorkflowRunParams) => Promise<void>;
      onEvent?: (
        instanceId: string,
        type: string,
        payload: Record<string, unknown>,
      ) => Promise<void>;
      onCancel?: (instanceId: string) => Promise<void>;
    } = {},
  ) {}

  async start(instanceId: string, params: WorkflowRunParams): Promise<void> {
    if (this.started.some((s) => s.instanceId === instanceId)) return;
    this.started.push({ instanceId, params });
    await this.hooks.onStart?.(instanceId, params);
  }

  async sendEvent(
    instanceId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.events.push({ instanceId, type, payload });
    await this.hooks.onEvent?.(instanceId, type, payload);
  }

  async cancel(instanceId: string): Promise<void> {
    this.cancelled.push(instanceId);
    await this.hooks.onCancel?.(instanceId);
  }
}
