-- 0009_asset_published_delivery: the published asset snapshot carries what Delivery and the media
-- Worker build its URLs from, so neither reads the draft row: the file `version` the URLs carry,
-- the `r2_key` of its bytes, its `kind` (for the delivery list's filter) and its `rights` (credit,
-- license, expiry). Mirrors `assetPublished` in packages/store/src/schema.ts.
--
-- Every column is nullable or has a constant default, so the code already deployed keeps writing
-- snapshots; the new code writes them all on every publish. Existing snapshots are backfilled
-- from their asset's row, which until replacing files ships holds the same file. A key that is
-- NULL there (0007 couldn't decode it) stays NULL, and the code falls back to the asset's own key
-- prefix.
ALTER TABLE `asset_published` ADD `version` integer DEFAULT 1 NOT NULL;
ALTER TABLE `asset_published` ADD `r2_key` text;
ALTER TABLE `asset_published` ADD `kind` text DEFAULT 'other' NOT NULL;
ALTER TABLE `asset_published` ADD `rights` text;

UPDATE `asset_published` SET
	`version` = ifnull((SELECT a.`version` FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id`), 1),
	`r2_key` = (SELECT a.`r2_key` FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id`),
	`kind` = ifnull((SELECT a.`kind` FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id`), 'other'),
	`rights` = (SELECT a.`rights` FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id`);

-- The delivery list pages in publish order (id as the keyset tie-break) and filters by kind.
CREATE INDEX `asset_published_by_time` ON `asset_published` (`space_id`, `environment_id`, `published_at`, `asset_id`);
CREATE INDEX `asset_published_by_kind` ON `asset_published` (`space_id`, `environment_id`, `kind`, `published_at`);
