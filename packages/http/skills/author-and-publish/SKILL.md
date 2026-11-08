---

name: author-and-publish
description: Find, create, edit and publish CommerceWorker entries — including versions, releases for atomic multi-entry launches, scheduled publishing and editorial workflow runs and approvals. Use for any content change that should reach the Delivery API.
---

# Author and publish

Every entry has a **draft** (what the management tools read and write) and, once published, a
**published** version (what the Delivery API serves). Saving never changes what readers see;
publishing does.

## Find the entry

- Resolve a name to an id with `entries_suggest` (matches the display field). Do not page through
  `entries_query` looking for a title: you will miss everything past the first page.
- Use `entries_query` for structured questions (field filters, ordering, `select` projection) and
  `entries_get` for a full entry. It returns one page (`{ items, nextCursor? }`); pass `nextCursor`
  back as `cursor`, with the same filters and order, for the next.
- Entries you created: filter `sys.createdBy` `eq` `me` (`me` is you; `sys.updatedBy` works the
  same). What you write is recorded as yours, so a person reading the entry sees who changed it.
  Connected with an API key, `me` is the key's kind (`cma`), so it also matches other keys of that
  kind; a preview key sees no `createdBy`/`updatedBy` and can't filter on them.

## Write

- Read the type first (`model_get_content_type`). A field's `description` says what belongs in it
  and its `help` how to write it; follow both. Where `validations.in` lists `{ value, label }`
  options, write the `value`, never the label. A field with `rules` is hidden or disabled while a
  sibling matches, judged on the values you write: leave a hidden field empty (it is not
  required), and send a disabled field's stored value unchanged (a change is refused).
- Write a Date in its field's `format`: `date` is `2026-11-03`, `datetime` `2026-11-03T14:30`,
  `time` `14:30`; without one, any ISO-8601 string.
- Field values are always **locale-keyed**: `{ "title": { "en-US": "Hello" } }`. That applies to
  non-localized fields too, under the space's default locale.
- `entries_create` makes a draft. `entries_update` saves a **new draft version** whose fields are
  exactly what you pass — an omitted field is dropped. To change one field, `entries_get` the entry
  and send all of its fields back with that one changed.
- A `RichText` value is a node tree under `{ "nodeType": "document", "content": [...] }`. A table
  is `table` → `table-row`s → `table-header-cell` or `table-cell` → blocks, each with
  `"data": {}`; put a cell's text in a `paragraph`, never directly in the cell.
- To embed a video, post or track (YouTube, Vimeo, X, Bluesky, Mastodon, Spotify, SoundCloud),
  call `embed_resolve` with its https URL and put the returned `embed` in the document as
  `{ "nodeType": "embed", "data": <embed>, "content": [] }`. Never write the provider's HTML or an
  `<iframe>` into rich text; it is refused. If `resolved` is false, the embed is still valid.
- Validation errors come back with the field that failed. Fix the value; do not retry unchanged.
- To check fields without saving, call `entries_validate` with `contentType` (as a new entry) or
  `id` (as a new version): the same checks and errors as the save, and nothing is written. Its
  `skippedHooks` lists plugins that didn't run and may still refuse the real save.

## Publish

| Situation                                     | Tool                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| One entry, now                                | `entries_publish` (also checks its references)                                                                       |
| Several entries that must appear together     | `releases_create` → `releases_add_entry` (per entry, `publish` or `unpublish`) → `releases_publish`, which is atomic |
| At a future time                              | `schedule_action` with an ISO-8601 `scheduledFor`, on an entry or a release                                          |
| The space routes the entry through a workflow | `workflow_run_start` (see below)                                                                                     |
| The space uses legacy workflow steps          | `workflow_transition` to the next step; a step can require a scope you lack                                          |
| Take it down                                  | `entries_unpublish`                                                                                                  |

Prefer a release over publishing several entries one by one: a failure halfway through a sequence
leaves the site half-updated, and a release cannot.

A publish that changes a slug named by its type's `urlPattern` writes a `301` from the old path to
the new one in the same step; check with `redirects_resolve` (path of the old URL). Manage other
redirects with the `redirects_*` tools.

To change only an entry's SEO metadata (its type's `Seo` field), call `entries_set_seo` with the
parts to change (`null` clears one; `locale` for a localized field): it saves a draft, so publish
afterwards. `sitemap_list` shows the published pages the sitemap lists.

To change a few blocks of a long blocks field, don't resend the whole field with `entries_update`:
read `entry_blocks_outline` (each block's `key`, type, label and children, and the `version`),
then send `entry_blocks_patch` with `expectedVersion` set to that version and ops addressed by
`key` (`insert`, `update`, `move`, `remove`, `duplicate`). Give an inserted block a `ref` to put
blocks inside it in the same patch. A refused op names its index; nothing is saved, so fix it and
send the patch again. A `409` means someone saved since you read: outline again. The answer's
`inverse` undoes the patch, and it saves a draft, so publish afterwards.

## Editorial workflows

A workflow is a published graph (approvals, waits for events, AI checks, publish). Runs act as
whoever started them, so a run can do only what that caller could.

- Find the workflow: `workflow_list` gives each one's id, what starts its published version and
  which others start alongside it.
- Submit: `workflow_run_start` with the entry and workflow. One active run per workflow and entry.
- Follow it: `workflow_run_get` (`include: ["timeline"]` for what happened) or `workflow_run_list`.
- Approvals waiting: `approvals_count` says how many; `workflow_task_list` with `status: "pending"`
  lists them, then `workflow_task_decide`.
  With separation of duties the run's starter can't decide, and an API token can't decide at all;
  hand those to a person rather than retrying.
- A run waiting for a business event: `workflow_event_deliver` with the event name.
- Stop a run: `workflow_run_cancel` undoes its finished steps. Confirm with the user first.
- Build or change a workflow: `workflow_copilot` proposes a graph (it never saves),
  `workflow_validate` checks one, `workflow_save_draft` saves it and `workflow_publish` makes it
  the version new runs use.

## Undo

`entries_list_versions` → `entries_diff_versions` to see what changed (`from` and `to` each take
a version number, `"draft"` or `"published"`; a change comes back typed: text as word segments,
rich text by block, lists by element with moves) →
`entries_restore_version`, which copies the old fields into a new draft. Publish that draft to make
the restore visible.
