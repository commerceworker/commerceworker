-- 0013_plugin_storage_settings: what a sandboxed plugin keeps (the `kv:storage` capability) and
-- how an operator configures it (manifest-declared settings). Mirrors `plugin_kv` and
-- `plugin_settings` in packages/store/src/schema.ts.
--
-- `plugin_kv` is one row per key, per plugin, per environment. The primary key leads with the
-- scope and the plugin id, and every statement the store runs filters on all three: that is the
-- isolation between plugins. Values are JSON text, capped by the application (64 KiB, 1000 keys
-- per plugin per environment). Rows belong to their environment and are purged with it.
--
-- `plugin_settings` is one row per installed plugin per space. `config` holds the non-secret
-- values; `secrets` maps each secret field to its value sealed under DATA_KEY (the reseal sweep
-- scans it as the `plugin_settings.secrets` column). `version` is the compare-and-set token for
-- concurrent edits.
--
-- New tables only: the code already deployed never reads them.
CREATE TABLE `plugin_kv` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `plugin_id`, `key`)
);

CREATE TABLE `plugin_settings` (
	`space_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secrets` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`space_id`, `plugin_id`)
);
