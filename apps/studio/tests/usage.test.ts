import { describe, expect, it } from 'vitest';
import type { AgentRun } from '~/cms/lib/management';
import { bucketRunsByDay, formatTokens, tokenGrowth, usageByWorkflow } from '~/cms/lib/usage';

const NOW = new Date('2026-06-25T12:00:00Z');

/** ISO timestamp `daysAgo` local days before NOW, at local noon — tz-robust. */
function at(daysAgo: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function run(partial: Partial<AgentRun> & { createdAt: string }): AgentRun {
  return {
    id: partial.id ?? 'r1',
    workflow: partial.workflow ?? 'enrich',
    entryId: partial.entryId ?? 'e1',
    status: partial.status ?? 'completed',
    decisions: partial.decisions ?? [],
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    createdAt: partial.createdAt,
  };
}

describe('bucketRunsByDay', () => {
  it('returns one zero-filled bucket per day, oldest → newest', () => {
    const buckets = bucketRunsByDay([], 14, NOW);
    expect(buckets).toHaveLength(14);
    expect(buckets.every((b) => b.totalTokens === 0)).toBe(true);
    // Keys are unique and ascending.
    const keys = buckets.map((b) => b.key);
    expect(new Set(keys).size).toBe(14);
    expect([...keys].sort()).toEqual(keys);
  });

  it('aggregates tokens and run counts into the matching day', () => {
    const runs = [
      run({ createdAt: at(0), inputTokens: 10, outputTokens: 5 }),
      run({ createdAt: at(0), inputTokens: 4, outputTokens: 1 }),
      run({ createdAt: at(1), inputTokens: 3, outputTokens: 2 }),
    ];
    const buckets = bucketRunsByDay(runs, 14, NOW);
    const today = buckets[buckets.length - 1]!;
    expect(today.runs).toBe(2);
    expect(today.inputTokens).toBe(14);
    expect(today.outputTokens).toBe(6);
    expect(today.totalTokens).toBe(20);
    expect(buckets[buckets.length - 2]!.totalTokens).toBe(5);
  });

  it('ignores runs older than the window', () => {
    const buckets = bucketRunsByDay([run({ createdAt: at(60), inputTokens: 99 })], 14, NOW);
    expect(buckets.reduce((s, b) => s + b.totalTokens, 0)).toBe(0);
  });
});

describe('tokenGrowth', () => {
  it('compares the recent window against the one before it', () => {
    const runs = [
      run({ createdAt: at(2), inputTokens: 100 }), // current 7-day window
      run({ createdAt: at(10), inputTokens: 50 }), // previous 7-day window
    ];
    const g = tokenGrowth(runs, 7, NOW);
    expect(g.current).toBe(100);
    expect(g.previous).toBe(50);
    expect(g.pct).toBe(100);
  });

  it('reports null pct when there is no prior data', () => {
    const g = tokenGrowth([run({ createdAt: at(0), inputTokens: 10 })], 7, NOW);
    expect(g.pct).toBeNull();
  });
});

describe('usageByWorkflow', () => {
  it('groups by workflow and sorts by total tokens descending', () => {
    const runs = [
      run({ workflow: 'enrich', createdAt: at(0), inputTokens: 5 }),
      run({ workflow: 'moderate', createdAt: at(0), inputTokens: 50 }),
      run({ workflow: 'moderate', createdAt: at(1), inputTokens: 10 }),
    ];
    const rows = usageByWorkflow(runs, 7, NOW);
    expect(rows.map((r) => r.workflow)).toEqual(['moderate', 'enrich']);
    expect(rows[0]!.runs).toBe(2);
    expect(rows[0]!.totalTokens).toBe(60);
    expect(rows[0]!.spark).toHaveLength(7);
    expect(rows[0]!.spark[rows[0]!.spark.length - 1]).toBe(1); // 1 moderate run today
  });
});

describe('formatTokens', () => {
  it('formats with K/M suffixes', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});
