-- 0001_init: commerceworker's D1 schema, its earlier history collapsed into one migration.
-- Timestamps are epoch milliseconds (drizzle `timestamp_ms` ↔ Date), JSON is
-- TEXT (drizzle `mode: 'json'`), booleans are INTEGER 0/1. The lexical search index is NOT here:
-- it lives in the SearchShard Durable Objects (FTS5). Hand-maintained from here on; never edit an
-- applied migration (expand-only: add a new numbered file).
CREATE TABLE `agent_reviews` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`workflow` text NOT NULL,
	`entry_id` text NOT NULL,
	`proposed` text NOT NULL,
	`notes` text NOT NULL,
	`status` text NOT NULL,
	`awaiting` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`applied_at` integer,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE INDEX `agent_reviews_pending` ON `agent_reviews` (`space_id`,`environment_id`,`status`,`created_at`);
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`workflow` text NOT NULL,
	`entry_id` text NOT NULL,
	`status` text NOT NULL,
	`decisions` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`created_at` integer NOT NULL
);

CREATE INDEX `agent_runs_by_space` ON `agent_runs` (`space_id`,`created_at`);
CREATE TABLE `agent_schedules` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`workflow` text NOT NULL,
	`content_type_api_id` text,
	`cron` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`auto_apply` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`cursor_entry_id` text,
	`next_run_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE INDEX `agent_schedules_due` ON `agent_schedules` (`enabled`,`next_run_at`);
CREATE TABLE `ai_actions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`prompt_template` text NOT NULL,
	`variables` text NOT NULL,
	`target_field` text,
	`tier` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text,
	`hashed_token` text NOT NULL,
	`scopes` text NOT NULL,
	`revoked` integer DEFAULT false NOT NULL,
	`role_id` text,
	`last_used_at` integer,
	`expires_at` integer,
	`issuance` text,
	`subject` text,
	`client_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE UNIQUE INDEX `api_keys_hashed_token` ON `api_keys` (`hashed_token`);
CREATE INDEX `api_keys_by_space` ON `api_keys` (`space_id`);
CREATE INDEX `api_keys_by_subject` ON `api_keys` (`space_id`,`subject`);
CREATE TABLE `app_extensions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`target` text NOT NULL,
	`entry_url` text NOT NULL,
	`field_types` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `asset_published` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`file` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`metadata` text DEFAULT '{"altText":{},"tags":[]}' NOT NULL,
	`published_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `asset_id`)
);

CREATE TABLE `assets` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text NOT NULL,
	`file` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`metadata` text DEFAULT '{"altText":{},"tags":[]}' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`environment_id` text,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`status` integer NOT NULL,
	`at` integer NOT NULL
);

CREATE INDEX `audit_log_by_space` ON `audit_log` (`space_id`,`at`);
CREATE TABLE `bulk_job_chunks` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`job_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	`entry_ids` text NOT NULL,
	`payload_key` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failures` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`claimed_at` integer,
	`completed_at` integer,
	PRIMARY KEY(`space_id`, `environment_id`, `job_id`, `chunk_id`)
);

CREATE INDEX `bulk_chunks_open` ON `bulk_job_chunks` (`status`,`created_at`) WHERE "bulk_job_chunks"."status" IN ('pending', 'running');
CREATE TABLE `bulk_jobs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`action` text NOT NULL,
	`config` text,
	`status` text NOT NULL,
	`total_items` integer NOT NULL,
	`total_chunks` integer NOT NULL,
	`completed_chunks` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `comments` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`entry_id` text NOT NULL,
	`parent_id` text,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE INDEX `comments_by_entry` ON `comments` (`space_id`,`environment_id`,`entry_id`);
CREATE TABLE `concept_schemes` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `concepts` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`scheme_id` text NOT NULL,
	`pref_label` text NOT NULL,
	`broader_id` text,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE INDEX `concepts_by_scheme` ON `concepts` (`space_id`,`environment_id`,`scheme_id`);
CREATE TABLE `content_types` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`api_id` text NOT NULL,
	`name` text NOT NULL,
	`display_field` text NOT NULL,
	`fields` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `api_id`)
);

CREATE TABLE `deployment_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE TABLE `entries` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`content_type_api_id` text NOT NULL,
	`status` text NOT NULL,
	`current_version` integer NOT NULL,
	`published_version` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `entry_metadata` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`tags` text NOT NULL,
	`concepts` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `entry_id`)
);

CREATE TABLE `entry_published` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`content_type_api_id` text NOT NULL,
	`version` integer NOT NULL,
	`fields` text NOT NULL,
	`metadata` text,
	`published_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `entry_id`)
);

