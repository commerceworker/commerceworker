/**
 * People's passkeys (WebAuthn credentials), and the short-lived challenges a registration or a
 * passkey sign-in answers. A challenge is taken (removed) when it is answered, so it can't be
 * answered twice. Verifying the answer is the web app's. `d1PasskeyStore` (packages/db) and
 * `InMemoryPasskeyStore` (packages/test-kit) implement it, held to one contract.
 */

export interface Passkey {
  readonly id: string;
  readonly userId: string;
  /** Base64url. */
  readonly publicKey: string;
  /** The authenticator's signature counter: a lower one than stored means a cloned key. */
  readonly counter: number;
  readonly transports: string[];
  readonly name: string;
  readonly backedUp: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface PasskeyStore {
  /** A person's passkeys, newest first. */
  forUser(userId: string): Promise<Passkey[]>;
  /** A passkey with its person (who may since have been disabled). */
  withUser(id: string): Promise<
    | {
        passkey: Passkey;
        user: { id: string; email: string; name: string; role: string; disabledAt: number | null };
      }
    | undefined
  >;
  /** Stores a new passkey; one whose id is already stored is left as it was. */
  add(passkey: Passkey): Promise<void>;
  /** Records a sign-in with it: its new counter, and when. */
  used(id: string, counter: number, at: number): Promise<void>;
  /** Removes a person's passkey; its name, or undefined when it was already gone. */
  remove(id: string, userId: string): Promise<string | undefined>;
  /** Removes every passkey a person has. Returns how many. */
  clear(userId: string): Promise<number>;
  /** Stores (or replaces) a challenge, dropping those already expired at `now`. */
  putChallenge(
    c: { id: string; challenge: string; userId: string | null; expiresAt: number },
    now: number,
  ): Promise<void>;
  /** Takes a challenge: removed so it can't be answered twice; undefined when missing or expired. */
  takeChallenge(
    id: string,
    now: number,
  ): Promise<{ challenge: string; userId: string | null } | undefined>;
}
