-- Promotion rules (packages/core/src/promotions.ts): a promotion may have no code (it applies to
-- any order it fits), a priority, a stacking mode and a cap on what it takes off one order.
--
-- code becomes nullable, which SQLite only allows by rebuilding the table. Every column and row
-- carries over unchanged, so the code already deployed reads and writes the new table as it did
-- the old (it never sees a null code: none exists until the new code writes one). New columns:
--   priority     higher is considered first; existing rows 0
--   stacking     'exclusive' (never combined) or 'stackable'; existing rows 'exclusive', which is
--                what the discount node's default (one code) did
--   max_discount the most it takes off one order, in the base currency; null for no cap
-- The unique index on code still holds codes unique; SQLite treats nulls as distinct, so any
-- number of codeless promotions can exist.
CREATE TABLE promotions_next (
  id TEXT PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  currency TEXT,
  min_subtotal REAL,
  skus TEXT,
  customer_id TEXT,
  valid_from INTEGER,
  valid_to INTEGER,
  max_redemptions INTEGER,
  per_customer_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  stacking TEXT NOT NULL DEFAULT 'exclusive',
  max_discount REAL
);
INSERT INTO promotions_next (
  id, code, name, kind, value, currency, min_subtotal, skus, customer_id, valid_from, valid_to,
  max_redemptions, per_customer_limit, status, created_by, created_at, updated_at
)
SELECT
  id, code, name, kind, value, currency, min_subtotal, skus, customer_id, valid_from, valid_to,
  max_redemptions, per_customer_limit, status, created_by, created_at, updated_at
FROM promotions;
DROP TABLE promotions;
ALTER TABLE promotions_next RENAME TO promotions;
CREATE UNIQUE INDEX promotions_code ON promotions(code);
-- The discount node reads the automatic promotions of every order it prices.
CREATE INDEX promotions_automatic ON promotions(status) WHERE code IS NULL;
