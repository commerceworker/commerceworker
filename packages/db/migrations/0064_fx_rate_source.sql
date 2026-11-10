-- Who set each exchange rate: the daily ECB refresh ('ecb') or a person ('person', with who in
-- updated_by), so the rates page can show it and the refresh's overwrite rule (`refreshMayWrite`,
-- core) has something to read. Two new columns with defaults: the code already deployed neither
-- reads nor writes them, and its upserts leave them alone. Existing rows read as the feed's.
ALTER TABLE fx_rates ADD COLUMN source TEXT NOT NULL DEFAULT 'ecb';
ALTER TABLE fx_rates ADD COLUMN updated_by TEXT;
