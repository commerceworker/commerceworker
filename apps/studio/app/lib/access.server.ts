/**
 * Ending what a person can still reach in the admin, in one place: their sessions and their
 * passkeys. Disabling someone, resetting their password or two-factor sign-in, demoting them and
 * SCIM deactivating them each end the parts that no longer fit, so a credential made under the old
 * trust doesn't outlive it.
 *
 * `tokens` also ends the credentials the api holds for them (OAuth grants and their tokens,
 * personal access tokens, setup credentials, in every space), through the api's
 * `DELETE /deployment/people/:subject/credentials`, signed as this Worker acting for the
 * deployment. A failure there throws, so the action fails visibly and can be repeated (both
 * halves are idempotent).
 */

import { principalTarget } from '@commerceworker/security/principal';
import { sessions } from '@commerceworker/store/auth';
import { and, eq, ne } from 'drizzle-orm';
import { api, db } from './env.server';
import { clearPasskeys } from './passkeys.server';
import { setPrincipalHeader } from './principal.server';

export type Person = { id: string; email: string };

export type EndWhat = {
  /** Every session, or every one but this session hash (the browser asking). */
  sessions?: true | { except: string };
  /** Passkeys: for a password or device that may be in someone else's hands. */
  passkeys?: true;
  /** The api's tokens for them: OAuth grants, personal access tokens, setup credentials. */
  tokens?: true;
};

export type Ended = { sessions: number; passkeys: number; tokens: number };

/** Ends what `what` names for `person`, and says how many of each. */
export async function endAccess(_request: Request, person: Person, what: EndWhat): Promise<Ended> {
  const ended: Ended = { sessions: 0, passkeys: 0, tokens: 0 };
  if (what.sessions) {
    const except = what.sessions === true ? undefined : what.sessions.except;
    const rows = await db()
      .delete(sessions)
      .where(
        and(eq(sessions.userId, person.id), except ? ne(sessions.tokenHash, except) : undefined),
      )
      .returning({ id: sessions.tokenHash });
    ended.sessions = rows.length;
  }
  if (what.passkeys) ended.passkeys = await clearPasskeys(person.id);
  if (what.tokens) ended.tokens = await revokeApiCredentials(person.id);
  return ended;
}

/** The web Worker itself, as the deployment administrator the api's people route requires. */
const SYSTEM = {
  kind: 'user' as const,
  id: 'system:web',
  email: '',
  name: 'commerceworker web',
  role: 'admin' as const,
};

async function revokeApiCredentials(subject: string): Promise<number> {
  const path = `/deployment/people/${encodeURIComponent(subject)}/credentials`;
  const headers = new Headers();
  await setPrincipalHeader(headers, SYSTEM, principalTarget('DELETE', path));
  const res = await api().fetch(`https://api${path}`, { method: 'DELETE', headers });
  if (!res.ok) throw new Error(`The api refused to revoke ${subject}'s tokens (${res.status})`);
  const body = (await res.json()) as { revokedTokens: number; revokedGrants: number };
  return body.revokedTokens + body.revokedGrants;
}

/** Only the counts that ended something, for an audit entry's detail. */
export const endedDetail = (e: Ended) =>
  Object.fromEntries(Object.entries(e).filter(([, n]) => n > 0)) as Partial<Ended>;
