import { CREDIT_ENTRY_KINDS } from '@commerceworker/core';
import { describe, expect, it } from 'vitest';
import { amountFrom, ENTRY_KINDS } from '../app/lib/credit';

describe('the credit forms', () => {
  it('reads an amount as it is typed, never negative, to the cent', () => {
    expect(amountFrom('1,250.50')).toBe(1250.5);
    expect(amountFrom(' $1000 ')).toBe(1000);
    expect(amountFrom('0')).toBe(0);
    for (const bad of ['', '  ', '-5', '1.234', 'ten', '1e3', '1.2.3'])
      expect(typeof amountFrom(bad)).toBe('string');
  });

  it('names every kind of ledger entry', () => {
    expect(Object.keys(ENTRY_KINDS).sort()).toEqual([...CREDIT_ENTRY_KINDS].sort());
  });
});
