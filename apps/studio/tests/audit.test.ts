import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_GROUPS, describeEvent, isAuditGroup } from '../app/lib/audit';

describe('audit vocabulary', () => {
  it('describes events in one line', () => {
    expect(
      describeEvent({
        action: 'team.role_changed',
        actor: 'ops@example.com',
        target: 'ann@example.com',
        detail: { from: 'member', to: 'admin' },
      }),
    ).toBe('Changed a role: ann@example.com, Member → Admin');
    expect(
      describeEvent({
        action: 'team.user_added',
        actor: 'ops',
        target: 'ann@example.com',
        detail: { role: 'member' },
      }),
    ).toBe('Added a person: ann@example.com, Member');
    expect(
      describeEvent({
        action: 'team.user_disabled',
        actor: 'ops',
        target: 'ann@example.com',
        detail: { sessions: 2 },
      }),
    ).toBe('Disabled a person: ann@example.com, 2 sessions ended');
    expect(
      describeEvent({
        action: 'auth.sign_in_failed',
        actor: null,
        target: 'ann@example.com',
        detail: { reason: 'wrong email or password' },
      }),
    ).toBe('Sign-in failed: ann@example.com, wrong email or password');
    expect(
      describeEvent({
        action: 'auth.sign_in',
        actor: 'ann@example.com',
        target: null,
        detail: { twoFactor: 'app' },
      }),
    ).toBe('Signed in: two-factor app');
    expect(
      describeEvent({
        action: 'auth.recovery_code_used',
        actor: 'ann@example.com',
        target: 'ann@example.com',
        detail: { left: 9 },
      }),
    ).toBe('Used a recovery code: ann@example.com, 9 left');
    expect(
      describeEvent({ action: 'auth.sign_out', actor: 'ann', target: null, detail: null }),
    ).toBe('Signed out');
    expect(
      describeEvent({ action: 'something.new', actor: null, target: null, detail: null }),
    ).toBe('something.new');
  });

  it('records nothing from commerce or api credentials', () => {
    const gone = ['order', 'cart', 'flow', 'catalog', 'plugin', 'token', 'oauth', 'ucp'];
    for (const action of Object.keys(AUDIT_ACTIONS))
      expect(gone).not.toContain(action.slice(0, action.indexOf('.')));
  });

  it('puts every action in a filter group', () => {
    for (const action of Object.keys(AUDIT_ACTIONS))
      expect(isAuditGroup(action.slice(0, action.indexOf('.')))).toBe(true);
    expect(Object.keys(AUDIT_GROUPS)).toEqual(['auth', 'team', 'scim']);
    expect(isAuditGroup('orders')).toBe(false);
  });
});
