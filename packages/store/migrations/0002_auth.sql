-- 0002_auth: human sign-in for the admin web app (apps/studio), in its final shape. Mirrors packages/store/src/auth-schema.ts
-- column for column and index for index. Timestamps are epoch milliseconds, booleans INTEGER 0/1.
-- There is no api_tokens table: programmatic access uses the api's own api_keys. The audit log is
-- `admin_audit`, apart from the api's per-space `audit_log`.

-- People with a deployment role (member < admin). password_hash is PBKDF2
-- (`pbkdf2:<iter>:<salt>:<hash>`, or `pbkdf2p:…` peppered with PASSWORD_PEPPER); external_sub links
-- a person to the identity provider's subject for single sign-on.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT,
  external_sub TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER,
  totp_secret TEXT,
  totp_enabled_at INTEGER,
  totp_last_step INTEGER,
  password_change_due INTEGER NOT NULL DEFAULT 0,
  password_expires_at INTEGER,
  scim_external_id TEXT
);
CREATE UNIQUE INDEX users_email ON users(email);
CREATE UNIQUE INDEX users_external_sub ON users(external_sub) WHERE external_sub IS NOT NULL;

-- Groups the identity provider pushes over SCIM, and their members; admins map groups to roles.
CREATE TABLE scim_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE scim_group_members (
  group_id TEXT NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX scim_group_members_user ON scim_group_members(user_id);

-- A session cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  ip TEXT,
  user_agent TEXT,
  reauth_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- One-use two-factor recovery codes (SHA-256), and the step between a correct password and a code.
CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

CREATE TABLE sign_in_challenges (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Passkeys (WebAuthn credentials) and the one-use challenges a registration or sign-in answers.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE passkey_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  challenge TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

-- Settings admins change in the web app (two-factor requirement, SSO, SCIM token and role map).
CREATE TABLE workspace_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- Failed sign-ins counted per key in fixed windows, so guessing is throttled before any check.
CREATE TABLE auth_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- The admin audit log: append-only and tamper-evident. Each event is sealed into a hash chain
-- (seq, prev_hash, hash).
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  actor_id TEXT,
  actor_kind TEXT,
  target TEXT,
  detail TEXT,
  ip TEXT,
  seq INTEGER,
  prev_hash TEXT,
  hash TEXT
);
CREATE INDEX admin_audit_at ON admin_audit(at);
CREATE INDEX admin_audit_action ON admin_audit(action, at);
CREATE UNIQUE INDEX admin_audit_seq ON admin_audit(seq);

-- No event is ever changed.
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'audit events cannot be changed');
END;

-- None younger than 90 days is deleted.
CREATE TRIGGER admin_audit_keep_90_days BEFORE DELETE ON admin_audit
WHEN old.at > (CAST(strftime('%s', 'now') AS INTEGER) - 90 * 86400) * 1000
BEGIN
  SELECT RAISE(ABORT, 'audit events are kept at least 90 days');
END;
