/**
 * Invitations to the admin: an email, the deployment role the person joins with, and the space
 * roles they get on accepting. The invitation is a credential until it is used: only a hash of its
 * link's token is kept (two, when the engine also emailed a link of its own), it works once, and it
 * stops working when it expires, is revoked or is resent (a resend issues a new token).
 *
 * `expired` is never stored: a pending invitation whose `expiresAt` has passed reads as expired, so
 * no read path has to write.
 */
import { DomainError } from '../errors';
import type { ContentTypeGrant, Principal } from './auth';
import { authorize, grantedActions, grantFor, SCOPES } from './auth';

/** How long an invitation works unless the inviter picks otherwise. */
export const INVITE_TTL_DAYS = 7;
/** The longest an inviter may give one. */
export const INVITE_MAX_TTL_DAYS = 30;
/** Space grants one invitation may carry. */
export const MAX_INVITE_GRANTS = 20;

/** The deployment-level roles a person signs in with (`member` < `admin`). */
export type InviteRole = 'member' | 'admin';
export const isInviteRole = (v: unknown): v is InviteRole => v === 'member' || v === 'admin';

/** What is stored. `expired` is derived (see {@link inviteStatus}). */
export type StoredInviteStatus = 'pending' | 'accepted' | 'revoked';
export type InviteStatus = StoredInviteStatus | 'expired';

/** A role in one space, given on accepting. */
export interface InviteGrant {
  readonly spaceId: string;
  readonly roleId: string;
}

/** Who invited, revoked or resent: the principal as the audit trail names it. */
export interface InviteActor {
  /** `user` for a person signed in to the admin; `admin` for the deployment's root tokens. */
  readonly kind: string;
  /** The person's web user id (`usr_…`), or `admin-token`. */
  readonly id: string;
}

export interface MemberInvite {
  readonly id: string;
  /** Lower-cased. */
  readonly email: string;
  readonly role: InviteRole;
  readonly grants: readonly InviteGrant[];
  /** The hash (TOKEN_PEPPER) of the link handed to the inviter. Never the token. */
  readonly tokenHash: string;
  /** The hash of the link the engine emailed, when it did; dropped by a resend. */
  readonly emailTokenHash?: string;
  readonly status: StoredInviteStatus;
  readonly expiresAt: string;
  /** Bumped by every change: the compare-and-set that makes a token work once. */
  readonly version: number;
  readonly invitedBy: InviteActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the current token was issued (creation or the last resend). */
  readonly sentAt: string;
  /** How many tokens have been issued (1 at creation). */
  readonly sendCount: number;
  /** When the engine emailed the current token's link; absent when it hasn't (or can't). */
  readonly emailedAt?: string;
  readonly acceptedAt?: string;
  /** The web user id of whoever accepted it. */
  readonly acceptedBy?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: InviteActor;
}

/** The status as of `now`: a pending invitation past its expiry reads as `expired`. */
export function inviteStatus(invite: MemberInvite, now: Date): InviteStatus {
  if (invite.status === 'pending' && Date.parse(invite.expiresAt) <= now.getTime()) {
    return 'expired';
  }
  return invite.status;
}

/** True while the invitation's token still works. */
export const invitePending = (invite: MemberInvite, now: Date): boolean =>
  inviteStatus(invite, now) === 'pending';

/**
 * Every way a token fails to work: unknown, used, revoked, expired, rotated by a resend, or for
 * someone else. One message for all of them, so a caller learns nothing about which.
 */
export class InvalidInviteError extends DomainError {
  constructor() {
    super('invalid_invite', 'This invitation link is not valid. Ask for a new one.');
  }
}

/** The actor an invitation records for a principal (as `auditActor` names it). */
export function inviteActorOf(principal: Principal): InviteActor {
  if (principal.kind === 'admin') return { kind: 'admin', id: 'admin-token' };
  return { kind: principal.kind, id: principal.subject ?? principal.kind };
}

/**
 * Refuses an inviter who can't manage people across the deployment: `space:admin` everywhere
 * (`*`), which is a deployment administrator signed in to the admin or one of the root tokens. A
 * space's own keys and its team's administrators manage that space's team, not who may sign in.
 */
export function authorizeInviter(principal: Principal): void {
  authorize(principal, SCOPES.spaceAdmin, '*');
}

/** True when `held` allows at least what `granted` does, both governing the same type. */
function grantCovers(held: ContentTypeGrant, granted: ContentTypeGrant): boolean {
  // Resolved, not as listed: a grant that withholds `delete` doesn't cover one that implies it.
  const heldActions = grantedActions(held);
  if (![...grantedActions(granted)].every((a) => heldActions.has(a))) return false;
  // A field the inviter can't see or change must stay that way for whoever they invite.
  const denied = new Set(granted.deniedFields ?? []);
  if (!(held.deniedFields ?? []).every((f) => denied.has(f))) return false;
  const limited = new Set([...(granted.readOnlyFields ?? []), ...denied]);
  return (held.readOnlyFields ?? []).every((f) => limited.has(f));
}

/**
 * An inviter can't hand out more than they hold. Inviting someone as a deployment `admin` needs
 * deployment-wide `space:admin` and a person (not a root token); a space role needs `space:admin` in that space, every scope the
 * role carries, and (for an inviter whose own access is limited per content type) content grants
 * at least as wide as the role's. Throws `ForbiddenError` naming what is missing.
 */
export function assertCanGrant(
  principal: Principal,
  role: InviteRole,
  grants: readonly {
    readonly spaceId: string;
    readonly scopes: readonly string[];
    readonly contentGrants: readonly ContentTypeGrant[];
  }[],
): void {
  if (role === 'admin') {
    authorize(principal, SCOPES.spaceAdmin, '*');
    // Only a person signed in to the admin (who answered a step-up for it) hands out an admin's
    // seat: the root tokens can't, so every admin made this way is someone's named act.
    if (principal.kind !== 'user' || !principal.subject) {
      throw new InviteEscalationError(
        'Only an admin signed in to the admin can invite someone as an admin',
      );
    }
  }
  for (const g of grants) {
    authorize(principal, SCOPES.spaceAdmin, g.spaceId);
    for (const scope of g.scopes) {
      if (!principal.scopes.includes(scope)) {
        throw new InviteEscalationError(`You can't grant "${scope}": you don't hold it`);
      }
    }
    const held = principal.contentGrants;
    if (held === undefined) continue;
    // Compared type by type, each side by the grant that governs it (an exact type over `*`), so
    // a wildcard can't borrow from one type's grant, nor a type escape its own narrower one.
    const types = new Set(['*', ...[...held, ...g.contentGrants].map((x) => x.contentTypeApiId)]);
    for (const type of types) {
      const granted = grantFor({ ...principal, contentGrants: g.contentGrants }, type);
      if (!granted) continue;
      const governing = grantFor(principal, type);
      if (!governing || !grantCovers(governing, granted)) {
        throw new InviteEscalationError(
          `You can't grant access to "${granted.contentTypeApiId}" beyond your own`,
        );
      }
    }
  }
}

/** A grant wider than the inviter's own access. Maps to HTTP 403, as a missing scope does. */
export class InviteEscalationError extends DomainError {
  constructor(message: string) {
    super('forbidden', message);
  }
}
