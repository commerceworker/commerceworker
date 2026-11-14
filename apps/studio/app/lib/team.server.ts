/**
 * The Team page's operations on people. Every secret is generated here, returned once to show the
 * admin, and stored only as a hash. (API keys and personal access tokens are the api's.)
 */

import {
  generatePassword,
  hashPassword,
  isEmail,
  normalizeEmail,
  passwordProblem,
} from '@commerceworker/security/credentials';
import { endAccess, endedDetail } from './access.server';
import { audit } from './audit.server';
import { forgetUserCount, reauthenticate } from './auth.server';
import { passwordPepper } from './env.server';
import { newId } from './ids';
import { inviteRole } from './invites.server';
import { isRole, type Principal, type Role, sessionIdleMs } from './roles';
import { describeAgent, sessionRef } from './sessions';
import { adminAuth, adminTeam } from './wire.server';

export class TeamError extends Error {}

/** How long a temporary password (a new person's, or a reset) works before it must be used. */
export const TEMPORARY_PASSWORD_MS = 7 * 86_400_000;

export async function listTeam() {
  const people = await adminTeam().people();
  return { people };
}

function role(v: unknown): Role {
  if (!isRole(v)) throw new TeamError('Pick a role: member or admin.');
  return v;
}

const noAdmin = () =>
  new TeamError('That would leave no admin to manage the team. Make someone else an admin first.');

/** The guarded write checks this again so concurrent changes cannot remove every admin. */
async function keepAnAdmin(exceptId: string) {
  if (!(await adminTeam().hasOtherAdmin(exceptId))) throw noAdmin();
}

export type NewAdmin = { email: string; name: string; password: string };

/**
 * The first account on an open local deployment (no users): the person setting it up, as an
 * admin with a password they choose. Adding it turns sign-in on. A deployed workspace gets its
 * first admin from its setup code instead (`setup.server.ts`).
 */
export async function createFirstAdmin(request: Request, input: NewAdmin) {
  const any = await adminAuth().userCount();
  if (any) throw new TeamError('The team already has people; sign in instead.');
  return insertAdmin(request, input, 'team.first_admin');
}

/** Adds an admin with the password they chose, and records how they came in. */
export async function insertAdmin(
  request: Request,
  input: NewAdmin,
  action: 'team.first_admin' | 'team.recovery_admin',
) {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new TeamError('Enter a valid email address.');
  const problem = passwordProblem(input.password, email);
  if (problem) throw new TeamError(problem);
  const taken = await adminAuth().userByEmail(email);
  if (taken)
    throw new TeamError(`${email} is already on the team; sign in, or use another address.`);
  const id = newId('usr');
  const name = input.name.trim() || email.split('@')[0]!;
  await adminAuth().addUser({
    id,
    email,
    name,
    role: 'admin',
    passwordHash: await hashPassword(input.password, passwordPepper()),
    passwordChangeDue: false,
    passwordExpiresAt: null,
    createdAt: Date.now(),
  });
  forgetUserCount();
  await audit(request, action, {
    actor: { kind: 'user', id, email, name, role: 'admin' },
    target: email,
  });
  return id;
}

/** Adds a person and returns the one-time password to hand them. */
export async function addUser(
  request: Request,
  by: Principal,
  input: { email: string; name: string; role: unknown },
) {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new TeamError('Enter a valid email address.');
  const exists = await adminAuth().userByEmail(email);
  if (exists) throw new TeamError(`${email} is already on the team.`);
  const password = generatePassword();
  const r = role(input.role);
  await adminAuth().addUser({
    id: newId('usr'),
    email,
    name: input.name.trim() || email.split('@')[0]!,
    role: r,
    passwordHash: await hashPassword(password, passwordPepper()),
    passwordChangeDue: true,
    passwordExpiresAt: Date.now() + TEMPORARY_PASSWORD_MS,
    createdAt: Date.now(),
  });
  forgetUserCount();
  await audit(request, 'team.user_added', { actor: by, target: email, detail: { role: r } });
  return { email, password };
}

export async function setRole(request: Request, by: Principal, id: string, next: unknown) {
  const r = role(next);
  if (r !== 'admin') await keepAnAdmin(id);
  if (id === by.id && r !== 'admin')
    throw new TeamError('Ask another admin to change your own role.');
  const user = await target(id);
  if (user.role === r) return;
  // The next forwarded request carries the new role: the principal is signed per request.
  if (!(await adminTeam().setRole(id, r))) throw noAdmin();
  await audit(request, 'team.role_changed', {
    actor: by,
    target: user.email,
    detail: { from: user.role, to: r },
  });
}

/** A person's role now, or null when they aren't on the team. */
async function roleOf(id: string): Promise<Role | null> {
  const row = await adminAuth().user(id);
  return row && isRole(row.role) ? row.role : null;
}

async function target(id: string) {
  const user = await adminAuth().user(id);
  if (!user) throw new TeamError('That person is no longer on the team.');
  return user;
}

/**
 * Sets a new one-time password and ends what the old one could have reached: sessions and
 * passkeys (adding one needs only the password).
 */
