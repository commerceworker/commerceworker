-- 0003_environment_purges: deleted environments whose rows are still being removed. Mirrors
-- `environmentPurges` in packages/store/src/schema.ts.
--
-- Deleting an environment removes its registry row at once (so it stops resolving) and leaves a
-- row here; the engine then deletes the environment's rows in bounded steps, because D1 refuses a
-- single statement that modifies hundreds of thousands of rows. While a row is here the name
-- can't be used for a new environment, which would otherwise inherit what is left.
-- `nudged_at` moves on every purge step, so the cron sweep restarts only a purge that stalled.
CREATE TABLE `environment_purges` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`nudged_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`)
);
