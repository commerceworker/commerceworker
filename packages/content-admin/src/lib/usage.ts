import type { AgentRun } from './management';

/** One calendar day of aggregated agent activity. */
export interface UsageBucket {
  /** Local day key, `YYYY-MM-DD`. */
  readonly key: string;
  /** Short axis label, e.g. `6/24`. */
  readonly label: string;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Convenience: `inputTokens + outputTokens`. */
  readonly totalTokens: number;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/**
 * Buckets runs into the last `days` calendar days, oldest → newest, including
 * empty days so charts keep a stable x-axis. `now` is injectable for tests.
 */
export function bucketRunsByDay(
  runs: readonly AgentRun[],
  days = 14,
  now: Date = new Date(),
): UsageBucket[] {
  const index = new Map<string, { runs: number; inputTokens: number; outputTokens: number }>();
  const order: string[] = [];
  const labels = new Map<string, string>();

  for (let i = days - 1; i >= 0; i--) {
    const d = startOfDay(now);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    order.push(key);
    labels.set(key, d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }));
    index.set(key, { runs: 0, inputTokens: 0, outputTokens: 0 });
  }

  for (const r of runs) {
    const bucket = index.get(dayKey(new Date(r.createdAt)));
    if (!bucket) continue;
    bucket.runs += 1;
    bucket.inputTokens += r.inputTokens;
    bucket.outputTokens += r.outputTokens;
  }

  return order.map((key) => {
    const b = index.get(key)!;
    return {
      key,
      label: labels.get(key)!,
      runs: b.runs,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      totalTokens: b.inputTokens + b.outputTokens,
    };
  });
}

/** Period-over-period change in total tokens. */
export interface Growth {
  /** Total tokens in the most recent `days`-day window. */
  readonly current: number;
  /** Total tokens in the `days`-day window immediately before it. */
  readonly previous: number;
  /** Percent change vs the previous window; `null` when there's no prior data. */
  readonly pct: number | null;
}

/** Token totals for the last `days` vs the `days` immediately before. */
export function tokenGrowth(runs: readonly AgentRun[], days = 7, now: Date = new Date()): Growth {
  const start = startOfDay(now);
  start.setDate(start.getDate() - (days - 1));
  const prevStart = new Date(start);
  prevStart.setDate(prevStart.getDate() - days);

  let current = 0;
  let previous = 0;
  for (const r of runs) {
    const t = new Date(r.createdAt).getTime();
    const tokens = r.inputTokens + r.outputTokens;
    if (t >= start.getTime()) current += tokens;
    else if (t >= prevStart.getTime()) previous += tokens;
  }

  const pct = previous === 0 ? null : Math.round(((current - previous) / previous) * 100);
  return { current, previous, pct };
}

/** Per-workflow rollup for the "usage by workflow" breakdown. */
export interface WorkflowUsage {
  readonly workflow: string;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Per-day run counts over the window, oldest → newest (mini-bar series). */
  readonly spark: number[];
}

/** Groups runs by `workflow`, sorted by total tokens descending. */
export function usageByWorkflow(
  runs: readonly AgentRun[],
  days = 7,
  now: Date = new Date(),
): WorkflowUsage[] {
  const byWorkflow = new Map<string, AgentRun[]>();
  for (const r of runs) {
    const list = byWorkflow.get(r.workflow);
    if (list) list.push(r);
    else byWorkflow.set(r.workflow, [r]);
  }

  const result: WorkflowUsage[] = [];
  for (const [workflow, list] of byWorkflow) {
    const buckets = bucketRunsByDay(list, days, now);
    const inputTokens = list.reduce((s, r) => s + r.inputTokens, 0);
    const outputTokens = list.reduce((s, r) => s + r.outputTokens, 0);
    result.push({
      workflow,
      runs: list.length,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      spark: buckets.map((b) => b.runs),
    });
  }
  return result.sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Compact token formatter: `1234 → 1.2K`, `1500000 → 1.5M`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
