import { describe, expect, it } from 'vitest';
import {
  assertCanGrant,
  ForbiddenError,
  inviteStatus,
  type MemberInvite,
  type Principal,
  SCOPES,
  scopesForKind,
} from '../src/index';

const admin: Principal = {
  spaceId: '*',
  kind: 'user',
  subject: 'usr_a',
  scopes: scopesForKind('cma'),
};
const grant = (scopes: string[], contentGrants: Principal['contentGrants'] = []) => ({
  spaceId: 'blog',
  scopes,
  contentGrants: contentGrants ?? [],
});

describe('what an inviter may grant', () => {
  it('lets a deployment admin grant any preset and the admin role', () => {
    expect(() => assertCanGrant(admin, 'admin', [grant([SCOPES.spaceAdmin])])).not.toThrow();
  });

  it('refuses an admin’s seat from anything but a person', () => {
    const root: Principal = { spaceId: '*', kind: 'admin', scopes: scopesForKind('cma') };
    expect(() => assertCanGrant(root, 'admin', [])).toThrow(/signed in to the admin/);
    expect(() => assertCanGrant(root, 'member', [grant([SCOPES.spaceAdmin])])).not.toThrow();
    expect(() => assertCanGrant({ ...admin, subject: undefined }, 'admin', [])).toThrow();
  });

  it('refuses a scope the inviter lacks, a space they don’t administer, and deployment admin from one space', () => {
    const narrow = { ...admin, scopes: [SCOPES.spaceAdmin] };
    expect(() => assertCanGrant(narrow, 'member', [grant([SCOPES.contentWrite])])).toThrow(
      /content:write/,
    );
    const blogAdmin: Principal = { spaceId: 'blog', kind: 'cma', scopes: scopesForKind('cma') };
    expect(() => assertCanGrant(blogAdmin, 'admin', [])).toThrow(ForbiddenError);
    expect(() => assertCanGrant(blogAdmin, 'member', [{ ...grant([]), spaceId: 'docs' }])).toThrow(
      ForbiddenError,
    );
  });

  it('keeps content grants within the inviter’s own, field rules included', () => {
    const limited: Principal = {
      ...admin,
      contentGrants: [
        { contentTypeApiId: 'post', actions: ['read', 'write'], deniedFields: ['secret'] },
      ],
    };
    const ok = grant(
      [],
      [{ contentTypeApiId: 'post', actions: ['read'], deniedFields: ['secret'] }],
    );
    expect(() => assertCanGrant(limited, 'member', [ok])).not.toThrow();
    for (const wider of [
      { contentTypeApiId: '*', actions: ['read'] as const },
      { contentTypeApiId: 'post', actions: ['publish'] as const },
      { contentTypeApiId: 'post', actions: ['read'] as const },
    ]) {
      expect(() =>
        assertCanGrant(limited, 'member', [grant([], [{ ...wider, actions: [...wider.actions] }])]),
      ).toThrow(/beyond your own/);
    }
  });
});

describe('an invitation’s status', () => {
  it('reads a pending one past its expiry as expired', () => {
    const invite = { status: 'pending', expiresAt: '2026-01-02T00:00:00.000Z' } as MemberInvite;
    expect(inviteStatus(invite, new Date('2026-01-01T23:59:59.999Z'))).toBe('pending');
    expect(inviteStatus(invite, new Date('2026-01-02T00:00:00.000Z'))).toBe('expired');
    expect(inviteStatus({ ...invite, status: 'revoked' }, new Date('2027-01-01'))).toBe('revoked');
  });
});
