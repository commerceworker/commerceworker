-- 0018_taxonomy_slugs_counts: slugs, descriptions and localized labels for tags and concepts, and
-- their published usage counts. Mirrors `tags`, `concepts` and `taxonomyUsage` in
-- packages/store/src/schema.ts.
--
-- Expand-only. The new columns are nullable or have a constant default, so the code already
-- deployed keeps inserting tags and concepts: theirs get a NULL slug, which the unique indexes
-- allow any number of (SQLite treats NULLs as distinct), and the daily `taxonomy-recount` sweep
-- gives them one. That code doesn't keep `taxonomy_usage` either; the same sweep recounts it.
--
-- Existing rows get a slug from their label, made the way `normalizeSlug` makes one for ASCII
-- (lowercase letters and digits, every other run of characters one hyphen, at most 200
-- characters, `tag` / `concept` when nothing survives). A slug two terms of one namespace would
-- share keeps the first (by id) and gives the others the tail of their id.

ALTER TABLE `tags` ADD COLUMN `slug` text;
ALTER TABLE `tags` ADD COLUMN `description` text;
ALTER TABLE `tags` ADD COLUMN `labels` text DEFAULT '{}' NOT NULL;
ALTER TABLE `concepts` ADD COLUMN `slug` text;
ALTER TABLE `concepts` ADD COLUMN `description` text;
ALTER TABLE `concepts` ADD COLUMN `labels` text DEFAULT '{}' NOT NULL;

-- One character per step: letters and digits kept, anything else a single hyphen between them.
WITH RECURSIVE walk(space_id, environment_id, id, rest, out) AS (
	SELECT `space_id`, `environment_id`, `id`, lower(`name`), '' FROM `tags`
	UNION ALL
	SELECT space_id, environment_id, id, substr(rest, 2),
		CASE
			WHEN substr(rest, 1, 1) BETWEEN 'a' AND 'z' OR substr(rest, 1, 1) BETWEEN '0' AND '9'
				THEN out || substr(rest, 1, 1)
			WHEN out = '' OR substr(out, -1) = '-' THEN out
			ELSE out || '-'
		END
	FROM walk WHERE rest <> ''
)
UPDATE `tags`
SET `slug` = coalesce(nullif(rtrim(substr(rtrim(w.out, '-'), 1, 200), '-'), ''), 'tag')
FROM walk w
WHERE w.rest = '' AND w.space_id = `tags`.`space_id` AND w.environment_id = `tags`.`environment_id`
	AND w.id = `tags`.`id` AND `tags`.`slug` IS NULL;

WITH RECURSIVE walk(space_id, environment_id, id, rest, out) AS (
	SELECT `space_id`, `environment_id`, `id`, lower(`pref_label`), '' FROM `concepts`
	UNION ALL
	SELECT space_id, environment_id, id, substr(rest, 2),
		CASE
			WHEN substr(rest, 1, 1) BETWEEN 'a' AND 'z' OR substr(rest, 1, 1) BETWEEN '0' AND '9'
				THEN out || substr(rest, 1, 1)
			WHEN out = '' OR substr(out, -1) = '-' THEN out
			ELSE out || '-'
		END
	FROM walk WHERE rest <> ''
)
UPDATE `concepts`
SET `slug` = coalesce(nullif(rtrim(substr(rtrim(w.out, '-'), 1, 200), '-'), ''), 'concept')
FROM walk w
WHERE w.rest = '' AND w.space_id = `concepts`.`space_id`
	AND w.environment_id = `concepts`.`environment_id` AND w.id = `concepts`.`id`
	AND `concepts`.`slug` IS NULL;

-- Two terms of one namespace with the same slug: all but the first take their id's tail.
UPDATE `tags`
SET `slug` = `slug` || '-' || lower(substr(replace(`id`, '-', ''), -12))
FROM (
	SELECT `space_id` AS s, `environment_id` AS e, `id` AS i,
		row_number() OVER (PARTITION BY `space_id`, `environment_id`, `slug` ORDER BY `id`) AS n
	FROM `tags`
) d
WHERE d.n > 1 AND d.s = `tags`.`space_id` AND d.e = `tags`.`environment_id` AND d.i = `tags`.`id`;

UPDATE `concepts`
SET `slug` = `slug` || '-' || lower(substr(replace(`id`, '-', ''), -12))
FROM (
	SELECT `space_id` AS s, `environment_id` AS e, `id` AS i,
		row_number() OVER (
			PARTITION BY `space_id`, `environment_id`, `scheme_id`, `slug` ORDER BY `id`
		) AS n
	FROM `concepts`
) d
WHERE d.n > 1 AND d.s = `concepts`.`space_id` AND d.e = `concepts`.`environment_id`
	AND d.i = `concepts`.`id`;

-- A slug is unique among an environment's tags and within a scheme's concepts; Delivery looks
-- terms up by it.
CREATE UNIQUE INDEX `tags_by_slug` ON `tags` (`space_id`, `environment_id`, `slug`);
CREATE UNIQUE INDEX `concepts_by_slug` ON `concepts` (`space_id`, `environment_id`, `scheme_id`, `slug`);

-- How many published entries of each content type carry each term. Written in the same batch as
-- the published snapshot it counts (the store's `putPublishedMany` / `removePublishedMany`), so a
-- Delivery read only sums a few rows. Environment-scoped (the environment purge clears it).
CREATE TABLE `taxonomy_usage` (
	`space_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`kind` text NOT NULL,
	`term_id` text NOT NULL,
	`content_type_api_id` text NOT NULL,
	`published_count` integer NOT NULL,
	PRIMARY KEY(`space_id`, `environment_id`, `kind`, `term_id`, `content_type_api_id`)
);

INSERT INTO `taxonomy_usage`
	(`space_id`, `environment_id`, `kind`, `term_id`, `content_type_api_id`, `published_count`)
SELECT p.`space_id`, p.`environment_id`, 'tag', j.value, p.`content_type_api_id`,
	count(DISTINCT p.`entry_id`)
FROM `entry_published` p, json_each(p.`metadata`, '$.tags') j
WHERE j.type = 'text'
GROUP BY p.`space_id`, p.`environment_id`, j.value, p.`content_type_api_id`;

INSERT INTO `taxonomy_usage`
	(`space_id`, `environment_id`, `kind`, `term_id`, `content_type_api_id`, `published_count`)
SELECT p.`space_id`, p.`environment_id`, 'concept', j.value, p.`content_type_api_id`,
	count(DISTINCT p.`entry_id`)
FROM `entry_published` p, json_each(p.`metadata`, '$.concepts') j
WHERE j.type = 'text'
GROUP BY p.`space_id`, p.`environment_id`, j.value, p.`content_type_api_id`;
