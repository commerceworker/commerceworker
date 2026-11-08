-- 0010_asset_published_backfill_again: 0009's backfill once more, for the snapshots it missed.
-- While a deployment rolls out, the api still running the pre-0009 code publishes assets after
-- 0009 has run, writing snapshots with the column defaults (`kind` 'other', no `r2_key`), which
-- the delivery list's kind filter and the media Worker's gate then read wrongly. Only such rows
-- are touched, and only where their asset's row knows better; a snapshot the new code wrote is
-- left as it is. No schema change, so nothing to mirror in schema.ts.
UPDATE `asset_published` SET
	`kind` = CASE WHEN `kind` = 'other' THEN ifnull((SELECT a.`kind` FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id`), 'other') ELSE `kind` END,
	`r2_key` = ifnull(`r2_key`, (SELECT a.`r2_key` FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id`)),
	`rights` = ifnull(`rights`, (SELECT a.`rights` FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id`))
WHERE (`kind` = 'other' OR `r2_key` IS NULL)
	AND EXISTS (SELECT 1 FROM `assets` a WHERE a.`space_id` = `asset_published`.`space_id` AND a.`environment_id` = `asset_published`.`environment_id` AND a.`id` = `asset_published`.`asset_id` AND (a.`kind` <> 'other' OR a.`r2_key` IS NOT NULL));
