/**
 * Identity linking's records (`ucp-links.ts` in @commerceworker/application, the rules in core's
 * `ucp/identity-linking.ts`): the one-time authorization codes a consenting shopper's approval
 * mints, the links (grants) a redeemed code starts between a shopper's address and a UCP platform,
 * and the access and refresh tokens of each. Secrets are never stored, only their SHA-256.
 * `d1UcpLinks` (packages/db) and `InMemoryUcpLinks` (packages/test-kit) implement it, held to one
 * contract; D1 matters here, since a code and a refresh token are each spent once, atomically.
 */

/** A one-time authorization code, from the shopper's approval until a platform redeems it. */
export interface LinkCode {
  readonly codeHash: string;
  /** The link the code will start, named now so a replayed code can end it (RFC 6749 §4.1.2). */
  readonly grantId: string;
  readonly platformId: string;
  readonly email: string;
  readonly scope: string;
  readonly redirectUri: string;
  /** The PKCE `S256` challenge the verifier must match. */
  readonly challenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A shopper's link to one platform: the family every token of it belongs to. */
export interface LinkGrant {
  readonly id: string;
  readonly platformId: string;
  readonly email: string;
  /** The most any token of it may carry. */
  readonly scope: string;
  readonly createdAt: number;
  /** Absolute: refreshing never extends it. */
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface LinkToken {
  readonly tokenHash: string;
  readonly grantId: string;
  readonly kind: 'access' | 'refresh';
  readonly scope: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A refresh token as read before it is spent: whose it is and whether it already was. */
export interface RefreshRead {
  readonly grant: LinkGrant;
  readonly scope: string;
  readonly spent: boolean;
  readonly expiresAt: number;
}

/** A link as `/account` lists it. */
export interface LinkedPlatform {
  readonly id: string;
  readonly platformId: string;
  readonly platformName: string;
  readonly scope: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface UcpLinks {
  /** Stores a code. */
  issueCode(code: LinkCode): Promise<void>;
  /**
   * Spends a code once, if it is unexpired: `spent` with the code for the one caller that did,
   * `replayed` with the link it started (or was to start) when it was already spent, null for one
   * that is unknown or expired. A replay is marked on the code itself, so the link its first use
   * is starting can't then be created (`createGrant`); the caller also ends one that exists.
   */
  spendCode(
    codeHash: string,
    now: number,
  ): Promise<{ kind: 'spent'; code: LinkCode } | { kind: 'replayed'; grantId: string } | null>;
  /**
   * Starts a link with its first tokens, one write: the shopper's earlier live links to the same
   * platform end (one link per platform and address), so the list never grows and a stale one
   * can't outlive a newer consent. Written only while the code it came from (`codeHash`, null when
   * there is none) hasn't been replayed, in the same write: false when a replay got there first,
   * and then nothing was written.
   */
  createGrant(
    grant: LinkGrant,
    tokens: readonly LinkToken[],
    now: number,
    codeHash: string | null,
  ): Promise<boolean>;
  /** The live access token's link and scope (unexpired, its link unrevoked and unexpired), or null. A read. */
  access(tokenHash: string, now: number): Promise<{ grant: LinkGrant; scope: string } | null>;
  /** A refresh token with its link, whether or not it is live; null when it is unknown. A read. */
  refresh(tokenHash: string): Promise<RefreshRead | null>;
  /**
   * Spends a refresh token and stores its successors in one write: `rotated` for the one caller
   * that spent it (while it, and its link, are live), `reused` when it was already spent (the
   * caller ends the link), `unknown` for anything else.
   */
  rotate(
    tokenHash: string,
    next: readonly LinkToken[],
    now: number,
  ): Promise<'rotated' | 'reused' | 'unknown'>;
  /** The link a token (either kind) belongs to, whether or not it is live; null when unknown. */
  grantOfToken(tokenHash: string): Promise<LinkGrant | null>;
  /** The link by id, or null. */
  grant(id: string): Promise<LinkGrant | null>;
  /** Ends a link and with it every token of it. False when it was already over or isn't there. */
  revokeGrant(id: string, now: number): Promise<boolean>;
  /** A shopper's live links, newest first, with each platform's name. */
  forShopper(email: string, now: number): Promise<LinkedPlatform[]>;
  /** Ends one of the shopper's own links (it must be theirs). */
  revokeForShopper(email: string, grantId: string, now: number): Promise<boolean>;
  /** An address's links as stored, without a code or token, for a data subject export. */
  exportFor(email: string): Promise<Record<string, unknown>[]>;
  /** Deletes an address's links, codes and tokens. Returns the links deleted. */
  eraseFor(email: string): Promise<number>;
  /**
   * Deletes codes that expired before `before.codes`; links that ended (revoked or expired) before
   * `before.grants`, with their tokens; and, from live links, the access tokens already expired at
   * `before.tokens` and every refresh token spent before `before.spent` except the latest spent
   * one of its link (it is what a copy presented again is recognized by).
   */
  prune(before: {
    codes: number;
    grants: number;
    tokens: number;
    spent: number;
  }): Promise<{ codes: number; grants: number; tokens: number }>;
}
