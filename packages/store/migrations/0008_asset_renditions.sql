-- 0008_asset_renditions: a space's named image presets (`thumbnail`, `hero`), which the media
-- Worker serves for every published image at `…/r-<name>/…`. Mirrors `assetRenditions` in
-- packages/store/src/schema.ts.
--
-- Presets belong to the space, not an environment: a front end asks for the same `hero` whatever
-- environment it reads. A new table only, so the code already deployed never notices it.
CREATE TABLE `asset_renditions` (
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`width` integer,
	`height` integer,
	`fit` text,
	`format` text,
	`quality` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `name`)
);
