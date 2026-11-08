/**
 * Invitations to the admin: a deployment administrator invites an email with a deployment role
 * (`member` or `admin`) and roles in any number of spaces; whoever holds the link joins with
 * exactly that.
 *
 * The link is a credential, so it is handled like an API key: a high-entropy token, returned once
 * (to the inviter, as a link to copy) and stored only as its peppered hash. When the deployment
 * sends email, the engine mails a link of its own (`deliverInviteEmail`), whose token is minted
 * there and likewise kept only as a hash; nothing that could rebuild a link is ever stored or put
 * on a queue. Either link works once: accepting is a compare-and-set on the invitation's `version`
 * in the same unit of work as the team places it grants, so of two racing accepts one wins and the
 * other fails cleanly. A resend issues a new token (the old links stop working); a revoke ends it.
 *
 * Accepting is the web app's sign-up handshake (`/invite/:token`): it creates or signs in the
 * person, then redeems the token here for them, as the deployment. That is why redeeming needs a
 * deployment-wide principal too, and why it is on HTTP only: an agent never holds someone's link.
 *
 * Every action is recorded in the audit trail of each space the invitation grants a role in.
 */
import {
  assertCanGrant,
  authorize,
  authorizeInviter,
  ConflictError,
  type DomainEvent,
  INVITE_MAX_TTL_DAYS,
  INVITE_TTL_DAYS,
  InvalidInviteError,
  InvalidStateError,
  type InviteActor,
  type InviteEmailDueEvent,
  type InviteGrant,
  type InviteRole,
  type InviteStatus,
  inviteActorOf,
  invitePending,
  inviteStatus,
  isEmail,
  isInviteRole,
  MAX_INVITE_GRANTS,
  type MemberInvite,
  NotFoundError,
  normalizeEmail,
  type Principal,
  type Role,
  SCOPES,
  type SpaceMember,
  ValidationError,
} from '@commerceworker/domain';
import type { AuditEntry, EmailSender, Hasher } from '@commerceworker/ports';
import { TransactionConflictError } from '@commerceworker/ports';
import { auditActor } from './audit';
import type { AppContext } from './context';
import { resolveRoleRef } from './team';
import { randomSecret, secureTokenEqual } from './token-crypto';

/** Where an invitation's link opens on the admin's origin: `/invite/<token>`. */
export const INVITE_PATH = '/invite/';

/** Every token starts with this, so a leaked one is recognisable (secret scanners, logs). */
const TOKEN_PREFIX = 'cwi_';
/** 32 random bytes, base64url. */
const TOKEN_SHAPE = /^cwi_[A-Za-z0-9_-]{43}$/;

/** The scope every invitation action is filed under: invitations belong to no one space. */
const DEPLOYMENT_SCOPE = { spaceId: '*', environmentId: 'main' } as const;

const DAY_MS = 86_400_000;

/** True for a string shaped like an invitation token (checked before any lookup). */
export const isInviteToken = (v: unknown): v is string =>
  typeof v === 'string' && TOKEN_SHAPE.test(v);

const newToken = () => `${TOKEN_PREFIX}${randomSecret(32)}`;

/** The link for `token` on the admin's `origin`. */
export const inviteUrl = (origin: string, token: string): string =>
  `${origin.replace(/\/$/, '')}${INVITE_PATH}${token}`;

/** An invitation as callers see it: never a token hash. */
export interface InviteView {
  readonly id: string;
  readonly email: string;
  readonly role: InviteRole;
  readonly grants: readonly InviteGrant[];
  readonly status: InviteStatus;
  readonly expiresAt: string;
  readonly invitedBy: InviteActor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sentAt: string;
  readonly sendCount: number;
  readonly emailedAt?: string;
  readonly acceptedAt?: string;
  readonly acceptedBy?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: InviteActor;
}

export function inviteView(invite: MemberInvite, now: Date): InviteView {
  const { tokenHash: _token, emailTokenHash: _emailed, version: _version, ...rest } = invite;
  return { ...rest, status: inviteStatus(invite, now) };
}

/** A new link, shown once: to the inviter at creation or a resend. */
export interface IssuedInvite {
  readonly invite: InviteView;
  readonly token: string;
  /** The link on the admin's origin, when the deployment knows it. */
  readonly url?: string;
}

