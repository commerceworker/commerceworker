/**
 * Who is signed in to the admin, and what they may do. Deployment roles are `member` < `admin`
 * (`roles.ts`); content permissions are the api's, resolved from the signed principal the gateway
 * forwards (`principal.server.ts`).
 *
 * - People sign in with an email and password from D1 `users`; the `__Host-cw_session` cookie holds
 *   a random token whose SHA-256 is a `sessions` row. Someone with two-factor sign-in on gets a
 *   `__Host-cw_2fa` cookie (a `sign_in_challenges` row) instead, and the session only once a code
 *   from their authenticator app, or a recovery code, checks out.
 * - Programmatic callers (API keys, personal access tokens, OAuth tokens) never sign in here: the
 *   gateway forwards their bearer token to the api untouched.
 * - A new deployment's first admin comes from its one-time setup code (`setup.server.ts`); with no
 *   users on localhost (local development) everything is open, as an admin.
 * - With single sign-on set up (`sso.server.ts`), people can also sign in through the workspace's
 *   identity provider, linked by `users.external_sub`; it starts the same session row. With
 *   SSO-only on, passwords and passkeys are refused, and two-factor sign-in is the provider's job.
 */

import { env } from 'cloudflare:workers';
import {
  hashPassword,
  needsRehash,
  normalizeEmail,
  pepperMismatch,
  randomToken,
  sha256Hex,
  verifyPassword,
} from '@commerceworker/security/credentials';
import { data, redirect } from 'react-router';
import { audit, clientIp } from './audit.server';
import { openSecret } from './data-key.server';
import { secretContext } from './encryption';
import { afterResponse, passwordPepper } from './env.server';
import { withNext } from './next-path';
import { isLocalHost } from './origin';
import {
  atLeast,
  type Principal,
  ROLE_LABELS,
  type Role,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SESSION_TOUCH_MS,
  sessionIdleMs,
} from './roles';
import { ssoOnlyInEffect, twoFactorRequirement } from './settings.server';
import {
  blockedFor,
  type FailureRow,
  retryText,
  signInKeys,
  throttleKey,
  WINDOW_MS,
} from './throttle';
import { hashRecoveryCode, looksLikeTotp, verifyTotp } from './totp';
import { mustUseTwoFactor } from './two-factor';
import { adminAuth } from './wire.server';

const SESSION = '__Host-cw_session';
/** Between a correct password and a correct code, for someone with two-factor sign-in on. */
const CHALLENGE = '__Host-cw_2fa';
const CHALLENGE_MS = 10 * 60_000;

const OPEN: Principal = { kind: 'open', id: 'local', name: 'local', role: 'admin' };

export function cookie(request: Request, name: string): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

// Whether any user exists decides if a deployment is open (localhost) or waiting for setup. It only changes
// when the first user is added, so each isolate remembers it briefly.
let haveUsers: { value: boolean; at: number } | null = null;
async function anyUsers() {
  if (haveUsers && (haveUsers.value || Date.now() - haveUsers.at < 30_000)) return haveUsers.value;
  haveUsers = { value: (await adminAuth().userCount()) > 0, at: Date.now() };
  return haveUsers.value;
}
export const forgetUserCount = () => {
  haveUsers = null;
};

export async function authEnabled(): Promise<boolean> {
  return anyUsers();
}

/**
 * True while a deployed workspace has no people yet: every caller would be an admin, which only
 * local development may be, so everything but the setup page is refused until its first admin
 * signs up with the setup code. Local development started for a first run (`pnpm dev:first-run`,
 * FIRST_RUN) is held to it too, so the setup flow can be walked as a deployment meets it.
 */
export async function awaitingSetup(url: URL): Promise<boolean> {
  return (!isLocalHost(url) || firstRun()) && !(await authEnabled());
}

/** Local development started as a fresh deployment's first run: closed until set up. */
const firstRun = () => (env as { FIRST_RUN?: string }).FIRST_RUN === 'true';

/**
 * The id of the request's session (the SHA-256 its `sessions` row is keyed by), or undefined.
 */
export async function sessionId(request: Request): Promise<string | undefined> {
  const token = cookie(request, SESSION);
  return token ? sha256Hex(token) : undefined;
}

/**
 * A browser caller. `twoFactorDue` marks a person whose role must use two-factor sign-in but who
 * hasn't set it up; `passwordChangeDue`, one still on a password an admin set. Until they put it
 * right, they may only use their Account page.
 */