CREATE INDEX `entry_published_by_type` ON `entry_published` (`space_id`,`environment_id`,`content_type_api_id`);
CREATE TABLE `entry_unique_values` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`content_type_api_id` text NOT NULL,
	`field_api_id` text NOT NULL,
	`locale` text NOT NULL,
	`value` text NOT NULL,
	`entry_id` text NOT NULL
);

CREATE UNIQUE INDEX `entry_unique_values_claim` ON `entry_unique_values` (`space_id`,`environment_id`,`content_type_api_id`,`field_api_id`,`locale`,`value`);
CREATE INDEX `entry_unique_values_by_entry` ON `entry_unique_values` (`space_id`,`environment_id`,`entry_id`);
CREATE TABLE `entry_versions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`version` integer NOT NULL,
	`fields` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `entry_id`, `version`)
);

CREATE TABLE `entry_workflow_state` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`current_step_id` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `entry_id`)
);

CREATE TABLE `environment_aliases` (
	`space_id` text NOT NULL,
	`alias` text NOT NULL,
	`target_environment_id` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `alias`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `environments` (
	`id` text NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `functions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`event_pattern` text NOT NULL,
	`url` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `_guard` (
	`ok` integer NOT NULL,
	CONSTRAINT "guard_ok" CHECK("_guard"."ok" = 1)
);

CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`grant_types` text NOT NULL,
	`scopes` text NOT NULL,
	`token_endpoint_auth_method` text NOT NULL,
	`hashed_client_secret` text,
	`client_uri` text,
	`logo_uri` text,
	`software_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE INDEX `oauth_clients_by_created` ON `oauth_clients` (`created_at`);
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`client_id` text NOT NULL,
	`hashed_code` text NOT NULL,
	`hashed_user_code` text,
	`status` text NOT NULL,
	`scopes` text NOT NULL,
	`space_id` text,
	`subject` text,
	`role_id` text,
	`redirect_uri` text,
	`code_challenge` text,
	`code_challenge_method` text,
	`resource` text,
	`parent_id` text,
	`issued_key_ids` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE UNIQUE INDEX `oauth_grants_kind_hashed_code` ON `oauth_grants` (`kind`,`hashed_code`);
CREATE UNIQUE INDEX `oauth_grants_hashed_user_code` ON `oauth_grants` (`hashed_user_code`);
CREATE INDEX `oauth_grants_by_parent` ON `oauth_grants` (`parent_id`);
CREATE INDEX `oauth_grants_by_expiry` ON `oauth_grants` (`expires_at`);
CREATE INDEX `oauth_grants_by_client_subject` ON `oauth_grants` (`client_id`,`subject`);
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`relayed_at` integer,
	`claimed_by` text,
	`claimed_until` integer
);

CREATE INDEX `outbox_pending` ON `outbox` (`occurred_at`) WHERE "outbox"."relayed_at" IS NULL;
CREATE INDEX `outbox_relayed` ON `outbox` (`relayed_at`) WHERE "outbox"."relayed_at" IS NOT NULL;
CREATE TABLE `plugins` (
	`space_id` text NOT NULL,
	`id` text NOT NULL,
	`manifest` text NOT NULL,
	`checksum` text NOT NULL,
	`bundle_key` text NOT NULL,
	`approved_capabilities` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`installed_by` text,
	`installed_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `id`)
);

CREATE TABLE `preview_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`hashed_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE UNIQUE INDEX `preview_tokens_hashed_token` ON `preview_tokens` (`hashed_token`);
CREATE INDEX `preview_tokens_by_entry` ON `preview_tokens` (`space_id`,`environment_id`,`entry_id`);
CREATE TABLE `references` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`from_entry_id` text NOT NULL,
	`from_field` text NOT NULL,
	`to_id` text NOT NULL,
	`to_type` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `from_entry_id`, `from_field`, `to_id`)
);

CREATE INDEX `references_reverse` ON `references` (`space_id`,`environment_id`,`to_id`);
CREATE TABLE `release_items` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`release_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `release_id`, `entity_id`)
);

CREATE TABLE `releases` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `roles` (
	`space_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`scopes` text NOT NULL,
	`content_grants` text NOT NULL,
	`preset` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `id`)
);

