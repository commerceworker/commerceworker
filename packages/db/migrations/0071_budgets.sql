-- Budgets (docs/b2b.md, S4), on the defaults D5 (each budget is `strict` or `advisory`, advisory
-- unless chosen) and D8 (amounts in the base currency). A budget belongs to a company (the
-- business customer's id) and optionally to one of its teams, which also covers the teams under
-- it. `period` is a calendar period in UTC (`budgetWindow` in core: weekly from Monday, monthly,
-- quarterly, yearly) or `one_time`; `anchor` is when the budget starts counting. `status` is the
-- budget lifecycle (active, paused, archived), changed only by a compare-and-set on the status
-- read.
-- `budget_spend` is the ledger spend is summed from, per window: never a counter that is added to
-- and reset. A `commit` row is keyed by order, step and budget (`bsp_<order>_<step>_<budget>`), so a
-- retried step commits once; its reversal is a `reverse` row (`rev_` and the commit's id) of the
-- negated amount in the same window, so a window's spend is the sum of its rows and a reversed
-- order nets to nothing. Rolling an order back inserts the reversals once.
-- Every table is new, so the code already deployed, which never names them, keeps working.
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  team_id TEXT,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  period TEXT NOT NULL,
  anchor INTEGER NOT NULL,
  enforcement TEXT NOT NULL DEFAULT 'advisory',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX budgets_company ON budgets (company_id, name, id);
CREATE INDEX budgets_active ON budgets (company_id, team_id) WHERE status = 'active';

CREATE TABLE budget_spend (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX budget_spend_window ON budget_spend (budget_id, window_start);
CREATE INDEX budget_spend_ledger ON budget_spend (budget_id, at DESC, id DESC);
CREATE INDEX budget_spend_order ON budget_spend (order_id);
