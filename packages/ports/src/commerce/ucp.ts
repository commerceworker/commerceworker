/**
 * Agentic checkout's own records: the platforms an admin lets in (each with an API key kept only as
 * its hash), each platform's `Idempotency-Key`s (claimed by the first request, holding its response
 * once it settles) and its cached UCP profile.
 * `d1UcpStore` (packages/db) and `InMemoryUcpStore` (packages/test-kit) implement it, held to one
 * contract.
 */

/** A platform as the admin API shows it: never its key. */
export interface UcpPlatform {
  readonly id: string;
  readonly name: string;
  /** The UCP profile the platform must name in `UCP-Agent`. */
  readonly profileUrl: string;
  /** The key's first characters, to tell keys apart. */
  readonly keyPrefix: string;
  readonly createdAt: number;
  readonly createdBy: string | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export interface UcpStore {
  /** Up to `limit` platforms, newest first. */
  platforms(limit: number): Promise<UcpPlatform[]>;
  addPlatform(
    p: Omit<UcpPlatform, 'lastUsedAt' | 'revokedAt'> & { readonly keyHash: string },
  ): Promise<void>;
  /**
   * Revokes a platform still let in: the platform as revoked, or undefined when it already was
   * or never existed. The row stays, so its checkouts and orders still name it.
   */
  revokePlatform(id: string, at: number): Promise<UcpPlatform | undefined>;
  /** The platform a key (by its hash) belongs to, unless it was revoked. */
  livePlatform(keyHash: string): Promise<UcpPlatform | undefined>;
  /** Records when a platform last called. */
  touchPlatform(id: string, at: number): Promise<void>;
  /**
   * Claims a platform's key for a request (by its hash), freeing it first when it was claimed
   * before `staleBefore`. False when the key is already held.
   */
  claimKey(
    ownerId: string,
    key: string,
    requestHash: string,
    now: number,
    staleBefore: number,
  ): Promise<boolean>;
  /** A held key: the request it was claimed for, and its response once settled (status null while running). */
  heldKey(
    ownerId: string,
    key: string,
  ): Promise<{ requestHash: string; status: number | null; response: string | null } | undefined>;
  /** Stores the response a key's request settled with. */
  settleKey(ownerId: string, key: string, status: number, response: string): Promise<void>;
  /** Frees a key, so the platform can try again. */
  releaseKey(ownerId: string, key: string): Promise<void>;
  /** A platform's cached profile (JSON), when it was fetched, and whether it was revoked. */
  platform(
    id: string,
  ): Promise<
    | { profile: string | null; profileFetchedAt: number | null; revokedAt: number | null }
    | undefined
  >;
  /** Caches a platform's freshly fetched profile. */
  cacheProfile(id: string, profile: string, at: number): Promise<void>;
}
