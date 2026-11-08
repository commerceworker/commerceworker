-- 0005_webhook_environments: a webhook can be scoped to one environment. Mirrors
-- `webhooks.environmentId` in packages/store/src/schema.ts.
--
-- NULL means every environment in the space: the only behaviour before this column, so every
-- existing hook keeps it (no backfill). A hook with an environment id receives only the events of
-- that environment, and is deleted with it when the environment is purged. Dispatch and the
-- admin reads filter on (space_id, environment_id), hence the index.
ALTER TABLE `webhooks` ADD COLUMN `environment_id` text;
CREATE INDEX `webhooks_by_environment` ON `webhooks` (`space_id`, `environment_id`);
