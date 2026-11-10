-- A buy X, get Y promotion's rule (packages/core/src/promotion-bxgy.ts), as JSON text: what to buy,
-- what is discounted and by how much, how often. Nullable and null for every other kind, so the
-- code already deployed, which never selects it by name, keeps working on the new table. `kind`
-- is free text, so `bxgy` needs no change to it.
ALTER TABLE promotions ADD COLUMN bxgy TEXT;