export interface InviteLinkOptions {
  /**
   * The admin's origin (`OAUTH_ISSUER`), where `/invite/<token>` opens. With it, the engine is
   * asked to email the link (it does when the deployment sends email); without it, nothing is
   * emailed and only the token comes back.
   */
  readonly origin?: string;
}

export interface CreateInviteInput {
  readonly email: string;
  /** The deployment role they join with (default `member`). */
  readonly role?: InviteRole;
  /** Roles in spaces: a role id, or a preset name (`viewer` … `admin`). */
  readonly grants?: readonly { readonly space: string; readonly role: string }[];
  /** How long the link works, 1–30 days (default 7). */
  readonly expiresInDays?: number;
}

function ttlMs(days: number | undefined): number {
  const d = days ?? INVITE_TTL_DAYS;
  if (!Number.isInteger(d) || d < 1 || d > INVITE_MAX_TTL_DAYS) {
    throw new ValidationError([
      { field: 'expiresInDays', message: `Between 1 and ${INVITE_MAX_TTL_DAYS} days` },
    ]);
  }
  return d * DAY_MS;
}

function emailDue(ctx: AppContext, invite: MemberInvite, origin: string): InviteEmailDueEvent {
  return {
    id: ctx.ids.newId(),
    type: 'invite.email_due',
    scope: DEPLOYMENT_SCOPE,
    occurredAt: ctx.clock.now().toISOString(),
    inviteId: invite.id,
    version: invite.version,
    origin,
  };
}

/**
 * Records an invitation action. Always one structured log line (`invite_audit`, which Logpush
 * carries like the admin's `audit_event` lines), since the api has no deployment-wide audit log
 * and an invitation may grant no space; then one `audit_log` row per space it grants a role in.
 * Failures never fail the action. Never the token or its hash.
 */
async function auditInvite(
  ctx: AppContext,
  actor: string,
  action: 'invite.created' | 'invite.resent' | 'invite.revoked' | 'invite.accepted',
  invite: MemberInvite,
  status = 200,
): Promise<void> {
  const at = ctx.clock.now().toISOString();
  const spaces = [...new Set(invite.grants.map((g) => g.spaceId))];
  console.log(
    JSON.stringify({
      type: 'invite_audit',
      at,
      action,
      actor,
      inviteId: invite.id,
      email: invite.email,
      role: invite.role,
      spaces,
    }),
  );
  for (const spaceId of spaces) {
    const entry: AuditEntry = {
      id: ctx.ids.newId(),
      spaceId,
      actor,
      action,
      targetType: 'invite',
      targetId: invite.id,
      status,
      at,
    };
    try {
      await ctx.store.audit.append(entry);
    } catch {
      /* auditing must never break the action */
    }
  }
}

/** The roles an invitation's grants name now; a grant whose role is gone is left out. */
async function grantedRoles(ctx: AppContext, grants: readonly InviteGrant[]): Promise<Role[]> {
  const roles = await Promise.all(grants.map((g) => ctx.store.roles.get(g.spaceId, g.roleId)));
  return roles.filter((r): r is Role => !!r);
}

/**
 * Invites `input.email`. Refused (403) unless the caller manages people across the deployment and
 * holds everything the invitation grants; refused (409) while the address has a pending
 * invitation (resend that one instead).
 */
