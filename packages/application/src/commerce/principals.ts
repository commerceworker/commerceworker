/**
 * A principal as it is now, read again before an agent acts: a person's from their live session
 * (with their current role, name and email), a token's while it is neither revoked nor expired,
 * and local dev's open principal only until anyone has an account. Time comes in as `now`.
 */
import {
  isRole,
  type Principal,
  type ProxiedPrincipal,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  sessionIdleMs,
} from '@commerceworker/core';
import type { IdentityStore } from '@commerceworker/ports/commerce';

const tokenHolds = (t: { revokedAt: number | null; expiresAt: number | null }, now: number) =>
  !t.revokedAt && (t.expiresAt === null || t.expiresAt > now);

/**
 * The principal as it is now, or null. Using a socket counts as activity unless `touch` is false
 * (a check the person didn't make), so a page left open still goes idle.
 */
export async function livePrincipal(
  ports: { readonly identity: IdentityStore },
  p: ProxiedPrincipal,
  now: number,
  { touch = true }: { touch?: boolean } = {},
): Promise<Principal | null> {
  // When it last stepped up is read from its session below, never taken from what was forwarded.
  const { session, steppedUpAt: _stepped, ...principal } = p;
  if (p.kind === 'open') return (await ports.identity.anyone()) ? null : principal;
  if (p.kind === 'token') {
    const token = await ports.identity.token(p.id);
    return token && tokenHolds(token, now) && isRole(token.role)
      ? { ...principal, role: token.role }
      : null;
  }
  if (!session) return null;
  const row = await ports.identity.session(session, now, SESSION_IDLE_MS);
  if (!row || !isRole(row.role)) return null;
  // An admin's session goes idle sooner than the limit for everyone.
  if (now - row.seen > sessionIdleMs(row.role)) return null;
  if (touch && now - row.seen > SESSION_TOUCH_MS) await ports.identity.touchSession(session, now);
  const { seen: _seen, reauthAt, ...person } = row;
  return {
    kind: 'user',
    ...person,
    role: row.role,
    ...(reauthAt ? { steppedUpAt: reauthAt } : {}),
  };
}

/**
 * Whether whoever is behind `<kind>:<id>` may still hear about their orders when no request is
 * open: not a person who has been disabled, nor a token revoked or expired. A name that matches no
 * record isn't refused (records are never deleted); a kind other than a person, a token or open
 * local dev is.
 */
export async function stillActive(
  ports: { readonly identity: IdentityStore },
  kind: string,
  id: string,
  now: number,
): Promise<boolean> {
  if (kind === 'user') return !(await ports.identity.disabledAt(id));
  if (kind === 'token') {
    const t = await ports.identity.token(id);
    return !t || tokenHolds(t, now);
  }
  return kind === 'open';
}
