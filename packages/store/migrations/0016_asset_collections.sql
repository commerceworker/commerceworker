-- 0016_asset_collections: collections, share links, zip downloads and multipart uploads for the
-- asset library. Mirrors `assetCollections`, `assetCollectionItems`, `assetShareLinks`,
-- `assetZipJobs` and `assetUploads` in packages/store/src/schema.ts.
--
-- New tables only, so the code already deployed never reads or writes them, and nothing is
-- backfilled. Every table is environment-scoped (the environment purge clears it).

-- A named, ordered set of assets. Many-to-many with assets, unlike folders.
CREATE TABLE `asset_collections` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
-- The admin lists collections by name.
CREATE INDEX `asset_collections_by_name` ON `asset_collections` (`space_id`, `environment_id`, `name`, `id`);

-- One row per membership. `position` orders a collection (lower first); it need not be dense, so
-- a reorder rewrites only the rows it names plus one shift of the rest.
CREATE TABLE `asset_collection_items` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `collection_id`, `asset_id`)
);
-- A collection in order, and the collections an asset is in (delete, purges).
CREATE INDEX `asset_collection_items_by_position` ON `asset_collection_items` (`space_id`, `environment_id`, `collection_id`, `position`, `asset_id`);
CREATE INDEX `asset_collection_items_by_asset` ON `asset_collection_items` (`space_id`, `environment_id`, `asset_id`);

-- Expiring, revocable links to an asset or a collection. `password_hash` is PBKDF2 (never the
-- password); `revoked_at` is set once and never cleared.
CREATE TABLE `asset_share_links` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`allow_download` integer DEFAULT 0 NOT NULL,
	`password_hash` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	`revoked_at` integer,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
CREATE INDEX `asset_share_links_by_target` ON `asset_share_links` (`space_id`, `environment_id`, `target_type`, `target_id`);
CREATE INDEX `asset_share_links_by_created` ON `asset_share_links` (`space_id`, `environment_id`, `created_at`);

-- Zip downloads: what to put in the archive, and the engine Workflow's progress building it.
CREATE TABLE `asset_zip_jobs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`file_count` integer,
	`total_bytes` integer,
	`parts_done` integer DEFAULT 0 NOT NULL,
	`part_count` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`created_by` text,
	`completed_at` integer,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
CREATE INDEX `asset_zip_jobs_by_created` ON `asset_zip_jobs` (`space_id`, `environment_id`, `created_at`);
-- The hourly sweep's read, across every space: archives past their expiry.
CREATE INDEX `asset_zip_jobs_by_expiry` ON `asset_zip_jobs` (`expires_at`);

-- Multipart uploads in progress: what completing one checks, and what the sweep aborts.
CREATE TABLE `asset_uploads` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`part_size` integer NOT NULL,
	`content_type` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `asset_id`, `upload_id`)
);
CREATE INDEX `asset_uploads_by_created` ON `asset_uploads` (`created_at`);
