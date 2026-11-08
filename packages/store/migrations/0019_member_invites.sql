-- 0019_member_invites: invitations to the admin. Mirrors `memberInvites` in
-- packages/store/src/schema.ts.
--
-- A new table only, so the code already deployed never reads or writes it, and nothing is
-- backfilled. Deployment-wide, like the people it makes: one invitation can grant roles in several
-- spaces (`grants`, JSON `[{ "spaceId", "roleId" }]`).
--
-- Only hashes of the links' tokens are stored (SHA-256 with TOKEN_PEPPER, as API keys are):
-- `token_hash` for the link the inviter was shown, `email_token_hash` for the one the engine
-- emailed, if it did. `status` is pending, accepted or revoked; an expired invitation is a pending
-- one past `expires_at`, read that way rather than written. `version` is the compare-and-set that
-- makes a link work once: every change bumps it, and a change that finds another version is lost.
CREATE TABLE `member_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`grants` text DEFAULT '[]' NOT NULL,
	`token_hash` text NOT NULL,
	`email_token_hash` text,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`version` integer NOT NULL,
	`invited_by_kind` text NOT NULL,
	`invited_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer NOT NULL,
	`send_count` integer DEFAULT 1 NOT NULL,
	`emailed_at` integer,
	`accepted_at` integer,
	`accepted_by` text,
	`revoked_at` integer,
	`revoked_by_kind` text,
	`revoked_by_id` text
);
-- A link resolves by its token's hash (either link).
CREATE UNIQUE INDEX `member_invites_token` ON `member_invites` (`token_hash`);
CREATE UNIQUE INDEX `member_invites_email_token` ON `member_invites` (`email_token_hash`) WHERE `email_token_hash` IS NOT NULL;
-- The Team page lists them newest first, by status; a new invitation looks for a pending one to
-- the same address.
CREATE INDEX `member_invites_by_status` ON `member_invites` (`status`, `created_at`);
CREATE INDEX `member_invites_by_email` ON `member_invites` (`email`, `status`);
