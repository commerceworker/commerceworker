-- 0025_locale_settings: per-locale settings of a space (whether Delivery serves the locale, and
-- which way its text runs). Mirrors `spaces` in packages/store/src/schema.ts.
--
-- One nullable JSON column, `{ "<locale>": { "delivered"?: boolean, "direction"?: "ltr" | "rtl" } }`,
-- beside `locales` rather than inside it: `locales` stays the string array the deployed code
-- reads, and that code names its columns on every read and write, so it never sees this one.
-- NULL (every existing space) means every locale is delivered, in its language's direction;
-- nothing is backfilled.
ALTER TABLE `spaces` ADD `locale_settings` text;
