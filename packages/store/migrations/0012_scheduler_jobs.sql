-- 0012_scheduler_jobs: the engine cron's heartbeat, one row per sweep. Mirrors `schedulerJobs` in
-- packages/store/src/schema.ts.
--
-- The cron writes it once a tick (one batch a minute) and nothing else does, so it adds no writer
-- to a request path. `job = 'tick'` is the tick itself: the api's /health reports the scheduler
-- stale when that row is more than five minutes old. A new table, so the code already deployed
-- never sees it.
CREATE TABLE `scheduler_jobs` (
	`job` text PRIMARY KEY NOT NULL,
	`last_run_at` integer NOT NULL,
	`last_success_at` integer,
	`last_error_at` integer,
	`last_error` text
);
