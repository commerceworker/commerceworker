# WordPress export (WXR) fields

`commerceworker import <file>.xml` reads a WordPress export ("Tools → Export"). The file must be
`<rss><channel>` with a `<wp:wxr_version>`; a plain RSS feed is refused because it has no post ids
or statuses to re-run against.

## What one record holds

| Source field     | From                                                   | Map it to          |
| ---------------- | ------------------------------------------------------ | ------------------ |
| `id`             | `wp:post_id`; the record's identity by default         | `legacyId` (`Symbol`, unique) |
| `title`          | `title`                                                | `Symbol`           |
| `slug`           | `wp:post_name`                                         | `Slug`             |
| `content`        | `content:encoded`, the post's HTML                     | `RichText` (converted) |
| `excerpt`        | `excerpt:encoded`                                      | `Text` or `RichText` |
| `status`         | `wp:status` (`publish`, `draft`, `private`, …)         | usually not mapped |
| `date`, `modified` | ISO 8601; the GMT time when WordPress recorded one   | `Date`             |
| `author`, `authorName` | the login, and the display name from the export's authors | `Symbol`     |
| `link`           | the post's URL on the old site                         | `Symbol` (for redirects) |
| `parentId`, `menuOrder`, `sticky` | page hierarchy and ordering           | `Symbol`, `Integer`, `Boolean` |
| `categories`, `tags` | lists of term names                                | `Array` of `Symbol` |
| `terms.<taxonomy>` | other taxonomies' term names                         | `Array` of `Symbol` |
| `featuredImage`  | the featured image's URL (from the attachment)         | `Symbol`, then upload |
| `meta.<key>`     | post meta, WordPress's own bookkeeping keys left out   | as the value needs |
| `attachmentUrl`  | attachments only (`postType=attachment`)               | `Symbol`           |

## Source options

Pass with `--option name=value`:

- `postType`: which post type to read (`post` by default; `page`, `attachment`, or a custom
  type). Other types are counted in a warning, so nothing is skipped silently.
- `statuses`: which `wp:status` to read. By default everything but `auto-draft` and `trash`.
- `identityField`: the source field naming each record (default `id`).

## Warnings to expect

- "Not read (other post types)": run again with `--option postType=<type>` into its own content
  type.
- Featured images pointing at attachments not in the export: export with media included.
- Comments in the export: they are not imported.