export async function createInvite(
  ctx: AppContext,
  hasher: Hasher,
  principal: Principal,
  input: CreateInviteInput,
  opts: InviteLinkOptions = {},
): Promise<IssuedInvite> {
  authorizeInviter(principal);
  const email = normalizeEmail(input.email ?? '');
  if (!isEmail(email) || email.length > 320) {
    throw new ValidationError([{ field: 'email', message: 'A valid email address is required' }]);
  }
  const role = input.role ?? 'member';
  if (!isInviteRole(role)) {
    throw new ValidationError([{ field: 'role', message: 'Pick a role: member or admin' }]);
  }
  const asked = input.grants ?? [];
  if (asked.length > MAX_INVITE_GRANTS) {
    throw new ValidationError([
      { field: 'grants', message: `At most ${MAX_INVITE_GRANTS} spaces per invitation` },
    ]);
  }
  const spaces = new Set<string>();
  const roles: Role[] = [];
  for (const [i, g] of asked.entries()) {
    if (spaces.has(g.space)) {
      throw new ValidationError([{ field: `grants[${i}].space`, message: 'Each space once' }]);
    }
    spaces.add(g.space);
    if (!g.space || g.space === '*') throw new NotFoundError('Space', g.space);
    const space = await ctx.store.spaces.getConfig({ spaceId: g.space, environmentId: 'main' });
    if (!space) throw new NotFoundError('Space', g.space);
    roles.push(await resolveRoleRef(ctx, g.space, g.role));
  }
  assertCanGrant(
    principal,
    role,
    roles.map((r) => ({ spaceId: r.spaceId, scopes: r.scopes, contentGrants: r.contentGrants })),
  );
  const now = ctx.clock.now();
  const [pending] = await ctx.store.invites.list({ now, status: 'pending', email, limit: 1 });
  if (pending) {
    throw new ConflictError(`${email} already has a pending invitation; resend it instead`);
  }
  const token = newToken();
  const at = now.toISOString();
  const invite: MemberInvite = {
    id: ctx.ids.newId(),
    email,
    role,
    grants: roles.map((r) => ({ spaceId: r.spaceId, roleId: r.id })),
    tokenHash: hasher.hash(token),
    status: 'pending',
    expiresAt: new Date(now.getTime() + ttlMs(input.expiresInDays)).toISOString(),
    version: 1,
    invitedBy: inviteActorOf(principal),
    createdAt: at,
    updatedAt: at,
    sentAt: at,
    sendCount: 1,
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.invites.create(invite);
    if (opts.origin) await tx.outbox.append(emailDue(ctx, invite, opts.origin));
  });
  await auditInvite(ctx, auditActor(principal), 'invite.created', invite, 201);
  return {
    invite: inviteView(invite, now),
    token,
    ...(opts.origin ? { url: inviteUrl(opts.origin, token) } : {}),
  };
}

/** Invitations, newest first; `status` narrows them (`expired` included, as read now). */
export async function listInvites(
  ctx: AppContext,
  principal: Principal,
  query: { readonly status?: InviteStatus; readonly limit?: number } = {},
): Promise<InviteView[]> {
  authorizeInviter(principal);
  const now = ctx.clock.now();
  const rows = await ctx.store.invites.list({ now, ...query });
  return rows.map((i) => inviteView(i, now));
}

async function existing(ctx: AppContext, id: string): Promise<MemberInvite> {
  const invite = await ctx.store.invites.get(id);
  if (!invite) throw new NotFoundError('Invite', id);
  return invite;
}

/** One invitation by id (what a step-up decides on: its role, as stored). */
export async function getInvite(
  ctx: AppContext,
  principal: Principal,
  id: string,
): Promise<InviteView> {
  authorizeInviter(principal);
  return inviteView(await existing(ctx, id), ctx.clock.now());
}

/**
 * Issues a new link for a pending (or expired) invitation: a new token, a fresh expiry, and the
 * old links (shown or emailed) stop working. The caller must be able to grant what it grants,
 * as at creation.
 */
export async function resendInvite(
  ctx: AppContext,
  hasher: Hasher,
  principal: Principal,
  id: string,
  input: { readonly expiresInDays?: number } = {},
  opts: InviteLinkOptions = {},
): Promise<IssuedInvite> {
  authorizeInviter(principal);
  const invite = await existing(ctx, id);
  if (invite.status !== 'pending') {
    throw new InvalidStateError(`This invitation was ${invite.status}; send a new one instead`);
  }
  const roles = await grantedRoles(ctx, invite.grants);
  assertCanGrant(
    principal,
    invite.role,
    roles.map((r) => ({ spaceId: r.spaceId, scopes: r.scopes, contentGrants: r.contentGrants })),
  );
  const now = ctx.clock.now();
  const at = now.toISOString();
  const token = newToken();
  const { emailTokenHash: _emailed, emailedAt: _at, ...rest } = invite;
  const next: MemberInvite = {
    ...rest,
    tokenHash: hasher.hash(token),
    expiresAt: new Date(now.getTime() + ttlMs(input.expiresInDays)).toISOString(),
    version: invite.version + 1,
    updatedAt: at,
    sentAt: at,
    sendCount: invite.sendCount + 1,
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.invites.replace(next, invite.version);
    if (opts.origin) await tx.outbox.append(emailDue(ctx, next, opts.origin));
  });
  await auditInvite(ctx, auditActor(principal), 'invite.resent', next);
  return {
    invite: inviteView(next, now),
    token,
    ...(opts.origin ? { url: inviteUrl(opts.origin, token) } : {}),
  };
}