export type Caller = Principal & { twoFactorDue?: true; passwordChangeDue?: true };

/**
 * Whether someone signs in with a password, which is what two-factor sign-in protects: not when
 * they have none (people single sign-on added) or the workspace is SSO-only. Then the identity
 * provider asks for a second factor, and this app can't.
 */
async function passwordInUse(passwordHash: string | null) {
  return passwordHash !== null && !(await ssoOnlyInEffect());
}

const callers = new WeakMap<Request, Promise<Caller | null>>();

/**
 * The signed-in person for a browser request, or null. It is looked up once per Request: the
 * shell's loader and the page's run against the same one and share the answer. A client
 * navigation's `.data` fetch is a Request of its own, and so is the one React Router hands the
 * loaders after an action (a sign-in, a sign-out), so neither sees an earlier answer.
 */
export function principal(request: Request): Promise<Caller | null> {
  let found = callers.get(request);
  if (!found) {
    found = lookUpPrincipal(request);
    callers.set(request, found);
    // A failed lookup isn't kept, so asking again with the same Request tries again.
    found.catch(() => callers.delete(request));
  }
  return found;
}

async function lookUpPrincipal(request: Request): Promise<Caller | null> {
  if (!(await authEnabled())) return OPEN;
  const token = cookie(request, SESSION);
  if (token) {
    const now = Date.now();
    const hash = await sha256Hex(token);
    const row = await adminAuth().liveSession(hash, now, SESSION_IDLE_MS);
    // An admin's session goes idle sooner than the query's limit for everyone.
    if (row && now - row.seen <= sessionIdleMs(row.role as Role)) {
      const { seen, totpEnabledAt, passwordChangeDue, passwordHash } = row;
      const person = { id: row.id, email: row.email, name: row.name, role: row.role };
      if (now - seen > SESSION_TOUCH_MS)
        afterResponse(adminAuth().touchSession(hash, now, clientIp(request)));
      const role = person.role as Role;
      const due =
        !totpEnabledAt &&
        (await passwordInUse(passwordHash)) &&
        mustUseTwoFactor(role, await twoFactorRequirement());
      return {
        kind: 'user',
        ...person,
        role,
        ...(due ? { twoFactorDue: true as const } : {}),
        // A temporary password matters only while passwords sign people in.
        ...(passwordChangeDue && (await passwordInUse(passwordHash))
          ? { passwordChangeDue: true as const }
          : {}),
      };
    }
  }
  return null;
}

// ── Throttling failed attempts (rules in throttle.ts, counts in D1 auth_failures) ──

