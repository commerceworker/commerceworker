-- 0017_redirects: redirects as delivery data, and a URL pattern per content type. Mirrors
-- `redirects`, `redirectSets` and `contentTypes.urlPattern` in packages/store/src/schema.ts.
--
-- New tables and one nullable column, so the code already deployed never reads or writes them,
-- and nothing is backfilled: existing content types have no URL pattern (no slug redirects) until
-- someone sets one. Both tables are environment-scoped (the environment purge clears them).

-- One row per redirect. `locale` is '' for a redirect that applies to every locale, so the unique
-- index holds one redirect per source per locale (SQLite treats NULLs as distinct).
CREATE TABLE `redirects` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`source` text NOT NULL,
	`locale` text DEFAULT '' NOT NULL,
	`destination` text NOT NULL,
	`status` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`note` text,
	`origin` text NOT NULL,
	`entry_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
-- No duplicate sources, and the set in source order (the admin's list, Delivery's set).
CREATE UNIQUE INDEX `redirects_by_source` ON `redirects` (`space_id`, `environment_id`, `source`, `locale`);
-- A slug change's read: the redirects pointing at the old path.
CREATE INDEX `redirects_by_destination` ON `redirects` (`space_id`, `environment_id`, `destination`);

-- The set's revision, bumped by every write to it: the compare-and-set that keeps two writers,
-- each of which checked the set for loops and the cap, from both committing.
CREATE TABLE `redirect_sets` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`)
);

-- Where a type's entries live on the site, e.g. /blog/{slug}. NULL: no pattern.
ALTER TABLE `content_types` ADD COLUMN `url_pattern` text;
