/**
 * The deployment-level human roles, ordered: each can do everything the ones before it can.
 *
 * - `member` signs in to the admin and uses the CMS, within the content permissions the api
 *   grants them per space (roles, scopes, field grants: resolved by the api, not here).
 * - `admin` also manages people, single sign-on, SCIM provisioning, setup and the audit log.
 */

export const ROLES = ['member', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

/** True when `role` is at least `min`. */
export function atLeast(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLES.indexOf(role) >= ROLES.indexOf(min);
}

// How long a web session lasts. The web Worker's sessions keep to these, and so does whatever
// keeps acting for a person after their request (the assistant's socket re-checks its session).

/** A session ends this long after sign-in, whatever happens. */
export const SESSION_MAX_MS = 30 * 86_400_000;
/** A session also ends after this long without a request. */
export const SESSION_IDLE_MS = 7 * 86_400_000;
/** An admin's, sooner: an admin's browser left signed in can change who has access. */
export const SESSION_IDLE_ADMIN_MS = 12 * 3_600_000;

/** How long a session of `role` may go without a request before it ends. */
export const sessionIdleMs = (role: Role) =>
  role === 'admin' ? SESSION_IDLE_ADMIN_MS : SESSION_IDLE_MS;
/** Activity is written back at most this often. */
export const SESSION_TOUCH_MS = 5 * 60_000;
