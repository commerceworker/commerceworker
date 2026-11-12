-- UCP identity linking: a storefront shopper links their address to a UCP platform through OAuth
-- (docs/architecture.md, "Identity linking"). New tables the code already deployed never names.
-- Only SHA-256 hashes of the secrets are stored, never a code or a token.

-- A link between a shopper's address and a platform: the family every token of it belongs to.
-- Ending it (revoked_at) ends them all; expires_at is absolute, refreshing never extends it. The
-- shopper has one live link per platform: a new consent ends the old.
CREATE TABLE ucp_link_grants (
  id TEXT PRIMARY KEY,
  platform_id TEXT NOT NULL,
  email TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX ucp_link_grants_email ON ucp_link_grants(email, platform_id);
CREATE INDEX ucp_link_grants_platform ON ucp_link_grants(platform_id);
CREATE INDEX ucp_link_grants_end ON ucp_link_grants(expires_at);

-- A one-time authorization code, from the shopper's approval until a platform redeems it (a minute).
-- used_at is set in one guarded update, so two redemptions can't both win; grant_id is the link the
-- code starts, so a replayed code can end it.
CREATE TABLE ucp_link_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  email TEXT NOT NULL,
  scope TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX ucp_link_codes_email ON ucp_link_codes(email);
CREATE INDEX ucp_link_codes_expiry ON ucp_link_codes(expires_at);

-- Access and refresh tokens. A refresh token is spent once (used_at); successor names the refresh
-- token its spending issued, which is how the same write stores the new tokens only for the one
-- caller that spent it. A spent refresh token presented again is a leak: its link ends.
CREATE TABLE ucp_link_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  successor TEXT
);
CREATE INDEX ucp_link_tokens_grant ON ucp_link_tokens(grant_id);
