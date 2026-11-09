/**
 * The people who sign in to the admin, as the web app keeps them (users and sessions in the
 * shared D1). A Worker that serves a person's socket outside the web app (the assistant) asks
 * here whether they are still who they were, so it never reads the auth tables itself.
 */

/** A person as they are now. `seenAt` (ms) is their session's last activity, when one was named. */
export interface PersonRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly seenAt?: number;
}

export interface PeopleDirectory {
  /**
   * The enabled person `who.sub`, or with `who.sid` the one whose unexpired session that is.
   * Read-only: it never counts as activity, so idleness is the caller's to judge from `seenAt`.
   */
  personNow(who: { sub: string; sid?: string }, now: number): Promise<PersonRecord | null>;
  /** Whether anyone has an account yet (before then, local development runs open). */
  anyPeople(): Promise<boolean>;
}
