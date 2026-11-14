/**
 * Self-service password reset: someone who forgot their password asks for a code by email, then
 * sets a new password with it (the pages are `routes/login-forgot.tsx` and `routes/login-reset.tsx`;
 * the code's shape and the copy are `password-reset.ts`).
 *
 * - Nothing the browser sees says whether an address has an account. Asking for a code always
 *   gets the same answer (`resetSent`) after the same work: the request is counted against the
 *   address and the place (`reset-email`, `reset-ip`), and everything that depends on the account
 *   (looking it up, writing the code, sending the email, the audit entry) runs after the response.
 *   A code that doesn't work always reads the same (`RESET_CODE_INVALID`, `RESET_LINK_INVALID`)
 *   after the same work: two counter upserts and one read, and the hashing, whether or not a code
 *   is live. The audit log says why.
 * - Every limit here counts each attempt with one atomic upsert and decides on the count the
 *   write returned (`countAttempt`, `overFor`), so a burst of parallel requests can't slip past.
 * - The per-address cap is a hard ceiling, whoever asks: someone who knows only an address can use
 *   up its 3 codes for the window, and the owner's own requests in that window then send nothing.
 *   They get none of the codes, though, and each new code replaces the last; the owner waits out
 *   the window or asks an admin.
 * - Codes go only to an enabled account with a password, while the workspace isn't SSO-only.
 *   Someone single sign-on added (no password) gets none: a reset would give them a password their
 *   identity provider doesn't control. With SSO-only on, there is nothing to reset.
 * - Only an HMAC of the code (with `PASSWORD_PEPPER`) is stored (`password_resets`). It works
 *   once, for 15 minutes and `RESET_TRIES` tries; a new code for the person deletes their older
 *   ones. A typed code is tried only from the browser that asked for it (the nonce in its cookie,
 *   stored hashed with the code), so a stranger can't spend the owner's tries; the emailed link
 *   works anywhere and its tries are counted by the reset's id. Tries are also limited per place
 *   (`reset-code-ip`).
 * - Setting the password keeps the policy (`passwordProblem`), ends every session and pending
 *   two-factor challenge in the same database batch, and starts no session: the person signs in
 *   with the new password, and then with their two-factor code if they use one. Passkeys,
 *   two-factor sign-in and API tokens are left as they are: an emailed code proves only the
 *   mailbox, so it may replace the password and nothing else.
 */

import {
  constantTimeEqual,
  hashPassword,
  isEmail,
  normalizeEmail,
  passwordProblem,
  randomToken,
  sha256Hex,
} from '@commerceworker/security/credentials';
import { audit, clientIp } from './audit.server';
import { countAttempt, Throttled } from './auth.server';
import { afterResponse, emailSender, passwordPepper, sendsEmail } from './env.server';
import { newId } from './ids';
import { isLocalHost } from './origin';
import {
  maskEmail,
  newResetCode,
  parseResetCode,
  parseResetLink,
  RESET_CODE_INVALID,
  RESET_LINK_INVALID,
  RESET_MS,
  RESET_PATH,
  type ResetCarry,
  resetDoneEmail,
  resetEmail,
  resetLinkToken,
} from './password-reset';
import type { Principal, Role } from './roles';
import { ssoOnlyInEffect } from './settings.server';
import { overFor, throttleKey } from './throttle';
import { adminAuth, adminPasswordResets } from './wire.server';

/** A refusal the page shows as it is. */
export class ResetError extends Error {}

/**
 * Whether this deployment can reset passwords by email: it sends email, or it is local development,
 * where the email is printed to the dev server's log instead (`deliver`).
 */
export const resetAvailable = (request: Request) =>
  sendsEmail() || isLocalHost(new URL(request.url));

/**
 * The stored form of a code: HMAC-SHA256 with the deployment's `PASSWORD_PEPPER` over the reset's
 * id and the code, so a copy of the database alone can't search the 40-bit code space; SHA-256
 * where there is no pepper (local development).
 */
async function codeHash(id: string, code: string): Promise<string> {
  const pepper = passwordPepper();
  if (!pepper) return sha256Hex(`${id}:${code}`);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}:${code}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compared against when no code is live, so a miss costs the same hashing as a hit. */
