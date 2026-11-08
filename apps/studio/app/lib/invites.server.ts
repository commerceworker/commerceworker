/**
 * Invitations, from the admin's side. The api keeps them (`/deployment/invites`: only token
 * hashes, single use, expiry); this Worker manages them for the Team page, signed as the admin
 * acting, and runs the sign-up handshake at `/invite/:token`, signed as itself acting for the
 * deployment (the api's lookup and accept need a deployment-wide principal, so nothing outside
 * this Worker can redeem a link on someone's behalf).
 *
 * Joining fails closed. A new person's account is redeemed for first, under the id it is about to
 * have: the api consumes the link (compare-and-set) and puts them on each space's team in one
 * unit of work, and only then is the `users` row written. If that write fails, the link is spent
 * and no one was created; the admin resends. Someone whose address already has an account signs in
 * as that person, and accepting adds the grants (and the admin role, if the invitation gives it).
 *
 * Every attempt is throttled per address (`invite-ip`), like sign-in, and every failure looks the
 * same to the browser (`INVITE_INVALID`, `INVITE_NOT_ACCEPTED`); the audit log says why. The token
 * is never logged, audited or stored here.
 */

import {
  hashPassword,
  isEmail,
  normalizeEmail,
  passwordProblem,
} from '@commerceworker/security/credentials';
import { principalTarget } from '@commerceworker/security/principal';
import { users } from '@commerceworker/store/auth';
import { eq } from 'drizzle-orm';
import { audit, clientIp } from './audit.server';
import { type Caller, forgetUserCount, recordFailure, Throttled, waitFor } from './auth.server';
import { api, db, passwordPepper } from './env.server';
import { newId } from './ids';
import { INVITE_INVALID, INVITE_NOT_ACCEPTED, type Invite } from './invites';
import { type SignedPrincipal, setPrincipalHeader } from './principal.server';
import type { Principal, Role } from './roles';
import { ssoOnlyInEffect } from './settings.server';
import type { SsoIdentity } from './sso';
import { throttleKey } from './throttle';

/** A refusal the page shows as it is (the api's words for management; generic for joining). */
export class InviteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** This Worker, acting for the deployment in the sign-up handshake (as `access.server.ts`). */
const SYSTEM: SignedPrincipal = {
  kind: 'user',
  id: 'system:web',
  email: '',
  name: 'commerceworker web',
  role: 'admin',
};

type ApiError = { error?: { code?: string; message?: string } };

