-- UCP identity linking sends a shopper back to a platform's return address (docs/architecture.md,
-- "Identity linking"). An admin registers each exact address with the platform; a request must name
-- one as the same string. A JSON array of strings, null for a platform with none (which can't link).
-- One nullable column the code already deployed never reads.
ALTER TABLE ucp_platforms ADD COLUMN redirect_uris TEXT;

-- A replayed authorization code is marked on its row, so a replay that lands before the link its
-- first use is starting exists still ends that link: the link's insert checks it (replayed_at).
ALTER TABLE ucp_link_codes ADD COLUMN replayed_at INTEGER;
