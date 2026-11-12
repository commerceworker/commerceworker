-- Order confirmation email (docs/operations.md, "Email sending"). `messages` was the mock outbox of
-- the notify node; a confirmation email also records when Email Sending took it (`sent_at`) and why
-- a send didn't go (`error`), so a repeat sends nothing once it has gone and an unsent one can be
-- found and retried. Both are null on every existing row, which the code already deployed never
-- reads.
ALTER TABLE messages ADD COLUMN sent_at INTEGER;
ALTER TABLE messages ADD COLUMN error TEXT;

-- The credential a confirmation's receipt link carries (`/orders/<id>?t=<token>` on the storefront).
-- Only the SHA-256 of the token is stored, never the token, and every one expires (`expires_at`,
-- ms; the daily sweep deletes the expired, and an erasure deletes the order's). A new table the
-- code already deployed never names.
CREATE TABLE order_view_tokens (
  token_hash TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX order_view_tokens_order ON order_view_tokens(order_id);
CREATE INDEX order_view_tokens_expiry ON order_view_tokens(expires_at);
