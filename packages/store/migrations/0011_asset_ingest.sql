-- 0011_asset_ingest: what the asset ingest pipeline (AssetIngestWorkflow) records about an asset's
-- file. Mirrors `assets` in packages/store/src/schema.ts.
--
-- `ingest_status` is pending, processing, ready or error, and `ingest_error` says why when it is
-- error; NULL means ingest never ran on the asset (a hosted video, or a file uploaded before
-- ingest shipped, which the asset reindex job picks up). `duplicate_of` names the oldest other
-- asset in the scope whose bytes hash the same (`content_hash`, already there since 0007).
-- `ai_suggestions` (JSON) marks the alt text locales and tag ids ingest filled from a model and no
-- person has saved yet. Every column is nullable, so the code already deployed keeps writing rows
-- without knowing them; nothing is backfilled.
ALTER TABLE `assets` ADD `ingest_status` text;
ALTER TABLE `assets` ADD `ingest_error` text;
ALTER TABLE `assets` ADD `duplicate_of` text;
ALTER TABLE `assets` ADD `ai_suggestions` text;

-- The reindex job's "never ingested or failed" pass and the admin's processing filter.
CREATE INDEX `assets_by_ingest` ON `assets` (`space_id`, `environment_id`, `ingest_status`);