const NO_HASH = '0'.repeat(64);

/**
 * Sends one email, or in local development without a sender prints it to the log. Returns why it
 * wasn't sent, or null.
 */
async function deliver(
  request: Request,
  message: { to: string[]; subject: string; text: string },
): Promise<string | null> {
  const sender = emailSender();
  if (sender) {
    const r = await sender.send(message);
    return r.delivered ? null : (r.error ?? 'not delivered');
  }
  if (isLocalHost(new URL(request.url))) {
    // Local development only: there is no mailbox, so the code is read from here.
    console.log(JSON.stringify({ type: 'password_reset_email', ...message }));
    return null;
  }
  return 'email sending is not configured';
}

// ── Asking for a code ──

/**
 * Asks for a code for `given`. The same answer and the same work whatever the address: it throws
 * `ResetError` only for something that isn't an address, and `Throttled` only when this place has
 * asked too often (across addresses). An address that has had its codes for this window gets the
 * usual answer and no email. Returns the address and this browser's nonce, for the reset cookie.
 */
export async function requestReset(
  request: Request,
  given: string,
): Promise<{ email: string; nonce: string }> {
  const email = normalizeEmail(given);
  if (!isEmail(email) || email.length > 320) throw new ResetError('Enter your email address.');
  const [place, address] = await countAttempt([
    throttleKey('reset-ip', clientIp(request)),
    throttleKey('reset-email', email),
  ]);
  const now = Date.now();
  const wait = overFor([place!], now);
  if (wait) {
    await audit(request, 'auth.password_reset_requested', {
      target: email,
      detail: { outcome: 'throttled' },
    });
    throw new Throttled(wait);
  }
  const nonce = randomToken(16);
  afterResponse(issue(request, email, overFor([address!], now) > 0, nonce));
  return { email, nonce };
}

/** After the response: a code for the account, if it may have one, and the audit entry. */
async function issue(request: Request, email: string, addressSpent: boolean, nonce: string) {
  const user = await adminAuth().userByEmail(email);
  let outcome = !user
    ? 'no account'
    : user.disabledAt
      ? 'disabled'
      : !user.passwordHash
        ? 'no password'
        : (await ssoOnlyInEffect())
          ? 'SSO only'
          : addressSpent
            ? 'too many codes for this address'
            : 'sent';
  if (user && outcome === 'sent') {
    const id = newId('pwr');
    const code = newResetCode();
    const now = Date.now();
    await adminPasswordResets().issue({
      id,
      userId: user.id,
      codeHash: await codeHash(id, code),
      browserHash: await sha256Hex(nonce),
      createdAt: now,
      expiresAt: now + RESET_MS,
    });
    const url = new URL(request.url);
    const failed = await deliver(
      request,
      resetEmail({
        to: user.email,
        code,
        link: new URL(`${RESET_PATH}/${resetLinkToken(id, code)}`, url).href,
        host: url.host,
      }),
    );
    if (failed) outcome = `email not sent: ${failed}`;
  }
  await audit(request, 'auth.password_reset_requested', { target: email, detail: { outcome } });
}

// ── Checking a code ──

type Proof = { link: string } | { email: string; nonce: string };

/**
 * Counts a try and checks a code: typed (for the address, from the browser that asked) or from an
 * emailed link. Every call does the same work whatever it finds, so a wrong guess for a real
 * account costs the same as one for nobody: two counter upserts (the place, and this code's
 * tries), one read for the newest live code, the SSO-only check and the hashing. Returns the reset
 * and its person, or why not. Throws `Throttled` while this place has tried too many codes.
 */
