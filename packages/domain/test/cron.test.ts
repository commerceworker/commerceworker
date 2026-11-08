import { describe, expect, it } from 'vitest';
import { assertValidCron, nextCronOccurrence, ValidationError } from '../src/index';

const at = (iso: string) => new Date(iso);
const next = (expr: string, from: string) => nextCronOccurrence(expr, at(from)).toISOString();

describe('nextCronOccurrence (UTC)', () => {
  it('every minute advances by one minute, dropping seconds', () => {
    expect(next('* * * * *', '2026-03-10T12:30:45.500Z')).toBe('2026-03-10T12:31:00.000Z');
  });

  it('fixed minute each hour', () => {
    expect(next('15 * * * *', '2026-03-10T12:14:00Z')).toBe('2026-03-10T12:15:00.000Z');
    expect(next('15 * * * *', '2026-03-10T12:15:00Z')).toBe('2026-03-10T13:15:00.000Z');
  });

  it('daily at a fixed time rolls to the next day once passed', () => {
    expect(next('0 2 * * *', '2026-03-10T01:00:00Z')).toBe('2026-03-10T02:00:00.000Z');
    expect(next('0 2 * * *', '2026-03-10T02:00:00Z')).toBe('2026-03-11T02:00:00.000Z');
  });

  it('steps and ranges', () => {
    expect(next('*/15 * * * *', '2026-03-10T12:16:00Z')).toBe('2026-03-10T12:30:00.000Z');
    expect(next('0 9-17/4 * * *', '2026-03-10T10:00:00Z')).toBe('2026-03-10T13:00:00.000Z');
    expect(next('5,35 * * * *', '2026-03-10T12:06:00Z')).toBe('2026-03-10T12:35:00.000Z');
  });

  it('day-of-week: weekly on Monday (2026-03-10 is a Tuesday)', () => {
    expect(next('0 9 * * 1', '2026-03-10T00:00:00Z')).toBe('2026-03-16T09:00:00.000Z');
    // 7 aliases Sunday.
    expect(next('0 9 * * 7', '2026-03-10T00:00:00Z')).toBe('2026-03-15T09:00:00.000Z');
  });

  it('day-of-month and month', () => {
    expect(next('0 0 1 * *', '2026-03-10T00:00:00Z')).toBe('2026-04-01T00:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('vixie OR: when both dom and dow are restricted, either fires', () => {
    // Next 13th OR Friday after Tue 2026-03-10 → Friday 2026-03-13 matches both,
    // but Wed 2026-03-11? Not 13th, not Friday. Fri 13th is 2026-03-13; the
    // first match is actually Friday 2026-03-13 — but an earlier Friday would
    // win if one existed. Verify with a spread: 13th of month OR Monday.
    expect(next('0 0 13 * 1', '2026-03-10T00:00:00Z')).toBe('2026-03-13T00:00:00.000Z'); // 13th
    expect(next('0 0 20 * 1', '2026-03-13T01:00:00Z')).toBe('2026-03-16T00:00:00.000Z'); // Monday
  });

  it('strictly after: never returns the input instant', () => {
    expect(next('30 12 10 3 *', '2026-03-10T12:30:00Z')).toBe('2027-03-10T12:30:00.000Z');
  });

  it('rejects malformed and unsatisfiable expressions', () => {
    for (const bad of [
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      'a * * * *',
      '*/0 * * * *',
      '5-1 * * * *',
      '-5 * * * *',
      '5- * * * *',
      '1//2 * * * *',
    ]) {
      expect(() => assertValidCron(bad), bad).toThrow(ValidationError);
    }
    // Satisfiable-looking but impossible date: Feb 30. The detail lives in the
    // ValidationError's field issues (the top-level message is generic).
    let caught: unknown;
    try {
      nextCronOccurrence('0 0 30 2 *', at('2026-01-01T00:00:00Z'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).issues[0]?.message).toMatch(/never matches/);
  });
});
