-- 0031_audit_log_filters: what filtering the audit log reads through. Mirrors the indexes on
-- `audit_log` in packages/store/src/schema.ts.
--
-- New indexes only, so the code already deployed reads and writes `audit_log` as it did, and no
-- row changes. Without them a filter walks `audit_log_by_space` until it has filled a page: fine
-- for a common value, the space's whole history for a rare one (one departed person, one entry),
-- and this table only grows. Each ends in (`at`, `id`), the listing's keyset order, so a page is
-- a range of the index with no sort. A date range needs none: `audit_log_by_space` is a range on
-- `at` already. Nor does `target_type`: on its own it is common, so the walk fills a page quickly,
-- and with a target id the id decides.
CREATE INDEX IF NOT EXISTS `audit_log_by_actor` ON `audit_log` (`space_id`, `actor`, `at`, `id`);
CREATE INDEX IF NOT EXISTS `audit_log_by_action` ON `audit_log` (`space_id`, `action`, `at`, `id`);
CREATE INDEX IF NOT EXISTS `audit_log_by_target` ON `audit_log` (`space_id`, `target_id`, `at`, `id`);
