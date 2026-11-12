-- Storefront shoppers sign in with an emailed code or link (docs/architecture.md, "Shoppers").
-- A shopper is a verified email address, not a customers row. New tables the code already
-- deployed never names, and one index.

-- One live sign-in per address: asking again replaces it. Only hashes are kept: the code's is an
-- HMAC under a key the engine alone holds, the link's the SHA-256 of its token. A use sets
-- used_at in one guarded update, so two redemptions can't both win. attempts counts the tries
-- against the address's codes and is carried to the next code (until the last try is older than
-- the lockout, or the sign-in was used), with last_attempt_at the time the lockout runs from.
-- created_at keeps the one-a-minute cooldown, and day_started_at and sent_today the daily cap,
-- so the daily sweep keeps a row a day after it expires.
CREATE TABLE shopper_sign_ins (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  link_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  day_started_at INTEGER NOT NULL,
  sent_today INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX shopper_sign_ins_link ON shopper_sign_ins(link_hash);
CREATE INDEX shopper_sign_ins_expiry ON shopper_sign_ins(expires_at);

-- A signed-in shopper: the cookie holds a random secret and only its SHA-256 is stored. Expiry is
-- absolute; last_seen_at is written at most hourly.
CREATE TABLE shopper_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX shopper_sessions_email ON shopper_sessions(email);
CREATE INDEX shopper_sessions_expiry ON shopper_sessions(expires_at);

-- A shopper's orders are found by the address they placed them under; an erasure, an export and
-- the order list all ask by lower(contact_email), which had no index.
CREATE INDEX orders_contact_email ON orders(lower(contact_email));
