-- 0022_webhook_delivery_resends: which event a delivery carried, and which delivery it resent.
-- Mirrors `webhook_deliveries` in packages/store/src/schema.ts.
--
-- Two nullable columns, so the code already deployed, which neither reads nor writes them, keeps
-- working; records written before them keep NULL (the event type is unknown, and none is a resend).
-- An administrator resends a stored delivery (`POST …/webhooks/:id/deliveries/:deliveryId/resend`);
-- the new attempt names the one it resent in `resend_of`. Nothing is backfilled.
ALTER TABLE `webhook_deliveries` ADD COLUMN `event_type` text;
ALTER TABLE `webhook_deliveries` ADD COLUMN `resend_of` integer;
