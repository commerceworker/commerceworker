-- 0026_content_type_details: a content type's group, description, icon and editor layout.
-- Mirrors `contentTypes.group`, `.description`, `.icon` and `.layout` in packages/store/src/schema.ts.
--
-- Nullable columns, so the code already deployed never reads or writes them: its upsert names
-- only the columns it knows, so a save from it leaves these as they were. Nothing is backfilled;
-- existing types have no group, description, icon or layout until someone sets one. The layout is
-- JSON ({ tabs: [...] }), read by the admin's entry form only and never by Delivery.
ALTER TABLE `content_types` ADD `group_name` text;
ALTER TABLE `content_types` ADD `description` text;
ALTER TABLE `content_types` ADD `icon` text;
ALTER TABLE `content_types` ADD `layout` text;
