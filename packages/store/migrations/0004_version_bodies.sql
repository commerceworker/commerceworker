-- 0004_version_bodies: superseded entry version bodies move to object storage. Mirrors
-- `entryVersions.bodyKey` and `versionArchiveQueue` in packages/store/src/schema.ts.
--
-- Version bodies are most of what an append-heavy space stores, and D1 holds at most 10 GB per
-- database. Only an entry's current version is read on every entry read (joined from here), and
-- its published version is diffed on every publish; every other version is read only by the
-- history views. The engine's sweep copies those bodies to R2, then sets `body_key` and empties
-- `fields` ('{}'). A row with `body_key` set has its body in R2 under that key.
ALTER TABLE `entry_versions` ADD COLUMN `body_key` text;

-- Versions waiting to move, queued when a newer version supersedes them (so the sweep never
-- searches the versions table). Due a day after that, so nothing still racing a write on the
-- entry can be caught out; a version that isn't archivable yet when due (its entry's published
-- one, say) is put back a day.
CREATE TABLE `version_archive_queue` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`version` integer NOT NULL,
	`due_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `entry_id`, `version`)
);
CREATE INDEX `version_archive_queue_due` ON `version_archive_queue` (`due_at`);

-- Every version already superseded, due a day from now.
INSERT INTO `version_archive_queue` (`space_id`, `environment_id`, `entry_id`, `version`, `due_at`)
SELECT v.`space_id`, v.`environment_id`, v.`entry_id`, v.`version`,
       cast(unixepoch('subsec') * 1000 as integer) + 86400000
FROM `entry_versions` v
JOIN `entries` e
  ON e.`space_id` = v.`space_id` AND e.`environment_id` = v.`environment_id` AND e.`id` = v.`entry_id`
WHERE v.`version` < e.`current_version`;
