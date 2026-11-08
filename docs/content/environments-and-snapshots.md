# Environments and snapshots

How an environment is exported, imported, cloned and deleted, and how content from other formats
is imported. The routes are in the [API reference](./api-reference.md#environment-snapshots);
restore points for the database are in [Backup & restore](./backup-and-restore.md).

## Snapshots

`GET …/export` produces portable JSON for one environment, `POST …/import` replays it into this one
and `POST …/clone` does both, including across spaces (`packages/application/src/snapshots.ts`
and `snapshot-jobs.ts`).

A snapshot carries the content model, entries (with taxonomy metadata), taxonomy, workflows,
asset **metadata**, the asset folders, the asset collections, the redirects (a `redirects` array,
optional, so snapshots written before redirects still import) and the menus (a `menus` array,
optional likewise). It deliberately never carries **credentials** (API keys, OAuth clients and
grants, preview tokens, webhook signing secrets), because a snapshot is a file people move around.
Asset **binaries** stay in the blob store: a restore into the same space, on a deployment
pointing at the same bucket, works, and one pointing elsewhere has dangling files, which is
visible rather than silent. An uploaded snapshot's asset may only name files in the space it is
imported into (`confineSnapshotFiles`): a file key naming another space is dropped, so the asset
points at its own (empty) key, because a snapshot is anyone's JSON and those keys are served as
they stand. A clone (`POST …/clone`, including across spaces) keeps its source's keys, since the
caller can read that space, so the two share the bytes: deleting the asset or the environment on
either side leaves them while any environment of the deployment has an asset with that id. The
import report names everything it did not carry.

**Import replays domain operations** rather than injecting rows: entries go through `createEntry`
and are republished through `publishEntry`. That is slower than a bulk insert, and deliberate:
validation, the reference graph, the delivery read model, the outbox and the search index all reach
the state they would have reached organically. A snapshot is therefore not a back door: content the
current model would reject fails the import loudly.

Import requires a target environment with **no content types**, and the target environment must
exist (create it first). Merging two content models is a different and much harder operation; use
`compare`/`merge` for the intra-space case. Cloning is the cross-space case those cannot cover, and
the target space is authorized separately so a clone cannot cross a tenancy boundary.

A live type with a draft revision carries what it serves in `published` beside its draft
(`SnapshotContentType`), and `writeSnapshotModel` publishes that first and saves the draft over it,
so the target serves what the source served. Versions start again in the target, as for any type.
The field is optional and `snapshotVersion` stays 1: a snapshot from before it, or a draft with
nothing kept, imports as a plain draft. A merge or a promotion copies the source's current
definition and no `published`: over a live target the target keeps serving its own definition until
it is published. Into a target without the type it arrives as a plain draft, which is a type never
published there: GraphQL serves it as it stands at once, and the routes, sitemap and menus leave it
out until it is published.

Preflight does what the write will do, so a definition that can't be written is refused (`422`, and
on a dry run) before anything is, rather than partway through an environment that then can't be
imported into again. A draft with a `published` definition is defined from that and revised over it
(`reviseContentType`, which passes what it finds unchanged); anything else goes through
`defineContentType`, and `published` on a published row is ignored, as the write ignores it. Both run
on the normalised model, so a rule normalising finds unusable is gone before either: a draft that
retypes `rating` under a rule comparing it with `gt` imports, and the rule stays in the target's
published definition and not in its draft, where the source's draft still holds it.

A snapshot's content model is normalised once, before the checks (`normalizeSnapshotModel`): an
`in` list stored before options were checked keeps its usable options, once each (and goes when
none is left), and unusable guidance, messages and conditional rules are dropped, rather than
failing the import. An entry that holds a dropped option is then refused by the checks, before
anything is written. Labelled options, validation messages and field guidance travel unchanged.

What an import preserves:

- **Ids.** Entries and asset records keep their ids (every table is keyed per environment), so
  links between them resolve in the target unchanged, and comparing or merging the copy against
  its source matches entries one to one. Taxonomy ids are remapped; terms keep their slug,
  description and labels (a slug the target already uses is numbered, `news-2`, and labels in a
  locale the target space lacks are left behind).
