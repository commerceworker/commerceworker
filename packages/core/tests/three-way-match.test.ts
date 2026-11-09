import { describe, expect, it } from 'vitest';
import { threeWayMatch } from '../src';

describe('three-way match', () => {
  it('matches when receipt and invoice are both within tolerance of the order', () => {
    expect(threeWayMatch(100, 100, 101, 0.02)).toEqual({ drift: 0.01, match: true });
    expect(threeWayMatch(100, 100, 102, 0.02).match).toBe(true);
  });

  it('measures the larger gap, either way', () => {
    expect(threeWayMatch(100, 90, 101, 0.02)).toEqual({ drift: 0.1, match: false });
    expect(threeWayMatch(100, 100, 110, 0.05).match).toBe(false);
  });

  it('measures a tiny order against 1, so a cent of drift is not 100%', () => {
    expect(threeWayMatch(0.5, 0.5, 0.51, 0.02).match).toBe(true);
    expect(threeWayMatch(0, 0, 0, 0).match).toBe(true);
  });
});
