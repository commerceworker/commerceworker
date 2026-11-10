-- Price books (packages/core/src/price-books.ts): named lists of prices with a priority and dates,
-- assigned to a customer or to a customer tier. A book's entries are price_rules rows in the
-- price_book source (volume tiers are rows with min_qty), tied to it by book_id; the book-less
-- price_book rules that exist stay valid and rank below every book. Additive only: nothing
-- deployed reads these tables or the new column.
--   priority  the higher wins among the books assigned to a customer that price a line
--   status    draft | active | inactive | archived; a move is one compare-and-set on it
--   starts_at, ends_at  ms; the book is in force from starts_at up to ends_at, null for no bound
CREATE TABLE price_books (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  starts_at INTEGER,
  ends_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX price_books_code ON price_books(code);

-- One row per book and assignee: a customer, or a tier, never both. SQLite treats NULLs as
-- distinct, so each kind has its own unique index.
CREATE TABLE price_book_assignments (
  book_id TEXT NOT NULL REFERENCES price_books(id),
  customer_id TEXT,
  tier TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((customer_id IS NULL) <> (tier IS NULL))
);
CREATE UNIQUE INDEX price_book_assignments_customer ON price_book_assignments(book_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX price_book_assignments_tier ON price_book_assignments(book_id, tier) WHERE tier IS NOT NULL;
CREATE INDEX price_book_assignments_assignee ON price_book_assignments(customer_id, tier);

ALTER TABLE price_rules ADD COLUMN book_id TEXT REFERENCES price_books(id);
CREATE INDEX price_rules_book ON price_rules(book_id, sku, min_qty);