export async function resetPassword(request: Request, by: Principal, id: string) {
  const user = await target(id);
  const password = generatePassword();
  await adminAuth().setPassword(id, await hashPassword(password, passwordPepper()), {
    changeDue: true,
    expiresAt: Date.now() + TEMPORARY_PASSWORD_MS,
  });
  const ended = await endAccess(
    request,
    { id, email: user.email },
    { sessions: true, passkeys: true, tokens: true },
  );
  await audit(request, 'team.password_reset', {
    actor: by,
    target: user.email,
    detail: endedDetail(ended),
  });
  return { email: user.email, password };
}

export async function setDisabled(request: Request, by: Principal, id: string, disabled: boolean) {
  if (id === by.id) throw new TeamError('You can’t disable yourself.');
  if (disabled) await keepAnAdmin(id);
  const user = await target(id);
  if (!(await adminTeam().setDisabled(id, disabled ? Date.now() : null))) throw noAdmin();
  // Enabling again brings back none of it: they sign in afresh.
  const ended = disabled
    ? await endAccess(request, { id, email: user.email }, { sessions: true, tokens: true })
    : null;
  await audit(request, disabled ? 'team.user_disabled' : 'team.user_enabled', {
    actor: by,
    target: user.email,
    ...(ended ? { detail: endedDetail(ended) } : {}),
  });
}

/** A signed-in person changes their own password. The route ends their other sessions. */
export async function changeOwnPassword(
  request: Request,
  by: Principal,
  current: string,
  next: string,
) {
  if (by.kind !== 'user')
    throw new TeamError('Only people with their own sign-in have a password.');
  const user = await adminAuth().user(by.id);
  if (!user?.passwordHash || !(await reauthenticate(user.id, current, user.passwordHash)))
    throw new TeamError('Your current password is not right.');
  const problem = passwordProblem(next, user.email);
  if (problem) throw new TeamError(problem);
  await adminAuth().setPassword(by.id, await hashPassword(next, passwordPepper()), {
    changeDue: false,
    expiresAt: null,
  });
  await audit(request, 'auth.password_changed', { actor: by, target: user.email });
  return 0;
}

/** The signed-in person's live sessions, newest activity first; `current` marks this browser. */
export async function ownSessions(by: Principal, currentHash: string | undefined) {
  if (by.kind !== 'user') return [];
  const now = Date.now();
  const rows = await adminAuth().sessionsOf(by.id, now);
  return rows
    .map((r) => ({
      ref: sessionRef(r.tokenHash),
      current: r.tokenHash === currentHash,
      device: describeAgent(r.userAgent),
      ip: r.ip,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt ?? r.createdAt,
    }))
    .filter((r) => now - r.lastSeenAt < sessionIdleMs(by.role))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
}

/** Signs out one of the person's own sessions, by its reference; never the current one. */
export async function endOwnSession(
  request: Request,
  by: Principal,
  ref: string,
  currentHash: string | undefined,
) {
  if (by.kind !== 'user' || !/^[0-9a-f]{16}$/.test(ref))
    throw new TeamError('That session is no longer active.');
  if (currentHash && sessionRef(currentHash) === ref)
    throw new TeamError('Use Sign out to end this session.');
  const row = await adminAuth().sessionByRef(by.id, ref);
  if (!row) throw new TeamError('That session is no longer active.');
  await adminAuth().endSession(row.tokenHash);
  await audit(request, 'auth.session_ended', {
    actor: by,
    target: by.email,
    detail: { device: describeAgent(row.userAgent), ip: row.ip },
  });
}

/** Signs out every session of the person's except this one. */
export async function endOtherSessions(
  request: Request,
  by: Principal,
  currentHash: string | undefined,
) {
  if (by.kind !== 'user') return 0;
  const n = await adminAuth().endSessions(by.id, currentHash);
  if (n)
    await audit(request, 'auth.other_sessions_ended', {
      actor: by,
      target: by.email,
      detail: { count: n },
    });
  return n;
}

/**
 * Changes that hand out access or lower the bar for it ask who is at the keyboard first
 * (`stepUp`): making a SCIM token, making someone an admin (directly, by inviting them as one or
 * resending such an invitation, or by mapping a group to Admin), enabling an admin, resetting someone's password or two-factor
 * sign-in, and the single sign-on and two-factor settings. Open local dev (no one
 * signed in) has no one to ask.
 */
const STEPPED_UP = new Set([
  'scim-token',
  'reset',
  'reset-two-factor',
  'sso-settings',
  'two-factor-requirement',
]);

export async function needsStepUp(intent: string, f: FormData, me?: Principal): Promise<boolean> {
  if (STEPPED_UP.has(intent)) return true;
  // A new link to an invitation is a new credential for its role, read from the api by id. Only a
  // positively member invitation goes without: an admin one, or one that can't be read (gone, the
  // api down), asks first.
  if (intent === 'invite-resend')
    return !me || (await inviteRole(me, String(f.get('id') ?? '')).catch(() => null)) !== 'member';
  // A group mapped to Admin makes each of its members one at once.
  if (intent === 'scim-roles')
    return [...f.entries()].some(([k, v]) => k.startsWith('role:') && v === 'admin');
  // Enabling an admin gives back what their old password could do.
  if (intent === 'enable') return (await roleOf(String(f.get('id') ?? ''))) === 'admin';
  if (f.get('role') !== 'admin') return false;
  if (intent === 'add-user' || intent === 'invite') return true;
  return intent === 'role' && (await roleOf(String(f.get('id') ?? ''))) !== 'admin';
}
