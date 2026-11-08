// Where the sign-in gate holds someone with something due: a temporary password on Account (it
// has the form for it), two-factor sign-in on its own step, and nothing else until it is done.
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const { heldAt, setupPath, TWO_FACTOR_STEP_PATH } = await import('~/lib/auth.server');

const person = {
  kind: 'user',
  id: 'usr_1',
  email: 'a@example.com',
  name: 'A',
  role: 'admin',
} as const;

describe('the sign-in gate', () => {
  it('holds someone whose two-factor sign-in is due on the two-factor step', () => {
    expect(setupPath({ ...person, twoFactorDue: true })).toBe(TWO_FACTOR_STEP_PATH);
  });

  it('holds someone whose own password is due on Account first', () => {
    expect(setupPath({ ...person, passwordChangeDue: true, twoFactorDue: true })).toBe('/account');
  });

  it('holds nobody with nothing due', () => {
    expect(setupPath(person)).toBeNull();
  });

  it('holds pages and their loader data alike, and lets the step through', () => {
    const due = { ...person, twoFactorDue: true as const };
    for (const p of ['/dashboard', '/dashboard.data', '/account', '/account.data', '/setup/space'])
      expect(heldAt(due, p), p).toBe(TWO_FACTOR_STEP_PATH);
    expect(heldAt(due, TWO_FACTOR_STEP_PATH)).toBeNull();
    expect(heldAt(due, `${TWO_FACTOR_STEP_PATH}.data`)).toBeNull();
  });

  it('keeps someone whose password is due off the two-factor step', () => {
    const both = { ...person, passwordChangeDue: true as const, twoFactorDue: true as const };
    expect(heldAt(both, TWO_FACTOR_STEP_PATH)).toBe('/account');
    expect(heldAt(both, `${TWO_FACTOR_STEP_PATH}.data`)).toBe('/account');
    expect(heldAt(both, '/account.data')).toBeNull();
  });
});
