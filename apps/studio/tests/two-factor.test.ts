import { describe, expect, it } from 'vitest';
import { describeEvent } from '../app/lib/audit';
import {
  DEFAULT_TWO_FACTOR,
  isTwoFactorRequirement,
  mustUseTwoFactor,
} from '../app/lib/two-factor';

describe('two-factor requirement', () => {
  it('covers the chosen role and the roles above it', () => {
    expect(mustUseTwoFactor('admin', 'off')).toBe(false);
    expect(mustUseTwoFactor('admin', 'admin')).toBe(true);
    expect(mustUseTwoFactor('member', 'admin')).toBe(false);
    expect(mustUseTwoFactor('member', 'member')).toBe(true);
    expect(mustUseTwoFactor('admin', 'member')).toBe(true);
  });

  it('requires it of admins until an admin chooses otherwise', () => {
    expect(mustUseTwoFactor('admin', DEFAULT_TWO_FACTOR)).toBe(true);
    expect(mustUseTwoFactor('member', DEFAULT_TWO_FACTOR)).toBe(false);
  });

  it('accepts only known settings', () => {
    expect(isTwoFactorRequirement('member')).toBe(true);
    expect(isTwoFactorRequirement('off')).toBe(true);
    expect(isTwoFactorRequirement('admin')).toBe(true);
    expect(isTwoFactorRequirement('operator')).toBe(false);
    expect(isTwoFactorRequirement('toString')).toBe(false);
    expect(isTwoFactorRequirement(undefined)).toBe(false);
  });

  it('describes a change in the audit log', () => {
    expect(
      describeEvent({
        action: 'team.two_factor_requirement',
        actor: 'ops@example.com',
        target: null,
        detail: { from: 'off', to: 'admin' },
      }),
    ).toBe('Changed who needs two-factor sign-in: Nobody → Admins');
  });
});
