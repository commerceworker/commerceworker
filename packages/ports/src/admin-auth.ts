/** Human sign-in storage shared in shape with commerce; roles remain opaque strings.
 * Studio owns its auth tables and never reads the commerce database.
 */
import type { AuthStore, FailureWindow } from './commerce/auth';

export interface AdminAuth
  extends Pick<
    AuthStore,
    | 'userCount'
    | 'userBySub'
    | 'addSsoUser'
    | 'linkSub'
    | 'addUser'
    | 'setPassword'
    | 'sessionsOf'
    | 'sessionByRef'
    | 'endSessions'
    | 'userByEmail'
    | 'user'
    | 'rehashPassword'
    | 'useTotpStep'
    | 'useRecoveryCode'
    | 'recoveryCodesLeft'
    | 'replaceRecoveryCodes'
    | 'enableTotp'
    | 'disableTotp'
    | 'liveSession'
    | 'session'
    | 'startSession'
    | 'touchSession'
    | 'setReauth'
    | 'endSession'
    | 'knownPlace'
    | 'failures'
    | 'recordFailures'
    | 'clearFailures'
    | 'pruneFailures'
    | 'startChallenge'
    | 'challenge'
    | 'endChallenge'
  > {
  /** The legacy content identity explicitly linked to one immutable commerce subject. */
  userByCommerceSubject(subject: string): ReturnType<AuthStore['user']>;
  commerceSubjectForUser(userId: string): Promise<string | undefined>;
  /** Link once, without replacing an existing link or another user's subject. */
  linkCommerceSubject(userId: string, subject: string): Promise<boolean>;
  /** Counts every attempt and returns the counts from the guarded writes, never a later read. */
  countAttempts(keys: readonly string[], now: number, windowMs: number): Promise<FailureWindow[]>;
}
