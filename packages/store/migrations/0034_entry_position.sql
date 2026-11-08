-- 0034_entry_position: each entry's place in its content type's manual order. Mirrors `entries`
-- and `entry_published` in packages/store/src/schema.ts.
--
-- `position` is a key that sorts by plain comparison (`positionBetween` in
-- packages/domain/src/entry/position.ts). Nullable, no backfill: an entry with none sorts by its
-- id, which uses the same characters and, minted as a UUIDv7, sorts by creation time. So every type
-- starts in creation order and a new entry lands at the end without anything writing a key; only a
-- move writes one. The order is read as `COALESCE(position, id)`, which the two indexes below hold,
-- ending in the id that breaks ties, so an ordered list is one index range with no sort.
--
-- `entry_published` keeps its own copy, so Delivery orders published rows without a join. Triggers
-- keep it, for the reason 0030 gives: CI migrates before it deploys and a rollback leaves the
-- migration in place, so code that has never heard of this column publishes entries. A copy made
-- only by new code would go missing the moment old code published one. Here every writer gets the
-- same result: a first publish copies the key, and a move copies it to a published row. A
-- republish is an upsert that never names the column, so the published row keeps it. The triggers
-- fire on `position` alone, which only a move writes, and `changes()` doesn't count a trigger's
-- writes, so the store's guards still hold.
ALTER TABLE `entries` ADD `position` text;
ALTER TABLE `entry_published` ADD `position` text;

CREATE INDEX IF NOT EXISTS `entries_by_position`
  ON `entries` (`space_id`, `environment_id`, `content_type_api_id`, COALESCE(`position`, `id`), `id`);
CREATE INDEX IF NOT EXISTS `entry_published_by_position`
  ON `entry_published` (`space_id`, `environment_id`, `content_type_api_id`, COALESCE(`position`, `entry_id`), `entry_id`);

-- A move: the published row, if there is one, follows.
CREATE TRIGGER entries_position_published AFTER UPDATE OF position ON entries
WHEN new.position IS NOT old.position
BEGIN
  UPDATE entry_published
  SET position = new.position
  WHERE space_id = new.space_id AND environment_id = new.environment_id AND entry_id = new.id;
END;

-- A first publish (or a publish after an unpublish): the published row starts where the entry is.
CREATE TRIGGER entry_published_position AFTER INSERT ON entry_published
WHEN new.position IS NULL
BEGIN
  UPDATE entry_published
  SET position = (
    SELECT position FROM entries
    WHERE space_id = new.space_id AND environment_id = new.environment_id AND id = new.entry_id
  )
  WHERE space_id = new.space_id AND environment_id = new.environment_id AND entry_id = new.entry_id;
END;
