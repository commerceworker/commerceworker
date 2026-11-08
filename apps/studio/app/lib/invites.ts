/**
 * Invitations in the admin, without bindings: what the Team page and the `/invite/:token` page
 * share. The api holds invitations (`/deployment/invites`); `invites.server.ts` calls it.
 */

import type { Tone } from '~/components/status';
import type { Role } from './roles';

/**
 * Where an invitation's link opens: `/invite/<token>`. The first request moves the token into a
 * cookie and redirects to `/invite`, so the token is in one logged URL (the link itself) and in no
 * later one: not the form posts, not sign-in's `?next=`, not single sign-on's round trip.
 */
export const INVITE_PATH = '/invite';

/** The token shape the api issues (`cwi_` and 32 random bytes, base64url). */
const TOKEN = /^cwi_[A-Za-z0-9_-]{43}$/;

export const isInviteToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v);

/**
 * The cookie holding the token while someone accepts. HttpOnly, Secure, SameSite=Lax (it must
 * come back from the identity provider's redirect), for an hour, and sent only where it is read:
 * the page, and single sign-on's callback, which joins someone new from it. Two cookies of one
 * name, one per path.
 */
export const INVITE_COOKIE = 'cw_invite';
const INVITE_COOKIE_PATHS = [INVITE_PATH, '/login/sso/callback'] as const;
const INVITE_COOKIE_S = 3600;

const inviteCookie = (value: string, path: string, maxAge: number) =>
  `${INVITE_COOKIE}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** The `set-cookie` values that keep `token` for the page and the SSO callback. */
export const keepInviteToken = (token: string): string[] =>
  INVITE_COOKIE_PATHS.map((p) => inviteCookie(token, p, INVITE_COOKIE_S));

/** The `set-cookie` values that forget it (after accepting). */
export const forgetInviteToken = (): string[] =>
  INVITE_COOKIE_PATHS.map((p) => inviteCookie('', p, 0));

/** The token this request carries in its cookie, if it is shaped like one. */
export function inviteTokenFrom(request: Request): string | null {
  const value = (request.headers.get('cookie') ?? '')
    .split(/;\s*/)
    .find((c) => c.startsWith(`${INVITE_COOKIE}=`))
    ?.slice(INVITE_COOKIE.length + 1);
  return isInviteToken(value) ? value : null;
}

/** `headers` with every cookie in `cookies` appended (a redirect or response's). */
export function withCookies(cookies: readonly string[], headers = new Headers()): Headers {
  for (const c of cookies) headers.append('set-cookie', c);
  return headers;
}

/**
 * The one thing the invitation page says when a link doesn't work, whatever the reason (unknown,
 * used, revoked, expired, resent, another address, a lost race): it tells a guesser nothing.
 */
export const INVITE_INVALID =
  'This invitation link isn’t valid any more. Ask whoever invited you for a new one.';

/**
 * What creating an account from a link says when it can't, including when the address already
 * has an account: no different from any other failure, and pointing at the way that works then.
 */
export const INVITE_NOT_ACCEPTED =
  'We couldn’t accept this invitation with a new account. If you already have one, sign in to accept it; otherwise ask for a new invitation.';

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** An invitation as the api lists it (never a token). */
export type Invite = {
  id: string;
  email: string;
  role: Role;
  grants: { spaceId: string; roleId: string }[];
  status: InviteStatus;
  expiresAt: string;
  invitedBy: { kind: string; id: string };
  createdAt: string;
  sentAt: string;
  sendCount: number;
  emailedAt?: string;
};

export const INVITE_TONE: Record<InviteStatus, Tone> = {
  pending: 'wait',
  accepted: 'ok',
  revoked: 'idle',
  expired: 'idle',
};

export const INVITE_LABEL: Record<InviteStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  revoked: 'Revoked',
  expired: 'Expired',
};

/** The invitations the Team page lists: those that can still be resent or revoked. */
export const openInvites = (all: readonly Invite[]) =>
  all.filter((i) => i.status === 'pending' || i.status === 'expired');
