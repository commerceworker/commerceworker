import { makeMetrics } from '@commerceworker/platform/metrics';
import { describe, expect, it, vi } from 'vitest';

describe('makeMetrics', () => {
  it('writes Analytics Engine data points in the documented layout', () => {
    const points: unknown[] = [];
    const dataset = {
      writeDataPoint: (p: unknown) => void points.push(p),
    } as AnalyticsEngineDataset;
    const metrics = makeMetrics(dataset);

    metrics.count('commerceworker_outbox_relayed_total', 3, { trigger: 'nudge' });
    metrics.count('commerceworker_dead_letters_total');

    expect(points).toEqual([
      {
        indexes: ['commerceworker_outbox_relayed_total'],
        blobs: ['commerceworker_outbox_relayed_total', 'nudge'],
        doubles: [3],
      },
      {
        indexes: ['commerceworker_dead_letters_total'],
        blobs: ['commerceworker_dead_letters_total'],
        doubles: [1],
      },
    ]);
  });

  it('falls back to structured log lines without a dataset', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      makeMetrics(undefined).count('commerceworker_events_consumed_total', 1, {
        type: 'entry.published',
        outcome: 'ok',
      });
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          metric: 'commerceworker_events_consumed_total',
          value: 1,
          type: 'entry.published',
          outcome: 'ok',
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('never lets a failing sink break the caller', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dataset = {
        writeDataPoint: () => {
          throw new Error('quota exceeded');
        },
      } as unknown as AnalyticsEngineDataset;
      expect(() => makeMetrics(dataset).count('commerceworker_relay_errors_total')).not.toThrow();
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});