/** One call to the api over the binding, signed for `by` and this exact path. */
async function call<T>(
  by: SignedPrincipal,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; status: number; code?: string; message: string }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  await setPrincipalHeader(headers, by, principalTarget(method, path.split('?')[0]!));
  const res = await api().fetch(`https://api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.ok) return { ok: true, value: (await res.json()) as T };
  const err = ((await res.json().catch(() => ({}))) as ApiError).error;
  return {
    ok: false,
    status: res.status,
    code: err?.code,
    message: err?.message ?? `The api refused (${res.status})`,
  };
}

const signed = (me: Principal): SignedPrincipal => ({ ...me, email: me.email ?? '' });

// ── The Team page ──

export type Issued = { invite: Invite; token: string; url?: string };
export type SpaceChoice = { id: string; name: string };

export async function listInvites(me: Principal): Promise<Invite[]> {
  const r = await call<{ items: Invite[] }>(signed(me), 'GET', '/deployment/invites?limit=200');
  if (!r.ok) throw new InviteError(r.message, r.status);
  return r.value.items;
}

/** The spaces an admin can grant roles in, for the invite dialog. */
export async function spaceChoices(me: Principal): Promise<SpaceChoice[]> {
  const r = await call<{ items: SpaceChoice[] }>(signed(me), 'GET', '/spaces');
  return r.ok ? r.value.items : [];
}

/** The link to show the inviter, on this origin (the api's `url` is the configured one). */
const linkFor = (request: Request, issued: Issued) =>
  issued.url ?? new URL(`/invite/${issued.token}`, request.url).href;

export async function createInvite(
  request: Request,
  me: Principal,
  input: { email: string; role: string; space?: string; spaceRole?: string },
): Promise<{ email: string; link: string; expiresAt: string }> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new InviteError('Enter a valid email address.');
  const role: Role = input.role === 'admin' ? 'admin' : 'member';
  const grants = input.space ? [{ space: input.space, role: input.spaceRole || 'viewer' }] : [];
  const r = await call<Issued>(signed(me), 'POST', '/deployment/invites', { email, role, grants });
  if (!r.ok) throw new InviteError(r.message, r.status);
  await audit(request, 'team.invite_created', {
    actor: me,
    target: email,
    detail: { role, ...(input.space ? { space: input.space, spaceRole: grants[0]?.role } : {}) },
  });
  return { email, link: linkFor(request, r.value), expiresAt: r.value.invite.expiresAt };
}

export async function resendInvite(request: Request, me: Principal, id: string) {
  const r = await call<Issued>(
    signed(me),
    'POST',
    `/deployment/invites/${encodeURIComponent(id)}/resend`,
    {},
  );
  if (!r.ok) throw new InviteError(r.message, r.status);
  await audit(request, 'team.invite_resent', { actor: me, target: r.value.invite.email });
  return {
    email: r.value.invite.email,
    link: linkFor(request, r.value),
    expiresAt: r.value.invite.expiresAt,
  };
}

export async function revokeInvite(request: Request, me: Principal, id: string) {
  const r = await call<Invite>(
    signed(me),
    'POST',
    `/deployment/invites/${encodeURIComponent(id)}/revoke`,
    {},
  );
  if (!r.ok) throw new InviteError(r.message, r.status);
  await audit(request, 'team.invite_revoked', { actor: me, target: r.value.email });
  return r.value;
}

/**
 * An invitation's deployment role, read by id from the api: what a step-up decides on, never the
 * form. Null when it can't be read (gone, refused, the api down): callers treat that as needing a
 * step-up.
 */
export async function inviteRole(me: Principal, id: string): Promise<Role | null> {
  try {
    const r = await call<Invite>(
      signed(me),
      'GET',
      `/deployment/invites/${encodeURIComponent(id)}`,
    );
    return r.ok && (r.value.role === 'member' || r.value.role === 'admin') ? r.value.role : null;
  } catch {
    return null;
  }
}

// ── The /invite/:token page ──

export type Preview = {
  invite: Invite;
  spaces: { spaceId: string; name: string; role: string }[];
};

/** What the page shows about an invitation: who it is for, who sent it, and what it gives. */
export type InvitePage = {
  email: string;
  role: Role;
  inviter: string;
  spaces: { name: string; role: string }[];
  expiresAt: string;
};

const throttle = (request: Request) => [throttleKey('invite-ip', clientIp(request))];

async function refused(request: Request, reason: string, actor?: Principal | null) {
  await recordFailure(throttle(request));
  await audit(request, 'auth.invite_failed', { actor: actor ?? null, detail: { reason } });
}

/** Throws `Throttled` while this address has failed too often. */
export async function checkThrottle(request: Request) {
  const wait = await waitFor(throttle(request));
  if (wait) throw new Throttled(wait);
}

/**
 * Who sent it, if they still may: an inviter who has since been disabled, removed or made a member
 * no longer vouches for anyone, so their pending invitations stop working.
 */
async function inviter(by: { kind: string; id: string }): Promise<string | null> {
  if (by.kind === 'admin') return 'An administrator';
  const row = await db()
    .select({ name: users.name, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, by.id))
    .get();
  return row && row.role === 'admin' && !row.disabledAt ? row.name : null;
}

/** The pending invitation `token` opens, or null (counted against this address, and audited). */
export async function readInvite(
  request: Request,
  token: string,
): Promise<(Preview & { page: InvitePage }) | null> {
  const r = await call<Preview>(SYSTEM, 'POST', '/deployment/invites/lookup', { token });
  if (!r.ok) {
    if (r.code !== 'invalid_invite') throw new Error(`Invitation lookup failed (${r.status})`);
    await refused(request, 'invalid link');
    return null;
  }
  const name = await inviter(r.value.invite.invitedBy);
  if (!name) {
    await refused(request, 'inviter no longer an admin');
    return null;
  }
  const { invite, spaces } = r.value;
  return {
    ...r.value,
    page: {
      email: invite.email,
      role: invite.role,
      inviter: name,
      spaces: spaces.map((s) => ({ name: s.name, role: s.role })),
      expiresAt: invite.expiresAt,
    },
  };
}

type Accepted = { role: Role; grants: { spaceId: string; outcome: string }[] };

/** Redeems the link for `person` (as the deployment); null when the api refuses it. */
async function redeem(token: string, person: { subject: string; email: string }) {
  const r = await call<Accepted>(SYSTEM, 'POST', '/deployment/invites/accept', { token, person });
  if (r.ok) return r.value;
  if (r.code === 'invalid_invite') return null;
  throw new Error(`Accepting the invitation failed (${r.status})`);
}

const emailTaken = async (email: string) =>
  !!(await db().select({ id: users.id }).from(users).where(eq(users.email, email)).get());

/**
 * A new person from a link: redeemed first under the id they are about to have, then created with
 * the invitation's role and either a password they chose or the identity provider's subject.
 * Returns their id, to start a session.
 */
async function join(
  request: Request,
  token: string,
  preview: Preview,
  who: { name: string; passwordHash?: string; externalSub?: string },
): Promise<string> {
  const email = preview.invite.email;
  if (await emailTaken(email)) {
    await refused(request, 'address already has an account');
    throw new InviteError(INVITE_NOT_ACCEPTED);
  }
  const id = newId('usr');
  const accepted = await redeem(token, { subject: id, email });
  if (!accepted) {
    await refused(request, 'link refused at accept');
    throw new InviteError(INVITE_NOT_ACCEPTED);
  }
  const name = who.name.trim().slice(0, 200) || email.split('@')[0]!;
  try {
    await db()
      .insert(users)
      .values({
        id,
        email,
        name,
        role: accepted.role,
        passwordHash: who.passwordHash ?? null,
        externalSub: who.externalSub ?? null,
        createdAt: Date.now(),
      });
  } catch (err) {
    // The link is spent and nobody was made (an account for the address appeared meanwhile). The
    // error itself is never recorded: drizzle's carries the statement's parameters, the password
    // hash among them. Only whether it was the address being taken.
    const taken = /UNIQUE constraint failed: users\.email/.test(
      `${err} ${(err as { cause?: unknown })?.cause ?? ''}`,
    );
    await audit(request, 'auth.invite_failed', {
      target: email,
      detail: {
        reason: 'account not created after accepting',
        constraint: taken ? 'users_email' : 'other',
      },
    });
    throw new InviteError(INVITE_NOT_ACCEPTED);
  }
  forgetUserCount();
  const person: Principal = { kind: 'user', id, email, name, role: accepted.role };
  await audit(request, 'team.invite_accepted', {
    actor: person,
    target: email,
    detail: {
      role: accepted.role,
      spaces: accepted.grants.filter((g) => g.outcome === 'added').length,
      ...(who.externalSub ? { via: 'sso' } : {}),
    },
  });
  return id;
}

/** Creates the invited person with the password they chose. Returns their id. */
export async function joinWithPassword(
  request: Request,
  token: string,
  input: { name: string; password: string },
): Promise<string> {
  await checkThrottle(request);
  if (await ssoOnlyInEffect())
    throw new InviteError('This workspace signs in with single sign-on only. Continue with it.');
  const preview = await readInvite(request, token);
  if (!preview) throw new InviteError(INVITE_INVALID);
  const problem = passwordProblem(input.password, preview.invite.email);
  // Checked before the link is spent, so a weak password costs nothing.
  if (problem) throw new InviteError(problem);
  return join(request, token, preview, {
    name: input.name,
    passwordHash: await hashPassword(input.password, passwordPepper()),
  });
}

/**
 * Joins with single sign-on, when the identity provider vouches for the invited address (`email`
 * is only ever a verified one). Null when the identity already has an account here: it signs in as
 * usual and comes back to the page to accept.
 */
export async function joinWithSso(
  request: Request,
  identity: SsoIdentity,
  token: string,
): Promise<string | null> {
  const known = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.externalSub, identity.sub))
    .get();
  if (known || (identity.email && (await emailTaken(identity.email)))) return null;
  await checkThrottle(request);
  const preview = await readInvite(request, token);
  if (!preview) throw new InviteError(INVITE_INVALID);
  if (!identity.email || identity.email !== preview.invite.email) {
    await refused(request, 'identity provider vouched for another address');
    throw new InviteError(INVITE_INVALID);
  }
  return join(request, token, preview, { name: identity.name ?? '', externalSub: identity.sub });
}

/**
 * The signed-in person accepts: only for their own address. The grants are added; an invitation
 * as admin makes a member an admin (never the other way).
 */
export async function acceptSignedIn(request: Request, me: Caller, token: string) {
  await checkThrottle(request);
  const preview = await readInvite(request, token);
  if (!preview) throw new InviteError(INVITE_INVALID);
  if (me.kind !== 'user' || normalizeEmail(me.email ?? '') !== preview.invite.email) {
    await refused(request, 'signed in as another address', me);
    throw new InviteError(INVITE_INVALID);
  }
  const accepted = await redeem(token, { subject: me.id, email: preview.invite.email });
  if (!accepted) {
    await refused(request, 'link refused at accept', me);
    throw new InviteError(INVITE_INVALID);
  }
  if (accepted.role === 'admin' && me.role !== 'admin') {
    await db().update(users).set({ role: 'admin' }).where(eq(users.id, me.id));
    await audit(request, 'team.role_changed', {
      actor: me,
      target: me.email ?? me.id,
      detail: { from: me.role, to: 'admin', via: 'invite' },
    });
  }
  await audit(request, 'team.invite_accepted', {
    actor: me,
    target: preview.invite.email,
    detail: {
      role: accepted.role,
      spaces: accepted.grants.filter((g) => g.outcome === 'added').length,
    },
  });
}