- **Redirects.** They keep their ids, `origin` and timestamps (`writeSnapshotRedirects`). Preflight
  checks each against the target's locales and the set as a whole (no loop, no duplicate source, at
  most `MAX_REDIRECTS`). A source the target already redirects keeps the target's, so a retry adds
  nothing twice. They are written in one unit with the set's revision and a `redirects.changed`
  event. A content type's `urlPattern` travels with the content model.
- **Menus.** They keep their ids and item ids (`writeSnapshotMenus`), written after the taxonomy so
  term links are remapped to the target's term ids; entry links keep their ids, since entries import
  with theirs. Preflight checks each menu's handle, name and items (not its links: the entries come
  after). A menu whose id or handle the target already holds keeps the target's, and at most
  `MAX_MENUS` are written. They are written in one unit with one `menus.changed` event.
- **Every entry.** The export reads every page of entries and assets, not the store's first page.
- **Live and draft versions.** A `changed` entry (published, with edits since) carries its live
  version's fields too: the import publishes those, then applies the draft, so the copy has the
  same live content and the same pending edits. Snapshots from before this carry no live version,
  and their changed entries land as drafts.
- **Assets** as records, published as they were; their files stay where they are. An archived
  asset arrives as a draft, and so does one whose rights no longer allow publishing (expired since
  the export, or under embargo), named in the report's `skipped`. Only the current file travels:
  an asset's earlier versions stay in the source's history.
- **Asset folders**, with their ids and paths, so each asset lands in the same folder. A snapshot
  from before folders carries none, and its assets land at the library root.
- **Asset collections**, with their ids, descriptions and member order, written with the model. A
  member is kept when its asset is in the snapshot or the target already holds it; the rest are
  dropped. A collection already there (a retried import) is kept as it is. A snapshot from before
  collections carries none. Share links, zip downloads and multipart uploads are not carried: a link
  belongs to the environment it was made in.

What ingest found is not carried: an imported asset arrives without `ingestStatus`,
`ingestError`, `duplicateOf` or `aiSuggestions` (`createSnapshotAsset`), because the target's
search has never indexed it. When the ingest queue is bound (`ASSET_EVENTS_QUEUE`), the import
then starts an `asset_reindex` job in the target: a synchronous import or clone as it returns, a
job-run one when its create job completes (`bulk.job_completed`, in the engine). The bytes are
the source's, so the content hash comes along.

### Checks before any write

Every entry is validated against the snapshot's content model and the target space's locales,
every link in what will be published must point at an entry or asset the snapshot carries, and
every asset folder needs a valid name and a parent the snapshot carries. Any
problem refuses the import with a `422` that lists them (up to 50, each naming its entry) and
writes nothing, so the target stays empty and a corrected retry works. `?dryRun=true` runs the same
checks and answers `200`. A failure the checks can't foresee (a plugin hook refusing an entry, an
infrastructure error) is reported per entry in the job's report.

### Import and clone run as jobs

Replaying every entry through the use-cases is far more than one request can hold for an
environment of any size. After the checks, the import request writes the content model, asset
folders, taxonomy, redirects, menus and workflows (small, and everything else depends on them) and answers `202` with
`{ report, job, publishJobId }`. The assets and entries are staged in the blob store in chunks of
100 before the model is written (so a staging failure leaves the target empty and a retry works),
and written by bulk jobs, with progress at `…/bulk/jobs/:id` and per-item failures at
`…/bulk/jobs/:id/report` in the **target** environment. The chunks run in the engine as
`bulk.chunk_due` events.

1. `job` creates the asset records and entries, as drafts, under their own ids.
2. `publishJobId` starts when `job` completes, in the same write that finalizes it: it publishes
   what the snapshot had published (assets, then entries), then lays each changed entry's draft on
   top. It waits because publishing an entry needs every entry and asset it links to to exist, and
   chunks run concurrently. It starts only if `job` completes with no failures (otherwise `job`'s
   report names what failed, and nothing is published); it never starts if `job` is cancelled, and
   it is `null` when nothing is published (`?publish=false`, or a snapshot of drafts).
   It publishes past every workflow that gates publishing (`gatesPublish`) in the target: those
   written with the model, and any the target already held (the import requires a target without
   content types, not one without workflows). `publishSnapshotEntry` is the only exempt path;
   publishes after the import are gated as usual.

