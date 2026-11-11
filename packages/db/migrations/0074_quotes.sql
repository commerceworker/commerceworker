-- Negotiated quotes (docs/b2b.md, S7), on the defaults D7 (a quote reaches an order through a PO
-- draft when the company uses POs) and D8 (quote prices are in the base currency). A quote belongs
-- to a company (the business customer's id) and is versioned: `root_id` is the first version's id,
-- shared by every revision, and `version` counts from 1, so a revision is a new row and the old one
-- becomes `superseded`. `status` is the quote lifecycle (draft, sent, accepted, declined, expired,
-- superseded; `QUOTE_LIFECYCLE` in core), changed only by a compare-and-set on the status read; only
-- a draft is edited. `expires_at` (ms) is null only on a draft; an accepted quote prices orders
-- until it. `converted_to` ('po' or 'order') and `converted_id` record what an accepted quote was
-- turned into, set once.
-- The pricing chain gains a `quote` source ahead of every other (priority 5, stops the chain). Its
-- entries are the lines of the customer's accepted, unexpired quotes, read with the contract prices
-- in the same statement, so the rows the chain reads are unchanged.
-- Every table is new, and the code already deployed, which never names them, keeps working: it reads
-- the new source row like any other, finds no entries for it in the rules it reads, and prices as before.
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  company_id TEXT NOT NULL,
  buyer_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  expires_at INTEGER,
  notes TEXT,
  converted_to TEXT,
  converted_id TEXT,
  converted_at INTEGER,
  sent_at INTEGER,
  decided_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX quotes_version ON quotes (root_id, version);
CREATE INDEX quotes_company ON quotes (company_id, created_at DESC, id DESC);
CREATE INDEX quotes_status ON quotes (status, created_at DESC, id DESC);
-- What the pricing chain reads: a company's quotes that are accepted, newest expiry last.
CREATE INDEX quotes_priced ON quotes (company_id, expires_at) WHERE status = 'accepted';

CREATE TABLE quote_lines (
  quote_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  sku TEXT NOT NULL,
  name TEXT,
  qty REAL NOT NULL,
  list_price REAL,
  unit_price REAL NOT NULL,
  PRIMARY KEY (quote_id, position)
) WITHOUT ROWID;

INSERT INTO price_sources (id, label, priority, stop_processing)
VALUES ('quote', 'Negotiated quotes', 5, 1);
