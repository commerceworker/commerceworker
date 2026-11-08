import { clampCount, MAX_PAGE_LIMIT, parseEntryQuery } from '@commerceworker/application';
import { describe, expect, it } from 'vitest';

describe('clampCount (pagination DoS guard)', () => {
  it('caps limit at the maximum', () => {
    expect(clampCount('100000000', MAX_PAGE_LIMIT, { min: 1 })).toBe(MAX_PAGE_LIMIT);
    expect(clampCount('1e999', MAX_PAGE_LIMIT, { min: 1 })).toBe(MAX_PAGE_LIMIT);
  });

  it('floors negatives and NaN to the minimum', () => {
    expect(clampCount('-5', MAX_PAGE_LIMIT, { min: 1 })).toBe(1);
    expect(clampCount('abc', MAX_PAGE_LIMIT, { min: 0 })).toBe(0);
  });

  it('passes through in-range values (truncated to int)', () => {
    expect(clampCount('25', MAX_PAGE_LIMIT, { min: 1 })).toBe(25);
    expect(clampCount('25.9', MAX_PAGE_LIMIT, { min: 1 })).toBe(25);
  });

  it('returns undefined for an absent value so defaults apply', () => {
    expect(clampCount(undefined, MAX_PAGE_LIMIT)).toBeUndefined();
    expect(clampCount('', MAX_PAGE_LIMIT)).toBeUndefined();
  });

  it('clamps limit/skip when parsing a query string', () => {
    const q = parseEntryQuery(new URLSearchParams('limit=999999&skip=-3'));
    expect(q.limit).toBe(MAX_PAGE_LIMIT);
    expect(q.skip).toBe(0);
  });
});
