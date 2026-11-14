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
  /** Counts every attempt and returns the counts from the guarded writes, never a later read. */
  countAttempts(keys: readonly string[], now: number, windowMs: number): Promise<FailureWindow[]>;
}
