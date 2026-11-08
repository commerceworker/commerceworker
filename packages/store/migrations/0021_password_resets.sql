-- 0021_password_resets: self-service password reset codes for the admin's people. Mirrors
-- `passwordResets` in packages/store/src/auth-schema.ts.
--
-- A new table only, so the code already deployed never reads or writes it, and nothing is
-- backfilled. The web Worker writes a row when someone asks for a code (apps/studio/app/lib/
-- password-reset.server.ts) and emails the code; only `code_hash` is kept (HMAC-SHA256 with
-- PASSWORD_PEPPER over the row id and the code). `browser_hash` is the SHA-256 of a random nonce
-- set in the asking browser's reset cookie: a typed code is tried only from that browser, while
-- the emailed link works anywhere. A code works once (`used_at`), until `expires_at` (15
-- minutes); its tries are counted in `auth_failures` (`reset-try`), one atomic upsert per try.
-- Issuing a new code deletes the person's older rows, and a finished reset deletes them all.
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`),
	`code_hash` text NOT NULL,
	`browser_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
-- A typed code is checked against the person's newest live row.
CREATE INDEX `password_resets_user` ON `password_resets` (`user_id`, `created_at`);
-- Finished rows are swept by expiry when a new code is issued.
CREATE INDEX `password_resets_expires` ON `password_resets` (`expires_at`);