/** Thrown when a client must wait before trying to authenticate again. */
export class Throttled extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Too many failed attempts. ${retryText(retryAfterMs)}`);
  }
}

export async function waitFor(keys: string[]) {
  const rows = await adminAuth().failures(keys);
  return blockedFor(rows, Date.now());
}

/**
 * How long a password sign-in must wait (`signInKeys`). Failures for the account from many places
 * (its `email` key) don't hold back a place that has signed this person in before (one of their
 * sessions was last seen there), so someone who knows only an address can't lock its owner out;
 * that place's own limits (`email-ip`, `ip`) still apply.
 */
async function signInWait(email: string, ip: string): Promise<number> {
  const keys = signInKeys(email, ip);
  const rows = (await adminAuth().failures(keys)).filter((r) => keys.includes(r.key));
  const now = Date.now();
  const wait = blockedFor(rows, now);
  if (!wait) return 0;
  const placeKeys = keys.slice(0, 2);
  const here = blockedFor(
    rows.filter((r) => placeKeys.includes(r.key)),
    now,
  );
  if (here) return here;
  const known = await adminAuth().knownPlace(normalizeEmail(email), ip, now);
  return known ? 0 : wait;
}

/** Counts a failure against each key, starting a fresh window where the old one has ended. */
export async function recordFailure(keys: string[]) {
  const now = Date.now();
  await adminAuth().recordFailures(keys, now, WINDOW_MS);
  await adminAuth().pruneFailures(now - 86_400_000);
}

/**
 * Counts an attempt against each key and returns each count as written (one upsert per key, a new
 * window where the old one has ended). For limits on every attempt rather than on failures
 * (password reset): the caller decides with `overFor` on what this returns, so a burst of
 * parallel requests can't all read a count under the limit before any of them writes.
 */
export async function countAttempt(keys: string[]): Promise<FailureRow[]> {
  const now = Date.now();
  const counted = await adminAuth().countAttempts(keys, now, WINDOW_MS);
  await adminAuth().pruneFailures(now - 86_400_000);
  return counted;
}

/**
 * Re-checks a signed-in person's current password (changing it, turning off two-factor sign-in,
 * new recovery codes). Wrong answers are throttled per person, so a left-open browser can't be
 * used to guess it. Throws `Throttled` while blocked; false for a wrong password.
 */
export async function reauthenticate(userId: string, given: string, hash: string) {
  const key = [throttleKey('reauth', userId)];
  const wait = await waitFor(key);
  if (wait) throw new Throttled(wait);
  if (await checkPassword(given, hash)) return true;
  await recordFailure(key);
  return false;
}

export const forbidden = (min: Role) =>
  `This needs the ${ROLE_LABELS[min]} role. Ask an admin to change your role on the Team page.`;

export const TWO_FACTOR_DUE = 'Your role needs two-factor sign-in. Turn it on first.';

export const PASSWORD_CHANGE_DUE =
  'You are signed in with a temporary password. Choose your own on your Account page first.';

/** Why a caller may use only their Account page for now, or null when nothing is due. */
export const setupDue = (c: Caller): string | null =>
  c.passwordChangeDue ? PASSWORD_CHANGE_DUE : c.twoFactorDue ? TWO_FACTOR_DUE : null;

/** The page someone whose two-factor sign-in or own password is due may still use, to set it up. */
const SETUP_PATH = '/account';

/**
 * The two-factor step (routes/setup-two-factor.tsx): the same setup as Account's, alone on a page.
 * Someone whose two-factor sign-in is due reaches it and nothing else until it is on (a new
 * deployment's first admin meets it straight after setup). A temporary password comes first, on
 * Account, which has the form for it.
 */
export const TWO_FACTOR_STEP_PATH = '/setup/two-factor';

/** Where a caller with something due is held until it is done, or null when nothing is. */
export const setupPath = (p: Caller): string | null =>
  p.passwordChangeDue ? SETUP_PATH : p.twoFactorDue ? TWO_FACTOR_STEP_PATH : null;

/**
 * Where a request for `pathname` is sent instead, while something is due, or null when it may go
 * on. A client navigation fetches loader data from `<path>.data`, held the same as the page.
 */
export const heldAt = (p: Caller, pathname: string): string | null => {
  const hold = setupPath(p);
  return hold && pathname.replace(/\.data$/, '') !== hold ? hold : null;
};

/**
 * Loader/action guard. Not signed in: redirect to sign-in. Two-factor sign-in due: redirect to the
 * Account page to set it up. Signed in without `min`: 403. Returns the principal for audit fields
 * and for hiding what the role can't use.
 */
export async function requireUser(request: Request, min: Role = 'member'): Promise<Caller> {
  const p = await principal(request);
  const url = new URL(request.url);
  if (!p) {
    // A client navigation asks for `<path>.data` (`_.data` for `/`) with `_routes`; come back to
    // the page itself.
    const back = new URL(url);
    back.pathname = back.pathname.replace(/\/_\.data$/, '/').replace(/\.data$/, '');
    back.searchParams.delete('_routes');
    throw redirect(withNext('/login', back.pathname + back.search));
  }
  // Client navigations fetch loader data from `<path>.data`.
  const hold = heldAt(p, url.pathname);
  if (hold) throw redirect(hold);
  if (!atLeast(p.role, min))
    throw data({ ok: false, error: forbidden(min), need: min }, { status: 403 });
  return p;
}

const sessionCookie = (token: string) =>
  `${SESSION}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_MS / 1000}`;

// Compared against when the email is unknown, so a miss costs the same PBKDF2 work as a hit.
let decoy: Promise<string> | null = null;

/**
 * What a correct password leads to: a session, or (with two-factor sign-in on) the code step,
 * with the cookie to set either way.
 */
export type SignInResult = { cookie: string; twoFactor: boolean };

/**
 * Checks an email and password. Null for a wrong one, or no email.
 * Throws `Throttled`, before checking anything, when this person, this address or this account
 * has failed too often in the current window.
 */
export async function signIn(
  request: Request,
  email: string,
  given: string,
): Promise<SignInResult | null> {
  const keys = signInKeys(email, clientIp(request));
  const target = normalizeEmail(email) || null;
  const wait = await signInWait(email, clientIp(request));
  if (wait) {
    await audit(request, 'auth.sign_in_throttled', { target });
    throw new Throttled(wait);
  }
  const r = await checkCredentials(email, given);
  if ('reason' in r) {
    await recordFailure(keys);
    // The audit log says why; the person signing in only hears that it didn't match.
    await audit(request, 'auth.sign_in_failed', { target, detail: { reason: r.reason } });
    return null;
  }
  // Success clears this person-and-place count; the wider counts age out with their window.
  await adminAuth().clearFailures(keys[0]!);
  if (r.twoFactor) return { cookie: await startChallenge(r.principal.id), twoFactor: true };
  await audit(request, 'auth.sign_in', { actor: r.principal });
  return { cookie: await startSession(request, r.principal.id), twoFactor: false };
}

/**
 * `signIn` for someone single sign-on has already identified, whose account has a password: the
 * identity provider vouched for their email, but before that links the account (`sso.server.ts`)
 * they give its password, then their code if they use two-factor sign-in. The same throttles
 * apply. SSO-only doesn't refuse it: the password here adds to the provider's word, never
 * replaces it. Without two-factor sign-in, the session waits on `signIn`, so the caller links
 * first and signs in only once that worked.
 */
export async function signInToLink(
  request: Request,
  user: {
    id: string;
    email: string;
    passwordHash: string;
    totpEnabledAt: number | null;
    passwordChangeDue: boolean;
    passwordExpiresAt: number | null;
  },
  given: string,
): Promise<
  { twoFactor: true; cookie: string } | { twoFactor: false; signIn: () => Promise<string> } | null
> {
  const keys = signInKeys(user.email, clientIp(request));
  const wait = await signInWait(user.email, clientIp(request));
  if (wait) {
    await audit(request, 'auth.sign_in_throttled', { target: user.email });
    throw new Throttled(wait);
  }
  if (!(await checkPassword(given, user.passwordHash))) {
    await recordFailure(keys);
    await audit(request, 'auth.sign_in_failed', {
      target: user.email,
      detail: { reason: 'wrong password', method: 'sso' },
    });
    return null;
  }
  // A temporary password that ran out links nothing, as it signs no one in.
  if (temporaryPasswordExpired(user)) {
    await recordFailure(keys);
    await audit(request, 'auth.sign_in_failed', {
      target: user.email,
      detail: { reason: 'temporary password expired', method: 'sso' },
    });
    return null;
  }
  await adminAuth().clearFailures(keys[0]!);
  if (user.totpEnabledAt) return { cookie: await startChallenge(user.id), twoFactor: true };
  return {
    twoFactor: false,
    signIn: async () => {
      const userRow = await adminAuth().user(user.id);
      const row = userRow
        ? { email: userRow.email, name: userRow.name, role: userRow.role }
        : undefined;
      if (row)
        await audit(request, 'auth.sign_in', {
          actor: { kind: 'user', id: user.id, ...row, role: row.role as Role },
          detail: { method: 'sso-link' },
        });
      return startSession(request, user.id);
    },
  };
}

/**
 * `verifyPassword` with the deployment's pepper. A hash made with another pepper (the secret lost
 * or changed) can't verify whatever is typed, so that is logged loudly for the operator, while the
 * person sees only a failed sign-in.
 */
async function checkPassword(given: string, hash: string): Promise<boolean> {
  const pepper = passwordPepper();
  if (await verifyPassword(given, hash, pepper)) return true;
  if (await pepperMismatch(hash, pepper))
    console.error(
      JSON.stringify({
        type: 'password_pepper_mismatch',
        message: pepper
          ? 'A password hash was made with another PASSWORD_PEPPER: restore the one it was made with'
          : 'A password hash is peppered but PASSWORD_PEPPER is not set: restore it',
      }),
    );
  return false;
}

/**
 * Whether the person is on a temporary password that has run out. Only while one is due: a
 * password they chose never expires, even if an older Worker left the column set.
 */
const temporaryPasswordExpired = (u: {
  passwordChangeDue: boolean;
  passwordExpiresAt: number | null;
}) => u.passwordChangeDue && u.passwordExpiresAt !== null && u.passwordExpiresAt <= Date.now();

async function checkCredentials(
  email: string,
  given: string,
): Promise<{ principal: Principal; twoFactor: boolean } | { reason: string }> {
  if (!email.trim()) return { reason: 'no email' };
  const user = await adminAuth().userByEmail(normalizeEmail(email));
  // The decoy is hashed like a real one (peppered when there is a pepper), so timing says nothing.
  decoy ??= hashPassword(randomToken(), passwordPepper());
  const ok = await checkPassword(given, user?.passwordHash ?? (await decoy));
  if (!user) return { reason: 'unknown email' };
  if (!user.passwordHash) return { reason: 'no password set' };
  if (await ssoOnlyInEffect()) return { reason: 'SSO only' };
  if (!ok)
    return {
      reason: (await pepperMismatch(user.passwordHash, passwordPepper()))
        ? 'password pepper mismatch'
        : 'wrong password',
    };
  if (user.disabledAt) return { reason: 'disabled' };
  if (temporaryPasswordExpired(user)) return { reason: 'temporary password expired' };
  // A hash from before the pepper is stored again with it, now that the password is known.
  if (needsRehash(user.passwordHash, passwordPepper()))
    afterResponse(
      adminAuth().rehashPassword(
        user.id,
        user.passwordHash,
        await hashPassword(given, passwordPepper()),
      ),
    );
  return {
    twoFactor: !!user.totpEnabledAt,
    principal: {
      kind: 'user',
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
    },
  };
}

/** Creates a session for a user and returns the cookie to set. */
export async function startSession(request: Request, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await adminAuth().startSession({
    tokenHash: await sha256Hex(token),
    userId,
    createdAt: now,
    expiresAt: now + SESSION_MAX_MS,
    ip: clientIp(request),
    userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
  });
  return sessionCookie(token);
}

// ── The two-factor step ──

async function startChallenge(userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await adminAuth().startChallenge({
    tokenHash: await sha256Hex(token),
    userId,
    createdAt: now,
    expiresAt: now + CHALLENGE_MS,
  });
  return `${CHALLENGE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CHALLENGE_MS / 1000}`;
}

export const clearChallengeCookie = `${CHALLENGE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The person a live challenge belongs to: their password was right, their code is still due. */
export async function pendingChallenge(request: Request) {
  const token = cookie(request, CHALLENGE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await adminAuth().challenge(hash, Date.now());
  if (!row) return null;
  const { id, email, name, role, totpSecret, totpLastStep } = row;
  return { id, email, name, role, totpSecret, totpLastStep, challenge: hash };
}

/**
 * Finishes a two-factor sign-in with a code from the authenticator app or a recovery code.
 * Returns the cookies to set, or null when there is no live challenge or the code is wrong.
 * Throws `Throttled` after too many wrong codes for this person.
 */
export async function verifySecondFactor(request: Request, code: string): Promise<string[] | null> {
  const pending = await pendingChallenge(request);
  if (!pending) return null;
  const person: Principal = {
    kind: 'user',
    id: pending.id,
    email: pending.email,
    name: pending.name,
    role: pending.role as Role,
  };
  const key = [throttleKey('two-factor', pending.id)];
  const wait = await waitFor(key);
  if (wait) {
    await audit(request, 'auth.two_factor_throttled', { target: pending.email });
    throw new Throttled(wait);
  }
  const method = looksLikeTotp(code) ? 'app' : 'recovery code';
  const ok =
    method === 'app' ? await useTotp(pending, code) : await useRecoveryCode(pending.id, code);
  if (!ok) {
    await recordFailure(key);
    await audit(request, 'auth.two_factor_failed', {
      target: pending.email,
      detail: { reason: `wrong ${method === 'app' ? 'code' : 'recovery code'}` },
    });
    return null;
  }
  await adminAuth().endChallenge(pending.challenge);
  await adminAuth().clearFailures(key[0]!);
  await audit(request, 'auth.sign_in', { actor: person, detail: { twoFactor: method } });
  if (method === 'recovery code') {
    const left = await adminAuth().recoveryCodesLeft(pending.id);
    await audit(request, 'auth.recovery_code_used', {
      actor: person,
      target: pending.email,
      detail: { left },
    });
  }
  return [await startSession(request, pending.id), clearChallengeCookie];
}

/** How recent signing in again at the identity provider must be to count as a step-up. */
const SSO_STEP_UP_MS = 10 * 60_000;

/**
 * What a step-up asks this person for: a two-factor code, their password, or (single sign-on
 * only) to sign in again at the identity provider.
 */
export type StepUpMethod = 'code' | 'password' | 'sso';

async function stepUpUser(by: Principal) {
  if (by.kind !== 'user') return null;
  const user = await adminAuth().user(by.id);
  if (!user) return null;
  const method: StepUpMethod =
    user.totpEnabledAt && user.totpSecret
      ? 'code'
      : (await passwordInUse(user.passwordHash))
        ? 'password'
        : 'sso';
  return { user, method };
}

export async function stepUpMethod(by: Principal): Promise<StepUpMethod | null> {
  return (await stepUpUser(by))?.method ?? null;
}

/**
 * A step-up before a sensitive admin action (disabling a person, changing SSO or SCIM settings):
 * a fresh two-factor code from someone who has two-factor sign-in, else their password, else (a
 * single sign-on account with neither) signing in again at the identity provider on this session
 * within the last ten minutes (`recordReauth`). Wrong answers are throttled per person. Returns
 * null when it passes, or what to tell them.
 */
export async function stepUp(
  request: Request,
  by: Principal,
  given: { code?: string; password?: string },
): Promise<string | null> {
  if (by.kind !== 'user') return 'This needs a person signed in.';
  const key = [throttleKey('step-up', by.id)];
  const wait = await waitFor(key);
  if (wait) return `Too many tries: ${retryText(wait)}`;
  const found = await stepUpUser(by);
  if (!found) return 'Sign in again.';
  const { user, method } = found;
  if (method === 'code') {
    if (given.code && looksLikeTotp(given.code) && (await useTotp(user, given.code))) return null;
    await recordFailure(key);
    return 'Enter a current code from your authenticator app.';
  }
  if (method === 'password') {
    try {
      if (
        given.password &&
        user.passwordHash &&
        (await reauthenticate(user.id, given.password, user.passwordHash))
      )
        return null;
    } catch (err) {
      if (err instanceof Throttled) return err.message;
      throw err;
    }
    await recordFailure(key);
    return 'Your password is not right.';
  }
  const sid = await sessionId(request);
  const session = sid ? await adminAuth().session(sid) : undefined;
  if (session?.reauthAt && Date.now() - session.reauthAt < SSO_STEP_UP_MS) return null;
  return 'Confirm with single sign-on, then try within ten minutes.';
}

/**
 * Records on this session that its person just signed in again at the identity provider (a
 * step-up's `reauth` flow), when the identity is the one linked to them. Returns whether it did.
 */
export async function recordReauth(
  request: Request,
  by: Principal,
  sub: string,
  at: number,
): Promise<boolean> {
  if (by.kind !== 'user') return false;
  const sid = await sessionId(request);
  if (!sid) return false;
  const user = await adminAuth().user(by.id);
  if (!user?.externalSub || user.externalSub !== sub) return false;
  await adminAuth().setReauth(sid, by.id, at);
  return true;
}

/** Accepts a code once: the step it matched must be later than the last one used. */
async function useTotp(
  user: { id: string; totpSecret: string | null; totpLastStep: number | null },
  code: string,
) {
  if (!user.totpSecret) return false;
  const secret = await openSecret(user.totpSecret, secretContext.totp(user.id));
  const step = await verifyTotp(secret, code, Date.now(), user.totpLastStep);
  if (step === null) return false;
  return adminAuth().useTotpStep(user.id, step);
}

async function useRecoveryCode(userId: string, code: string) {
  return adminAuth().useRecoveryCode(userId, await hashRecoveryCode(code));
}

/** Ends the session server-side and returns the cookies that clear it. */
export async function signOut(request: Request): Promise<string[]> {
  const who = await principal(request);
  if (who && who.kind !== 'open') await audit(request, 'auth.sign_out', { actor: who });
  const token = cookie(request, SESSION);
  if (token) await adminAuth().endSession(await sha256Hex(token));
  return [`${SESSION}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, clearChallengeCookie];
}

/** Who acted, for audit fields such as an approval's `by`. */
export const actor = (p: Principal) => p.email ?? p.name;
