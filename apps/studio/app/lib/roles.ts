/**
 * The deployment-level human roles (`member` < `admin`, from `@commerceworker/security`), their
 * labels, and how long a session lasts. Client-safe: pages import it for `useCan`.
 *
 * - `member` signs in and uses the CMS, within the content permissions the api grants per space.
 * - `admin` also manages people, single sign-on, SCIM provisioning, setup and the audit log.
 */

import type { Role } from '@commerceworker/security/roles';

export { atLeast, isRole, ROLES, type Role } from '@commerceworker/security/roles';

export const ROLE_LABELS: Record<Role, string> = {
  member: 'Member',
  admin: 'Admin',
};

/**
 * Who is acting in the web app. `id` is stable (`usr_…`, or `local` for open local development
 * before anyone has signed up); `name` is what the audit trail shows.
 */
export type Principal = {
  kind: 'user' | 'open';
  id: string;
  name: string;
  email?: string;
  role: Role;
};

// Session lifetimes are shared with the engine (the assistant's socket re-checks its session).
export {
  SESSION_IDLE_ADMIN_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  SESSION_TOUCH_MS,
  sessionIdleMs,
} from '@commerceworker/security/roles';
