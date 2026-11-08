-- 0033_audit_log_entries: which entries each audit row is about, for an entry's activity. Mirrors
-- `audit_log_entries` in packages/store/src/schema.ts.
--
-- A row is about an entry when it targets it (`target_type` 'entry'), and when its `detail` names
-- it: an approved review, a duplicate's new entry, a workflow run's undo each target something
-- else and save entries. Finding the second kind in `audit_log` itself means reading every row's
-- JSON in the space, and the log only grows; here it is one range of an index, ending in (`at`,
-- `audit_id`), the listing's keyset order, so a page has no sort. A row names at most 20 entries
-- (`MAX_AUDIT_DETAIL_ENTRIES`), so this holds at most 21 rows for each of it.
--
-- A trigger rather than the store, for the reason 0030 gives: CI migrates before it deploys and a
-- rollback leaves the migration in place, so code that has never heard of this table appends audit
-- rows. Here every writer's row is indexed, in the statement that appends it, and the store's own
-- insert names neither the table nor the rule. `environment_id` is the row's: a row without one
-- (a promotion's, which spans two) is about no environment's entry. Audit history is never
-- deleted, so neither is this; deleting an environment leaves both.
--
-- Rows already written are indexed below. Rows from before 0032 have no `detail`, so only their
-- target counts, and rows from before 0031 that came through REST or MCP have no `target_type`:
-- they don't appear in an entry's activity (the audit log's `targetId` filter still finds them).
CREATE TABLE IF NOT EXISTS `audit_log_entries` (
  `audit_id` text NOT NULL,
  `space_id` text NOT NULL,
  `environment_id` text,
  `entry_id` text NOT NULL,
  `at` integer NOT NULL,
  PRIMARY KEY (`audit_id`, `entry_id`)
);
CREATE INDEX IF NOT EXISTS `audit_log_entries_by_entry`
  ON `audit_log_entries` (`space_id`, `environment_id`, `entry_id`, `at`, `audit_id`);

-- The target, then each entry `detail` names that isn't the target. `detail` is JSON the store
-- wrote; one that isn't, or an element that isn't an object with a text `entryId` (a hand-written
-- row), names nothing rather than failing the append. An element is read through its path in the
-- whole document (`fullkey`), never as JSON of its own: a string element's value is bare text, and
-- reading that as JSON throws. OR IGNORE: a row's entries are distinct already, so it only ever
-- ignores a re-run.
CREATE TRIGGER IF NOT EXISTS audit_log_index_entries AFTER INSERT ON audit_log
BEGIN
  INSERT OR IGNORE INTO audit_log_entries (audit_id, space_id, environment_id, entry_id, at)
  SELECT new.id, new.space_id, new.environment_id, new.target_id, new.at
  WHERE new.target_type = 'entry' AND new.target_id IS NOT NULL;
  INSERT OR IGNORE INTO audit_log_entries (audit_id, space_id, environment_id, entry_id, at)
  SELECT DISTINCT new.id, new.space_id, new.environment_id,
    json_extract(new.detail, e.fullkey || '.entryId'), new.at
  FROM json_each(CASE WHEN json_valid(new.detail) THEN new.detail ELSE '{}' END, '$.entries') AS e
  WHERE json_type(new.detail, e.fullkey || '.entryId') = 'text'
    AND NOT (new.target_type IS 'entry'
      AND new.target_id IS json_extract(new.detail, e.fullkey || '.entryId'));
END;

INSERT OR IGNORE INTO audit_log_entries (audit_id, space_id, environment_id, entry_id, at)
SELECT id, space_id, environment_id, target_id, at
FROM audit_log
WHERE target_type = 'entry' AND target_id IS NOT NULL;

INSERT OR IGNORE INTO audit_log_entries (audit_id, space_id, environment_id, entry_id, at)
SELECT DISTINCT a.id, a.space_id, a.environment_id,
  json_extract(a.detail, e.fullkey || '.entryId'), a.at
FROM audit_log AS a,
  json_each(CASE WHEN json_valid(a.detail) THEN a.detail ELSE '{}' END, '$.entries') AS e
WHERE json_type(a.detail, e.fullkey || '.entryId') = 'text';
