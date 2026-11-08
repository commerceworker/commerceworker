-- 0007_dam: the asset library becomes a DAM. Mirrors `assets`, `assetFolders` and `assetVersions`
-- in packages/store/src/schema.ts.
--
-- `assets` gains columns that until now lived only inside the `file` JSON (or nowhere), so the
-- library can filter, sort and page in SQL: kind and mime for filtering, size and created_at for
-- sorting, folder_id for filing, version and r2_key for the file each version points at,
-- created_by, archived_at and rights (JSON). Every new column is nullable or has a constant
-- default, so the code already deployed keeps inserting rows; the new code writes them all on
-- every save, which also heals a row the old code wrote during the deploy.
--
-- Existing rows are backfilled from `file`: mime (lowercased, without parameters), kind (the same
-- families as `assetKind` in packages/domain), size, width, height, created_at (their last change
-- is the best we know) and r2_key. The key is the path of the stored signed URL after `/media/`;
-- a key with a percent-encoded character can't be decoded in SQL, so it stays NULL and the code
-- falls back to the asset's own key prefix. Hosted videos have no key.
ALTER TABLE `assets` ADD `kind` text DEFAULT 'other' NOT NULL;
ALTER TABLE `assets` ADD `mime` text;
ALTER TABLE `assets` ADD `size` integer;
ALTER TABLE `assets` ADD `width` integer;
ALTER TABLE `assets` ADD `height` integer;
ALTER TABLE `assets` ADD `content_hash` text;
ALTER TABLE `assets` ADD `folder_id` text;
ALTER TABLE `assets` ADD `version` integer DEFAULT 1 NOT NULL;
ALTER TABLE `assets` ADD `r2_key` text;
ALTER TABLE `assets` ADD `created_at` integer DEFAULT 0 NOT NULL;
ALTER TABLE `assets` ADD `created_by` text;
ALTER TABLE `assets` ADD `archived_at` integer;
ALTER TABLE `assets` ADD `rights` text;

UPDATE `assets` SET
	`mime` = lower(trim(CASE
		WHEN instr(json_extract(`file`, '$.contentType'), ';') > 0
			THEN substr(json_extract(`file`, '$.contentType'), 1, instr(json_extract(`file`, '$.contentType'), ';') - 1)
		ELSE json_extract(`file`, '$.contentType')
	END)),
	`size` = json_extract(`file`, '$.size'),
	`width` = json_extract(`file`, '$.width'),
	`height` = json_extract(`file`, '$.height'),
	`created_at` = `updated_at`;

UPDATE `assets` SET `kind` = CASE
	WHEN `mime` LIKE 'image/%' THEN 'image'
	WHEN `mime` LIKE 'video/%' THEN 'video'
	WHEN `mime` LIKE 'audio/%' THEN 'audio'
	WHEN `mime` LIKE 'text/%'
		OR `mime` LIKE 'application/vnd.openxmlformats-officedocument.%'
		OR `mime` IN (
			'application/pdf', 'application/rtf', 'application/msword', 'application/vnd.ms-excel',
			'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.text',
			'application/vnd.oasis.opendocument.spreadsheet',
			'application/vnd.oasis.opendocument.presentation', 'application/epub+zip'
		) THEN 'document'
	ELSE 'other'
END;

-- The key: what follows `/media/` in the stored URL, then without its query string, and only when
-- nothing in it is percent-encoded.
UPDATE `assets`
SET `r2_key` = substr(json_extract(`file`, '$.url'), instr(json_extract(`file`, '$.url'), '/media/') + 7)
WHERE json_extract(`file`, '$.video') IS NULL AND instr(json_extract(`file`, '$.url'), '/media/') > 0;

UPDATE `assets`
SET `r2_key` = substr(`r2_key`, 1, instr(`r2_key`, '?') - 1)
WHERE instr(`r2_key`, '?') > 0;

UPDATE `assets` SET `r2_key` = NULL WHERE instr(`r2_key`, '%') > 0 OR `r2_key` = '';

-- Listing order (updated or created, newest first, id as the tie-break the keyset cursor uses),
-- and the filters the library offers, each leading with the scope.
CREATE INDEX `assets_by_updated` ON `assets` (`space_id`, `environment_id`, `updated_at`, `id`);
CREATE INDEX `assets_by_created` ON `assets` (`space_id`, `environment_id`, `created_at`, `id`);
CREATE INDEX `assets_by_kind` ON `assets` (`space_id`, `environment_id`, `kind`, `updated_at`);
CREATE INDEX `assets_by_mime` ON `assets` (`space_id`, `environment_id`, `mime`);
CREATE INDEX `assets_by_folder` ON `assets` (`space_id`, `environment_id`, `folder_id`, `updated_at`);
CREATE INDEX `assets_by_status` ON `assets` (`space_id`, `environment_id`, `status`, `updated_at`);
-- Duplicate detection reads assets by the hash of their bytes.
CREATE INDEX `assets_by_hash` ON `assets` (`space_id`, `environment_id`, `content_hash`);

-- Folders nest; `path` is the materialized path of ids from the root (`/a/b/`), so a subtree is
-- one prefix and a move rewrites one prefix. `parent_id` is '' at the root, so the sibling-name
-- uniqueness below holds there too (NULLs never collide in a unique index).
CREATE TABLE `asset_folders` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text DEFAULT '' NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
CREATE UNIQUE INDEX `asset_folders_sibling_name` ON `asset_folders` (`space_id`, `environment_id`, `parent_id`, `name`);
CREATE INDEX `asset_folders_by_path` ON `asset_folders` (`space_id`, `environment_id`, `path`);

-- The files an asset had before its current one: replacing the file appends the outgoing
-- version here, so an older version can be restored and its key purged. Empty until replacing
-- ships; nothing is backfilled (every existing asset is on its first version).
CREATE TABLE `asset_versions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	`file` text NOT NULL,
	`r2_key` text,
	`content_hash` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	PRIMARY KEY(`space_id`, `environment_id`, `asset_id`, `version`)
);
