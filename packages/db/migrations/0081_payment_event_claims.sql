-- A claim on a Stripe event that outlives its handler (an evicted isolate, a CPU limit, a deploy
-- cutting over, a failed release) used to make Stripe's redelivery and the hourly reconciliation both
-- treat the event as handled, for good. A claim now says what became of it: `status` is `processing`
-- (claimed at `claimed_at`; after ten minutes another taker may claim it again), `released` (its
-- handling threw or answered `retry`; claimable at once), `done` (handled, with its `outcome`) or
-- `poisoned` (it threw `failures` times in a row; the reconciliation no longer waits for it and an
-- operator decides, docs/operations.md, "Stripe reconciliation").
--
-- Expand only. A row that exists already was handled (the old code deleted a claim it gave up on), so
-- the default is `done`, and the code still deployed during the rollout, which inserts none of these
-- columns, writes `done` rows: its claims behave as they did.
ALTER TABLE payment_events ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE payment_events ADD COLUMN claimed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_events ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_events ADD COLUMN outcome TEXT;
CREATE INDEX payment_events_open ON payment_events(status) WHERE status <> 'done';
