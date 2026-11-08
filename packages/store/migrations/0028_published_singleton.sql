-- 0028_published_singleton: whether a content type's PUBLISHED revision is a singleton. Mirrors
-- `content_types` in packages/store/src/schema.ts.
--
-- `content_types` holds one row per type, the current revision, so a draft revision that turns
-- `singleton` on or off would change what Delivery serves at `GET …/singletons/:apiId` before
-- anyone published it. The store sets this column from `singleton` whenever it saves a published
-- revision and leaves it alone on a draft save, so Delivery reads the flag as last published.
--
-- Backfill: a type that is already a singleton (a local database that ran 0027) counts as
-- published with it, as 0027's code served it. A rollback to code without this column leaves it
-- unread and unwritten (selects name their columns; the upsert leaves it out); on return, a type
-- published meanwhile serves the flag this column last had, until its next publish.
ALTER TABLE `content_types` ADD `published_singleton` integer DEFAULT 0 NOT NULL;
UPDATE `content_types` SET `published_singleton` = `singleton` WHERE `singleton` = 1;
