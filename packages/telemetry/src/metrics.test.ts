import { describe, expect, it, vi } from 'vitest';
import { opsMetrics, routeGroup, statusClass } from './metrics';

const recording = () => {
  const points: unknown[] = [];
  return { points, sink: { writeDataPoint: (p: unknown) => void points.push(p) } };
};

describe('opsMetrics', () => {
  it('writes one data point per event in the documented layout', () => {
    const { points, sink } = recording();
    const m = opsMetrics(sink, 'web');
    m.request('api', 503, 12);
    m.stepFailed('commerce.reserve');
    m.d1('health', 4);
    m.failover('ai_heuristic');
    m.reconcileMismatch('stripe');
    expect(points).toEqual([
      { indexes: ['request'], blobs: ['request', 'web', 'api', '5xx'], doubles: [1, 12] },
      {
        indexes: ['step_failed'],
        blobs: ['step_failed', 'web', 'commerce.reserve', ''],
        doubles: [1, 0],
      },
      { indexes: ['d1'], blobs: ['d1', 'web', 'health', ''], doubles: [1, 4] },
      { indexes: ['failover'], blobs: ['failover', 'web', 'ai_heuristic', ''], doubles: [1, 0] },
      {
        indexes: ['reconcile_mismatch'],
        blobs: ['reconcile_mismatch', 'web', 'stripe', ''],
        doubles: [1, 0],
      },
    ]);
  });

  it('does nothing without a binding', () => {
    expect(() => opsMetrics(undefined, 'engine').request('health', 200, 1)).not.toThrow();
  });

  it('never throws, whatever the sink or the log does', () => {
    const sink = {
      writeDataPoint: () => {
        throw new Error('analytics engine is down');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console is down too');
    });
    const error = vi.spyOn(console, 'error');
    try {
      const m = opsMetrics(sink, 'storefront');
      expect(() => {
        m.request('ucp', 200, 3);
        m.stepFailed('x');
        m.d1('p', 1);
        m.failover('email_failed');
      }).not.toThrow();
      // A dropped metric is a warning, never the error-level line that would page someone.
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe('routeGroup and statusClass', () => {
  const groups = [
    ['/health', 'health'],
    ['/api', 'api'],
  ] as const;

  it('matches whole segments and falls back', () => {
    expect(routeGroup('/health', groups)).toBe('health');
    expect(routeGroup('/health/deep', groups)).toBe('health');
    expect(routeGroup('/api/orders/ord_1', groups)).toBe('api');
    expect(routeGroup('/apiary', groups)).toBe('app');
    expect(routeGroup('/orders', groups, 'page')).toBe('page');
  });

  it('classes a status', () => {
    expect([200, 302, 404, 500, 503].map(statusClass)).toEqual(['2xx', '3xx', '4xx', '5xx', '5xx']);
  });
});
