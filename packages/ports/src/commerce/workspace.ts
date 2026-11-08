/**
 * The workspace's own records: its members (people on the team and their roles), the API tokens
 * they made, and its settings (approval separation, assistant routing, the UCP storefront). A role
 * change that would leave no admin is refused in the write itself, so two admins changing roles
 * at once can't leave none. `d1WorkspaceStore` (packages/db) and `InMemoryWorkspaceStore`
 * (packages/test-kit) implement it, held to one contract.
 */

export interface Member {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly disabledAt: number | null;
}

/** A person as the Team page lists them. */
export interface TeamPerson extends Member {
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  /** When they turned two-factor sign-in on. */
  readonly twoFactorAt: number | null;
  readonly passwordChangeDue: boolean;
}

/** An API token as the Team page lists it: never its hash. */
export interface TeamToken {
  readonly id: string;
  readonly name: string;
  /** The first characters, to tell tokens apart. */
  readonly prefix: string;
  readonly role: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  readonly expiresAt: number | null;
}

export interface NewToken {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  /** The SHA-256 of the token; the token itself is never stored. */
  readonly tokenHash: string;
  readonly role: string;
  /** Who made it, as the audit log names them. */
  readonly createdBy: string;
  /** The person who made it; null for a token another token made. */
  readonly createdById: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export interface WorkspaceStore {
  /** Everyone on the team by email, and every API token, newest first, in one round trip. */
  team(): Promise<{ people: TeamPerson[]; tokens: TeamToken[] }>;
  /** Disables a member (`at`), or enables them again (null). */
  setDisabled(id: string, at: number | null): Promise<void>;
  addToken(token: NewToken): Promise<void>;
  /**
   * Revokes a token that is still live: its name and prefix, or undefined when it was already
   * revoked or never existed. One guarded write, so two revocations audit once.
   */
  revokeToken(id: string, at: number): Promise<{ name: string; prefix: string } | undefined>;
  member(id: string): Promise<Member | undefined>;
  /** Whether an admin who isn't disabled, other than `exceptId`, is on the team. */
  hasOtherAdmin(exceptId: string): Promise<boolean>;
  /**
   * Sets a member's role. Taking away admin is refused (false, nothing written) unless another
   * admin who isn't disabled remains.
   */
  setRole(id: string, role: string): Promise<boolean>;
  /**
   * Revokes the member's live API tokens with one of `roles` (any role when null): those they made
   * (or, for tokens made before makers were kept, those named by their email). Returns how many.
   */
  revokeTokens(
    member: Pick<Member, 'id' | 'email'>,
    roles: readonly string[] | null,
  ): Promise<number>;
  /** Up to `limit` active admins, by name: who to ask when a page needs a higher role. */
  admins(limit: number): Promise<{ name: string; email: string }[]>;
  /** The names of these members; unknown ids are absent. */
  names(ids: readonly string[]): Promise<{ id: string; name: string }[]>;
  /** A setting's value, or undefined when it was never set. */
  setting(key: string): Promise<string | undefined>;
  /**
   * Sets a setting only while it doesn't already hold `value`: false when it did (a setup code
   * already used). One write, so two claims at once can't both win.
   */
  claimSetting(key: string, value: string, by: string): Promise<boolean>;
  /** Puts a setting back as it was before a claim: its earlier value, or none. */
  restoreSetting(key: string, before: string | undefined): Promise<void>;
  /** A setting with when and by whom it was last set, or undefined when it isn't set. */
  settingRecord(
    key: string,
  ): Promise<{ value: string; updatedAt: number; updatedBy: string } | undefined>;
  /** Removes a setting. */
  clearSetting(key: string): Promise<void>;
  /** Sets a setting, recording who changed it. */
  setSetting(key: string, value: string, by: string): Promise<void>;
}
