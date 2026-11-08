/**
 * Self-service password reset, without bindings: the code's shape, the cookie that carries a reset
 * between pages, what the pages say and the email. `password-reset.server.ts` issues and checks
 * codes; the pages are `routes/login-forgot.tsx` and `routes/login-reset.tsx`.
 *
 * A code is 8 characters from Crockford's base32 (no I, L, O or U), shown as `ABCD-EFGH`: 40 bits,
 * for 15 minutes and a few tries, so guessing one is out of reach. The email also carries a link,
 * `/login/reset/<reset id>.<code>`; its first request moves that into a cookie and redirects to
 * `/login/reset`, so the code is in one logged URL (the link itself) and in no later one.
 */

import { LIMITS } from './throttle';

/** How long a code works. */
export const RESET_MINUTES = 15;
export const RESET_MS = RESET_MINUTES * 60_000;

/**
 * Tries per code, the right one included; then it is dead and a new one must be asked for. The
 * limit itself is `reset-try` in throttle.ts, where the tries are counted.
 */
export const RESET_TRIES = LIMITS['reset-try'];

export const FORGOT_PATH = '/login/forgot';
export const RESET_PATH = '/login/reset';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/** A new code: 8 characters, uniformly from the 32-letter alphabet (256 is a multiple of 32). */
export function newResetCode(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(CODE_LENGTH)),
    (b) => ALPHABET[b % 32],
  ).join('');
}

/** `ABCD-EFGH`, as the email shows it. */
export const formatResetCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * A typed code as stored, or null when it can't be one: case, spaces and dashes don't matter, and
 * the letters people mistake for digits (O, I, L) read as them.
 */
export function parseResetCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** A reset's id, from `newId('pwr')`. */
const RESET_ID = /^pwr_[0-9a-z]{8,24}$/;

/** The reset id and code an emailed link carries, or null for anything else. */
export function parseResetLink(token: string): { id: string; code: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const code = token.slice(dot + 1);
  return RESET_ID.test(id) && parseResetCode(code) === code ? { id, code } : null;
}

export const resetLinkToken = (id: string, code: string) => `${id}.${code}`;

/**
 * What a reset in progress carries between pages. From asking: the address a code was asked for
 * and this browser's nonce (only a hash of it is stored with the code, and a typed code must come
 * with it, so a stranger can't spend the owner's tries). From an emailed link: its id and code, and
 * the masked address the code is for, to show on the page.
 */
export type ResetCarry = { email: string; nonce: string } | { link: string; masked: string };

/**
 * The cookie holding it: HttpOnly, Secure, SameSite=Lax (the link is opened from a mail client),
 * for as long as a code works, and sent only to the reset page, so its forms post as whole
 * documents (`reloadDocument`): a `/login/reset.data` fetch is outside the path.
 */
export const RESET_COOKIE = 'cw_reset';

const resetCookie = (value: string, maxAge: number) =>
  `${RESET_COOKIE}=${value}; Path=${RESET_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const toBase64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** A browser's nonce: `randomToken(16)`, base64url. */
const NONCE = /^[A-Za-z0-9_-]{22}$/;

/** The `set-cookie` value that keeps `carry` for the reset page. */
export const keepReset = (carry: ResetCarry) =>
  resetCookie(
    'link' in carry
      ? `l.${carry.link}.${toBase64url(carry.masked)}`
      : `e.${toBase64url(carry.email)}.${carry.nonce}`,
    RESET_MS / 1000,
  );

/** The `set-cookie` value that forgets it (after a reset). */
export const forgetReset = () => resetCookie('', 0);

/** What this request's reset cookie carries, if it is shaped like one. */
export function resetFrom(request: Request): ResetCarry | null {
  const value = (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${RESET_COOKIE}=`))
    ?.slice(RESET_COOKIE.length + 1);
  const parts = value?.split('.') ?? [];
  try {
    if (parts[0] === 'l' && parts.length === 4) {
      const link = `${parts[1]}.${parts[2]}`;
      return parseResetLink(link) ? { link, masked: fromBase64url(parts[3]!) } : null;
    }
    if (parts[0] === 'e' && parts.length === 3 && NONCE.test(parts[2]!)) {
      const email = fromBase64url(parts[1]!);
      return email.includes('@') && email.length <= 320 ? { email, nonce: parts[2]! } : null;
    }
  } catch {
    // Not base64url: not a cookie this page set.
  }
  return null;
}

/**
 * An address as the link page shows it, `b***@example.com`: enough to notice a link meant for
 * another account, not enough to read someone's address off a forwarded link.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * What asking for a code says, whatever happened: an account or none, disabled, single sign-on
 * only, or too many codes for the address. It tells a guesser nothing.
 */
export const resetSent = (email: string) =>
  `If ${email} belongs to an account that signs in with a password, we’ve emailed it a code. It works once, for ${RESET_MINUTES} minutes; only the newest code works.`;

/** What a typed code that doesn't work says, whatever the reason. */
export const RESET_CODE_INVALID =
  'That code isn’t right, or it has expired or been used. Check your newest email, or ask for a new code.';

/** What an emailed link that doesn't work says, whatever the reason. */
export const RESET_LINK_INVALID = 'This reset link isn’t valid any more. Ask for a new code.';

/** The email with a code: plain text, the code and the link to it. */
export function resetEmail(m: { to: string; code: string; link: string; host: string }) {
  return {
    to: [m.to],
    subject: 'Your CommerceWorker password reset code',
    text: [
      `Someone asked to reset the password for ${m.to} on CommerceWorker (${m.host}).`,
      '',
      `Your code: ${formatResetCode(m.code)}`,
      '',
      `Or open this link to choose a new password: ${m.link}`,
      '',
      `The code works once, for ${RESET_MINUTES} minutes. If you use two-factor sign-in, you’ll still need it to sign in afterwards.`,
      '',
      'If you didn’t ask for this, ignore this email: your password stays as it is.',
    ].join('\n'),
  };
}

/** The email after a reset, so someone who didn’t do it finds out. */
export function resetDoneEmail(m: { to: string; host: string }) {
  return {
    to: [m.to],
    subject: 'Your CommerceWorker password was changed',
    text: [
      `The password for ${m.to} on CommerceWorker (${m.host}) was just changed with an emailed reset code, and every session it had was signed out.`,
      '',
      'Your two-factor sign-in, passkeys, personal access tokens and connected apps were left as they are. Remove any you don’t recognise on your Account page.',
      '',
      'If this wasn’t you, tell an admin now: they can disable the account, which ends all of them, and reset it.',
    ].join('\n'),
  };
}
