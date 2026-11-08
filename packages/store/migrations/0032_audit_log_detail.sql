-- 0032_audit_log_detail: what an action changed, on its audit row. Mirrors `audit_log.detail` in
-- packages/store/src/schema.ts.
--
-- A nullable column with no default, so the code already deployed reads and writes `audit_log` as
-- it did, and no row changes: older rows simply have no detail. JSON of field paths and small
-- structural facts, capped by the application (`capAuditDetail`); it never holds a value. Nothing
-- filters on it, so it needs no index.
ALTER TABLE `audit_log` ADD COLUMN `detail` text;