CREATE UNIQUE INDEX `roles_space_preset` ON `roles` (`space_id`,`preset`) WHERE "roles"."preset" IS NOT NULL;
CREATE TABLE `scheduled_actions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`executed_at` integer,
	`error` text,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE INDEX `scheduled_actions_due` ON `scheduled_actions` (`status`,`scheduled_for`);
CREATE TABLE `space_members` (
	`space_id` text NOT NULL,
	`id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`subject` text,
	`role_id` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`space_id`, `id`)
);

CREATE UNIQUE INDEX `space_members_email` ON `space_members` (`space_id`,`email`);
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`default_locale` text NOT NULL,
	`locales` text NOT NULL,
	`fallbacks` text,
	`workflow_separate_duties` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE TABLE `tags` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `tasks` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`entry_id` text NOT NULL,
	`assignee` text,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE INDEX `tasks_by_entry` ON `tasks` (`space_id`,`environment_id`,`entry_id`);
CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`space_id` text NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`status_code` integer,
	`attempts` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE INDEX `webhook_deliveries_by_webhook` ON `webhook_deliveries` (`space_id`,`webhook_id`);
CREATE INDEX `webhook_deliveries_by_created` ON `webhook_deliveries` (`created_at`);
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`url` text NOT NULL,
	`topics` text NOT NULL,
	`secret` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`headers` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);

CREATE TABLE `workflow_definitions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`content_types` text DEFAULT '[]' NOT NULL,
	`graph` text,
	`gates_publish` integer DEFAULT false NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE TABLE `workflow_node_runs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`generation` integer NOT NULL,
	`node_id` text NOT NULL,
	`run` integer NOT NULL,
	`node_type` text NOT NULL,
	`model` text,
	`ran_by` text,
	`status` text NOT NULL,
	`summary` text,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `run_id`, `generation`, `node_id`, `run`)
);

CREATE TABLE `workflow_runs` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`generation` integer NOT NULL,
	`entry_id` text NOT NULL,
	`content_type_api_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`plan` text NOT NULL,
	`nodes` text NOT NULL,
	`vars` text NOT NULL,
	`input` text NOT NULL,
	`seq` integer NOT NULL,
	`waiting_on` text,
	`waiting_at` text,
	`waiting_since` integer,
	`waiting_due` integer,
	`waiting_for` text,
	`stopped_at` text,
	`early_events` text DEFAULT '[]' NOT NULL,
	`started_by` text NOT NULL,
	`trigger_event_id` text,
	`instance_id` text NOT NULL,
	`log_seq` integer NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE INDEX `workflow_runs_by_entry` ON `workflow_runs` (`space_id`,`environment_id`,`entry_id`);
CREATE INDEX `workflow_runs_by_status` ON `workflow_runs` (`space_id`,`environment_id`,`status`);
CREATE INDEX `workflow_runs_by_workflow` ON `workflow_runs` (`space_id`,`environment_id`,`workflow_id`);
CREATE INDEX `workflow_runs_by_waiting_due` ON `workflow_runs` (`space_id`,`environment_id`,`waiting_due`);
CREATE UNIQUE INDEX `workflow_runs_trigger_event` ON `workflow_runs` (`space_id`,`environment_id`,`trigger_event_id`) WHERE "workflow_runs"."trigger_event_id" IS NOT NULL;
CREATE TABLE `workflow_tasks` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`node_id` text NOT NULL,
	`event_type` text NOT NULL,
	`kind` text NOT NULL,
	`entry_id` text NOT NULL,
	`content_type_api_id` text NOT NULL,
	`title` text NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`assignee` text,
	`event` text,
	`required_scope` text,
	`separate_duties` integer DEFAULT false NOT NULL,
	`review_id` text,
	`deadline` integer NOT NULL,
	`status` text NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`note` text,
	`started_by` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `id`)
);

CREATE UNIQUE INDEX `workflow_tasks_run_event` ON `workflow_tasks` (`space_id`,`environment_id`,`run_id`,`event_type`);
CREATE INDEX `workflow_tasks_by_status_deadline` ON `workflow_tasks` (`space_id`,`environment_id`,`status`,`deadline`);
CREATE INDEX `workflow_tasks_by_entry` ON `workflow_tasks` (`space_id`,`environment_id`,`entry_id`);
CREATE TABLE `workflow_timeline` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`key` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`node_id` text,
	`message` text NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `run_id`, `key`)
);

CREATE INDEX `workflow_timeline_by_seq` ON `workflow_timeline` (`space_id`,`environment_id`,`run_id`,`seq`);
CREATE TABLE `workflow_versions` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text,
	PRIMARY KEY(`space_id`, `environment_id`, `workflow_id`, `version`)
);