Staged work is removed as each chunk finishes, and whatever is left (a chunk that failed for good, a
publishing job that never started, a cancelled job) when the job completes or is cancelled. Each
imported entry is created and published through the use-cases, so it emits its own events (webhooks,
search and vector indexing) as an entry written by hand would.

Every chunk step is safe to run again after a crash: an entry already created isn't created twice,
and one already published (or already carrying its draft) isn't published again. A snapshot with no
entries or assets answers `job: null`. Without a blob store (local fakes), import and clone run
synchronously and answer `201` with the report.

**A clone runs entirely as jobs.** An import's snapshot arrives in the request body, so its checks
run there; a clone's source is read from the database, so even the export and the checks move off
the request. `POST …/clone` checks only that both environments exist and the target holds no
content types, and answers `202` with `{ job, createJobId, publishJobId }`. `job` (one `prepare`
chunk, in the engine) exports the source, runs every check, stages the work, writes the model and
starts `createJobId`, as an import's request would, under create and publish job ids fixed when the
clone started (so a re-run after the create job exists does nothing). A snapshot the checks refuse
fails `job`, and its report (`…/bulk/jobs/:id/report`) names the problems; nothing is written.
`publishJobId` starts when `createJobId` completes cleanly, and only exists if anything is
published. A dry run (`dryRun: true` on the MCP tool) still exports and checks in the request.

## Deleting an environment

`DELETE …/environments/:env?confirm=:env` (MCP `environment_delete`) removes the environment and
everything in it: content model, entries and versions, assets, references, releases, schedules,
workflows and runs, taxonomy, redirects, menus, comments, tasks and jobs, and the webhooks scoped to it (space-wide
ones stay). Its audit history stays. `confirm` must
repeat the environment id. It takes a person holding `space:admin` in that space (signed in, or
through their OAuth or personal access token) or the deployment admin token; a plain API key gets
`403`, even one with `space:admin`. It refuses `main` (`422`) and any environment an alias points
at (`409`: repoint or remove the alias first).

One atomic write takes the environment out of the registry, so from that moment it answers `404`
to reads and writes on every surface. The same write records an `environment.deleted` audit row
naming the caller (on both surfaces, so a deletion never commits unrecorded), appends
`environment.deleted` events (published entry ids in chunks of 500) and the first
`environment.purge_due`. From the first, the engine removes the entries' search documents and
vectors and purges the delivery cache. Search results only ever include entries published now, so
an index document that outlives its entry is never served.

