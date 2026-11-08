-- 0024_entry_authorship: who created and last changed an entry, when it was created, and when it
-- was first published. Mirrors `entries`, `entryVersions` and `entryPublished` in
-- packages/store/src/schema.ts.
--
-- Every column is nullable, so the code already deployed (which names its columns on every insert
-- and update) writes rows exactly as before and never reads these. An actor is the principal's
-- audit identity (a person's subject, `admin-token`, a key kind) or `agent:<name>`,
-- `workflow:<id>`, `plugin:<id>` or `system`. NULL means unknown: written before this migration,
-- or by code that predates it.
ALTER TABLE `entries` ADD `created_at` integer;
ALTER TABLE `entries` ADD `created_by` text;
ALTER TABLE `entries` ADD `modified_by` text;
-- Set once, by the first publish (`COALESCE` in the update), and kept through unpublish.
ALTER TABLE `entries` ADD `first_published_at` integer;
-- Who saved each version.
ALTER TABLE `entry_versions` ADD `created_by` text;
-- The entry's first publish, copied into the read model so Delivery sorts by it without a join.
ALTER TABLE `entry_published` ADD `first_published_at` integer;

-- "Entries I created" (`sys.createdBy=me`), and later grants limited to one's own entries.
CREATE INDEX IF NOT EXISTS `entries_by_creator` ON `entries` (`space_id`,`environment_id`,`created_by`);

-- An existing entry was created when its first version was saved: one primary-key read per entry,
-- and only where nothing is recorded yet, so running it again changes nothing. Who created it, and
-- when it was first published, aren't recorded anywhere exact (the audit log misses scheduled and
-- release publishes), so those stay NULL. A known gap follows: an entry published and unpublished
-- before this migration records its next publish as its first.
--
-- One statement rather than a chunked engine job: each row costs a probe of `entry_versions`'
-- primary key (space, environment, entry, version), so the statement is linear in `entries` with
-- no scan per row, binds no parameters, and writes each row once. The fleet it runs on is two
-- deployments created on 2026-10-31 and seeded at SEED_SCALE=1 (about 900 entries an
-- environment), orders of magnitude under what D1's per-query time limit allows for this shape. A
-- deployment that ever needed a chunked backfill would be one created later than this migration,
-- and it starts with an empty `entries`.
UPDATE `entries`
SET `created_at` = (
  SELECT v.`created_at` FROM `entry_versions` v
  WHERE v.`space_id` = `entries`.`space_id`
    AND v.`environment_id` = `entries`.`environment_id`
    AND v.`entry_id` = `entries`.`id`
    AND v.`version` = 1
)
WHERE `created_at` IS NULL;
