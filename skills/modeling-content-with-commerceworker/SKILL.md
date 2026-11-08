---
name: modeling-content-with-commerceworker
description: Design and change a CommerceWorker content model - content types, the field types, components and repeaters, blocks fields with variants, references, validations and localization - and keep it as code in a repository, applied with the CommerceWorker CLI (model export, model apply with a dry-run diff). Use when creating or editing content types, planning a model change that may affect existing entries, or reviewing a model file.
---

# Modeling content with CommerceWorker

A content model is the set of content types in one environment of a space. Model content by what
it *is* (an article, an author, a promo), not where it appears, so one entry can feed a site, an
app and an agent. Docs: https://docs.commerceworker.com/content/guides/content-modeling/

## A content type

```json
{
  "apiId": "article",
  "name": "Article",
  "displayField": "title",
  "fields": [
    { "apiId": "title", "name": "Title", "type": "Symbol", "required": true, "localized": true, "validations": { "size": { "max": 120 } } },
    { "apiId": "slug", "name": "Slug", "type": "Slug", "required": true, "unique": true },
    { "apiId": "body", "name": "Body", "type": "RichText", "localized": true },
    { "apiId": "author", "name": "Author", "type": "Link", "linkType": "Entry", "validations": { "linkContentTypes": ["author"] } },
    { "apiId": "tags", "name": "Tags", "type": "Array", "items": { "type": "Symbol" } }
  ]
}
```

- `apiId` is what code depends on: up to 64 letters, digits and underscores, starting with a
  letter. Treat it as permanent; rename `name` freely.
- `displayField` names the field used as each entry's title in lists and search.
- Each field: `type`, `required`, `localized`, optional `unique`, `defaultValue`, `validations`.
  In a model file `localized` and `required` default to false and `position` to the field's
  index.

## Field types

`Symbol` (short text), `Slug`, `Text` (long plain text), `RichText` (a document tree, never HTML),
`Integer`, `Number`, `Boolean`, `Date` (ISO 8601), `Location` (`{ lat, lon }`), `JSON`, `Link`
(an entry or an asset), `Component` (a group of nested fields) and `Array` (of `Symbol`, `Link` or
`Component`).

- **Component**: a `Component` field with `fields`. Nested fields can't be localized on their own,
  unique, or slugs; components nest up to three levels. Deeper than that is its own type, linked.
- **Repeater**: an `Array` with `items: { type: 'Component', fields: [...] }`.
- **Blocks**: an `Array` with `items: { type: 'Component', variants: [...] }`, one variant per
  shape (`{ apiId, name, fields }`). Stored blocks carry `_type` (the variant) and `_key` (a stable
  id the server assigns). A slot holding one block: `validations: { size: { max: 1 } }`.
- **References**: `Link` with `linkType` `Entry` or `Asset`, or an `Array` of them; restrict
  targets with `validations.linkContentTypes`.

See [references/field-reference.md](references/field-reference.md) for a blocks field and a
component in full.

## Validations

| Rule               | On                              | Checks                            |
| ------------------ | ------------------------------- | --------------------------------- |
| `in`               | Symbol, Text, Integer, Number   | One of a list (codegen makes it a union type) |
| `regexp`           | Symbol, Text                    | `{ pattern, flags? }` matches     |
| `range`            | Integer, Number                 | `{ min?, max? }`                  |
| `size`             | Symbol, Text, Array             | Length or item count `{ min?, max? }` |
| `linkContentTypes` | Link, Array of Link             | The linked entry's type           |

They run on every write from every surface, including imports and agents.

## Localization

A space has a default locale and others, each optionally falling back (`fr-CA` → `fr` → default).
Values are stored per locale, `{ title: { 'en-US': 'Hello', 'de-DE': 'Hallo' } }`; a field that
isn't `localized` keeps one value under the default locale. Localize text people translate (titles,
bodies, alt text); don't localize identifiers, numbers, references or slugs you share across
locales. Turning `localized` on or off reshapes stored values, so the CLI treats it as destructive.
Docs: https://docs.commerceworker.com/content/start/concepts/#locales

## The model as code

Keep the model in the repository and apply it like a migration:

```sh
commerceworker model export --out content-model.ts    # or .json
# edit content-model.ts, commit it, open a pull request
commerceworker model apply content-model.ts --dry-run
commerceworker model apply content-model.ts --yes --environment staging
```

- `--dry-run` prints the plan, type by type and field by field, and changes nothing. With `--json`
  each change has `path`, `kind`, `destructive` and `detail`.
- **Safe**: a new type, field or block type, and edits to names, `required`, validations,
  defaults and order.
- **Destructive** (marked `!`): removing a field or a block type at any depth, and changing a
  field's `type`, `linkType`, `localized` or item type. `model apply` refuses these (exit code 4)
  unless you pass `--allow-destructive`. Even then the server refuses to remove a field or block
  type that any entry, draft, trashed or published, still holds; the error lists the entries.
- Types in the space but not in the file are left alone; the CLI never deletes a type.
- Each changed type is published as it applies (`--no-publish` leaves drafts).
- Changing the model needs `content:manage`, which a `commerceworker login` device-flow sign-in
  never grants: use a Management key or a personal access token
  (`commerceworker login --url … --token …`, or `COMMERCEWORKER_TOKEN` in CI).
- Off a terminal (CI, an agent), `model apply` needs `--yes`; it never prompts there.

After applying, regenerate types: `commerceworker types --out src/generated/content-types.ts`.

## Changing a model that has content

1. Add new fields optional, fill them (an import with `conflicts: update`, or edits), then make
   them required.
2. To remove a field: clear it in every entry, publish the live ones, purge the trash, then
   remove it.
3. To change a field's type: add a new field, copy values across, switch readers, remove the old.
4. Try it on a copy first: clone `main` to `staging`, `model apply … -e staging`, preview, then
   apply to `main`. Docs: https://docs.commerceworker.com/content/guides/environments/
