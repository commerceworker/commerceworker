-- 0029_saved_views: saved views of the entries list. Mirrors `saved_views` in
-- packages/store/src/schema.ts.
--
-- A new table, so the code already deployed never reads or writes it, and nothing is backfilled.
-- Space-scoped, not per environment: a view is how people work through the content, not content,
-- so every environment of the space shows the same views and none rides a snapshot or a clone.

-- One row per view. `query` is the structured query (filters, where tree, order, search, kept
-- extra keys) as JSON, never a query string; `columns` is a JSON list or NULL for the default.
-- `created_by` is the creator as the audit trail names them, and a personal view's owner.
-- `revision` is the compare-and-set every save rides with.
CREATE TABLE `saved_views` (
	`space_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text,
	`visibility` text NOT NULL,
	`created_by` text NOT NULL,
	`query` text NOT NULL,
	`columns` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `id`)
);
-- What one person sees: the space's shared views, and their own personal ones.
CREATE INDEX `saved_views_by_owner` ON `saved_views` (`space_id`, `visibility`, `created_by`);
