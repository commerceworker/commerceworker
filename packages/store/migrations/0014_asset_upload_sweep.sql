-- 0014_asset_upload_sweep: finds the assets whose presigned upload never completed, for the
-- engine's abandoned-upload sweep. Mirrors `assets_awaiting_upload` in packages/store/src/schema.ts.
--
-- A draft created for an upload carries no measurements and no ingest status until its bytes land
-- (ingest records both). The index is partial, so it holds only those rows, ordered by creation
-- across every space and environment: the sweep reads the oldest without scanning the library.
-- Index only: the code already deployed writes the same rows, and nothing is backfilled.
CREATE INDEX IF NOT EXISTS `assets_awaiting_upload` ON `assets` (`created_at`)
	WHERE `status` = 'draft' AND `ingest_status` IS NULL AND `size` IS NULL AND `r2_key` IS NOT NULL;
