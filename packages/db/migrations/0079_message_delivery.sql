-- What Email Sending reports after it accepted a message (docs/operations.md, "Email sending"):
-- the id its binding returned (`provider_id`, how an event finds the row), and the newest status an
-- event subscription delivered (delivered, deferred, bounced, failed, rejected or complained), when,
-- and why (`delivery_detail`, an SMTP reason, capped). All null on every existing row, which the code
-- already deployed never reads; an event for a message with no row here (a sign-in code has none) is
-- dropped.
ALTER TABLE messages ADD COLUMN provider_id TEXT;
ALTER TABLE messages ADD COLUMN delivery_status TEXT;
ALTER TABLE messages ADD COLUMN delivery_at INTEGER;
ALTER TABLE messages ADD COLUMN delivery_detail TEXT;
CREATE INDEX messages_provider ON messages(provider_id);
