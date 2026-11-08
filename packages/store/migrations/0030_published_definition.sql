-- 0030_published_definition: what a live content type serves while a draft revision holds its row.
-- Mirrors `content_types` in packages/store/src/schema.ts.
--
-- `content_types` holds one row per type, the current revision, so a draft save overwrote the
-- definition Delivery served: its fields reached GraphQL at once, and the type left the routes,
-- the sitemap and menus until it was published again. Delivery now reads the row when it is
-- published and this column when a draft has replaced it (0028 did the same for one flag).
--
-- Nullable, no backfill. A published row needs none: the row is the published definition. A row
-- that is a draft today has none to copy (its published revision is gone, if it ever had one), so
-- it stays NULL, and NULL serves the row as it always has, until its next publish.
--
-- Triggers rather than the store, because CI migrates before it deploys and a rollback leaves the
-- migration in place: code that has never heard of this column saves rows here. A copy made only
-- by new code would go stale the moment old code published and then saved a draft, and new code
-- would serve the older definition. Here every writer gets the same result, and the store's own
-- upsert names neither the column nor the rule. They fire on `status` alone: the store's guards
-- touch only `api_id`, and `changes()` doesn't count a trigger's writes, so guards still hold.
-- Going back to code that doesn't read the column loses nothing, and on return it is still right.
ALTER TABLE `content_types` ADD `published_definition` text;

-- A revision replaces the published row: keep what it was. A draft saved over a draft leaves the
-- copy alone, so it stays the definition last published.
CREATE TRIGGER content_types_keep_published AFTER UPDATE OF status ON content_types
WHEN old.status = 'published' AND new.status <> 'published'
BEGIN
  UPDATE content_types
  SET published_definition = json_object(
    'name', old.name,
    'displayField', old.display_field,
    'fields', json(old.fields),
    'urlPattern', old.url_pattern,
    'version', old.version
  )
  WHERE space_id = new.space_id AND environment_id = new.environment_id AND api_id = new.api_id;
END;

-- A publish makes the row the published definition: the copy has nothing left to say.
CREATE TRIGGER content_types_clear_published AFTER UPDATE OF status ON content_types
WHEN new.status = 'published' AND new.published_definition IS NOT NULL
BEGIN
  UPDATE content_types
  SET published_definition = NULL
  WHERE space_id = new.space_id AND environment_id = new.environment_id AND api_id = new.api_id;
END;
