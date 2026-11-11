-- Purchase orders (docs/b2b.md, S6), on the default D6 (a buyer's PO and the inbound EDI, email and
-- punchout POs are all records; `commerce.generate_po` stays the supplier document). A PO belongs to
-- a company (the business customer's id) and, when it names one, the company member who placed it.
-- `status` is the PO lifecycle (draft, submitted, pending_approval, approved, rejected, ordered,
-- fulfilled, cancelled; `PO_LIFECYCLE` in core), changed only by a compare-and-set on the status
-- read; only a draft is edited. `po_number` is the buyer's own reference, unique within a company
-- among POs not cancelled (a cancelled number may be used again). `order_id` is the order a
-- submitted PO started, set once and unique, so an order has at most one PO. `quote_id` is the quote
-- it was made from (S7), null for none. `source` is app, api, edi, email or punchout. `ship_to` is
-- the address as JSON, null for none.
-- Every table is new, so the code already deployed, which never names them, keeps working.
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  buyer_id TEXT,
  po_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'USD',
  ship_to TEXT,
  notes TEXT,
  quote_id TEXT,
  order_id TEXT,
  source TEXT NOT NULL DEFAULT 'app',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX purchase_orders_number ON purchase_orders (company_id, lower(po_number))
  WHERE status <> 'cancelled';
CREATE UNIQUE INDEX purchase_orders_order ON purchase_orders (order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX purchase_orders_company ON purchase_orders (company_id, created_at DESC, id DESC);
CREATE INDEX purchase_orders_status ON purchase_orders (status, created_at DESC, id DESC);
CREATE INDEX purchase_orders_buyer ON purchase_orders (buyer_id, created_at DESC)
  WHERE buyer_id IS NOT NULL;

CREATE TABLE purchase_order_lines (
  po_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  sku TEXT NOT NULL,
  name TEXT,
  qty REAL NOT NULL,
  unit_price REAL,
  PRIMARY KEY (po_id, position)
) WITHOUT ROWID;