async function checkCode(
  request: Request,
  proof: Proof,
  typedCode: string,
): Promise<{ id: string; userId: string } | { reason: string }> {
  const link = 'link' in proof ? parseResetLink(proof.link) : null;
  const code = link ? link.code : parseResetCode(typedCode);
  const browser = 'nonce' in proof ? await sha256Hex(proof.nonce) : null;
  const [place, tries] = await countAttempt([
    throttleKey('reset-code-ip', clientIp(request)),
    throttleKey('reset-try', link ? link.id : (browser ?? 'none')),
  ]);
  const now = Date.now();
  const wait = overFor([place!], now);
  if (wait) throw new Throttled(wait);
  const row = await adminPasswordResets().live(
    link
      ? { id: link.id }
      : {
          email: 'email' in proof ? normalizeEmail(proof.email) : '',
          browserHash: browser ?? '',
        },
    now,
  );
  const ssoOnly = await ssoOnlyInEffect();
  const right = constantTimeEqual(
    await codeHash(row?.id ?? 'pwr_none', code ?? ''),
    row?.codeHash ?? NO_HASH,
  );
  if (!code) return { reason: 'malformed code' };
  if (overFor([tries!], now)) return { reason: 'no tries left' };
  if (!row) return { reason: 'no live code' };
  // Asked for before the workspace went SSO-only.
  if (ssoOnly) return { reason: 'password sign-in off' };
  if (!right) return { reason: 'wrong code' };
  return { id: row.id, userId: row.userId };
}

/**
 * The masked address an emailed link's code is for, or null when the link doesn't work (counted
 * as a try, and audited). The link page shows it, so a link planted for another account is
 * noticed before a password is set on it. Throws `Throttled` like a typed try.
 */
export async function openResetLink(request: Request, token: string): Promise<string | null> {
  const found = await checkCode(request, { link: token }, '');
  if ('reason' in found) {
    await audit(request, 'auth.password_reset_failed', {
      detail: { reason: found.reason, via: 'link', step: 'open' },
    });
    return null;
  }
  const user = await adminAuth().user(found.userId);
  return user ? maskEmail(user.email) : null;
}

// ── Setting the new password ──

/**
 * Sets a new password with a code: typed for the address it was asked for, or from the emailed
 * link. Throws `Throttled` while this place has tried too many codes, and `ResetError` for a
 * password the policy refuses or a code that doesn't work (the same words whatever the reason).
 * Starts no session.
 */
export async function resetPassword(
  request: Request,
  carry: ResetCarry,
  typedCode: string,
  password: string,
): Promise<void> {
  const viaLink = 'link' in carry;
  const email = viaLink ? null : normalizeEmail(carry.email);

  // Typed: the policy first, against the address typed, so a weak password spends no try and
  // says nothing about the account.
  if (email !== null) {
    const problem = passwordProblem(password, email);
    if (problem) throw new ResetError(problem);
  }

  const refuse = async (reason: string): Promise<never> => {
    await audit(request, 'auth.password_reset_failed', {
      target: email,
      detail: { reason, ...(viaLink ? { via: 'link' } : {}) },
    });
    throw new ResetError(viaLink ? RESET_LINK_INVALID : RESET_CODE_INVALID);
  };

  const found = await checkCode(
    request,
    'link' in carry ? { link: carry.link } : { email: carry.email, nonce: carry.nonce },
    typedCode,
  );
  if ('reason' in found) return refuse(found.reason);

  // Known only now that the code is right: who it is for.
  const user = (await adminAuth().user(found.userId))!;

  // Through a link, the address is known only now; the code stays good for its remaining tries.
  if (viaLink) {
    const problem = passwordProblem(password, user.email);
    if (problem) throw new ResetError(problem);
  }

  // Used once: of two requests with the right code, one wins here.
  if (!(await adminPasswordResets().claim(found.id, Date.now())))
    return refuse('code already used');
  const passwordHash = await hashPassword(password, passwordPepper());
  const ended = await adminPasswordResets().complete(found.userId, passwordHash);
  const person: Principal = {
    kind: 'user',
    id: found.userId,
    email: user.email,
    name: user.name,
    role: user.role as Role,
  };
  await audit(request, 'auth.password_reset', {
    actor: person,
    target: user.email,
    detail: { sessions: ended, ...(viaLink ? { via: 'link' } : {}) },
  });
  const url = new URL(request.url);
  afterResponse(
    deliver(request, resetDoneEmail({ to: user.email, host: url.host })).then((failed) => {
      if (failed)
        console.error(JSON.stringify({ type: 'password_reset_notice_failed', error: failed }));
    }),
  );
}
