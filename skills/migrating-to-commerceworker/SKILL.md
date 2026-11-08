---
name: migrating-to-commerceworker
description: Move existing content into CommerceWorker from a WordPress export (WXR), a CSV spreadsheet or a JSON export - model the target types, map source fields, convert HTML to structured rich text, dry-run, import as drafts, publish and verify. Use when migrating a site or catalog into CommerceWorker, re-running an import to pick up changes, or checking that a migration landed completely.
---

# Migrating to CommerceWorker

An import maps records from one file onto one content type and creates **drafts** through the same
validation as any write. It is planned before it runs: the analysis is the run without the commit.
Docs: https://docs.commerceworker.com/content/guides/editing-and-publishing/#import-content

## 1. Model the target first

The target content types must exist. Write them as a model file and apply them (see the
`modeling-content-with-commerceworker` skill), with one field to hold each record's source id:

```sh
commerceworker model apply content-model.ts --dry-run
commerceworker model apply content-model.ts --yes
```

Add a `legacyId` (`Symbol`, `unique: true`) to each imported type. It is what makes a second run
update or skip what the first created instead of duplicating it. Rehearse in a scratch
environment (`--environment migration`) and apply to `main` when it's right.

## 2. See what the source holds

Run an analysis with no mapping: every source field comes back in `unmappedSourceFields`.

```sh
commerceworker import export.xml --content-type article --dry-run --json
```

The format comes from the extension (`.csv` → `csv`, `.json` → `json`, `.xml` or `.wxr` → `wxr`),
or pass `--source`.

| Source | Records are                                                                   | Notes |
| ------ | ----------------------------------------------------------------------------- | ----- |
| `csv`  | one per row, fields named by the header row                                   | Quoted newlines and CRLF are handled; an unnamed column becomes `column<n>` |
| `json` | one per object in an array, or in `items`, `records`, `data` or `results`     | One level of nesting flattens to dotted names (`title.rendered`) |
| `wxr`  | one per `<item>` of one post type (`post` by default)                         | `--option postType=page` for pages; see [references/wxr-fields.md](references/wxr-fields.md) |

A record's source id is the first of `id`, `ID`, `uuid`, `slug`; without one, records are named
by position (`row-12`) and a re-run can't match them.

## 3. Map, and dry-run until it's clean

```sh
commerceworker import export.xml --content-type article \
  --map title=title --map slug=slug --map body=content --map excerpt=excerpt \
  --map legacyId=id --identity legacyId --dry-run
```

`--map target=source`: the content type's field first, the source field second. Fix the mapping
until the report shows:

- `missingRequiredFields` and `unknownTargetFields` empty (either blocks the run);
- `unmappedSourceFields` lists only data you mean to leave behind;
- the `issues` sample shows no systematic failure, and `invalid` is what you expect.

Values are coerced to the field type: numbers and booleans (`true`/`yes`/`1`) from text, a
comma-separated cell to an `Array` of `Symbol`.

## 4. Rich text: HTML in, a document out

Map HTML (a post's `content`, a CSV cell) to a `RichText` field and the import converts it to a
`RichTextDocument`; plain text becomes paragraphs. Nothing is stored as HTML.

- Headings, lists, quotes, code, tables and links convert to their nodes; bold, italic,
  underline and code become marks.
- A YouTube or Vimeo iframe, a tweet blockquote, a WordPress embed block, or a bare provider URL
  on its own line becomes an `embed` node with only its URL and provider.
- Images and other media become links to their source URL (there is no asset to point at yet),
  so an editor can see and fix them. To bring the files across, upload them
  (`commerceworker assets upload <file>`) and replace the links.
- Markup with no text in it becomes no value, so a required field reports it.

## 5. Run, then publish

```sh
commerceworker import export.xml --content-type article --map … --identity legacyId --yes
```

- `--conflicts` decides what happens to a record already imported: `skip` (default), `update` or
  `fail`.
- One run takes up to 10,000 records and the API's request size (5 MiB by default). For more, use
  `--job` (a durable job, up to 250,000 records; follow it at `GET …/bulk/jobs/{id}`) or split
  the file.
- Off a terminal the import needs `--yes`; it never prompts there.

Entries arrive as drafts. Publish them (up to 1,000 per call):

```sh
ids=$(commerceworker entries list --content-type article --limit 100 --json | jq -r '.items[].id')
commerceworker entries publish $ids
```

For more than a page, page with `--skip`, or start a bulk job
(https://docs.commerceworker.com/content/guides/editing-and-publishing/#change-many-entries-at-once).
A failed publish is reported per entry and the command exits 1.

## 6. Verify

- Counts: `willCreate + willUpdate` from the analysis against `created` / `updated` in the result,
  and `commerceworker entries list --content-type article --json` (page until short).
- Re-run the analysis with the same mapping: with `--identity` every record should now be
  `willSkip` (or `willUpdate` with `--conflicts update`). Anything in `willCreate` didn't land.
- Spot-check entries: `commerceworker entries get <id> --json`, rich text included.
- Read them as your site will: published entries through Delivery
  (https://docs.commerceworker.com/content/guides/reading-content/).

## Several types

Import one file per content type, referenced types first (authors, then categories, then posts),
each with its own `legacyId`. A `Link` field can't be mapped from a source id yet: import the
records, then set the links with `commerceworker entries update <id> --fields …` (it merges by
field and locale) or the Management SDK, looking each target up by its `legacyId`.
