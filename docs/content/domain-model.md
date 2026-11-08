# Domain model

The domain layer (`packages/domain`) is pure TypeScript with no infrastructure dependencies. It
defines the structured-content model and the rules that govern it.

## Core scalar types

| Type                | Shape                                               | Notes                                                                     |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `Scope`             | `{ spaceId, environmentId }`                        | The multi-tenant boundary on every operation                              |
| `LocaleCode`        | `string`                                            | BCP-47, e.g. `"en-US"`                                                    |
| `LocalizedValue`    | `Record<LocaleCode, unknown>`                       | A field value keyed by locale, e.g. `{ "en-US": "Hi", "de-DE": "Hallo" }` |
| `EntryFields`       | `Record<string, LocalizedValue>`                    | All field values for an entry: `fieldApiId → locale → value`              |
| `EntryStatus`       | `'draft' \| 'changed' \| 'published' \| 'archived'` | Entry lifecycle                                                           |
| `ContentTypeStatus` | `'draft' \| 'published'`                            | Content-type lifecycle                                                    |

A space id (`SPACE_ID_PATTERN`) is 1–64 ASCII letters, digits, `.`, `_` or `-`, starting with a
letter or digit. It is the first segment of the space's asset keys in the media bucket
(`<space>/<environment>/<assetId>/<file>`), which also holds archived version bodies, staged import
chunks, plugin bundles, dead letters and zip downloads under their own top-level prefixes. Those prefixes are
`RESERVED_SPACE_IDS` (`versions`, `imports`, `plugins`, `dlq`, `zips`): `createSpace` refuses each, in any
case, with a `ValidationError`, so deleting a space's files never reaches them.

Non-localized fields still use `LocalizedValue` with a single entry under the space's default
locale, keeping the read/write paths uniform.

## Field types

A content type is an ordered list of typed, validated fields. The 13 field types
(`FIELD_TYPES`):

