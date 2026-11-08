import { describe, expect, it } from 'vitest';
import { customerNameKey, matchCustomerByName } from '../src/customers';

describe('customer name matching', () => {
  const people = [
    { id: 'c1', name: 'Northwind Traders, Inc.' },
    { id: 'c2', name: 'Acme' },
    { id: 'c3', name: 'ACME' },
  ];

  it('folds case, punctuation and spacing', () => {
    expect(customerNameKey('  Northwind   Traders, Inc. ')).toBe('northwind traders inc');
  });

  it('attaches the one exact match', () => {
    expect(matchCustomerByName(people, 'northwind traders inc')?.id).toBe('c1');
  });

  it('attaches nobody for a near match, several matches or an empty name', () => {
    expect(matchCustomerByName(people, 'Northwind Trade')).toBeUndefined();
    expect(matchCustomerByName(people, 'acme')).toBeUndefined();
    expect(matchCustomerByName(people, ' , ')).toBeUndefined();
  });
});
