-- 0006_environment_promotions: promoting content from one environment to another (staging → main,
-- say), with a risk check and, when it calls for one, a person's approval. Mirrors
-- `environmentPromotions` in packages/store/src/schema.ts.
--
-- A promotion pins the source versions it copies when it is requested (`content_types` and
-- `entries`, JSON), so content edited in the source afterwards is not swept in, and records the
-- risk check (`risk`, JSON) that decided whether it waits for approval. `status` starts as
-- awaiting_approval or applying and ends completed, rejected or failed, each move a
-- compare-and-set on the status it leaves, so an approval applies once.
-- A space-level record: it keeps its history when either environment is deleted.
CREATE TABLE `environment_promotions` (
	`space_id` text NOT NULL,
	`id` text NOT NULL,
	`source_environment_id` text NOT NULL,
	`target_environment_id` text NOT NULL,
	`content_types` text NOT NULL,
	`entries` text NOT NULL,
	`status` text NOT NULL,
	`risk` text NOT NULL,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`completed_at` integer,
	PRIMARY KEY(`space_id`, `id`)
);
CREATE INDEX `environment_promotions_by_created` ON `environment_promotions` (`space_id`, `created_at`);