/** Ends an invitation: its links stop working. Revoking a revoked one changes nothing. */
export async function revokeInvite(
  ctx: AppContext,
  principal: Principal,
  id: string,
): Promise<InviteView> {
  authorizeInviter(principal);
  const invite = await existing(ctx, id);
  const now = ctx.clock.now();
  if (invite.status === 'revoked') return inviteView(invite, now);
  if (invite.status === 'accepted') {
    throw new InvalidStateError('This invitation was accepted; change their access instead');
  }
  const at = now.toISOString();
  const next: MemberInvite = {
    ...invite,
    status: 'revoked',
    version: invite.version + 1,
    updatedAt: at,
    revokedAt: at,
    revokedBy: inviteActorOf(principal),
  };
  await ctx.store.invites.replace(next, invite.version);
  await auditInvite(ctx, auditActor(principal), 'invite.revoked', next);
  return inviteView(next, now);
}

/** Only the web app's sign-up handshake (and the root tokens) redeems a link. */
const authorizeRedeemer = (principal: Principal) => authorize(principal, SCOPES.spaceAdmin, '*');

/** The pending invitation `token` opens, or InvalidInviteError (one error for every failure). */
async function pendingFor(ctx: AppContext, hasher: Hasher, token: string): Promise<MemberInvite> {
  if (!isInviteToken(token)) throw new InvalidInviteError();
  const hash = hasher.hash(token);
  const invite = await ctx.store.invites.findByTokenHash(hash);
  // The lookup matched on the hash already; the comparison again in constant time keeps the
  // decision itself free of a timing side channel, whatever the index does.
  const matches =
    !!invite &&
    (secureTokenEqual(hash, invite.tokenHash) ||
      (invite.emailTokenHash !== undefined && secureTokenEqual(hash, invite.emailTokenHash)));
  if (!invite || !matches || !invitePending(invite, ctx.clock.now())) {
    throw new InvalidInviteError();
  }
  return invite;
}

/** What the invitation page shows before someone accepts. */
export interface InvitePreview {
  readonly invite: InviteView;
  /** Each granted space with its name and the role's name, as they read now. */
  readonly spaces: readonly { spaceId: string; name: string; roleId: string; role: string }[];
}

/** The pending invitation behind `token`, for the page that accepts it. Writes nothing. */
export async function previewInvite(
  ctx: AppContext,
  hasher: Hasher,
  principal: Principal,
  token: string,
): Promise<InvitePreview> {
  authorizeRedeemer(principal);
  const invite = await pendingFor(ctx, hasher, token);
  const spaces = [];
  for (const g of invite.grants) {
    const [space, role] = await Promise.all([
      ctx.store.spaces.getConfig({ spaceId: g.spaceId, environmentId: 'main' }),
      ctx.store.roles.get(g.spaceId, g.roleId),
    ]);
    if (space && role) spaces.push({ ...g, name: space.name, role: role.name });
  }
  return { invite: inviteView(invite, ctx.clock.now()), spaces };
}

/** Who is accepting, as the web app vouches for them (its signed-in or newly made person). */
export interface InviteAcceptor {
  /** Their web user id (`usr_…`). */
  readonly subject: string;
  readonly email: string;
}

export type GrantOutcome = 'added' | 'already_member' | 'role_missing';

export interface AcceptedInvite {
  readonly invite: InviteView;
  readonly role: InviteRole;
  readonly grants: readonly (InviteGrant & { readonly outcome: GrantOutcome })[];
}

/**
 * Redeems `token` for `person`: the invitation becomes accepted and they join each space's team
 * with its role, in one unit of work. Only for the address it was sent to. A person already on a
 * space's team keeps the role they have there (changing it is the space admins'), and a role
 * deleted since the invitation was sent is skipped. A token that is unknown, used, revoked,
 * expired, rotated, for another address or lost to a concurrent accept is InvalidInviteError.
 */