The rows themselves go afterwards, in bounded steps, because the database refuses one statement that
modifies hundreds of thousands of rows. Each step deletes at most 500 rows from each of the
environment's tables (`PURGE_ROWS_PER_TABLE`), and each `environment.purge_due` runs up to 20 steps
(`PURGE_STEPS_PER_EVENT`) before handing on to the next. When nothing is left, the environment's
asset files go from the blob store (keeping any another environment's asset records still point at,
as a clone's do; a space created before reserved space ids were refused, and named like one of
the bucket's own prefixes, keeps its asset files rather than reach that data) and its id is free
again. Until then, creating an environment with that id is
refused (`409`). A purge whose event is lost is restarted by the engine's cron after five minutes
without progress (`PURGE_STALE_SECONDS`). The pending purges are the `environment_purges` table
(`0003_environment_purges.sql`).

## Importing from other formats

Snapshots move content between CommerceWorker environments. This moves it _in_, from a format
someone else produced. The routes are `GET …/imports/sources`, `POST …/imports/analyze`,
`POST …/imports` and `POST …/imports/job` (all `content:write`). A role's grants apply too (below).

Both POSTs take the same body, so analyzing and running are the same request to two paths:

```jsonc
{
  "source": "csv", // or "json", "wxr" (a whole space export has its own routes, below)
  "payload": "sku,title\nA-1,Widget\n", // the file, as text
  "mapping": {
    "contentTypeApiId": "product",
    "fields": { "name": "title", "sku": "sku" }, // target apiId -> source field
    "identityField": "sku", // what makes a re-run recognise its own work
    "locale": "en-US" // default: the space's default locale
  },
  "sourceOptions": { "identityField": "sku" },
  "conflicts": "skip" // skip (default) | update | fail
}
```

The admin drives exactly this, from the entries list of any content type. It reads a file by
analyzing it with an **empty mapping** (every source field then comes back as unmapped, which is the
column list) rather than parsing it locally, so the names offered for mapping cannot disagree with
the names the import sees.

**Two phases, one computation.** `analyze` and the run share the same planner, so the report is not
a prediction: it is the run, without the commit. A migration is irreversible in practice, and the
decision to start one should be made while looking at its consequences.

The analysis reports what would be created, updated and skipped, plus three things that are only
findable beforehand:

- **`unmappedSourceFields`**: columns nothing maps to. This is the data the import throws away.
- **`missingRequiredFields`** / **`unknownTargetFields`**: a mapping that cannot work at all.
  These block execution; per-record failures do not.
- **`issues`**: a bounded sample of records that would fail, each named by its source id.

**Re-running is safe when `identityField` is set.** With it, a second run matches what the first
created and skips (or updates) it. Without it, every run creates everything again, which the
analysis makes visible rather than leaving to be discovered.

Entries arrive as **drafts**. Publishing them is the existing bulk job, which is resumable,
cancellable and reportable, none of which a flag on the import would be. A record that fails
validation is skipped and reported rather than aborting the run, and trashed entries are never
matched as conflicts: an import must not silently revive something someone deleted.

**An import runs as whoever asked.** A role limited per content type
gets a `403` for a type it can't write, at analyze as at the run, and for an `identityField` it
can't read, or on a type it can't read (matching on a field answers which values it holds). A
record that sets a field the role denies or makes read-only is skipped and listed in `issues`. An
update keeps what those fields hold, since an update's fields are the whole new version and leaving
one out would clear it; schema defaults apply to new entries only. A durable job is
authorized when it starts: only records the caller may write are staged, and the engine writes those
with no further check. A snapshot import, a clone, a snapshot export and a space export import need
`content:manage` and a role holding their actions on every content type with no field rules (see
[Custom roles](auth-and-rbac.md#custom-roles-granular-rbac)), because they touch types and fields
that can't be checked one at a time.

**Text for a RichText field is read as HTML.** Paragraphs, headings, lists, quotes, code blocks,
rules, tables, links and inline marks map to their rich-text nodes; a blank-line-separated block of
plain text becomes paragraphs, as WordPress renders it. The reader is lenient (unclosed tags and stray
end tags are recovered the way a browser recovers them) and keeps the text of any element it does not
know. Media from an allowed embed provider becomes an **`embed` node** holding its page URL and
provider (no title until someone resolves it): a provider's player `<iframe>`, a post
`<blockquote>` (`twitter-tweet`, `bluesky-embed`, `mastodon-embed`), a WordPress `wp-block-embed`
figure (its caption kept as a paragraph) and a provider URL alone on its line or in
`[embed]…[/embed]`; the player markup is dropped. Images and other media become **links to their
source**, since there is no asset to point an embed at yet; a link is visible and fixable, where a
dropped image is neither. A `<table>` becomes a `table`
(rows from `thead`, `tbody` and `tfoot` alike, `th` as header cells, `colspan`/`rowspan` kept); its
caption becomes a paragraph before it, and a table with no cells or over the size limits keeps its
text as paragraphs instead. A value that is already a rich-text document is left alone.

### WordPress exports (`wxr`)

The file from WordPress's _Tools → Export_. It holds posts, pages, attachments, menu items and
revisions in one list, and a mapping targets one content type, so the source reads one kind at a time:

```jsonc
"sourceOptions": {
  "postType": "page",           // default "post"; a list reads several
  "statuses": ["publish"]       // default: everything except auto-draft and trash
}
```

What it passed over is **named in `warnings`** ("Not read (other post types): page (12),
attachment (40)") along with comments, which are not imported. An export where the pages silently did
not come across is the failure this guards against.

Each item becomes flat fields: `id` (the WordPress post id, which is the identity, so map it to a field and
set `identityField` to make re-runs safe), `title`, `slug`, `content` (the post's HTML as stored),
`excerpt`, `status`, `date`/`modified` (ISO-8601; the GMT time when WordPress recorded one),
`author`/`authorName`, `link`, `parentId`, `menuOrder`, `sticky`, `categories` and `tags` (lists of
names), `terms.<taxonomy>` for custom taxonomies, `featuredImage` (the attachment's URL, resolved
within the file), `attachmentUrl` when reading attachments, and `meta.<key>` for custom fields.
WordPress's own bookkeeping meta (`_edit_lock` and the like) is left out; other underscore keys are
kept, since plugins store real content that way, and show up in `unmappedSourceFields` for you to
decide on.

The XML reader does not process a document type's internal subset, so a file cannot define entities
(the mechanism behind entity-expansion and local-file-read attacks), and an error names the line it
happened on, and says when the file looks truncated.

Payload size is bounded by `MAX_BODY_BYTES` (default 5 MB) on HTTP, and by the source's own 20 MB
cap elsewhere. The synchronous run refuses a file with more than 10,000 records; past that, use the
durable path.

### Space exports (`space-export`)

A whole space from the widely used JSON space export format (`contentTypes`, `entries`,
`assets`, `locales`, `tags`, `editorInterfaces`), whose rich text is a typed node tree
(`nodeType`, `content`, `data`, `marks`, links under `data.target.sys`). Unlike the formats above it
carries its own content model, so there is no mapping: it imports a whole environment, like a
snapshot, into one with **no content types**. The routes are `POST …/imports/space-export/analyze`
(writes nothing) and `POST …/imports/space-export` (`202`), both `content:manage`; the MCP tools are
`space_export_analyze` and `space_export_import`. Both take:

```jsonc
{
  "payload": "{\"contentTypes\": [...], ...}", // the export file, as text
  "publish": true, // publish what the export marks published (default)
  "addLocales": false // add the export's locales the space lacks; needs space:admin
}
```

The reader (`@commerceworker/adapters/import-space-export`, the `SpaceExportReader` port) maps the
whole file in one pass:

| Export                                                                                             | Here                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Symbol`, `Text`, `RichText`                                                                       | the same types                                                                                                                          |
| `Integer`, `Number`, `Boolean`, `Date`                                                             | the same types                                                                                                                          |
| `Location`                                                                                         | `Location` (`{ lat, lon }`)                                                                                                             |
| `Object`                                                                                           | `JSON`                                                                                                                                  |
| `Link` (`Entry` / `Asset`)                                                                         | `Link` with `linkType`                                                                                                                  |
| `Array` of `Symbol` / `Link`                                                                       | `Array` with `items`                                                                                                                    |
| `ResourceLink`, other arrays                                                                       | not imported, listed in `unmappedFields`                                                                                                |
| validations `in` (usable values once each), `size`, `range`, `regexp`, `linkContentType`, `unique` | `in`, `size`, `range`, `regexp` (if `unsafeRegexReason` allows it), `linkContentTypes`, `unique`                                        |
| a validation's custom `message`                                                                    | `validations.messages` for a kept `in`, `size`, `range` or `regexp` on the field; else (a list element's, too) in `unmappedValidations` |
| any other validation                                                                               | listed in `unmappedValidations`                                                                                                         |
| `required`, `localized`, `defaultValue`, `displayField`                                            | the same (a missing display field becomes the first `Symbol`)                                                                           |
| `locales` with `fallbackCode`                                                                      | the space's locales and `fallbacks` (added only with `addLocales`)                                                                      |
| `tags`, `metadata.tags`                                                                            | taxonomy tags, attached to their entries                                                                                                |
| assets (`fields.file` per locale)                                                                  | one asset each (the default locale's file), the file copied from its URL                                                                |
| `editorInterfaces` help text (`settings.helpText`)                                                 | the field's `help`; one with no imported field, or over 500 characters, is counted in `warnings`                                        |
| other `editorInterfaces` settings, `webhooks`, `roles`                                             | not imported                                                                                                                            |

A content type or field id that is not a legal apiId here (a hyphen, a leading digit) is rewritten
(`landing-page` → `landing_page`) and named in `warnings`.

**Every id is new.** Each entry and asset gets an id from `ctx.ids.newId()` before any value is
converted, so a link to something later in the file, or a cycle, resolves like any other. Links in
`Link` and `Array` fields and rich-text targets (`embedded-entry-block`, `embedded-asset-block`,
`embedded-entry-inline`, `entry-hyperlink`, `asset-hyperlink`) are rewritten to the new ids. A link
whose target isn't imported is dropped and listed in `missingLinks`: an embed goes, a hyperlink keeps
its words.

**Rich text** maps node for node: the export's node types are this platform's. A node with no
equivalent (`embedded-resource-block`, anything newer) keeps its text, as a paragraph where a block
stood, and is counted in `warnings`; a hyperlink to an unsafe URI keeps its text. Every converted
document is checked with `validateRichText`. No value passes through HTML.

**Entries that would fail are left out, and named.** Each converted entry is validated against the
mapped model as a write would validate it (defaults first, `unique` values checked across the file);
one that fails is listed in `invalidEntries` with why, and links to it are dropped. That can leave
another entry's required link empty, so it repeats until nothing changes.

**Published state.** An entry or asset whose current version is the published one
(`version == publishedVersion + 1`) is published by the import's second job. One with newer
unpublished changes imports as a draft (the export carries only the draft), and so does an archived
one; both are counted in `warnings`.

**Problems** stop the run as a whole (`executable: false`): a target environment with content types,
an export whose default locale is not the space's (values of fields that aren't localized live under
the default locale on both sides), and locales the space lacks without `addLocales`.

**The run** reuses the environment import's jobs (`startSnapshotImport`): locales, the content model
and tags are written in the request; then a create job copies each asset file and creates the assets
and entries, and when it completes with no failures, a publish job publishes what the export had
published. Each file URL passes `assertSafeExternalUrl`, then the outbound fetcher downloads it (GET,
no redirects, at most `ASSET_COPY_MAX_BYTES`, 50 MiB) into the asset's own key in the blob store, and
only then is the record written; the create job's completion sends the assets through ingest, as for
any snapshot import. A 5xx, a 429 or a network error fails the whole chunk so the queue retries it
(every step is safe to repeat); a 4xx, a redirect, an unsafe URL or an oversized file is that asset's
failure in the job's report, and, as with any snapshot import, a create job with failures does not
start publishing.

### Bigger than one request

`POST …/imports/job` takes the same body and returns the same report, chunked into a resumable
job: `202` with `{ job, analysis }`. The analysis is the same one `analyze` returns, and the job is
an ordinary bulk job, so progress polls at `…/bulk/jobs/:id`, per-record failures at
`…/bulk/jobs/:id/report`, and cancellation at `…/bulk/jobs/:id/cancel`, exactly as for a bulk
publish. Reading those requires `content:write` rather than `content:publish`, because someone who
can start an import must be able to watch it.

Planning is still one pass over the whole file (a report describing only part of a file is worse
than no report), so the durable path bounds memory, not time, at 250,000 records. What it chunks is
the writing. Records the report already counted as skipped are never staged: a job whose progress bar
counts work it will refuse reads as slower than it is.

Chunk work is staged in the blob store at plan time, once. Every chunk re-reading and re-parsing the
source file would make a 40,000-row import quadratic. **A consumer without a blob store leaves import
chunks claimable** rather than reporting an import that did not run, visible as a job that does not
progress. On a deployment that means `MEDIA_BUCKET` (object storage), where chunks are staged under
`imports/`.
