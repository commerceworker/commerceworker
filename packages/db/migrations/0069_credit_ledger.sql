-- The credit ledger. `balance_entries` gains the kind of each entry, the charge a settlement or
-- reversal offsets (`reference`), and an adjustment's reason (`note`); an adjustment, a credit
-- memo or a payment received off the platform, belongs to no order (`order_id` ''). Existing rows
-- are charges, settlements (`set_` ids) and reversals (`rev_` ids), so the backfill reads the id.
-- Additive: the Workers deployed before this read neither column.
ALTER TABLE balance_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'charge';
ALTER TABLE balance_entries ADD COLUMN reference TEXT;
ALTER TABLE balance_entries ADD COLUMN note TEXT;

UPDATE balance_entries SET kind = 'settle', reference = substr(id, 5) WHERE id LIKE 'set\_%' ESCAPE '\';
UPDATE balance_entries SET kind = 'reverse', reference = substr(id, 5) WHERE id LIKE 'rev\_%' ESCAPE '\';

-- Credit holds: what an open order has claimed of a customer's limit. A credit check takes one in
-- the same batch that checks the limit, the invoice converts it to its charge, and an order that
-- ends otherwise releases it. `status` is `held → charged | released | expired`, each move one
-- compare-and-set. What a customer has held is the sum of its `held` rows not past `expires_at`,
-- never a counter, so a hold nobody gave back stops counting when it expires.
CREATE TABLE credit_holds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'held',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX credit_holds_order ON credit_holds (order_id);
-- Only open holds are summed per check, so the index holds just those.
CREATE INDEX credit_holds_open ON credit_holds (customer_id) WHERE status = 'held';
