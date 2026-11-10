-- Companies (docs/b2b.md, S1), on the default that the business customer is the company (D1): a
-- `companies` row is one to one with a business customer and keyed by its id, so nothing keyed by
-- `customer_id` moves. `status` is the company lifecycle (pending, active, suspended, rejected,
-- closed; `COMPANY_LIFECYCLE` in core), changed only by a compare-and-set on the status read.
-- Teams are a tree: `path` holds the ids from the root down, each followed by `/`, so a team's
-- subtree is a prefix. Members are the people who buy, approve and administer for a company, in
-- fixed roles (D9); `order_limit` is the most one order of theirs may total, in the base currency,
-- null for none. A member's email is unique within the company among those not removed (a
-- removed member is kept for the orders they placed, so the same person can be added again).
-- `orders.buyer_id` is the member who placed an order (`meta.buyerId`), null for none.
-- Every table and column is new and nullable or defaulted, so the code already deployed, which
-- never names them, keeps working. Every existing business customer becomes an active company, as
-- it ordered before companies existed.
CREATE TABLE companies (
  customer_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  legal_name TEXT NOT NULL,
  tax_id TEXT,
  parent_company_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX companies_status ON companies (status, customer_id);
CREATE INDEX companies_parent ON companies (parent_company_id)
  WHERE parent_company_id IS NOT NULL;

CREATE TABLE company_teams (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL
);

CREATE INDEX company_teams_company ON company_teams (company_id, path);

CREATE TABLE company_members (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'buyer',
  team_id TEXT,
  status TEXT NOT NULL DEFAULT 'invited',
  order_limit REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX company_members_email ON company_members (company_id, lower(email))
  WHERE status <> 'removed';
CREATE INDEX company_members_company ON company_members (company_id, name, id);
CREATE INDEX company_members_removed ON company_members (updated_at)
  WHERE status = 'removed';

ALTER TABLE orders ADD COLUMN buyer_id TEXT;

INSERT INTO companies (customer_id, status, legal_name, created_at, updated_at)
  SELECT id, 'active', name, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM customers WHERE kind = 'business';
