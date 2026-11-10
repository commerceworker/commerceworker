-- A promotion's JSON Logic condition (packages/core/src/promotion-conditions.ts), beside its typed
-- fields. Both columns are nullable and read as "no condition" when null, so the code already
-- deployed, which never selects them by name, keeps working on the new table.
--   condition          the expression, as JSON text
--   condition_message  what a buyer entering the code is told when the condition fails
ALTER TABLE promotions ADD COLUMN condition TEXT;
ALTER TABLE promotions ADD COLUMN condition_message TEXT;