| Type        | Represents                                          | Stored value                   |
| ----------- | -------------------------------------------------------- | ------------------------------ |
| `Symbol`    | Short single-line text                              | `string`                       |
| `Slug`      | URL-safe identifier (normalized on write)           | `string`                       |
| `Text`      | Long multi-line text                                | `string`                       |
| `RichText`  | Structured rich-text document                       | object                         |
| `Integer`   | Whole number                                        | integer                        |
| `Number`    | Floating-point number                               | number                         |
| `Boolean`   | True/false                                          | boolean                        |
| `Date`      | A date, date and time, or time of day (`format`)         | string                         |
| `Location`  | Geographic point                                    | `{ lat: number, lon: number }` |
| `Seo`       | Search engine metadata (see [SEO](#seo-and-the-sitemap)) | object of fixed shape     |
| `JSON`      | Arbitrary JSON                                      | object                         |
| `Link`      | Reference to an Entry or Asset                      | `{ id, linkType }`             |
| `Component` | A group of nested typed fields                      | object keyed by nested apiId   |
| `Array`     | List of scalars, `Link`s or `Component`s (or blocks)     | array                          |

### Components and repeaters

A `Component` is a named group of nested field definitions — the "hero block", "call to action",
"spec row" shape. An `Array` whose `items.type` is `Component` is the **repeater**: a list of
feature cards, timeline entries, table rows.

Nested fields are ordinary `FieldDefinition`s, with three things withheld, each because it would
otherwise be a promise nothing keeps:

| Withheld    | Why                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localized` | Localization is decided once, on the field holding the component. Per-leaf flags would let one card in a list be German while its sibling was not — a shape no editor can express and no fallback chain can resolve. |
| `unique`    | The constraint behind it is a row per (content type, field, locale, value). There is no row for the third card's title.                                                                                              |
| `Slug`      | Slugs are normalized by walking an entry's top-level fields, so a nested one would be stored exactly as typed and then fail its own validation.                                                                      |

Components nest up to `MAX_COMPONENT_DEPTH` (3). The cap exists because validation, codegen,
GraphQL type generation and the editor all walk this tree; anything deeper is better modeled as its
own content type and linked, which is what the error says.

Everything else behaves as it does at the top level, and is tested that way:

- **Validation recurses**, and issues are addressed by path — `hero.title`, `cards[2].title`. An
  editor looking at eight cards needs to be told which one is wrong.
- **Required means required** wherever the component appears, including the fourth repeater item.
- **`defaultValue` fills gaps** in components that exist, including every item of a repeater. A
  component the author never supplied stays absent rather than being invented from its defaults.
- **Links nested anywhere produce reference edges**, so referential integrity, `?include=`
  resolution and reverse cache invalidation cover component content. Edges are attributed to the
  **top-level** field, not the nested path: an edge answers "does anything still link to this?", and
  knowing it was card 3's image makes that answer no better while multiplying near-identical rows.
- **Text inside components is embedded and indexed**, so component-modeled content is findable.

**GraphQL** gives a component a real object type, named for the content type and the field path —
`ArticleHero`, `ArticleHeroCta`, and `[PageCards]` for a repeater. Type names are global and
"content type + field path" is not unique, so a collision takes a numeric suffix; content-type names
are reserved first, since those are what clients query by. A component with no declared shape stays
`JSON`, because an object type with no fields is not a legal schema.

### Blocks

A **blocks field** is an `Array` of `Component` whose `items` declares `variants` instead of
`fields` (never both): a page body assembled from a hero, then a rich-text section, then a call to
action, in whatever order the editor chooses. Each variant is `{ apiId, name, fields }`
(`ComponentVariant`, `packages/domain/src/content-type/field.ts`), and each stored element names its
variant and carries a stable key:

```json
{
  "_type": "hero",
  "_key": "0192f4a1-…",
  "heading": "Spring launch",
  "image": { "id": "…", "linkType": "Asset" }
}
```

`_`-prefixed keys cannot collide with a field apiId, which must start with a letter. A variant-less
repeater is unchanged: its elements carry neither key.

- **Definition rules** (`defineContentType` / `reviseContentType`): at least one variant, variant
  apiIds legal and unique within the field, each variant at least one field. A variant's fields
  obey the component rules above (no `localized`, `unique` or `Slug`) and count toward
  `MAX_COMPONENT_DEPTH`. Variants are refused on a single `Component`: one optional block slot is
  the same `Array` field with `validations.size.max: 1`. Content type fields are stored as JSON
  (`content_types.fields`), so blocks needed no migration.
- **`_key` is assigned on write.** `createEntry` and `updateEntry` fill a missing `_key` from
  `ctx.ids.newId()` (`assignBlockKeys`, however deep the blocks field sits) and keep the ones sent,
  so a block keeps its identity across edits and reorders. Validation does not require `_key`
  (an AI draft or an import dry-run is judged on content), but a present key must be a non-empty
  string used once in the field value: a duplicate is refused at `body[i]`.
- **`_key` is unique per list, not per tree.** Validation refuses a key repeated within one field
  value at one level, but the same key at two depths (a section pasted inside itself with its
  keys) is stored. Keys minted on write never collide; a caller's can.
- **Block patches** (`applyBlockPatch` in `packages/domain/src/content-type/block-patch.ts`) edit
  a top-level blocks field in one locale by key: `insert`, `update` (a block's own fields, never
  one that holds blocks), `move` (never into itself or a block inside it), `remove` and
  `duplicate` (fresh keys throughout). A block's slots are the blocks fields its variant declares
  directly; blocks under a plain component or repeater inside a block are carried along but not
  addressable. A key two blocks of the tree hold is refused as ambiguous rather than guessed at,
  and so is an op on a block whose parent has no `_key` (its place couldn't be written into an
  undo). A `ref` resolves only on its own field and locale. Ops apply in order, all or none, and
  the first that can't apply is reported with its index. `invertBlockPatch` takes the `applied`
  ops (refs and positions resolved, every key present) and returns the ops that undo them;
  `outlineBlocks` is the tree of keys, types and labels to build a patch from. The use-case
  (`patchEntryBlocks`) holds the patch to `expectedVersion` and saves through `saveEntryDraft`, so
  the result is validated as any save is. It answers the inverse only when the save stored the
  blocks the patch made (`null` when an `entry:beforeSave` plugin rewrote them).
  `authorizeBlockPatch` is the role check both surfaces run before it.
- **Validation** looks up each element's variant by `_type`; a missing or unknown `_type` is one
  issue at `body[i]`, and the element is then checked as that variant's component (`body[i].heading`).
- **References, defaults and search** read each element with its own variant's fields, so links in
  a block produce edges (and `?include=` resolves them), nested defaults apply per variant, and
  text is indexed. `_type` and `_key` are left out of the embedded text.
- **Removing a variant** is refused with `409 conflict` while any entry still has a block of it
  (`updateContentType`, `removedVariants` / `removedVariantUses` in
  `packages/domain/src/content-type/blocks.ts`). It scans the type's current versions, the trash
  and the published snapshots in keyset pages of 100 by entry id, only when a variant is removed,
  and names each `location: variant` with the entries using it (`details.variantsInUse`). Adding a
  variant, or an optional field to one, is always allowed.
- **Removing a field**, at any depth, is refused the same way while any entry still holds a
  value for it (anything but absent or `null`): `removedFields` / `removedFieldUses` name each
  location (`seo.description`, `body[hero].image`) with its entries (`details.fieldsInUse`). One
  scan (`removedContentInUse` in `packages/application/src/content-types.ts`) serves both checks
  and the promotion risk check. There is no override, as for variants: clear the values, publish
  the entries whose published snapshot holds them, purge them from the trash, then remove it.
- **Tightening a rule** on a top-level field (its `format`, `dateRange` or `assetMimeTypes`,
  or its list items') is saved, never refused: `tightenedRulesInUse` judges each changed field
  alone against the current version of every entry out of the trash (keyset pages of 100, a
  page's linked assets read together, only when such a rule changed) and the save answers with
  `warnings: [{ field, entries, message }]`, counting the entries the new rule refuses and the old
  one took. Each such entry is refused on its next save until the value changes.

**GraphQL** gives a blocks field a union named like a component in that place (`LandingPageBody`)
with one object type per variant (`LandingPageBodyHero`), each exposing `_type`, `_key` and the
variant's fields; `resolveType` reads `_type`. An element whose `_type` names no variant is left
out of the list rather than failing the query. **SDK codegen** emits a discriminated union on
`_type`: `({ _type: 'hero'; _key: string; heading: string } | …)[]`.

One surface still treats a component as opaque, deliberately:

- **Query pushdown** cannot filter on a nested value. Filter on a top-level field, or model the
  thing you filter by as one.

The admin's entry editor renders a component as a group of real inputs, and a repeater as a list
with add / remove / reorder. Validation issues land on the nested input that caused them, and the
error summary reads paths as directions ("Cards 3 › Title", not `cards[2].title`). The content-type
dialog does not offer to _create_ a component — it has no nested-field authoring, and a component
with no fields is refused by the domain — so component shapes are authored through the API or MCP.
Existing ones load, edit and round-trip there unchanged. Blocks are the exception: the dialog's
**Blocks** type authors the variants (a name, an API ID and a flat list of fields each), and the
entry editor adds a block from an "Add block" menu of variants (a plain "Add …" button when there
is one), reorders and removes blocks, and names them by type in the error summary
("Body 2 (Hero) › Heading").

### Rich text

A `RichText` value is a document tree (`packages/domain/src/rich-text/rich-text.ts`): a
`document` root whose `content` is block and inline nodes. Text lives in `text` nodes carrying
`marks`; reference nodes carry a `data.target` link so the reference graph can be extracted from
rich text exactly as from `Link` fields (`extractRichTextTargets`). `richTextToPlainText`
flattens a document for search/embedding; a table reads as one block, a line per row with its
cells separated by `|`, and an `embed` as `Title (url)` (its URL alone when it has no title).

The node vocabulary (`RICH_TEXT_BLOCK_NODE_TYPES`, `RICH_TEXT_INLINE_NODE_TYPES`):

- **Blocks** — `paragraph`, `heading-1`…`heading-6`, `blockquote`, `unordered-list`,
  `ordered-list`, `list-item`, `code-block` (optional `data.language`), `hr`.
- **Tables** — `table` → `table-row` → `table-header-cell` | `table-cell` → blocks (normally a
  `paragraph`), each with `data: {}`. A merged cell carries `data.colspan` / `data.rowspan`
  (integers above 1); column widths are not stored.
- **Inline** — `text` (with `marks`), `hard-break`, `hyperlink` (`data.uri`, text children).
- **References** (`REFERENCE_NODE_TYPES`, each with `data.target: { id, linkType }`) —
  `embedded-entry-block`, `embedded-asset-block`, `embedded-entry-inline`, `entry-hyperlink`,
  `asset-hyperlink`.
- **External media** — `embed`, a block with no `content` whose `data` is structured metadata
  (`EmbedData`, `packages/domain/src/rich-text/embed.ts`): `url` (an https page on an allowed
  provider) and `provider` are required; `kind` (`video` | `post` | `audio` | `other`), `title`,
  `authorName`, `thumbnail: { url, width?, height? }`, `width`, `height` and `aspectRatio` are
  optional. The provider's oEmbed `html` is never stored or delivered: channels build their own
  player or link card from the data.
- **Marks** — `bold`, `italic`, `underline`, `code`, `strikethrough`.

`validateRichText` runs on every write (API, MCP, editor, import, AI) and refuses:

- a `nodeType` outside the vocabulary, anywhere in the tree — delivery clients switch on
  `nodeType`, so a type they cannot know is refused rather than delivered;
- a `text` node without a string `value`, a reference node without a well-formed `data.target`,
  and a node whose `data` is not an object or whose `content` is not an array;
- an `embed` whose `data.url` is not https or not on an allowed provider (`EMBED_PROVIDERS`:
  YouTube, Vimeo, X, Bluesky, Spotify, SoundCloud, and Mastodon matched by URL shape on any
  instance), whose `data.provider` is not the one that URL belongs to, whose metadata is
  malformed, that holds `content`, or whose `data` carries any other key (an `html` snippet
  included); Mastodon accepts any public domain with a post's URL shape (never a named provider's
  host), so a `mastodon` embed vouches for its shape, not its origin: channels should frame only
  instances they trust;
- a `hyperlink` whose `data.uri` is missing or unsafe. `safeLinkUri` allows `http`, `https`,
  `mailto` and `tel`, plus relative and fragment URIs; it reads the scheme the way a browser does
  (ignoring embedded whitespace and control characters) and refuses an undecoded entity before
  the path (`javascript&colon;`). The HTML import applies the same rule, keeping an unsafe link's
  text and dropping its target;
- a document over `MAX_RICH_TEXT_BYTES` (512 KiB serialized, twice the `JSON` field cap) or
  nested more than `MAX_RICH_TEXT_DEPTH` (64) nodes below the root;
- table structure: a table must hold at least one `table-row`, and only rows; a row at least
  one cell, and only cells; a cell at least one block, and no bare inline nodes (wrap text in a
  `paragraph`). Rows and cells outside their parent are refused, as is a table over
  `MAX_TABLE_ROWS` (500) rows or a row over `MAX_TABLE_COLUMNS` (50) cells. Spans must be
  integers within those bounds. Tables may nest inside a cell.

Beyond tables, which node may hold which (for example blocks inside inline nodes) is not yet
constrained. The admin editor carries a table it can't draw as a grid (`isWellFormedTable`)
through unchanged.

`resolveEmbed` (`POST …/embeds/resolve`, MCP `embed_resolve`, `content:write`) fills an embed's
metadata: it matches the URL to its provider, screens the provider's oEmbed endpoint with
`assertSafeExternalUrl` (a Mastodon URL names its own host), fetches it through the
`RemoteFetcher` port (64 KiB, 5 s, no redirects) and keeps only the `EmbedData` fields
(`embedFromOEmbed`). A provider that fails to answer gives `resolved: false` and an embed of the
URL, provider and kind alone, which is valid to store. The admin editor calls it when a provider
URL is pasted; imports do not (`richTextFromHtml` makes the bare node), so an imported embed has
no title until someone resolves it.

`richTextFromHtml` reads a provider's player `<iframe>` (YouTube, Vimeo, Spotify, SoundCloud,
Bluesky and Mastodon players map back to the page URL), a post `<blockquote>`
(`twitter-tweet`, `bluesky-embed`, `mastodon-embed`), a WordPress `wp-block-embed` figure (its
caption stays as a paragraph after it), and a provider URL alone on its line or in `[embed]…[/embed]`
(WordPress's classic editor) as an `embed` node. A player inside a paragraph is lifted out, splitting
the paragraph. Media from any other host stays a link to its source, as before.

In Delivery, `?include=` resolves rich-text references like `Link` fields: each reference node's
`data.target` becomes the embedded entry or asset (the node and its `nodeType` stay), and a
dangling, unpublished or cyclic target stays a `{ id, linkType }` stub.

### Slug, `unique` and `defaultValue`

**`Slug`** is a constrained string: lowercase ASCII letters, digits and single hyphens, ≤200
characters. Values are normalized on every write (`normalizeSlug`), so an editor can type
"Crème Brûlée" and store `creme-brulee`. Normalization is idempotent and transliterates accents
rather than dropping the letter; characters with no ASCII equivalent are removed, so a title that
is entirely non-Latin normalizes to `''` and the caller decides what to do.

**`unique`** means no two entries of the content type may share a value, compared **per locale**
and scoped **per content type** — a post named `about` does not stop a page being named `about`.
It is backed by a real uniqueness constraint (`entry_unique_values`, one row per claim with a
unique index), not a read-then-write check, so two concurrent creates of the same slug cannot both
succeed. A pre-check runs first purely to produce a message naming the field and the entry holding
the value; the constraint is what guarantees the invariant.

Only the types in `UNIQUE_FIELD_TYPES` may declare it (`Symbol`, `Slug`, `Text`, `Integer`,
`Number`, `Date`). Declaring it elsewhere is refused at content-type authoring time rather than
accepted and never enforced. Empty values are not claims — otherwise a single entry with an empty
slug would block every other entry from having one.

Claims follow the trash lifecycle: trashing an entry **frees** its values (an editor who deleted
`about` expects to reuse it), and restoring **re-claims** them, which can legitimately fail with a
409 if someone took the value meanwhile. Duplicating an entry rewrites its unique values to free
ones (`about` → `about-2`) rather than failing.

There is deliberately **no `indexed` attribute**: field values live in a JSON `text` column, so
honouring it would mean issuing DDL per field on publish. Accepting the flag and not indexing
would be a promise the storage layer does not keep.

**`defaultValue`** is applied only on **create**, for fields the caller omitted. An update that
omits a field means "leave it alone" and one that clears it means "make it empty" — re-applying a
default in either case would override the editor. A bare value fills every locale of a localized
field; a `{ locale: value }` map sets them individually. A default is only read as a locale map
when _every_ key is one of the space's locales, so a JSON field defaulting to `{ theme: 'dark' }`
is stored whole rather than torn apart.

### Field definition

```ts
interface FieldDefinition {
  apiId: string; // unique within the type; /[a-zA-Z][a-zA-Z0-9_]*/, ≤ 64 chars
  name: string; // human-facing label
  help?: string; // how to fill it: under the editor's input, and given to a model (≤ 500)
  placeholder?: string; // an example in the empty input; never stored (≤ 200)
  description?: string; // what the field means, for agents and API readers (≤ 2000)
  type: FieldType;
  format?: 'date' | 'datetime' | 'time'; // for Date fields (see Date formats)
  localized: boolean; // may values differ per locale?
  required: boolean;
  position: number; // ascending order within the type
  validations?: FieldValidations;
  rules?: readonly FieldRule[]; // hide or disable it while a sibling matches (≤ 10)
  linkType?: 'Entry' | 'Asset'; // for Link fields
  items?: {
    // for Array fields
    type: 'Symbol' | 'Text' | 'Integer' | 'Number' | 'Date' | 'Link' | 'Component';
    format?: 'date' | 'datetime' | 'time'; // for a list of Dates
    linkType?: 'Entry' | 'Asset';
    validations?: FieldValidations;
    fields?: readonly FieldDefinition[]; // for Array-of-Component
    variants?: readonly { apiId: string; name: string; fields: readonly FieldDefinition[] }[]; // blocks, instead of fields
  };
  fields?: readonly FieldDefinition[]; // for Component fields
}
```

### Per-field validations

```ts
interface FieldValidations {
  in?: readonly FieldOption[]; // enumeration (Symbol/Text/Integer/Number)
  regexp?: { pattern: string; flags?: string; preset?: PatternPreset }; // pattern match (Symbol/Text)
  range?: { min?: number; max?: number }; // numeric range, inclusive (Integer/Number)
  size?: { min?: number; max?: number }; // length (Symbol/Text) or item count (Array)
  linkContentTypes?: readonly string[]; // restrict Link targets to these content-type apiIds
  dateRange?: { min?: string; max?: string }; // inclusive Date bounds, in the field's format
  assetMimeTypes?: readonly string[]; // an asset link's allowed MIME types: exact or `image/*`
  messages?: { [rule in MessageRule]?: string }; // custom error text, keyed by rule
}
type FieldOption = string | number | { value: string | number; label: string };
```

### Date formats

A Date field's `format` says what its value holds, each in one written form (`dates.ts`):

| `format`   | Value                                                                |
| ---------- | -------------------------------------------------------------------- |
| `date`     | `2026-11-03` (a real calendar date: `2026-02-30` is refused)         |
| `datetime` | `2026-11-03T14:30`, optionally seconds, fraction and `Z` or `±hh:mm` |
| `time`     | `14:30` or `14:30:15`                                                |
| (none)     | any ISO-8601 string `Date.parse` reads, as before formats existed    |

`validations.dateRange` bounds a Date inclusively; each bound is written in the field's format and
checked when the type is saved (a bound that doesn't read, or `min` after `max`, is refused).
Values compare by `dateSortKey`: milliseconds for a date or date and time, seconds into the day for
a time. A list of Dates takes `items.format` and is checked element by element.

### Lists of scalars

An `Array`'s `items.type` is `Symbol`, `Text`, `Integer`, `Number`, `Date`, `Link` or `Component`.
Each element of a list of scalars is checked against its type (and a Date element against
`items.format`), with the issue reported at the element (`sizes[2]`). Element rules
(`items.validations`) are stored but not yet enforced per element. GraphQL types a list of scalars
as a list of that scalar (`[Int]`), and codegen as `number[]` or `string[]`.

### Asset MIME types

`validations.assetMimeTypes` on an asset `Link` (or an Array of them) lists the MIME types a linked
asset may have, exactly (`application/pdf`) or by family (`image/*`); at most 50. The rule is on the
field and the type on the asset, so it is checked on write by the use-case, not the validator:
`assetMimeChecks` names every asset link under such a rule (any depth, every locale),
`createEntry`, `updateEntry`, `validateEntry` and an environment merge (against the target's
assets) read those assets in one batch (`assets.getMany`) and refuse one whose `file.contentType`
doesn't match (`mimeTypeAllowed`), with the field's `messages.assetMimeTypes` when set; the
default message names what the field takes, never the asset's own type. It checks the type the
file was declared with on upload, not its bytes. A link to an asset that doesn't exist is left to
the publish gate, as any link is.

### Pattern presets

`regexp.preset` names a pattern from `PATTERN_PRESETS` (`patterns.ts`): `email`, `url` (http or
https), `slug`, `phone` (international, `+14155550123`), `hexColor` and `usZipCode`. When the type
is saved (`compilePatternPresets`) the preset's `pattern` and `flags` are written into the rule
beside its name, so the stored rule is an ordinary screened pattern every reader enforces, and a
preset changed in a later release takes effect when the type is next saved. Each preset passes
`unsafeRegexReason`. An unknown preset is refused by name.

These settings are refused where they mean nothing (a `format` on a non-Date, `assetMimeTypes` on
anything but an asset link, `items.format` on a non-Date list) and checked only when new against
the stored field. Snapshot import and clone drop the ones a field can't use
(`normalizeLegacyFields`).

**Breaking (GraphQL):** a list of `Symbol` values (`Array` with `items.type: 'Symbol'`) was typed
`JSON` and is now `[String]`, like every list of scalars (`[Int]`, `[Float]`, `[String]`); a
query that selected it as a JSON scalar keeps working, but generated client types change.

**Rollout.** A time-only Date (`format: 'time'`, or `items.format: 'time'`) and a list of `Text`,
`Integer`, `Number` or `Date` shipped in two releases. The first read them (validation, the entry
form, codegen, GraphQL) and refused a new one on write, because the release before it reads them
wrongly: its validator demands a full ISO date and checks no list element, its form edits such a
list as raw JSON, and its codegen types it as strings. The second, deployed once the first was
everywhere, accepts them on write. A rollback goes no further back than the first, or an entry
holding one could no longer be saved.

### Field guidance

`help`, `placeholder` and `description` are plain text for whoever fills the field, capped by
`FIELD_GUIDANCE_LIMITS`; a blank one (empty or whitespace) is left out of the stored definition. The
admin's entry form shows `help` under the input (wired to it with `aria-describedby`, the rich-text
editor included) and `placeholder` in it; `description` is read from the model (MCP
`model_get_content_type`, the API) rather than shown on every form.

Guidance is author text (and imported text), so a prompt never carries it as instructions.
`fieldGuidance` collapses a field's description and help to one line of at most
`FIELD_GUIDANCE_LIMITS.brief` (600) characters, and `describeFieldForModel` (application) puts it
after the field's name, labelled as describing the field and inside `<user_content>` delimiters,
with `UNTRUSTED_CONTENT_GUARD` in the system prompt. AI drafting, canvas, autofill, the `ai.enrich`
node and the agent runtime's enrich, improve and repurpose agents all describe fields this way.

An `in` option is a bare value or `{ value, label }`; both forms mix in one list, so definitions
stored before labels still validate. An entry stores and is checked against the `value`; the label
is what an editor picks it by (the form draws a select), so relabelling never invalidates content.
A value is a string or a finite number, never `''` (the select's empty choice); values are unique
by their text, so `'1'` and `1` clash; a label is non-empty.

Nothing was checked before guidance existed, so a stored definition may hold a duplicate or
non-scalar option, a non-text or oversize guidance value, or a message for a rule it lacks. A
revision refuses such a value only when it is new: an option that occurs more often than in the
stored list (options compared by type, text and label, never key order), or guidance or a message
that differs from the stored one. A legacy type therefore stays editable, and `createContentType`
on an existing apiId revises it for the same reason. The request schemas (HTTP and MCP) leave these
keys to the domain for the same reason.

An environment snapshot import or clone normalises the snapshot's model once, before its checks
(`normalizeSnapshotModel` → `normalizeLegacyFields`), so every entry is validated against the model
that will be written and one holding a dropped option refuses the import before any write.
`normalizeOptions` drops unusable options and keeps each value once; of a clash by text (`'1'` and
`1`) it keeps the one of the field's type (a number for Integer and Number, a string for Symbol
and Text), and the entry form draws its select the same way. A list with nothing left goes, and so
do guidance that isn't text within its cap, unusable messages and any message on an Array's
elements. Readers treat a stored `in` that is not a list as no rule.

`messages` replaces a rule's default error text, keyed by rule (`in`, `regexp`, `range`, `size`,
`dateRange`, `assetMimeTypes`;
at most 500 characters). It is a map rather than a key on each rule because `in` is a list. A
message for a rule the field does not declare, or for an unknown rule, is refused when the type is
defined, and so is any `messages` on an Array's `items.validations`: element rules are stored but
not yet enforced per element (per-element `in` is planned). Content types are stored as JSON
definitions, so none of this needs a migration.

### Conditional field rules

A field's `rules` hide or disable it while a sibling's value matches
(`packages/domain/src/content-type/field-rules.ts`):

```ts
interface FieldRule {
  action: 'hide' | 'disable';
  when: {
    field: string; // a sibling's apiId, or a dot path into a sibling Component (`hero.style`)
    operator: 'eq' | 'ne' | 'in' | 'empty' | 'notEmpty' | 'gt' | 'lt';
    value?: string | number | boolean | readonly (string | number)[]; // a list for `in`; none for empty/notEmpty
  };
}
```

Any matching rule applies. `eq`, `ne` and `in` compare strictly (`'2'` is not `2`); `empty` means
absent, null, blank text or an empty list or object; `gt` and `lt` compare numbers and are refused
on a sibling that is not an Integer or Number. A rule names a sibling at its own level: a top-level
field reads top-level fields, a component's field reads the fields beside it in that component.

`fieldState(field, values)` gives `{ hidden, disabled }` from the values being written, never from
what was stored, so the admin's form (live, as the editor types) and the save judge the same thing.
A condition reads a sibling's raw value whether or not that sibling is itself hidden, so rules
never chase each other in a cycle. A top-level field's localized sibling is read in the same
locale; one that is not localized, in the default locale.

- **Hidden:** not shown in the entry form and not required. A value it holds is kept and still
  validated, so switching the sibling back brings it back.
- **Disabled:** read-only. Given the values the write replaces (`ValidationContext.previous`: the
  stored version on an update, the type's defaults on a create), a value that differs from them is
  refused ("Field is read-only while its rules disable it; it keeps its stored value"). A write
  that stops the rule matching opens the field in the same write. Readers judging stored content
  rather than an edit (snapshots, imports, merges, the workflow `validate` node) leave `previous`
  out. `disable` is refused on a field inside an Array's element: elements are added, removed and
  reordered, so an element has no stored value to keep. `hide` works per element.

A rule must be usable when it is written (`ruleProblem`): a known action and operator, a sibling
that exists (not the field itself, not a whole component), a value of the operator's shape (text
at most 200 characters; an `in` list of 1 to 100). A revision cannot remove the sibling a kept rule
reads. Snapshot import and clone drop unusable rules (`normalizeLegacyFields`).

Generation never fills a hidden or disabled field: `describeFieldForModel` names the field's rules
(`describeFieldRules`, in words) inside its delimited `<user_content>` span, since a rule quotes
author values, and `withoutClosedFields` leaves the values of fields the draft's own values close
out of a draft or canvas result. Autofill refuses a hidden or disabled field, and `ai.enrich`,
translation and the agent runtime skip them. SDK codegen makes a required field that a rule can
hide optional.

Rules shipped without a reader-first step: a release from before them ignores `rules`, so after a
rollback a hidden required field is required again and a disabled field is editable. Nothing
stored is lost, but two things change for writers:

- An entry saved while a required field was hidden and empty is refused on its next save by the
  older release, until an editor fills the field.
- The older release's MCP field schema strips the keys it doesn't know, so a content type revised
  through MCP after a rollback loses its fields' `rules` and `format` (a revision through the admin
  or the REST API keeps them, since its HTTP field schema stores unknown keys).

## The validation engine

`validateEntryFields(contentType, fields, ctx)` returns a `FieldIssue[]` (empty when valid).
`assertEntryFieldsValid(...)` wraps it and throws `ValidationError` if any issue exists. This is
the **single validation path** for both human API writes and AI-generated content.

Rules applied:

1. **Unknown fields** — any key not in the content type is rejected.
2. **Required** — enforced on the default locale only; other locales resolve via fallback at
   delivery time. A field its [rules](#conditional-field-rules) hide is not required, and a value
   for a field they disable must equal the value it replaces.
3. **Type checks** — per the table above (string/integer/number/boolean/a date in the field's
   format/`{lat,lon}`/object/`{id,linkType}`/array-of-items, each element of a list of scalars
   checked against its type).
4. **Size** — `size.min`/`size.max` against string length or array item count.
5. **Range** — `range.min`/`range.max` against numeric value.
6. **Enumeration** — value must be the `value` of one of `validations.in`.
7. **Regex** — `Symbol`/`Text` must match `validations.regexp` (a preset's compiled pattern).
8. **Date range** — a Date must fall within `validations.dateRange`.
9. **Localization** — non-localized fields must not carry values under non-default locales.

A size, range, enumeration, regex or date range issue reports `validations.messages[rule]` when
the field sets one, else the default text. An asset link's MIME type is checked on write by the
use-case (see [Asset MIME types](#asset-mime-types)).

```ts
interface FieldIssue {
  field: string; // field apiId ("" for entry-level issues)
  locale?: string; // present when locale-specific
  message: string;
}
```

## Content type

```ts
interface ContentType {
  apiId: string; // stable machine identifier
  name: string;
  displayField: string; // apiId of the field used as the entry's display title
  fields: readonly FieldDefinition[];
  urlPattern?: string; // where its entries live on the site, e.g. /blog/{slug}
  singleton?: true; // holds at most one entry outside the trash; absent otherwise
  group?: string; // the admin's sidebar lists types under their group (≤ 100)
  description?: string; // what the type is for (≤ 2000)
  icon?: string; // a kebab-case icon name the admin draws (≤ 40)
  agentInstructions?: string; // style guidance for agents; never delivered (≤ 4000)
  layout?: ContentTypeLayout; // editor-only tabs and field groups; never delivered
  preview?: { urlTemplate: string }; // the frontend URL the admin previews entries at; never delivered
  version: number; // bumped on each revision
  status: 'draft' | 'published';
}
```

- `defineContentType(draft)` — validates the `apiId` and field set (no duplicate apiIds,
  `displayField` must exist), returns a `ContentType` at version 1, status `draft`. Throws
  `ValidationError` / `ConflictError`.
- `reviseContentType(current, changes)` — increments `version`, resets status to `draft`, sorts
  fields by `position`, optionally updates `name`/`displayField`/`fields`/`urlPattern` (`null` or
  `''` clears it) and `singleton` (left out, kept).
- **The published view.** `content_types` holds one row per type, the current revision, which is
  what Management, MCP and the admin read. Delivery reads `deliveredContentType(row, kept,
  publishedSingleton)` instead (`DeliveryReadResult.contentTypes`, `SingletonRead.contentType`): a
  published row as it stands; a draft with a kept definition as that definition, reporting
  `published`; a draft with none as it stands, reporting `draft`. `kept` is
  `content_types.published_definition` (`PublishedContentTypeDefinition`: name, display field,
  fields, URL pattern, version). Triggers from 0030_published_definition write it, on `status`, so
  every writer gets the same result: leaving `published` keeps the row's old values, a publish
  clears it, a draft over a draft leaves it. `ContentTypeRepo.publishedDefinitions(scope)` lists
  them. So GraphQL, the routes, the sitemap, menus (and `previewMenu`), reference filters and
  singletons all serve a live type as last published through a draft, and a draft save needs no
  purge: it changes nothing they serve. Slug redirects and the delete check on a URL pattern
  follow the same pattern (`slugRedirectWrites`, `contentTypeDependents`). A draft with nothing kept
  is either never published or was revised before 0030; Delivery can't tell which, so both behave
  as they always have: in GraphQL, out of the routes, sitemap and menus, until the next publish.
  Entries don't wait for any of this: they validate against the current row and can be published
  under a draft, so REST can show a draft-only field's value before GraphQL has the field, and a
  value of a draft's changed field type (`rating`: `Integer` published, `Symbol` in the draft, a
  value of `"great"`) is `null` with an error on GraphQL until the type is published.
  `DeliveredContentType` is the view's type: it leaves out the admin-only `group`, `description`,
  `icon` and `layout`. Saving a menu checks a link against the pattern served or one in a draft,
  so a menu can be built ahead of a publish; `previewMenu` reports what Delivery does (`no_url`
  until then). A promotion of a published definition is assessed against what the target serves
  too, not only its working draft.
- `group`, `description`, `icon`, `agentInstructions` and `layout` follow one rule on a draft or
  revision: left out keeps the stored value, `null` (or blank text) clears it, and a value stored as
  it stands passes unchecked. They are columns on `content_types` (0026, 0032), not part of the
  `fields` JSON.
- `layout` arranges the admin's entry form: `{ tabs: [{ apiId, name, groups: [{ name?, fields,
  collapsed? }] }] }` (at most 20 tabs, 50 groups a tab; names at most 100). Each top-level field
  is placed at most once, and a name that is not a field is refused (`checkLayout`), except that a
  field the revision removes, or one a carried-over layout still names, leaves the layout quietly,
  with any group or tab left empty. `layoutTabs(fields, layout)` resolves it for the form: fields it
  doesn't place follow, in field order, at the end of the first tab, so a new field is never lost.
  It changes nothing stored or validated, Delivery never serves it, and no webhook carries it.
- **Singletons.** Every entry of a singleton type stakes `singletonClaim(apiId)` (field
  `SINGLETON_CLAIM_FIELD`, `$singleton`, which no field apiId can be) beside its unique values, so
  the `entry_unique_values` unique index admits one entry outside the trash whatever the race.
  `createEntry`, `restoreEntry` and an environment merge also read for one first
  (`assertSingletonFree`), which names the entry and still refuses when its claim went missing (an
  entry saved by a release from before singletons). `saveContentTypeOver` is the one save of a
  definition over another (a revision, a merge, a promotion): turning the flag on is refused over
  more than one entry outside the trash and claims the one there is, in the same unit as the save,
  guarded (`ContentTypeRepo.guard` with the entries it read) so an entry created meanwhile fails
  the commit (`409`); turning it off gives the claim back. A published save that changes the flag
  appends `content_type.published`, which purges Delivery. Every new entry (`writeNewEntry`, used
  by `createEntry` and the merge, which also claims the entry's unique values) is written in a unit
  guarded on its type as read (`guard(scope, apiId, { singleton })`): a type deleted, or flipped,
  since its read fails the commit, mapped to `409`. A promotion that would leave a singleton with a
  second entry is refused when it is requested. Snapshots (clone, export and import) carry the
  flag. Stored in `content_types.singleton` (0027_singleton_types); Delivery serves by
  `content_types.published_singleton`, the flag as last saved published (0028_published_singleton),
  so a draft's change reaches it with the type's publish: `…/singletons/:apiId` and GraphQL's roots
  (Delivery's `contentTypes` read reports `singleton` as last published) alike. A draft that turns
  the flag off gives the claim back at once, so the type can gain entries before the turn-off is
  published; meanwhile Delivery serves the published entry with the lowest id. Every save over a
  stored definition (`saveContentTypeOver`, and `publishContentType`) is guarded on the flag it
  read, so a save that raced a turn on or off fails (`409`) rather than undoing it, and every
  save of a published definition announces `content_type.published` once (a promotion's apply
  relies on it, with no separate publish).
- **Merging entries** (`mergeEnvironments`) checks every selected entry's unique values (the
  singleton's claim included) before the first write, against the target and against each other,
  and refuses once (`409`, `details.conflicts`), naming each entry and its holder; a value an entry
  of the merge gives up is free (a swap). Entries the target already has are applied first, each
  with its claims rebuilt in the same unit, as `updateEntry` does; new ones then stake theirs. An
  entry the target holds in its trash gets the new version and stays there, claiming nothing.
- **Delete and clone** (`content-type-lifecycle.ts`). `fieldsLinkingTo(types, apiId)` finds other
  types' fields whose `linkContentTypes` name it, through components, repeaters and block variants
  (a path like `body.byline.who`). `contentTypeDependents` adds its entry counts (live, trashed),
  menus and slug redirects naming its entries, and its `urlPattern`; `deleteContentType` refuses
  while any is there, then deletes in one unit with `content_type.deleted`. The store's
  `ContentTypeRepo.delete(scope, apiId, version)` is a compare-and-set whose own `WHERE` also
  requires no entry of the type, so a revision or an entry written after the reads fails the
  commit (`TransactionConflictError`). `deleteContentTypeWithEntries` starts a `content_type_delete`
  bulk job instead (chunks of `ENTRY_TRASH_CHUNK_SIZE`): `trashEntry`, then `purgeEntry`, forced
  only past links from entries of the same type, over ids read by `EntryRepo.idsOfType` (an id-only
  keyset read); `finishContentTypeDeletion` deletes the type on the job's clean
  `bulk.job_completed`, and records the outcome on the job (`BulkJobRepo.mergeConfig`,
  `config.typeDeletion`: `{ deleted: true }` or `{ deleted: false, reason }`, also when the job is
  stopped). `cloneContentType` defines a copy (fields, display field, singleton, group, description, icon,
  agent instructions, layout, preview; not `urlPattern`)
  at version 1 under a new `apiId`, inserted by `ContentTypeRepo.create`, which never overwrites.
- `checkUrlPattern(pattern, fields)` — a pattern is a path starting with `/` (at most
  `MAX_URL_PATTERN_LENGTH`, 512; no space, `?`, `#`, `[`, `]` or `\`) whose `{…}` placeholders are
  `{id}`, `{locale}` or the apiId of one of the type's own `Slug` fields; anything else is a
  `ValidationError` on `urlPattern`. A revision is checked against its revised fields, so removing a
  slug a kept pattern names is refused. `urlPath(pattern, entry, locale)` builds an entry's path (or
  `null` when a named slug has no value in that locale), which is also how a preview or site link
  can be built. A pattern is what makes a slug change write a [redirect](#redirects).
- `checkPreviewTemplate(template, fields, { allowLoopback })` (`content-type/preview.ts`) —
  `preview.urlTemplate` is an absolute URL (at most `MAX_PREVIEW_TEMPLATE_LENGTH`, 1024; no space):
  `https`, or `http` on `localhost` or `127.0.0.1` only with `allowLoopback`, on a host of DNS
  labels or a bracketed IPv6 address (never `*`), without credentials, with no placeholder in the
  scheme or authority. `defineContentType` / `reviseContentType` take `{ previewLoopback }`, which
  the use-cases pass from `AppContext.previewLoopback` (set by `wireEdge` with no D1 or
  `REQUIRE_SECURE_SECRETS=false`).
  Its placeholders are `{id}`, `{token}` (required), `{locale}`, `{space}`, `{environment}` and
  `{field:<apiId>}` naming one of the type's top-level `PREVIEW_FIELD_TYPES` fields (Symbol, Slug,
  Integer, Number, Date); anything else is a `ValidationError` on `preview.urlTemplate`. `null` or a
  blank template clears it. Sent on a revision it is checked against the revised fields (one sent
  back as stored keeps its scheme as it stands); left out, the stored one is kept while it still
  checks and dropped when it doesn't (older code may have removed the field it names), so a save
  that doesn't mention it is never refused for it. `previewOrigin(template)` is its fixed origin (what the admin's
  `frame-src` may allow), `fillPreviewTemplate(template, values)` fills it URL-encoded, or `null`
  while a named field has no value. `createPreviewLink` returns it filled as `frontendUrl` (a
  localized field in the link's locale only; one that isn't, under the default locale). Stored in
  `content_types.preview_url_template` (0035); a promotion that adds or changes it needs approval.
  `createContentType`, `updateContentType` and `cloneContentType` take a required caller as their
  second argument (`ContentTypeCaller`): the request's principal (the HTTP route and MCP tool pass
  theirs), or `SYSTEM_CALLER` for seeding and snapshot import, which are authorized as a whole.
  Anything else is refused before a read (`assertContentTypeCaller`), so the check fails closed.
  `authorizePreviewChange` holds a principal to `read` on the type when it sets a template other
  than the stored one: it decides where that type's preview tokens go.

## Entry aggregate & state machine

```ts
interface Entry {
  id: string;
  contentTypeApiId: string;
  status: EntryStatus;
  currentVersion: number; // latest saved draft snapshot
  publishedVersion: number | null; // snapshot served by Delivery (if any)
  createdAt?: string | null; // authorship (below); null when unknown
  createdBy?: string | null;
  updatedBy?: string | null;
  firstPublishedAt?: string | null;
}

interface EntryVersion {
  // immutable point-in-time snapshot
  entryId: string;
  version: number;
  fields: EntryFields;
  createdBy?: string | null; // who saved it
}
```

Status is **derived**, never set directly, by `deriveStatus(currentVersion, publishedVersion, archived)`:

| Condition                             | Status                                              |
| ------------------------------------- | --------------------------------------------------- |
| `archived === true`                   | `archived`                                          |
| `publishedVersion === null`           | `draft`                                             |
| `currentVersion > publishedVersion`   | `changed` (published, with newer unpublished edits) |
| `currentVersion === publishedVersion` | `published`                                         |

Transitions (pure functions; each throws `InvalidStateError` when its precondition fails):

| Function                   | Effect                                                      | Precondition         |
| -------------------------- | ----------------------------------------------------------- | -------------------- |
| `saveDraft(entry, fields)` | `currentVersion += 1`, new `EntryVersion`, re-derive status | not `archived`       |
| `publish(entry)`           | `publishedVersion = currentVersion`, status `published`     | not `archived`       |
| `unpublish(entry)`         | `publishedVersion = null`, status `draft`                   | currently published  |
| `archive(entry)`           | status `archived`                                           | unpublished          |
| `restore(entry)`           | status `draft` (re-derived with no published version)       | currently `archived` |

`currentVersion`/`publishedVersion` are pointers into the immutable version ledger; each
`saveDraft` appends a new version, and `publishedVersion` pins which one Delivery serves.

### Authorship

Every write stamps who made it, from the context's `actor` (`AppContext.actor`) and `ctx.clock`
(`stampCreated`, `stampChanged`, `stampPublished` in `entry/authorship.ts`). An actor is the
principal's audit identity (`principalActorId`: a person's subject, `admin-token`, or the key kind),
or names what acted without a request: `agent:<name>` (an editorial agent), `workflow:<id>` (a
workflow node or its compensation, whatever principal's grants it runs with), `plugin:<id>` (a
plugin's capabilities) and `system` (the scheduler). The HTTP routes and the MCP session derive the
context per request (`actingAs`); a bulk job records who started it in its `config.actor` and its
chunks write as them; a promotion writes as whoever approved it.

| Field              | Set by                                                   | `sys.*`              |
| ------------------ | -------------------------------------------------------- | -------------------- |
| `createdAt`        | creation (kept by a clone, a merge or a promotion)       | `sys.createdAt`      |
| `createdBy`        | creation (kept likewise; never from an uploaded snapshot) | `sys.createdBy`      |
| `updatedBy`        | every change, the one `sys.updatedAt` records            | `sys.updatedBy`      |
| `firstPublishedAt` | the first publish only; kept through unpublish           | `sys.firstPublishedAt` |

The store writes creation once and `first_published_at` with `COALESCE`, so a stale aggregate or a
lost race never moves either; the publish upsert copies `entry_published.first_published_at` from
`entries` in the same batch (a subquery), so the read model always matches that result. An entry
already live with nothing recorded (from before `0024_entry_authorship`) keeps an unknown (null)
first publish when republished. A known gap: an entry published and then unpublished before
`0024` left no trace of that, so its next publish is recorded as its first.

A new entry a merge (`mergeEnvironments`) brings into the target keeps the source's creation and
first publish, as a promotion's does; one the target already has keeps its own. An environment
clone keeps all three (`ImportOptions.keepCreators`, set only by the clone paths). An uploaded
snapshot keeps `createdAt` and `firstPublishedAt`, checked by `carriedAuthorshipIssues` (ISO-8601
UTC instants; a creator at most 320 characters), and credits its importer as the creator: a file
can name anyone.
An imported entry keeps its id only if it fits `ENTRY_ID_PATTERN` (1 to 64 ASCII letters, digits,
underscores or hyphens). The snapshot's preflight refuses one that doesn't, by position, before
anything is written, and `createEntry` refuses it on every other path that carries an id.

Management and Preview serve all four, filter and sort on them, and resolve `me` in
`sys.createdBy` and `sys.updatedBy` to the caller's actor id (`principalActorId`: a person's
subject, `admin-token`, or an API key's kind, so `me` is every key of that kind). The writer ids
go only where `seesAuthorIds` holds (a teammate, the admin token, or a key with a management
scope): a preview key reads entries and versions without `createdBy`/`updatedBy`
(`withAuthorIdsFor`, on every read it can reach: Preview, the management entry and version reads,
and their MCP tools), and `assertAuthorIdQuery` refuses its filter or order on them, in `filters`
or anywhere in a `where` tree (400). Agent-review decisions record
`decidedBy` with the same actor id. Delivery serves `firstPublishedAt` alone, since the others name
people and keys a public read has no business seeing.

**Manual order.** Each entry has a place in its content type's one manual order, read as
`order=sys.position`: `position` (`0034_entry_position`), a key from
`packages/domain/src/entry/position.ts`, or the entry's id while it has none. Ids use the same
characters as keys and UUIDv7 ids sort by creation time, so a type starts in creation order and a
new entry lands at the end without a key being written. No save writes `position`, so a stale
aggregate can't move an entry back; triggers copy it to `entry_published`, so Delivery orders
published rows by the same key.

A move (`moveEntry`, `packages/application/src/entry-order.ts`; `POST …/entries/:id/move`, MCP
`entries_move`) is live, like a menu's order: no version, no status or `updatedAt` change. It
writes one key between its new neighbours, each write only if every key it read is unchanged and
nothing else has landed in the gap since, so two moves into one gap can't both land; a lost race
is read again and retried, up to three times. When a gap runs out (or a key would pass 96
characters) it re-keys up to 16 neighbours on each side with it. Trashed entries keep their keys
and count as neighbours, so a restored entry returns to its place. The move and an `entry.moved`
event commit together; a published entry's move purges Delivery.

### Comparing versions

`diffEntryFields(before, after, contentType?)` (`packages/domain/src/entry/entry-diff.ts`) is the
readable diff between two versions' fields. It returns one `FieldDiff` per field either version
holds, in the content type's order (fields the type no longer declares follow, by name), each
labelled with the field's `name` and `fieldType` and split per locale into `LocaleDiff`s whose
`kind` is `added`, `removed`, `changed` or `unchanged`. A changed locale carries a typed `detail`
(`ValueDiff`) picked by the field's type:

| Field type                                                 | `detail.type` | What it holds                                                                                           |
| ---------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `Symbol`, `Slug`, `Text`                                   | `text`        | `segments`: a word-level diff (`TextSegment`: `added`, `removed`, `unchanged` runs)                     |
| `RichText`                                                 | `richText`    | `blocks`: one `RichTextBlockDiff` per paragraph, heading, list item, table row or embed, with its words |
| `Link`                                                     | `link`        | the entry or asset id before and after                                                                  |
| `Component`                                                | `component`   | the nested fields, each a `NestedFieldDiff` with its own `detail`                                       |
| `Array`                                                    | `list`        | the elements (`ListItemDiff`), with their positions and a `moved` flag                                  |
| `Integer`, `Number`, `Boolean`, `Date`, `Location`, `JSON` | `value`       | the two values                                                                                          |

List elements are matched by identity where they have one (a block's `_key`, under its `_type`; a
link's target; a tag's text) and by content otherwise; a matched element outside the longest run
that kept its order is `moved`. Rich text is read as its blocks (`diffRichText` in
`rich-text/rich-text-diff.ts`): blocks are lined up by content, an unmatched block of the same type
in the same stretch is the same block edited (with `beforeNodeType` when it changed type, and
`formattingChanged` when only its marks or links did), and embedded entries and assets carry their
`target`. The word diff (`diffText`, Myers' algorithm in `entry/sequence-diff.ts`) stops looking for
the shortest script past `MAX_DIFF_EDITS` edits and reports the text replaced. Every part is typed
data, never markup: the admin, an API client and an agent each render it for themselves.

`changedPaths` (`packages/domain/src/entry/entry-change.ts`) reads the same diff, with
`structureOnly` so a save pays for no word diff, down to what an audit row keeps: the model's paths that changed and the space's locales they changed in, never a
value. It only names what the model declares, so a JSON field, a `Seo` value and rich text stop at
the field, a block's `_key` and an undeclared nested key are left out, and a locale key the space
doesn't have is ignored (a localized field stores whatever keys it is sent). A save notes the result
on `ctx.changes`, a `ChangeLog` each surface sets per request (`packages/application/src/change-log.ts`):
the row is written in the surface, so every route and tool reaching a save gets the same detail
without passing it back. A context with no log (a queue consumer, a seed, a plugin's capability
call) runs no diff. `recordAudit` caps what it stores (`capAuditDetail`). See
[Audit log](./api-reference.md#audit-log) for the shape. An entry's activity
(`listEntryActivity`, the editor's Activity view) is the log read for one entry: the rows that
target it and the rows whose `detail` names it, through `audit_log_entries` (see
[An entry's activity](./api-reference.md#an-entrys-activity)).

### The trash

`archive` moves an entry out of circulation and `restore` brings it back as a _draft_, never
straight to published: archiving requires an unpublished entry, and re-publishing should be a
deliberate act rather than a side effect of undoing a delete. Application-side, `trashEntry`
unpublishes a live entry first so one editor intention stays one step, and `purgeEntry` is the only
operation that destroys an entry and its version history.

## Locales & fallback

```ts
interface LocaleConfig {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
  fallbacks?: Record<LocaleCode, LocaleCode | null>; // locale → fallback (null = stop)
  localeSettings?: Record<LocaleCode, { delivered?: boolean; direction?: 'ltr' | 'rtl' }>;
}
```

- `fallbackChain(config, requested)` — builds an ordered chain (most specific first) by following
  fallback pointers, guards against cycles, and always ends at `defaultLocale`. E.g. with
  `fallbacks = { "fr-CA": "fr", "fr": null }`, requesting `fr-CA` yields `["fr-CA", "fr", default]`.
- `resolveLocalizedValue(value, config, requested)` — walks the chain and returns the first
  defined value.
- `resolveFieldsForLocale(fields, config, requested)` — flattens an entry's fields to a single
  locale with fallback applied; used by Delivery/Preview when `?locale=` is given.

**Delivered locales and direction.** `localeSettings` (stored beside `locales`,
`0025_locale_settings`) says per locale whether Delivery serves it (`isLocaleDelivered`: the
default always, any other unless `delivered: false`) and which way its text runs
(`localeDirection`: as set, else `rtl` for a right-to-left language or script, `rtlByLanguage`).
`assertLocaleSettings` refuses a locale the space lacks, an undelivered default and unknown keys.
Delivery reads the space through `deliveredLocaleConfig`: undelivered locales leave `locales`, and
each fallback is re-pointed past them (`fr-CA → fr → en` with `fr` off is `fr-CA → en`), so no
render, sitemap alternate, menu or label reaches their values; `withoutUndeliveredLocales` drops
them from all-locale maps (entry fields, taxonomy labels, and asset title, description and alt
text, alone or embedded by `include`). The same holds on every other Delivery output: GraphQL's
`localize` answers `null` for an undelivered locale; list filters, `where` trees, ordering and
`query=` skip their values (`hiddenLocales` on the store query, so the any-locale fallback never
compares one); Delivery search (`deliveredSearch`, REST `/search` and GraphQL `search`) drops a
vector chunk in an undelivered locale and re-checks and re-ranks each lexical hit on its delivered
text alone, quoting only that in snippets; Delivery asset search (`searchDeliveredAssets`, whose
indexes hold every locale in one document and one embedding per asset) scans delivered text only
and drops a hit any query term finds only in undelivered title, caption or alt text, and a
vector-only hit on an asset that has undelivered text; and the queue consumer strips undelivered locales from an
`entry.published` before the LiveHub fans it out to live subscribers (`liveEventOf`; the object
holds no store, so the consumer writes the filtered copy once). A request naming an undelivered locale is a `NotFoundError` (404),
rather than a fallback, so a front end leaves the route out instead of serving another language
under it; a locale the space doesn't have still resolves through the default, as before. Preview
and Management read every locale. `setLocaleSettings` (`space:admin`) writes the settings and a
`space_locales.changed` event in one unit; the engine purges every environment of the space.
GET `…/space-config` serves each locale's settings resolved; the admin sets `dir` on each
locale's inputs from `direction`.

## Assets

```ts
interface Asset {
  id: string;
  status: 'draft' | 'published' | 'archived';
  file: AssetFile; // { url, fileName, contentType, size?, width?, height?, placeholder?, video? }
  title: LocalizedValue;
  description: LocalizedValue;
  metadata: AssetMetadata; // { altText: LocalizedValue, tags: string[], focalPoint?: { x, y }, fields? }
  folderId?: string; // absent at the library root
  version?: number; // 1, then +1 per file replacement (absent reads as 1)
  r2Key?: string; // where the bytes live; absent for a hosted video
  contentHash?: string; // SHA-256 of the bytes (hex), set by ingest
  createdAt?: string;
  createdBy?: string; // as the audit log names actors
  archivedAt?: string; // only while archived
  rights?: AssetRights; // { license?, credit?, expiresAt?, embargoUntil? }
  ingestStatus?: 'pending' | 'processing' | 'ready' | 'error'; // absent: never ingested
  ingestError?: string;
  duplicateOf?: string; // the oldest other asset in the scope with the same contentHash
  aiSuggestions?: { altText?: string[]; tags?: string[] }; // filled by a model, not yet saved
}
```

Ingest (migration `0011_asset_ingest`; see
[Architecture](./architecture.md#asset-ingest-and-search)) owns `contentHash`, `ingestStatus`,
`ingestError` and `duplicateOf`: it writes them through `AssetRepo.recordIngest`, and `save`
leaves them as they are. `aiSuggestions` marks the alt text locales and tag ids ingest filled
from a model; `clearAcceptedSuggestions` drops a field's mark when a metadata patch carries it,
so saving the field makes it the editor's.

`file.placeholder` (`AssetPlaceholder`: `thumbhash`, base64; `dominantColor`, `#rrggbb`) is
measured by ingest's `placeholder` step for raster types the image-transform binding decodes, no
larger than 20 MiB. Like `width` and `height` it lives in the `file` JSON (no column), is written
by `recordIngest` and copied into the published snapshot by `finish`. It is data a client renders,
never a URL or markup.

An upload whose presigned PUT never landed leaves a draft with no `ingestStatus` and no `size`;
`sweepAbandonedUploads` (hourly, see [Architecture](./architecture.md#asset-ingest-and-search))
removes it a day later, or marks it `error` ("The upload never completed") when an entry links it.

`file.video` is present on hosted video assets (provider, status, playback URLs). `metadata` holds
the editorial "aspects": per-locale alt text, taxonomy tag ids, a focal point (0..1 on each axis,
so transforms crop toward it) and free-form `fields`; `applyAssetMetadata` merges a partial patch
and validates the focal point.

An asset has one current file; `version` counts its files. Replacing or restoring one keeps the
previous file in `asset_versions` (`AssetVersionRecord`: `version`, `file`, `r2Key`,
`contentHash`, `replacedAt`, `replacedBy`), and `listAssetVersions` reads them as `AssetVersion`
(`{ version, file, r2Key?, contentHash?, createdAt?, createdBy?, current, published,
restoredFrom? }`, newest first; `createdAt`/`createdBy` are when and by whom the file became the
asset's, `published` marks the one the snapshot delivers). A restore is a new version pointing at
the old bytes.

`AssetRights` carry `license` and `credit` (delivered with the asset) and `expiresAt` and
`embargoUntil` (ISO-8601). `validateAssetRights` trims text (at most `MAX_ASSET_RIGHTS_TEXT`,
500), requires dates with a zone and an expiry after the embargo;
`assertRightsAllowDelivery(id, rights, now)` throws `AssetRightsError` (`asset_embargoed` or
`asset_expired`, with the deciding instant in `details`), which publishing checks;
`rightsExpireSoon` backs the admin's "Expires soon" status. The published snapshot's expiry is also
a column (`asset_published.expires_at`, migration `0015_asset_expiry`) for the expiry sweep.

`publishAsset` / `unpublishAsset` move between `draft` and `published`; `archiveAsset(asset, at)`
takes any non-archived asset to `archived`, and `restoreAsset` brings an archived one back as a
`draft` (each throws `InvalidStateError` on a bad transition; an archived asset cannot be
published, nor one under embargo or past its expiry). File bytes are not part of the aggregate: `createAsset` returns a signed upload URL
and the bytes go to the blob store (see
[Architecture](./architecture.md#assets-object-storage-image-transforms-video-and-the-media-worker)).

`assetKind(contentType)` derives an `AssetKind` (`image`, `video`, `audio`, `document`, `other`;
`ASSET_KINDS`) from the content type; the store keeps it in a column for filtering, so it is never
set by a client. Only an archived asset can be deleted (`InvalidStateError` otherwise, `400 invalid_state`), because
its bytes can't be brought back. Deleting one that entries still link to, drafts and the trash
included, throws `AssetInUseError`
(`asset_in_use`), whose `usage` lists the links (`AssetUsage`: the edge plus the entry's
`contentTypeApiId` and `entryTitle`, at most `MAX_ASSET_USAGE_SHOWN`, 50) and `total` counts them.

### Asset collections, share links and zip jobs

`packages/domain/src/asset/collection.ts`. An `AssetCollection` is a named (`name` 1 to 128 characters,
`assetCollectionName`), ordered set of assets of one environment, with an optional `description`
(at most `MAX_COLLECTION_DESCRIPTION`, 1,000) and an `itemCount`. Membership is many-to-many
(`AssetCollectionItem`: `assetId`, `position`), unlike a folder. A collection holds at most
`MAX_COLLECTION_ITEMS` (1,000) assets, and one change names at most `MAX_COLLECTION_CHANGE` (500)
ids (`collectionChangeIds`). Deleting an asset removes its memberships in the same unit.

An `AssetShareLink` (`id`, `targetType` `asset | collection`, `targetId`, `expiresAt`,
`allowDownload`, `hasPassword`, `createdAt`, `createdBy?`, `revokedAt?`, `url?`) is an expiring,
revocable link; the store keeps `StoredAssetShareLink`, with the PBKDF2 `passwordHash` only the
media origin reads. `shareLinkExpiry` requires an expiry `MIN_SHARE_LINK_SECONDS` (5 minutes) to
`MAX_SHARE_LINK_SECONDS` (90 days) out; `shareLinkPassword` requires `MIN_SHARE_PASSWORD` (8) to
`MAX_SHARE_PASSWORD` (256) characters. `shareLinkState(link, nowMs)` is `active`, `expired` or
`revoked` (revoking is permanent). `parseShareLinkPath` reads `/s/<space>/<env>/<link>/<token>`,
`…/unlock` or `…/f/<assetId>/<fileName>`; the token is 22 base64url characters and is checked by the
caller before any lookup.

An `AssetZipJob` (`id`, `status` `pending | running | completed | failed`, `source` (a selection of
`assetIds` or a `collectionId`), `fileName`, `fileCount?`, `totalBytes?`, `partsDone`, `partCount?`,
`error?`, `createdAt`, `completedAt?`, `expiresAt`, and a read-time `downloadUrl?`) describes a zip
being built. A job covers at most `MAX_ZIP_ASSETS` (1,000) assets and lives
`ZIP_RETENTION_SECONDS` (a day); `zipFileName` makes the archive's name safe. The events are
`asset_collection.changed`, `asset_share.created`, `asset_share.revoked` and `asset_zip.requested`
([Events](./events-and-webhooks.md#event-payloads)); how it all runs is in
[Architecture](./architecture.md#collections-share-links-multipart-uploads-and-zips).

### Asset folders

```ts
interface AssetFolder {
  id: string;
  name: string; // 1..128 characters, no "/"; unique among siblings
  parentId?: string; // absent at the root
  path: string; // materialized path of ids, e.g. "/a/b/"
  createdAt: string;
  updatedAt: string;
}
```

Folders nest up to `MAX_ASSET_FOLDER_DEPTH` (16). `assetFolderPath(parent, id)` builds a path and
enforces the depth; `assertFolderMove` refuses a move into the folder itself or below it. Moving a
folder rewrites the path prefix of its whole subtree.

### Renditions and the delivered asset

`packages/domain/src/asset/delivered.ts`. A **rendition** is a named image preset of a space
(`AssetRendition`: `name`, `width?`, `height?`, `fit?` (`RENDITION_FITS`), `format?`
(`RENDITION_FORMATS`, `auto` negotiates AVIF/WebP), `quality?`, `createdAt`, `updatedAt`).
`assetRenditionName` allows 1–40 lowercase letters, digits and dashes (the name is its URL
segment); `assetRenditionSpec` requires a width, height or format; a space has at most
`MAX_ASSET_RENDITIONS` (20). Presets belong to the space, not an environment.

An `AssetVariant` is the original (`o`), a width from `ASSET_WIDTH_LADDER` (320, 640, 960, 1280,
1920, 2560; `w<width>`) or a rendition (`r-<name>`). `assetMediaPath` / `parseAssetMediaPath`
build and read `/<space>/<env>/<assetId>/v<n>/<token>/<variant>/<fileName>`; a width off the
ladder is no variant, and the parser checks only the token's shape (22 base64url characters): the
`MediaPathSigner` port makes and verifies it, outside the domain, so the projector stays pure. `isTransformableImage` says which types have variants (JPEG, PNG, WebP, AVIF, GIF; not
SVG). `variantForTransform` maps a legacy `?w=` to the next step up (the largest past it).

`deliveredAsset(asset, { urlFor?, renditions, locale? })` is the one projector for Delivery
(REST, embeds, GraphQL) and Preview. It is pure: the caller supplies the URL builder
(`publicAssetUrls(origin, scope, { id, version, fileName })` for published files, width steps with
`?fm=auto`; signed URLs for Preview), the space's rendition names and the locale settings. The
result, `DeliveredAsset`, is `{ id, title, description, altText, focalPoint, contentType, size,
width, height, kind, url, renditions, srcset, placeholder, video?, rights?, file }`; `placeholder`
is `file.placeholder ?? null` (always `null` for a hosted video); text is flattened with
`resolveLocalizedValue` when a locale is given, a hosted video's `url` is its HLS manifest and it
has no variants, and the srcset stops at the image's own width.

## References

```ts
interface ReferenceEdge {
  fromEntryId: string;
  fromField: string; // the link field's apiId
  toId: string; // target entry/asset id
  toType: 'Entry' | 'Asset';
}
```

`extractReferences(fromEntryId, fields, contentType)` is a pure function that walks an entry's
`Link`, `Array`-of-`Link`, `RichText` and `Component` fields across all locales — however deep the
components nest — and returns deduplicated edges attributed to the top-level field. On publish,
edges are materialized so the platform can:

- enforce **referential integrity** (publishing fails if a linked entry/asset doesn't exist),
- **resolve links** in Delivery (`?include=` embedding, including links inside `Component`
  values and rich-text reference nodes), and
- **invalidate caches** in reverse — when X changes, entries embedding X are refreshed.

## Redirects

`packages/domain/src/redirect/redirect.ts`. CommerceWorker serves no site, so a redirect is
**delivery data**: Delivery hands the set (or one path's match) to the front end, or an edge worker
in front of it, that answers the request. A redirect belongs to a space and environment:

```ts
interface Redirect {
  id: string;
  source: string; // normalized path: exact, or a pattern
  destination: string; // a path (optional query, fragment) or an absolute https:// URL
  status: 301 | 302 | 307 | 308; // default 301 (REDIRECT_STATUSES)
  locale?: string; // applies only to requests in this locale
  enabled: boolean;
  note?: string; // at most MAX_REDIRECT_NOTE_LENGTH (500)
  origin: 'manual' | 'import' | 'slug';
  entryId?: string; // the entry whose slug change made it (origin 'slug')
  createdAt: string;
  updatedAt: string;
}
```

- **Source.** A path starting with `/`, no query, fragment, `.`/`..` segment or whitespace;
  percent-encoded as a request's path is, repeated and trailing slashes removed
  (`normalizeRedirectSource`). It is exact (`/old-page`) or a pattern of whole segments:
  `[param]` captures one segment, a trailing `[...splat]` one or more.
- **Destination.** A path starting with `/` or an absolute `https://` URL without credentials
  (another scheme, `//host` and a relative path are refused). It may insert the source's captures by
  the same names, with the same kind (`normalizeRedirectDestination`).
- **Limits.** `MAX_REDIRECTS` (10,000) per environment, since Delivery serves the set in one
  response; `MAX_REDIRECT_IMPORT` (1,000) rows per import; `MAX_REDIRECT_LENGTH` (2048) characters
  per source or destination. One redirect per source per locale (`redirectKey`).
- **Matching** (`createRedirectMatcher`, `matchRedirect`). Disabled redirects never match. An exact
  source beats any pattern; between patterns the more specific wins segment by segment (a fixed
  segment, then `[param]`, then `[...splat]`); a tie goes to the locale's own redirect, then the
  source, then the id. A locale's redirects apply only to requests in that locale; a request
  without one meets only the all-locale redirects. The request's query string is appended when the
  destination has none.
- **Set analysis** (`analyzeRedirects`): `duplicates`, `loops` and `chains`. Every write checks the
  set it would leave (`redirectSetError`) and refuses a loop or a duplicate source with a
  `ValidationError` (`422`). A chain (a destination that is itself redirected) is allowed and
  reported; `collapseRedirectChains` points each chain's first redirect at where it ends.
- **Slug changes.** `slugMoves` compares the published fields a publish replaces with the new ones
  for every slug the type's `urlPattern` names; `planSlugRedirects` turns the moves into writes
  (see [Slug-change redirects](#slug-change-redirects)).
- **CSV.** `redirectsFromCsv` / `redirectsToCsv` read and write a header row of
  `REDIRECT_CSV_COLUMNS` (`source`, `destination`, `status`, `locale`, `enabled`, `note`; in any
  order on import, unknown columns ignored, `source` and `destination` required).

The application use-cases (`packages/application/src/redirects.ts`) check the whole set on every
write and commit it with the set's revision (`redirect_sets`) as a compare-and-set and a
`redirects.changed` event in one unit; a writer that loses the race reads the set again and checks
once more (three attempts, then the `TransactionConflictError` surfaces). A publish's slug redirects advance the revision unconditionally, so a publish never fails over a concurrent redirect edit; that edit, having read the set before, checks it again.

### Slug-change redirects

When a type has a `urlPattern` and a publish changes a slug it names on an entry that was already
published, `publishEntryTx` / `publishEntriesTx` (so single publish, releases and bulk publish) write
the redirect in the same unit of work as the publish; there is no event of its own, because the
`entry.published` already purges Delivery. The old path gets a `301` (`origin: 'slug'`, `entryId`)
to the new one, taking over a redirect already on that source; redirects that pointed at the old
path are repointed at the new one, so no chain forms; a redirect away from the new path is removed,
so no loop forms. A localized slug writes a per-locale redirect. Nothing is written when the type
has no pattern, a first publish, or when the set is at `MAX_REDIRECTS`.

## SEO and the sitemap

An entry's search engine metadata is a field of type `Seo` (`packages/domain/src/seo/seo.ts`): a
component whose shape is fixed, `SEO_FIELDS`, so the sitemap, the admin and every client find a
page's metadata without reading the model. Being a field, it is versioned with the draft, published
with the entry, localized when the field is, and delivered with the entry's other fields. A content
type opts in by declaring one.

| Part           | Type                     | Rule                                                                                 |
| -------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `title`        | `Symbol`                 | at most `MAX_SEO_TITLE_LENGTH` (200)                                                 |
| `description`  | `Text`                   | at most `MAX_SEO_DESCRIPTION_LENGTH` (500)                                           |
| `canonicalUrl` | `Symbol`                 | a site path (`/…`, not `//…`) or an absolute `http(s)` URL (`canonicalUrlIssue`); at most 2,048 |
| `noindex`      | `Boolean`                | keeps the page out of search results and the sitemap                                 |
| `ogImage`      | `Link` (`Asset`)         | the social image; a reference edge like any link (integrity, purges)                 |

A type declares at most one `Seo` field, at the top level only (never inside a component), and it
cannot be `unique` or carry nested `fields`. Validation, reference extraction, GraphQL (an object
type such as `ArticleSeo`) and codegen read it as a component of `SEO_FIELDS`. `setEntrySeo`
(`packages/application/src/seo.ts`) changes one locale of it (a part left out keeps its value,
`null` clears it) and saves a new draft through the same path as `updateEntry`; it is refused
(`422`) for a type with no `Seo` field, and for a non-default locale on an unlocalized one.

**The sitemap** lists published entries of every published content type with a `urlPattern`, each
type as last published (see [the published view](#content-type)).
`entrySitemapUrls` gives each entry its URLs: one per locale of the space when the pattern names
`{locale}` or a localized slug, else the default locale only. Each locale reads the named slugs and
the `Seo` value through the fallback chain, as Delivery does; a path two locales share is listed
once, under the first. A locale is left out when its `Seo` value says `noindex`, or names a
canonical URL whose path is not the entry's own. Paths compare in one spelling
(`normalizeSitePath`: each segment percent-encoded, one trailing slash dropped). A path canonical is
a site path, like the pattern's; an absolute one, given the site (`SiteLocation`: origin and path
prefix, from `base`), is elsewhere on another origin or outside the prefix, and has the prefix taken
off before comparing. The store reads only `sitemapFieldsOf` (the pattern's slugs and the `Seo` field) from
each `entry_published` body, picked out in SQL, by entry id. `lastmod` is the live version's
`publishedAt`. A sitemap file holds `sitemapPageSize(locales)` entries (at most 5,000, and few
enough that one URL per locale stays under `SITEMAP_MAX_URLS`, 50,000); past one file, the XML
sitemap is an index of pages, each named by a token for its range of entry ids (`<first>,<next
page's first>`, the first page open at its start and the last at its end), so an entry published
after the index was read still lands in a page. A key with content grants sees only the types it may
read, and never a type whose pattern names a field it may not read; a type whose `Seo` field it may
not read is listed as if it had none (no `noindex` or canonical exclusions, which would reveal the
field's values).

## Menus

`packages/domain/src/menu/menu.ts`. A navigation menu is **delivery data**: a named, ordered tree
of links a front end renders. A menu belongs to a space and environment:

```ts
interface Menu {
  id: string;
  handle: string; // unique in the environment: lowercase letters and digits joined by - or _
  name: string;
  description?: string;
  items: MenuItem[];
  revision: number; // bumped by every save: the compare-and-set
  createdAt: string;
  updatedAt: string;
}

interface MenuItem {
  id: string; // stable within the menu; made when not given
  label?: string; // required for a URL link
  link:
    | { type: 'entry'; entryId: string }
    | { type: 'term'; termKind: 'tag' | 'concept'; termId: string }
    | { type: 'url'; url: string };
  target?: '_blank';
  attrs?: Record<string, string>; // rel, title, class, aria-label, data-*
  children: MenuItem[];
}
```

- **Live, not versioned.** A saved change is what Delivery serves next. An entry link resolves only
  against the published entry, so a menu never shows unpublished work, and a publish, unpublish or
  slug change moves the menu with it without a save.
- **Limits.** `MAX_MENUS` (100) per environment, `MAX_MENU_ITEMS` (250) per menu at every depth,
  `MAX_MENU_DEPTH` (3) levels, labels up to 120 characters, URLs up to 2048, up to 8 attributes of
  up to 256 characters.
- **Checks** (`checkMenuItems`) normalize the tree and throw one `ValidationError` naming each bad
  item by its path. A URL link is a site path, `#fragment`, `?query`, `http(s)://` URL without
  credentials, `mailto:` or `tel:` (`checkMenuUrl`).
- **Moves** (`moveMenuItem`) relocate an item and its subtree under a parent (or the top level),
  refusing a move under itself or past the depth.
- **Resolution** (`resolveMenuItems`, `entryUrlPath`). An entry link becomes its published
  entry's path from the published type's `urlPattern` in the requested locale (each slug following
  the space's fallback chain) and its label the display field; a term link the term's localized
  label and slug, with `url: null`. An item whose link doesn't resolve is dropped and its children
  take its place.

The use-cases (`packages/application/src/menus.ts`) read the menu, apply the change, check the links
a save adds (the entry exists and its type has a URL pattern; the term exists), and commit the menu
at its revision with a `menus.changed` event in one unit. A caller that names the revision it read
gets a `ConflictError` (`409`) when someone saved since; one that doesn't is retried against the
menu as it now stands (three attempts, then the `TransactionConflictError` surfaces). Every read
and link check takes the caller (`MenuAccess`): an entry of a type their content grants don't
cover is `hidden` (dropped on delivery) and, on a write, doesn't exist; a denied display field
never becomes a label and a denied slug field drops the item, as `maskDeliveredFields` hides them
on an entry read.

## Saved views

```ts
interface SavedView {
  id: string;
  name: string;
  contentTypeApiId: string | null; // null: the entries of every type
  visibility: 'personal' | 'shared';
  createdBy?: string; // as the audit log names the creator; a personal view's owner; left out for a key not served author ids
  query: SavedViewQuery; // { filters?, where?, order?, search?, extra? }
  columns?: string[]; // after the display field; absent: sys.status, sys.updatedAt
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

A saved view (`packages/domain/src/saved-view/saved-view.ts`) is a named entries-list query and
the columns to show. Its query is the structured form a live query parses into (`QueryFilter`s and
a `QueryNode` tree), never a query string, read by `checkSavedViewQuery` with the live query's own
validators (`queryFilterIssues` strictly, `parseQueryWhere`), so a stored view is never one the
Preview list would refuse for its shape. `extra` keeps query keys this version doesn't apply (a
newer client's), verbatim and never applied (`savedViewEntryQuery` leaves it out); it never holds a
key anything here reads (`isSavedViewExtraKey`: a filter key, a list or connection parameter), so
it can't become a live filter once a client writes it back into a URL.

Views are **space-scoped**: how people work through the content, not content. Every environment of
a space shows the same views, and none rides a snapshot, clone, merge or the environment purge; a
view runs in whichever environment asks, where a field that environment's type lacks matches
nothing. `canSeeSavedView` decides who sees one: a personal view only its owner (a person:
`isPersonPrincipal`), any view only a role that can read its type, and no role whose field rules
hide a field the query names or which `search` would reach (`assertQueryRespectsFieldRules`).
`savedViewFor` drops columns naming a hidden field, and a save by that role keeps them where they
stood (`savedViewColumnsAfter`), so saving columns never takes one from the people who can see it.
The use-cases
(`packages/application/src/saved-views.ts`) run a view as the caller's own Preview list query
(`listPreviewEntryPage` with the caller's `readable` grant, then `maskDeniedFields`), ask
`content:manage` of anything shared, and cap views at `MAX_PERSONAL_VIEWS` (50) per person and
`MAX_SHARED_VIEWS` (100) per space, a check rather than a guarantee under a race, as menus' cap is.
A change of visibility is held to the same caps as a new view. A write is a compare-and-set on
`revision` (no event: nothing outside the admin reacts to a view).

A view keeps its creator for life: `save` never writes `createdBy` on an update. So only the view's
creator, a person, can stop sharing it; anyone else gets a `422` and can save a copy. Moving
ownership instead would let any `content:manage` holder take a view away from the space for
themselves, and would have no answer for a view a key created, which has no person to go back to:
that view stays shared until it is deleted.

A run acts as the caller, so a shared view's `sys.createdBy=me` is each reader's own entries. A key
that isn't served author ids gets none in a run's rows, a view's `createdBy` is left out for it
(`savedViewFor`), and a view naming them isn't shown to it (`assertAuthorIdQuery`, in
`canSeeSavedView`).

**A view of a deleted content type.** Views are per space and types per environment, so deleting a
type doesn't cascade: the same view may be good in another environment, and the type may come back
through a merge. Where the type is missing, `runSavedView` answers an empty page with
`typeMissing: true` (a fact about this environment, not an error, and not "nothing matched"), the
view stays listed and readable, and it can still be renamed, requeried, reset with `columns: null`
or deleted. Only naming columns is refused (`422`), with no type to check them against. The admin
lists a type's views on that type's page, so it doesn't show these; they are reached over the API,
MCP and the SDK.

## Webhooks

```ts
interface Webhook {
  id: string;
  url: string;
  topics: readonly (EventType | '*')[]; // subscribed event types; "*" = all
  secret: string; // HMAC signing secret
  active: boolean;
  headers?: Record<string, string>; // extra headers per delivery
  environmentId: string | null; // the one environment it hears; null = every environment
}
```

`matchesTopic(webhook, type)` is true when the webhook is active and its topics include `*` or the
exact event type. `coversEnvironment(webhook, environmentId)` is true when the webhook is
space-wide (`environmentId: null`) or scoped to that environment; dispatch and every webhook read
under a scope apply it. Delivery attempts are recorded as `WebhookDelivery` rows for observability.

## Domain events

`DomainEvent` (`packages/domain/src/events.ts`) is a discriminated union appended to the
transactional outbox. All share a `BaseEvent` of `{ id, scope, occurredAt }`. The types are
`entry.published`, `entry.unpublished`, `entries.published_bulk`, `asset.published`,
`asset.unpublished`, `asset.deleted`, `asset.ingested`, `asset.file_replaced`, `asset.rights_changed`, `asset.expired`, `content_type.published`, `release.published`, `redirects.changed`, `menus.changed`, `environment_alias.changed`,
`environment.deleted`, `promotion.awaiting_approval`, `environment.promoted`, `bulk.job_completed`,
the `workflow_run.*` end states,
`workflow.task_opened` and `workflow.webhook`, plus control messages for background work
(`search.reindex_requested`, `bulk.chunk_due`, `environment.purge_due`). `webhook.test` is the body
of an administrator's test delivery; it travels inside a `WebhookSendRequest`, which shares the
outbox but is not a domain event. Every type and its payload
is in [Events & webhooks](./events-and-webhooks.md#event-payloads).

`EventType = DomainEvent['type']`. The stable `id` makes dispatch idempotent.

## Platform aggregates

Beyond core content types and entries, the domain (and store) model several platform capabilities.
See [API reference](./api-reference.md) for HTTP shapes.

| Aggregate                                     | Purpose                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Release**                                   | Bundle entries/assets for coordinated publish (`release.published` event)                                                            |
| **ScheduledAction**                           | Deferred publish/unpublish at a future time                                                                                          |
| **Comment / Task**                            | Editorial collaboration on entries                                                                                                   |
| **WorkflowGraphDefinition / WorkflowVersion** | An editable workflow graph (the draft) and its immutable versions; the latest's `gatesPublish` lets only its runs publish its types. |
| **WorkflowRun / WorkflowTask**                | A durable run pinned to one version, and the approvals, event waits and agent reviews it opens                                       |
| **WorkflowDefinition** (legacy)               | Ordered `steps`, each gated by a scope; per-entry `EntryWorkflowState`. Kept for existing rows; `legacyStepsToGraph` converts it     |
| **ConceptScheme / Concept / Tag**             | Controlled vocabulary and free-form tags, each term with a slug, description and localized labels (see [Taxonomy](#taxonomy))        |
| **EntryMetadata**                             | Tags and concept associations on an entry                                                                                            |
| **Role / ContentTypeGrant**                   | Granular RBAC (see [Auth & RBAC](./auth-and-rbac.md))                                                                                |
| **AiAction**                                  | Configurable prompt templates runnable against entries                                                                               |
| **Function**                                  | User-defined HTTP endpoint invoked on domain events                                                                                  |
| **AppExtension**                              | iframe panel registration for the admin UI                                                                                           |
| **AgentRun**                                  | Audit record for agent workflow executions                                                                                           |
| **AuditLogEntry**                             | Space-level change audit                                                                                                             |
| **EnvironmentAlias**                          | Map a path alias to a concrete environment id                                                                                        |
| **Plugin** (`InstalledPlugin`)                | A sandboxed write-path plugin: manifest, checksum, approved capabilities (see [Plugins](./plugins.md))                               |
| **PluginSettings**                            | An operator's values for the settings a plugin's manifest declares; secret ones sealed at rest, never returned by a read API         |
| **BulkJob**                                   | A durable bulk publish, unpublish or import: N items in claimable chunks, with a report                                              |
| **AgentSchedule**                             | A recurring agent job: workflow, UTC cron, content-type filter, `autoApply`                                                          |
| **AgentReview**                               | A pending agent proposal a human approves or rejects                                                                                 |
| **SpaceMember**                               | A person on a space's team: email, linked SSO subject, role, `disabled`                                                              |
| **PreviewToken**                              | An expiring, entry-scoped token behind a shareable preview link (stored hashed)                                                      |
| **OAuthClient / OAuth grant**                 | A dynamically registered client (not space-scoped) and the code, device and refresh grants a person approves                         |

### Taxonomy

`packages/domain/src/taxonomy/taxonomy.ts`. A `ConceptScheme` is a vocabulary; a `Concept` belongs
to one and may nest under a `broaderId` (cycles refused); a `Tag` is flat. Both kinds of term carry:

- **`slug`**: normalized like a Slug field (`normalizeSlug`), unique among the environment's tags
  or within the concept's scheme (unique indexes in the database). Made from the label when none
  is given (`termSlug`), numbered past the taken ones (`uniqueTermSlug`: `news`, `news-2`). A slug
  asked for that another term holds is a `ConflictError`. It never follows the label: a rename
  keeps it.
- **`description`**: plain text or null.
- **`labels`**: labels in the space's other locales. The term's own label (`Tag.name`,
  `Concept.prefLabel`) is the default locale's, so nothing that reads the label changed.
  `resolveTermLabel` walks the space's fallback chain to it.

`EntryMetadata` (an entry's tag and concept ids) is copied into the published snapshot. **Usage**
(`TermUsage`: per term and content type, how many published entries carry it) counts snapshots
only: a draft's terms count once it is published and stop counting when it is unpublished or
trashed. The store keeps it as it writes snapshots (`TaxonomyRepo.listUsage`, `recountUsage`; see
[Consistency](./consistency.md#database-limits-as-design-inputs)); `summarizeUsage` sums it per
term, leaving out the content types a key may not read. Every term change emits `taxonomy.changed`.


## RBAC types

See [Auth & RBAC](./auth-and-rbac.md) for the full model. The domain owns: the `SCOPES` map,
`scopesForKind(kind)`, the `Principal` type, and the `authorize` / `inScope` decisions.

## Errors

All extend `DomainError` (`{ code, message, details? }`) and carry a stable, client-facing `code`:

| Class                                 | `code`              | HTTP | Meaning                                                          |
| ------------------------------------- | ------------------- | ---- | ------------------------------------------------------------------------------ |
| `NotFoundError(resource, id)`         | `not_found`         | 404  | Resource missing                                                 |
| `ValidationError(issues)`             | `validation_failed` | 422  | Carries `issues: FieldIssue[]`                                   |
| `ConflictError(message, details?)`    | `conflict`          | 409  | Uniqueness or identity violation (e.g. duplicate apiId); `details` on the wire |
| `TransactionConflictError` (ports)    | `conflict`          | 409  | A compare-and-set lost inside a unit of work; nothing committed  |
| `LastAdminError`                      | `last_admin`        | 409  | Would leave the space with no active administrator               |
| `PublishGatedError(entries)`          | `publish_gated`     | 409  | A publish of an entry a gated workflow covers, outside its runs  |
| `AssetInUseError(assetId, usage)`     | `asset_in_use`      | 409  | Entries still link to the asset (`usage`, `total`)               |
| `InvalidStateError(message)`          | `invalid_state`     | 400  | Illegal state-machine transition                                 |
| `QueryTooBroadError(scanLimit)`       | `query_too_broad`   | 400  | A field query matched more candidates than the store evaluates   |
| `UnauthorizedError(message?)`         | `unauthorized`      | 401  | Invalid/missing credentials                                      |
| `ForbiddenError(scope)`               | `forbidden`         | 403  | Missing the required scope                                       |
| `HookRejectedError(hook, reason)`     | `hook_rejected`     | 422  | A write-path hook refused the operation                          |
| `RateLimitedError(message, retry?)`   | `rate_limited`      | 429  | A per-space rate or budget ceiling was exceeded                  |
| `NotConfiguredError(capability, msg)` | `not_configured`    | 501  | The deployment has not bound the capability the request needs    |
| `SecretUnreadableError(context)`      | `secret_unreadable` | 500  | A stored secret no configured key opens (never treated as unset) |

`OAuthError` (`oauth_<error>`) carries its own wire code and status for the OAuth endpoints, and
`PluginCapabilityDeniedError` (`capability_denied`) refuses a plugin call outside its grant.

`toHttpError` (`packages/http/src/api/http.ts`) does the mapping above, and the response body is in the [API reference](./api-reference.md#error-handling).
