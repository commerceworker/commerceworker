import { describe, expect, it } from 'vitest';
import { entitlementCode, pickupCode, stringHash } from '../src/codes';

describe('codes', () => {
  it('hashes the way the engine always has (golden)', () => {
    expect(stringHash('')).toBe(0);
    expect(stringHash('pkp_ord_1_pickup_0')).toBe(stringHash('pkp_ord_1_pickup_0'));
    expect(stringHash('abc')).toBe(96354);
  });

  it('derives the same pickup and entitlement code from the same id', () => {
    expect(pickupCode('pkp_ord_1_pickup_0')).toMatch(/^[0-9A-Z]{6}$/);
    expect(pickupCode('pkp_ord_1_pickup_0')).toBe(pickupCode('pkp_ord_1_pickup_0'));
    expect(entitlementCode('EBOOK-1', 'ent_ord_1_x_0_0')).toMatch(
      /^EBOOK-1-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );
    expect(entitlementCode('EBOOK-1', 'ent_ord_1_x_0_0')).not.toBe(
      entitlementCode('EBOOK-1', 'ent_ord_1_x_0_1'),
    );
  });
});