export async function acceptInvite(
  ctx: AppContext,
  hasher: Hasher,
  principal: Principal,
  token: string,
  person: InviteAcceptor,
): Promise<AcceptedInvite> {
  authorizeRedeemer(principal);
  const invite = await pendingFor(ctx, hasher, token);
  if (!person.subject || normalizeEmail(person.email ?? '') !== invite.email) {
    throw new InvalidInviteError();
  }
  const now = ctx.clock.now();
  const at = now.toISOString();
  // Reads first: the unit below can't see its own writes.
  const plan = await Promise.all(
    invite.grants.map(async (g) => {
      const [role, member] = await Promise.all([
        ctx.store.roles.get(g.spaceId, g.roleId),
        ctx.store.members.getByEmail(g.spaceId, invite.email),
      ]);
      const outcome: GrantOutcome = !role ? 'role_missing' : member ? 'already_member' : 'added';
      return { ...g, outcome };
    }),
  );
  const accepted: MemberInvite = {
    ...invite,
    status: 'accepted',
    version: invite.version + 1,
    updatedAt: at,
    acceptedAt: at,
    acceptedBy: person.subject,
  };
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.invites.replace(accepted, invite.version);
      for (const g of plan) {
        if (g.outcome !== 'added') continue;
        const member: SpaceMember = {
          id: ctx.ids.newId(),
          spaceId: g.spaceId,
          email: invite.email,
          subject: person.subject,
          roleId: g.roleId,
          disabled: false,
          createdAt: at,
          updatedAt: at,
        };
        await tx.members.save(member);
      }
    });
  } catch (err) {
    // Another accept, a resend or a revoke got there first: this link no longer works.
    if (err instanceof TransactionConflictError) throw new InvalidInviteError();
    throw err;
  }
  await auditInvite(ctx, person.subject, 'invite.accepted', accepted);
  return { invite: inviteView(accepted, now), role: invite.role, grants: plan };
}

// ---- the engine's half: emailing the link ----------------------------------------------------

export interface InviteMailDeps {
  readonly email: EmailSender;
  readonly hasher: Hasher;
}

export type InviteMailOutcome = 'sent' | 'stale' | 'already_sent';

/**
 * Emails an invitation's link (`invite.email_due`). The token is minted here and recorded only as
 * its hash before the send; the email is the one place it goes. Stale events (the invitation was
 * resent, revoked, accepted or has expired since) send nothing, and so does a redelivery after the
 * send was recorded. A send that fails throws, so the queue retries with a fresh token; if the
 * send went but recording it didn't, the retry mails a second link and the first stops working.
 */
export async function deliverInviteEmail(
  ctx: AppContext,
  deps: InviteMailDeps,
  event: InviteEmailDueEvent,
): Promise<InviteMailOutcome> {
  const invite = await ctx.store.invites.get(event.inviteId);
  if (!invite || invite.version !== event.version || !invitePending(invite, ctx.clock.now())) {
    return 'stale';
  }
  if (invite.emailedAt) return 'already_sent';
  const token = newToken();
  const hash = deps.hasher.hash(token);
  if (!(await ctx.store.invites.recordEmailToken(invite.id, invite.version, hash, null))) {
    return 'stale';
  }
  const url = inviteUrl(event.origin, token);
  const expires = new Date(invite.expiresAt).toUTCString();
  const sent = await deps.email.send({
    to: [invite.email],
    subject: 'You’re invited to commerceworker',
    text: [
      'You have been invited to sign in to commerceworker.',
      '',
      `Accept the invitation: ${url}`,
      '',
      `The link works once, until ${expires}. If you weren’t expecting it, ignore this email.`,
    ].join('\n'),
  });
  if (!sent.delivered) throw new Error(`Invite email not delivered: ${sent.error ?? 'unknown'}`);
  await ctx.store.invites.recordEmailToken(
    invite.id,
    invite.version,
    hash,
    ctx.clock.now().toISOString(),
  );
  return 'sent';
}

/** True for the control event that asks the engine to email an invitation. */
export const isInviteEmailDue = (event: DomainEvent): event is InviteEmailDueEvent =>
  event.type === 'invite.email_due';
