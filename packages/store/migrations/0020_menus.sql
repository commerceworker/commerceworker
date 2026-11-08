-- 0020_menus: navigation menus, as delivery data. Mirrors `menus` in packages/store/src/schema.ts.
--
-- A new table, so the code already deployed never reads or writes it, and nothing is backfilled.
-- Environment-scoped (the environment purge clears it, snapshots and clones carry it).

-- One row per menu: its items are a JSON tree (at most MAX_MENU_ITEMS items, MAX_MENU_DEPTH deep),
-- written whole. `revision` is the compare-and-set every save rides with, so two people saving the
-- same menu can't both win. Delivery reads a menu by handle and, in the same batch, the published
-- entries and terms its items name (json_tree over `items`).
CREATE TABLE `menus` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`items` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);
-- One menu per handle, and the environment's menus by handle (the list, Delivery's read).
CREATE UNIQUE INDEX `menus_by_handle` ON `menus` (`space_id`, `environment_id`, `handle`);
