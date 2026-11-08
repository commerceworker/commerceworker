-- 0015_asset_expiry: what the asset expiry sweep reads. Mirrors `asset_published` in
-- packages/store/src/schema.ts.
--
-- `expires_at` (epoch milliseconds) is the published snapshot's `rights.expiresAt`, copied out of
-- the JSON on every publish and rights change so the engine's sweep finds what has expired with one
-- index read across every space, instead of parsing every snapshot each minute. NULL: the rights
-- set no expiry. Nullable, so the code already deployed keeps writing snapshots without knowing it
-- (a snapshot it writes is swept once it is next published or its rights next change).
ALTER TABLE `asset_published` ADD `expires_at` integer;

-- Snapshots published before this migration whose rights already carry an expiry (an imported
-- environment's, say). A value that doesn't parse leaves the column NULL.
UPDATE `asset_published`
SET `expires_at` = CAST(ROUND((julianday(json_extract(`rights`, '$.expiresAt')) - 2440587.5) * 86400000) AS integer)
WHERE json_extract(`rights`, '$.expiresAt') IS NOT NULL;

-- The sweep's read: only snapshots that expire at all, soonest first.
CREATE INDEX `asset_published_by_expiry` ON `asset_published` (`expires_at`) WHERE `expires_at` IS NOT NULL;
