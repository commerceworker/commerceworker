# HTTP API reference

> **Interactive docs:** every deployment serves its own OpenAPI 3.1 spec at
> `GET /openapi.json` (an inventory of the mounted routes, so it reflects the deployment's `ROLE`)
> and a browsable Scalar UI at `GET /docs`. The page loads
> Scalar from the deployment's own admin origin (`/vendor/scalar/standalone.js`, copied out of
> node_modules by `apps/studio/scripts/vendor-scalar.mjs` on every web `dev` and `build`), with
> Scalar's default fonts and "Ask AI" off, so it makes no third-party requests.

The API is a [Hono](https://hono.dev) app (`createApp` in `packages/http/src/api/app.ts`) mounted by
two edge workers. It exposes three role-based surfaces:

- **Management (CMA)**: authoring, publishing, space administration, AI, releases, workflows.
- **Delivery (CDA)**: read-only published content, hybrid search, Live Content SSE, GraphQL.
- **Preview (CPA)**: read-only draft/current content.

Which surfaces mount is controlled by `ROLE` (see [Configuration](./configuration.md)):

| `ROLE`          | Mounted                         |
| --------------- | ------------------------------- |
| `all` (default) | Management + Delivery + Preview |
| `management`    | Management only                 |
| `delivery`      | Delivery only                   |
| `preview`       | Preview only                    |

`ROLE` may also be a comma-separated union. Where each surface is served:

| Host                      | Edge worker     | `ROLE`                        | Serves                                                                                                                                                                                                                                                                                        |
| ------------------------- | --------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.<domain>`            | `apps/api`      | `management,preview,delivery` | Management, Preview, MCP, OAuth, `/media/*`; delivery routes for the admin's own reads                                                                                                                                                                                                        |
| `cdn.<domain>`            | `apps/delivery` | `delivery`                    | The public Delivery API (`/delivery/*`, `/graphiql/*`), cached; auth on every request                                                                                                                                                                                                         |
| `media.<domain>`          | `apps/media`    | `media`                       | Published asset files (`/<space>/<env>/<id>/v<n>/<token>/<variant>/<file>`), cached (immutable unless rights expire); the asset reference route (`/a/<assetId>[/<variant>]`, a 302 to the current published file), Preview's signed `/media/*` reads (GET only, `exp` required); share links (`/s/<space>/<env>/<link>/<token>`, [below](#asset-collections-share-links-uploads-and-zips)) |
| `<domain>` (admin origin) | `apps/studio`      | —                             | Forwards the api's surfaces to it ([the list](./architecture.md#appsweb-the-admin-and-the-gateway)); OAuth's issuer on a fleet deployment                                                                                                                                                     |

Public delivery clients should use `cdn.<domain>`; it answers only `GET`/`HEAD` (cached) and
`POST` for GraphQL (uncached), and anonymous reads get 401 before the cache.

**Read-your-writes.** Every api response carries `x-cw-bookmark`, the database session's bookmark
after the request's queries. Send it back on the next request and that read is at least as fresh
as your last response, even from a read replica. Without it, a `GET` may be served by any replica.
See [Consistency](./consistency.md).

## Authentication

Every endpoint needs a credential except:

- `/health`, `/ready`, `/graphiql/:space/:env` (the shell; its queries still need a CDA token),
  `/openapi.json` and `/docs`;
- `/oauth/*` and `/.well-known/*`, which speak the OAuth protocol (see below);
- `/media/*`, which is authorized by an HMAC signature in the URL;
- `POST /webhooks/stream`, authorized by the video streaming service's `Webhook-Signature` (mounted
  only with the `STREAM` binding and `STREAM_WEBHOOK_SECRET`).

A credential is resolved in this order (`principalMiddleware`, `packages/http/src/api/auth.ts`):

1. **A signed `x-cw-principal` header**, which the web gateway adds for a signed-in person (see
   [Auth & RBAC](./auth-and-rbac.md#the-web-principal)). It is believed only when signed with
   `PRINCIPAL_KEY`, bound to the request method and path, and under 60 seconds old; one that
   fails verification is a `401`, never a fall-through to the bearer token.
2. **`Authorization: Bearer <token>`.** If the token equals the configured **admin token**, the
   request gets a wildcard admin `Principal` (`spaceId: '*'`, all CMA scopes), used for
   provisioning and bootstrap. Otherwise the token is SHA-256 hashed and looked up as an API key;
   the matched key's space, scopes, and optional role grants become the `Principal`. OAuth access
   tokens and personal access tokens are the same lookup (API keys with a different issuance) and
   resolve to a `user` principal carrying the human's `subject`.
3. Neither, or an unknown token: **401**. Failed bearer lookups count against the client IP and
   answer `429` once the limit trips.

When `OAUTH_ISSUER` is configured the API also runs an OAuth 2.1 authorization server at
`/oauth/*` plus `/.well-known/oauth-authorization-server`, so MCP clients authenticate through a
consent flow rather than a static key. A fleet deployment serves it on the admin host
(`OAUTH_ISSUER=https://<domain>`, forwarded by the web gateway), and a person approves after
signing in to the web app. See [Auth & RBAC](./auth-and-rbac.md#oauth-21-for-mcp-clients).

Each route then calls `requireScope(scope)`, which runs `authorize(principal, scope, :space)`.
Delivery and Preview list/get endpoints additionally filter by granular `contentGrants` when the
key is role-bound. See [Auth & RBAC](./auth-and-rbac.md).

## Environment aliases

Path segment `:env` in Management, Delivery, and Preview routes is resolved through
**environment aliases** (`environment_aliases` table) before use. This supports blue/green-style
routing without changing client URLs.

MCP tools resolve their `environment` argument the same way (except `environment_delete`, which
takes the name as given, and `audit_log_list`, so a deleted environment's history stays readable).

A write must name an alias or an environment that exists. Anything else is `404`, so a typo'd or
deleted environment never collects rows that no environment owns. A read of an unknown environment
is just empty. A caller who can't act in the space gets `403` before that check, so they can't tell
which environments exist there. Snapshot import and clone also need their target environment to
exist (create it first).

Setting an alias and deleting its target can't race: each write re-checks inside its own batch.
An alias set after a deletion's check aborts the deletion (`409`), and an alias whose target was
deleted after its check is refused (`404`).

## System endpoints

| Method | Path                    | Auth | Response                                                 |
| ------ | ----------------------- | ---- | ---------------------------------------------------- |
| GET    | `/health`               | none | `{ "status": "ok", "scheduler": "ok" }` (below)          |
| GET    | `/health/scheduler`     | none | `{ "scheduler": "ok" }`, `503` unless `ok` (below)       |
| GET    | `/ready`                | none | `{ "status": "ready", "role": "<role>" }`                |
| GET    | `/graphiql/:space/:env` | none | GraphiQL HTML shell (queries still need a CDA token)     |

`/health` always answers `200` with `status: "ok"` while the api runs. `scheduler` says whether the
engine's per-minute cron is ticking: `ok` when its last tick is at most five minutes old, `stale`
when it is older or there has never been one, `unknown` when the heartbeat could not be read. It
names no job and no error, and each isolate reuses the answer for 30 s
(`HEALTH_SCHEDULER_TTL_MS`). `GET /deployment/scheduler` (deployment administrators: the admin
or MCP token; anyone else `403`) and the `scheduler_status` MCP tool return the detail:
`{ scheduler, lastTickAt?, staleAfterSeconds, jobs: [{ job, lastRunAt, lastSuccessAt?, lastErrorAt?, lastError? }] }`,
one job per sweep (`outbox-relay`, `scheduled-actions`, `asset-expiry`, `abandoned-multipart-uploads`, `abandoned-uploads`, `expired-zips`, `trash-retention`, `event-history-prune`, `secrets-reseal`, `taxonomy-repair`,
`bulk-resume`, `environment-purge-resume`, `version-archive`, `agent-schedules`), the error
redacted and at most 500 characters.

`/health/scheduler` is the same answer for an external uptime monitor: `200 { "scheduler": "ok" }`
while the cron ticks, `503` with `stale` or `unknown` otherwise (same 30 s cache, same privacy).
`/health` stays `200` because it is the api's liveness and the deploy smoke test's; the cron can't
report its own outage, so this probe is what an uptime check watches (see
[Deployment](./deployment.md#scheduler-alerts)).

`GET /deployment/scheduler/alerts` and the `scheduler_alerts` MCP tool (deployment administrators)
return the stale alerts: `{ recipients, evaluatingSince?, open: [episode], recent: [episode] }`,
where an episode is `{ id, job, lastSuccessAt?, detectedAt, lastError?, resolvedAt?, resolution?,
staleNotice?, recoveryNotice? }` and a notice `{ state: pending|sent|failed|skipped, attempts, at?,
error? }`. `recent` holds the last 20 resolved episodes, newest first; `job: "tick"` is a gap in
the cron, resolved when it came back. `PUT /deployment/scheduler/alerts` with
`{ "recipients": ["oncall@example.com"] }` (and `scheduler_alerts_set_recipients`) replaces who is
emailed: at most 50 addresses, trimmed, lowercased and deduplicated; `[]` turns the emails off.

---

## Shared query language

Delivery and Preview entry list endpoints, and GraphQL resolvers, share the query parser in
`packages/application/src/entry-query.ts` (`entryQueryFrom`). In addition to `content_type`, `locale`, `limit`, `skip`, `since`, and
`include`:

| Parameter         | Syntax                                | Meaning                                                               |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Field filter      | `fields.<apiId>=v`                    | Equals                                                                |
| Field filter (op) | `fields.<apiId>[op]=v`                | `op` ∈ `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `between` (`low,high`), `exists`, `match`, `startsWith` |
| Component path    | `fields.seo.title[op]=v`              | A component member (up to 4 segments); through a list of components, any element's |
| Referenced entry  | `fields.<link>[ref]=<id>`             | The field links to the entry (`[refIn]=<id>,<id>`: any of them)        |
| Links to entry    | `links_to_entry=<id>[,<id>]`          | Any field links to the entry; refused (403) to a key with hidden fields |
| Groups            | `where=<json>`                        | `and`/`or` groups of `{ field, op, value }`, ≤ 4 deep, ≤ 20 predicates (`parseQueryWhere`); ANDed with the rest |
| System field      | `sys.publishedAt[gt]=<iso>`           | Filter on `sys.*` pseudo-fields                                       |
| Authorship        | `sys.createdBy=me`                    | Preview and Management: `sys.createdBy`/`sys.updatedBy` (`me` is the caller), `sys.createdAt`, `sys.firstPublishedAt`; Delivery has `sys.firstPublishedAt` only |
| Taxonomy          | `metadata.tags.slug=news`             | Delivery only: entries carrying a tag (`metadata.tags` by id; `metadata.concepts[.slug]` for concepts) |
| Sort              | `order=fields.title,-sys.publishedAt` | Comma-separated; `-` prefix = descending                              |
| Manual order      | `order=sys.position`                  | A content type's manual order on every surface (`-sys.position` reversed); an entry never moved sorts by its id, so creation order. Alone, it is answered in SQL from an index and pages like a plain list; with filters, search or other keys it sorts over the matches. Meaningful within one `content_type` |
| Projection        | `select=fields.title,fields.body`     | Return only listed field apiIds                                       |
| Full-text         | `query=foo`                           | FTS over string fields (published model on Delivery)                  |

The D1 store pushes a superset of each predicate into SQL and the domain engine
(`runEntryQuery`) decides exactly (`packages/store/src/query-pushdown.ts`). Reference filters on
Delivery are an `IN` over the `references` edges table (by its `to_id` index), on Preview a
`json_tree` walk of the current fields, after a cheap `instr` test for the quoted id (so ref ids
are restricted to printable ASCII: an id containing `"`, `\` or a non-ASCII character can't be
targeted). On Delivery a top-level reference filter answered by the edge lookup is exact and is
not rechecked against today's type, since the edges record the type as it was at publish. The use-cases pass the content model with a
reference filter (`EntryQuery.contentTypes`; on Delivery it rides the config read), and the
engine then reads links exactly as `extractReferences` writes the edges: declared link-bearing
fields only, any locale. Component paths compare the path's last segment as a bound value, at
most `MAX_PATH_FILTERS` (4) pushed per statement (the rest are left to the engine; only a `where`
tree is refused, 422, past 4 paths, since top-level dotted keys were always accepted); an `or` group is pushed only when every branch is; a field
key holding `"` widens the scan instead of being walked. Prefilters spend at most
`PREFILTER_PARAM_BUDGET` (64) bound parameters per statement; a predicate past it is left to the
engine.

Strict checks (`queryFilterIssues`, strict inside `where`) apply to the new inputs only: `ref`,
`refIn`, `between`, `startsWith`, `*`, and every predicate of a `where` tree. An empty `match`
("has a value"), an `in`/`nin` list past 100 values and an unknown operator behave as before.
Repeated `where` parameters (and GraphQL's `and`, `or` and `where` keys) are merged with
`mergeWhereJson` and checked as one tree: ≤ 4 deep, ≤ 20 predicates, ≤ 8,192 characters (MCP
measures `JSON.stringify(where)`); an empty `where=` is absent. A query-string key the parser
doesn't recognise (more than 4 path segments, a numeric segment) is ignored as before; the same
path inside `where` is refused with 422.

In `packages/store/test/query-counts.json` the Delivery reference rows (`fields.author[ref]=`,
`links_to_entry=`) record 3 statements to a plain list's 2: a reference filter reads the content
types alongside the space config, in the same round trip, so the engine can read links as the
edges do.

---

## Management API (CMA)

Base paths: `/spaces`, and `…` for `/spaces/:space/environments/:env`. Space-level routes (keys, roles, team, plugins) are written out in full.

### Spaces & environments

| Method | Path                                        | Scope                                | Description                                                                               |
| ------ | ------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| GET    | `/spaces`                                   | auth                                 | List spaces (admin: all; scoped key: own space)                                           |
| POST   | `/spaces`                                   | `space:admin`                        | Create a space (reserved ids are `422`, below). `starter`: `empty` (default), `sample` (installed before it returns, `installed`), or `enterprise` where `DEMO_STARTERS=true` (else `422` on `starter`): the brand's locales join the space and its content installs in the background as a chain of `starter_install` bulk jobs; `201` carries `installing: { install, jobId, steps }` |
| GET    | `/starters`                                 | `space:admin`                        | The starters `POST /spaces` accepts here: `{ items: [{ id, title, description, background }] }` |
| GET    | `/spaces/:space/environments/:env/starter-installs/:install` | `content:write`     | A background install's progress: `{ install, starter, step, steps, phase, title, jobId, status: running\|completed\|failed, failures? }` from the environment's `starter_install` jobs; `failed` when a phase finished with failures or was cancelled (the rest never start); `404` for an install not in this environment |
| GET    | `/spaces/:space/environments`               | `preview:read`                       | List environments                                                                         |
| POST   | `/spaces/:space/environments`               | `space:admin`                        | Create environment `{ id, name }`                                                         |
| DELETE | `/spaces/:space/environments/:env?confirm=` | `space:admin`                        | Delete an environment and everything in it                                                |
| GET    | `/spaces/:space/environment-aliases`        | `preview:read`                       | List aliases                                                                              |
| PUT    | `/spaces/:space/environment-aliases/:alias` | `space:admin`                        | Set alias → environment id                                                                |
| DELETE | `/spaces/:space/environment-aliases/:alias` | `space:admin`                        | Remove alias                                                                              |
| GET    | `/spaces/:space/audit-log`                  | `space:admin`                        | Space audit log, a page at a time ([filters and paging](#audit-log))                      |
| GET    | `/spaces/:space/compare`                    | `preview:read`                       | Compare two environments (`?from`, `?to`), limited to the types the role can read         |
| POST   | `/spaces/:space/merge`                      | `content:manage`                     | Merge environment branch (entries need the actions on every content type); `409` (`details.conflicts`) before any write when its entries would take a unique value twice; an entry in the target's trash stays there |
| POST   | `/spaces/:space/promotions`                 | `content:manage` + `content:publish` | Promote content between environments (`{ source, target, contentTypes?, entries? }`)      |
| GET    | `/spaces/:space/promotions`                 | `content:publish`                    | List promotions, newest first (`?status=`)                                                |
| GET    | `/spaces/:space/promotions/:id`             | `content:publish`                    | A promotion, its risk check and result                                                    |
| POST   | `/spaces/:space/promotions/:id/approve`     | `content:publish`                    | Approve a waiting promotion and apply it (a person or the admin token, not the requester) |
| POST   | `/spaces/:space/promotions/:id/reject`      | `content:publish`                    | Reject a waiting promotion                                                                |

A space id is 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit, and is
never one of the media bucket's own prefixes: `versions`, `imports`, `plugins`, `dlq` or `zips`, in any case
(`RESERVED_SPACE_IDS`). `POST /spaces` and the `space_create` MCP tool refuse one with a validation
error (`422` over HTTP).

**Promotions** carry content from one environment to another and, unlike merge, go live and
check first.

1. **Pinning.** A request pins what it copies, each entry and each content type by version, so
   nothing edited in the source afterwards gets in. A content type changed since fails the apply
   with a 409. What's live in the source goes live in the target, and a draft goes as a draft. Omit
   `contentTypes` and `entries` to promote everything that differs (at most 200 entries and 100
   content types). Promotions take a role without content-type or field restrictions (`403`
   otherwise), since they write and publish whole entries across types. An entry that a workflow
   gates in the target (`gatesPublish`) goes as a draft, and the reasons say which workflow: that
   workflow's run publishes it there, not the promotion. A gate added after the request leaves that
   entry a draft too (`result.gated`) rather than failing the rest.
2. **The risk check.** The rules come first. Approval is required when:
   - the target is `main`, or an alias points at it;
   - a promoted content type would remove a field (at any depth) or a block variant, change a
     field's type, or make one required;
   - the target's entries still hold a field or a block variant it removes (each named with its
     entries; applying it would be refused with `409` until they are cleared).

   Then the decision model (Clef) answers `review`, `breaking` and `risk` over a summary of the
   change. It can only add a requirement, at `review` ≥ 0.5 or `risk` Significant or above, never
   waive one. If it should answer and can't, approval is required too. The record keeps the
   reasons and the probabilities (`risk`).
3. **Deciding.** A promotion that needs no approval applies at once (`completed`). One that does
   waits as `awaiting_approval` (event `promotion.awaiting_approval`). It's then approved or
   rejected by a person, or the deployment admin token, other than whoever requested it:
   - an API key, or an application acting for a person (an MCP or OAuth client, an agent), can
     request a promotion but not decide one;
   - approving one with content types also takes `content:manage`;
   - both environments must still exist when it's approved.

   Approving moves it to `applying` with a compare-and-set, so it applies exactly once. The
   request, the decision and the outcome are each written to the audit log.
4. **Applying.** Applying goes through the use-cases (`createEntry`/`updateEntry`, then
   `publishEntry`), so validation, references, events and the delivery cache behave as they would
   for a person's edits. Afterwards it checks that the target holds the pinned fields
   (`result.mismatched`) and emits `environment.promoted`. A failure marks it `failed` with the
   error; whatever was applied before it stays.

### Audit log

`GET /spaces/:space/audit-log` returns `{ items, nextCursor? }`, newest first, ordered by `at` and
then `id`. Every filter is an exact match and they all apply together:

| Parameter     | Keeps                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| `environment` | The environment acted in, as recorded: never resolved, so a deleted one stays readable       |
| `actor`       | A person's id, `admin-token`, or the kind of key                                             |
| `action`      | `<METHOD> <route>` for REST, `MCP <tool>` for a tool, or a use-case's own (`invite.created`) |
| `targetType`  | The kind of thing acted on: `entry`, `release`, `content_type`, `environment_alias`, …       |
| `targetId`    | The id of the thing acted on                                                                 |
| `from`, `to`  | A time range, both ends inclusive                                                            |

`from` and `to` take an ISO 8601 date, read as the start of that UTC day for `from` and its end for
`to`, or a date-time with an offset. `limit` is at most 100 (the default), clamped rather than
refused. Pass `nextCursor` back as `cursor`, with the same filters, for the next page; it is a keyset
on (`at`, `id`), so entries appended while walking shift nothing and entries sharing a millisecond
are neither lost nor repeated. A `from` or `to` it can't read, a `from` after `to` and a `cursor`
it can't read are each `422`. MCP: `audit_log_list` takes the same filters and returns the
same page.

Entries written before migration `0031` have no `targetType` when they came from a REST or MCP call:
their `targetId` still matches.

A row whose action saved entries carries `detail`, and any other row has no such key (nor do rows
written before migration `0032`):

```json
{
  "entries": [
    {
      "entryId": "0198…",
      "contentType": "article",
      "kind": "updated",
      "version": 7,
      "paths": ["fields.title", "fields.hero.alt", "fields.sections[].heading"],
      "locales": ["de"]
    }
  ]
}
```

`paths` are the content model's: rich text, JSON, `Seo` values and scalar lists stop at the field,
`[]` is an element of a list (an element added, removed or moved reports the list), and a nested key
the model doesn't declare reports its parent. A created entry lists each field it was given, and
its row names the entry as its target. `locales` are the space's locales the change touched, among
localized fields. `undeclaredFields` counts changed fields the type no longer declares, which are
not named. An empty `paths` is a save that changed nothing. `detail` never holds a value. It is
capped at 4096 characters and 20 entries; a row past either has `truncated: true` and lists what
fit. `audit_log_list` serves it unchanged, and a REST write and a tool call that made the same edit
carry the same detail.

#### An entry's activity

`GET …/entries/:id/activity` (MCP: `entries_list_activity`) is the audit log read for one entry in
the environment: the rows about it, as `{ items, nextCursor? }`, in the log's order and with its
`limit` and `cursor`. A row is about the entry when it targets it (`targetType` `entry`: its saves,
publishes, trashing, a version restored, its creation, a duplicate made from it) or when its
`detail` names it while targeting something else (an approved agent review, the copy a duplicate
made, a cancelled workflow run's undo). Each row comes once, as the log serves it, so a row that
saved several entries still lists them all. It takes `space:admin`, as the log does: rows name who
acted and through which route or tool. The id must have the shape of an entry id (`422`
otherwise), and the entry need not exist any more: a deleted entry's history stays readable. An
entry with no rows is an empty page. A row with no `detail` says nothing about what changed.

It reads `audit_log_entries` (migration `0033`), one row per entry an audit row is about, which a
trigger on `audit_log` fills as each row is appended, so rows from code that has never heard of the
table are indexed too; the migration indexes the rows already there. A page is one statement, a
range of that index joined to the rows it keeps. Not in it: a row past `detail`'s 20-entry cap
for the entries left out, a promotion's (its rows name no environment), and a row from before
`0031` that came through REST or MCP (it has no `targetType`); `targetId` on the log still finds
the last.

Field edits are what `detail` covers: an entry's save made within the request, through any route or
tool (creating, updating, SEO, restoring a version, duplicating, an AI `apply`, an approved agent
review, the undo of a cancelled workflow run, an import that runs in the request). A promotion's
entries are in its target environment, which `detail` doesn't name. Publishing, trashing, tags,
every other kind of target, environment merges and work a job does later (bulk jobs, job-run
imports) write their rows without it.

### Environment snapshots

| Method | Path       | Scope            | Description                                                                                                      |
| ------ | ---------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `…/export` | `content:manage` | Export the environment as portable JSON                                                                          |
| POST   | `…/import` | `content:manage` | Replay a snapshot into this environment, as a job (`202`; `?dryRun=true` reports, `200`; `?publish=false`)       |
| POST   | `…/clone`  | `content:manage` | Copy this environment into another, entirely as jobs (`202`) `{ targetSpaceId?, targetEnvironmentId, publish? }` |

A snapshot carries the content model, entries, taxonomy, workflows, asset metadata, asset
folders and asset collections (with their member order), never
credentials or asset bytes. Import and clone answer `202` and run as bulk jobs in the engine,
followed at `…/bulk/jobs/:id` in the target environment; `?dryRun=true` reports with `200`. What an
import checks, preserves and writes, how clone differs, and how
`DELETE /spaces/:space/environments/:env?confirm=:env` purges an environment are in
[Environments and snapshots](./environments-and-snapshots.md).

### Importing from other formats

| Method | Path                             | Scope            | Description                                                                                                 |
| ------ | -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| GET    | `…/imports/sources`              | `content:write`  | Formats this deployment can read (`csv`, `json`, `wxr`)                                                     |
| POST   | `…/imports/analyze`              | `content:write`  | Report what an import would do. Writes nothing                                                              |
| POST   | `…/imports`                      | `content:write`  | Run it (`201`); entries arrive as drafts                                                                    |
| POST   | `…/imports/job`                  | `content:write`  | Same body, chunked into a resumable bulk job (`202 { job, analysis }`)                                      |
| POST   | `…/imports/space-export/analyze` | `content:manage` | Report what importing a JSON space export would do. Writes nothing                                          |
| POST   | `…/imports/space-export`         | `content:manage` | Import it into an empty environment (`202 { report, job, publishJobId }`); `addLocales` needs `space:admin` |

The body, the analysis report and the format notes are in
[Environments and snapshots](./environments-and-snapshots.md#importing-from-other-formats).

### API keys, tokens & roles

| Method | Path                                      | Scope         | Description                                                                                  |
| ------ | ----------------------------- | ------------- | ------------------------------------------------------------------------- |
| GET    | `/spaces/:space/api-keys`                 | `space:admin` | List keys                                                                                    |
| POST   | `/spaces/:space/api-keys`                 | `space:admin` | Mint key (`kind`, optional `roleId`); raw `token` returned once                              |
| DELETE | `/spaces/:space/api-keys/:id`             | `space:admin` | Revoke a key (also how a personal access token or OAuth token is revoked)                    |

MCP: `api_keys_list`, `api_key_create`, `api_key_update` (the key's role), `api_key_revoke`.
Minting a key, and a role change that widens one, answer 403 to a personal access token or an
OAuth token (see [Auth & RBAC](./auth-and-rbac.md#one-token-model-three-issuances)).
| POST   | `/spaces/:space/personal-access-tokens`   | `space:admin` | Mint a personal access token `{ name, scopes, expiresInDays? }` (1 to 365); raw `token` once |
| GET    | `/spaces/:space/personal-access-tokens`   | `space:admin` | List personal access tokens                                                                  |
| GET    | `/spaces/:space/oauth/connections`        | `space:admin` | List applications connected through OAuth                                                    |
| POST   | `/spaces/:space/oauth/connections/revoke` | `space:admin` | Disconnect one `{ clientId, subject }`: revokes its tokens and grants                        |
| GET    | `/spaces/:space/roles`                    | `space:admin` | List roles                                                                                   |
| POST   | `/spaces/:space/roles`                    | `space:admin` | Create role                                                                                  |
| GET    | `/spaces/:space/roles/:id`                | `space:admin` | Get role                                                                                     |
| PUT    | `/spaces/:space/roles/:id`                | `space:admin` | Update role                                                                                  |
| DELETE | `/spaces/:space/roles/:id`                | `space:admin` | Delete role (refused if a key or person holds it, and for a preset)                          |

A personal access token is minted for the caller themselves, with scopes intersected with their
own, and only by a `user` principal (a signed-in person, or one of their personal access tokens)
that carries no OAuth client: API keys, the admin token and OAuth-issued tokens get `403`. It has no
MCP tool. The team (`…/team`, `…/members`, `…/role-presets`, `…/roles/:id/clone`,
`…/api-keys/:id/role`, `…/access-settings`) is in
[Auth & RBAC](./auth-and-rbac.md#space-access-the-team). Plugin routes (`/spaces/:space/plugins*`,
all `space:admin`) are in [Plugins](./plugins.md#managing-plugins).

`DELETE /deployment/people/:subject/credentials` revokes every OAuth grant and token, personal
access token and setup credential a person (`subject`, their web user id) holds, in every space,
and answers `{ revokedTokens, revokedGrants }`. Only a deployment administrator (a wildcard
principal) may call it; the web app does when it ends a person's access (see
[Auth & RBAC](./auth-and-rbac.md#ending-a-persons-access)).

### Space config & content types

| Method | Path                               | Scope             | Description                        |
| ------ | ---------------------------------- | ----------------- | ---------------------------------- |
| GET    | `…/space-config`                   | `preview:read`    | Space settings for the environment, with `localeSettings` resolved per locale (`delivered`, `direction`) |
| PUT    | `…/locale-settings`                | `space:admin`     | `{ localeSettings: { <locale>: { delivered?, direction? } } }`: a locale not delivered is edited and previewed, never served by Delivery; the default locale is always delivered; answers the space config |
| GET    | `…/content-types`                  | `preview:read`    | List content types                 |
| POST   | `…/content-types`                  | `content:manage`  | Create/update content type; `singleton: true` holds one entry (`409` turning it on over several) |
| GET    | `…/content-types/entry-counts`     | `preview:read`    | Entries per type, by status        |
| GET    | `…/content-types/:apiId`           | `preview:read`    | Get one                            |
| GET    | `…/content-types/:apiId/fields/:field/values` | `preview:read` | Distinct values of a short scalar field (not `Text`) or list of Symbols across current entries, trash excluded, each with its entry `count`; booleans, numbers, strings ascending; `locale`, `limit` (≤ 100), `cursor` → `{ items, nextCursor? }`. 422 for any other field, 403 for a hidden one, `query_too_broad` when the type holds more entries than the scan cap (5,000) |
| POST   | `…/content-types/:apiId/published` | `content:publish` | Publish definition                 |
| GET    | `…/content-types/:apiId/dependents` | `preview:read`   | What blocks a delete: `{ entries: { live, trashed }, linkedFrom, menus, redirects, urlPattern? }`; `403` for a role without read on the type |
| DELETE | `…/content-types/:apiId`           | `content:manage`  | Delete (`{ deleted: true }`, emits `content_type.deleted`); `409` naming every dependent (`details.dependents`); `?purge_entries=true` (also `content:write` and `content:publish`, and a role on every type) → `202 { deleted: false, job }`, a `content_type_delete` bulk job that trashes and purges each entry, then deletes the type on `bulk.job_completed`; the job's `config.typeDeletion` (on `GET …/bulk/jobs/:id`) is then `{ deleted: true }` or `{ deleted: false, reason }` (also when the job is stopped) |
| POST   | `…/content-types/:apiId/clone`     | `content:manage`  | `{ apiId, name }` → the copy (`201`): fields, display field, singleton, group, description, icon, agent instructions, layout; not `urlPattern`; draft, version 1; `409` for a taken apiId, also when a concurrent clone or create took it after the check (the insert never overwrites) |

A content type may carry `urlPattern` (a path starting with `/` whose placeholders are `{id}`,
`{locale}` or its own `Slug` fields' apiIds, e.g. `/blog/{slug}`; `null` or `''` clears it; `422`
otherwise). When set, a publish that changes a slug it names writes a redirect (see
[Redirects](#redirects)).

Saving a content type that drops a blocks variant some entry still uses, or a field (at any depth)
some entry still holds a value for, answers `409 conflict` naming each `location: variant` or field
location and its entries (`details.variantsInUse`, `details.fieldsInUse`); see
[domain-model.md](domain-model.md#blocks).

#### Types from the live model

`GET …/content-types?format=typescript` returns the content model as a TypeScript module, one type
per content type in both the delivery (locale-flattened) and management (locale-keyed) shapes, plus
the apiId union and lookup maps. Same output as the codegen CLI, served from the model as it is right
now.

```bash
curl -H "Authorization: Bearer $CMA_KEY" \
  "$API/spaces/$SPACE/environments/main/content-types?format=typescript" > src/commerceworker.d.ts
```

The point is that CI and coding agents need nothing installed, and cannot type against a stale file:
the banner carries the space, environment and generation time, so a checked-in copy that has drifted
says so. `preview:read`, the same scope as listing content types, since it is the same information
in another shape.

MCP exposes it as `model_typescript`, returning the source as text rather than JSON: it is something
a caller pastes into a file, and wrapping it in a JSON string only makes it something to unescape.

### Entries: CRUD and publishing

| Method | Path                               | Scope             | Description                                                                                                    |
| ------ | ---------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `…/entries`                        | `content:write`   | Create draft `{ contentTypeApiId, fields }`                                                                    |
| GET    | `…/entries/:id`                    | `preview:read`    | Get current entry (RBAC-filtered fields)                                                                       |
| PUT    | `…/entries/:id`                    | `content:write`   | Save new draft version                                                                                         |
| POST   | `…/entries/validate`               | `content:write`   | Validate without saving `{ contentTypeApiId \| entryId, fields }`: a create's or an update's checks and errors, no write; `200 { valid, fields, skippedHooks }` |
| POST   | `…/entries/:id/published`          | `content:publish` | Publish                                                                                                        |
| DELETE | `…/entries/:id/published`          | `content:publish` | Unpublish                                                                                                      |
| GET    | `…/entries/:id/reverse-references` | `preview:read`    | Entries linking to this one                                                                                    |
| DELETE | `…/entries/:id`                    | `content:write`   | Move to the trash (unpublishes first if live; idempotent)                                                      |
| POST   | `…/entries/:id/restore`            | `content:write`   | Restore from the trash, as a draft                                                                             |
| DELETE | `…/entries/:id/permanent`          | `content:publish` | **Irreversible** delete of a trashed entry. `?force=true` overrides the inbound-link guard                     |
| GET    | `…/trash-settings`                 | `preview:read`    | `{ retentionDays }` (null: off, the default)                                                                   |
| PUT    | `…/trash-settings`                 | `space:admin`     | `{ retentionDays: 1..3650 \| null }`: the hourly `trash-retention` sweep purges entries trashed longer ago, in every environment of the space, never one a published entry links to |
| POST   | `…/entries/:id/duplicate`          | `content:write`   | Copy fields + taxonomy metadata into a new draft; a role needs read and write on the type, and the response is masked for it |
| POST   | `…/entries/:id/preview-link`       | `content:write`   | Mint a shareable preview link `{ ttlHours?, previewBaseUrl?, locale? }` (default 72 h); `201 { url, frontendUrl?, token, expiresAt }` (`frontendUrl`: the type's `preview.urlTemplate`, filled) |
| POST   | `…/embeds/resolve`                 | `content:write`   | Resolve a media URL `{ url }` into a rich-text `embed` node's data; `200 { embed, resolved }`                  |

**Held to a version.** Publish, unpublish and version restore take an optional
`?expectedVersion=N`: the entry's `currentVersion` as the caller read it. If someone has saved a
newer draft since, the call returns **409** and changes nothing, rather than publishing or
overwriting content the caller never saw. The MCP tools `entries_publish`, `entries_unpublish` and
`entries_restore_version` take the same `expectedVersion` argument.

**Publish gating.** When the latest published version of a workflow has `gatesPublish` on and a run
of it can publish (a `trigger.manual` trigger and a `content.publish` or `content.publish_release`
node; publishing a gated version that can't is refused with **422**), an entry of a content type it
covers (its `contentTypes`, or every type when empty) publishes only from a run of that workflow
(its `content.publish` or `content.publish_release` node). Every other publish is refused with
**409** `publish_gated`, for every caller including the admin token: the publish route and
`entries_publish`, bulk publish and bulk jobs (a failed item each, the rest publish), a release
holding such an entry (refused whole), and a scheduled publish (refused when created, and failed
when it fires if gating came on since). The body's `entries` names each refused entry and the
workflows whose runs may publish it. To publish directly, publish a version of the workflow with
`gatesPublish` off, or delete the workflow.

**Unique fields.** Creating or updating an entry whose `unique` field collides returns **409**
with a message naming the field, the value and the entry holding it. Trashing an entry frees its
unique values; restoring re-claims them and can therefore fail with 409 if the value was taken in
the meantime.

**The trash.** Deleting an entry is two deliberate steps. `DELETE …/entries/:id` archives it,
unpublishing first when it is live, so delivery stops serving it and the usual
`entry.unpublished` event clears the delivery cache and the entry's embeddings. Archived entries
are hidden from every list unless a request asks for them with `?trashed=true`, which is the trash
view. Only an archived entry can be permanently deleted, and that route needs `content:publish`
rather than `content:write` because it is the one entry action with no way back.

Permanent deletion is refused with **409** while _published_ entries still link to the target
(the message gives the count; the ids are not in the response, see [Error handling](#error-handling)).
Those are the links delivery resolves per request, so removing the target under them would break
live pages. Reference edges are recorded at publish
time, so a link from an unpublished draft does not block the delete.

**Embeds.** `POST …/embeds/resolve` (MCP `embed_resolve`) asks an allowed provider's oEmbed
endpoint (YouTube, Vimeo, X, Bluesky, Mastodon, Spotify, SoundCloud) about an https URL and
returns `{ embed, resolved }`: `embed` is the data of an `embed` rich-text node (`url`,
`provider`, `kind`, and when the provider answered `title`, `authorName`, `thumbnail`, `width`,
`height`, `aspectRatio`); the provider's player `html` is discarded. A URL that is not https, not
on an allowed provider, or whose oEmbed endpoint is not a public address is refused with **422**
before anything is fetched. A provider that errors, redirects, times out (5 s) or answers more than
64 KiB is not an error: `resolved` is `false` and `embed` holds the URL, provider and kind alone,
which is valid to store. See [Rich text](./domain-model.md#rich-text).

### Entries: AI and semantics

| Method | Path                         | Scope            | Description                                                                                                         |
| ------ | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| POST   | `…/entries/generate`         | `content:write`  | Generate draft fields from prompt                                                                                   |
| POST   | `…/entries/canvas`           | `content:write`  | Multi-field canvas generation                                                                                       |
| POST   | `…/entries/:id/translate`    | `content:write`  | Translate fields to locales                                                                                         |
| POST   | `…/entries/:id/summarize`    | `content:write`  | Summarize entry text                                                                                                |
| POST   | `…/entries/:id/autofill`     | `content:write`  | Fill empty fields                                                                                                   |
| POST   | `…/entries/:id/suggest-tags` | `content:write`  | Suggest taxonomy tags                                                                                               |
| POST   | `…/entries/:id/apply-tags`   | `content:write`  | Persist a reviewed tag suggestion                                                                                   |
| POST   | `…/entries/:id/audit`        | `content:write`  | AI content audit                                                                                                    |
| POST   | `…/entries/:id/moderate`     | `content:write`  | Run moderation agent                                                                                                |
| GET    | `…/entries/:id/related`      | `search:read`    | Semantically related entries                                                                                        |
| GET    | `…/entries/:id/duplicates`   | `search:read`    | Near-duplicate detection                                                                                            |
| GET    | `…/entries/:id/embedding`    | `search:read`    | Embedding vector metadata                                                                                           |
| GET    | `…/search/index`             | `content:manage` | Lexical index health for the environment (`?content_type`): indexed documents against published entries, as `drift` |
| POST   | `…/search/reindex`           | `content:manage` | Request a background reindex of published entries `{ contentTypeApiId? }` (`202`; `429` if requested too soon)      |

### Entries: versioning and bulk

| Method | Path                                      | Scope             | Description                                                                 |
| ------ | ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `…/entries/:id/versions`                  | `preview:read`    | Version list                                                                |
| GET    | `…/entries/:id/versions/diff`             | `preview:read`    | Readable diff (`hiddenChanges` counts changed fields the caller can't read; `?from`, `?to`: a version, `draft` or `published`)           |
| GET    | `…/entries/:id/versions/:version`         | `preview:read`    | Get specific version                                                        |
| GET    | `…/entries/:id/activity`                  | `space:admin`     | The entry's audit rows, newest first (`?limit`, `?cursor`): see [Audit log](#an-entrys-activity) |
| POST   | `…/entries/:id/versions/:version/restore` | `content:write`   | Restore version as new draft                                                |
| POST   | `…/bulk/entries`                          | `content:write`   | Bulk create/update                                                          |
| POST   | `…/bulk/entries/publish`                  | `content:publish` | Bulk publish                                                                |
| POST   | `…/bulk/entries/unpublish`                | `content:publish` | Bulk unpublish                                                              |
| POST   | `…/bulk/jobs`                             | `content:publish` | Start a durable bulk job `{ action: publish\|unpublish\|trash\|restore\|purge, entryIds }` (`202`); trash, restore and purge run each entry through its single-entry rules (purge only from the trash, never under a published link), refusals reported per entry, 50 entries per chunk and at most 100,000 ids a job; an entry already where the action puts it counts as succeeded (already trashed, already restored, and for `purge` already gone or never there), so a retried chunk reports the same totals. Start, report and cancel need a role holding the job's actions on every content type (no per-type grants, or one full `*` grant: see [Auth & RBAC](./auth-and-rbac.md)) |
| POST   | `…/bulk/jobs/set-fields`                  | `content:write`   | Start a bulk field edit `{ contentTypeApiId, entryIds, fields }` (`202`, a `set_fields` job): `fields` is field apiId → locale → value, `null` clearing a locale; only those change. Each entry is saved as a new draft with an edit's checks (validation, field rules, `entry:beforeSave` plugins, refused in the trash); a refusal or an entry in the trash is that entry's failure in the report, and a missing entry and one of another type both read `No "<type>" entry with this id`, and one already holding the values is left as it is. `422` before the job starts for an unknown field or locale, a locale on a field that isn't localized, or a value for a unique field (clearing one is allowed). The job, its progress and the job list carry the names of the fields it sets (`config.fieldNames`), never their values. Needs `write` on the type and on every field sent (not a role on every type); the report needs a role with no field rules on the type. At most 100,000 ids, 50 per chunk |
| GET    | `…/bulk/jobs`                             | `content:write`   | List jobs (`?limit`)                                                        |
| GET    | `…/bulk/jobs/:id`                         | `content:write`   | Job progress. A chained job (a snapshot import, a starter install) names the job it starts as `config.nextJobId`, never its plan (`config.next`) |
| GET    | `…/bulk/jobs/:id/report`                  | `content:write`   | Per-item failures                                                           |
| POST   | `…/bulk/jobs/:id/cancel`                  | `content:publish` | Cancel a job                                                                |

Reads of a job are `content:write` so that whoever can start an import can watch it. Starting,
reading the report of, or cancelling a job needs a role holding its actions on every content type
(`403` otherwise), because the report exposes entry ids across content types. An import job goes by
what it reached: `write` on the type of a CSV, JSON or WordPress job (its report also refused to a
role with field rules on that type), and `read` and `write` on every type for a snapshot, clone or
space export job.

### Entry metadata & taxonomy associations

| Method | Path                     | Scope           | Description              |
| ------ | ------------------------ | --------------- | ------------------------ |
| GET    | `…/entries/:id/metadata` | `preview:read`  | Tags + concepts on entry |
| PUT    | `…/entries/:id/metadata` | `content:write` | Set tags/concepts        |

### Manual order

| Method | Path                 | Scope           | Description |
| ------ | -------------------- | --------------- | ----------- |
| POST   | `…/entries/:id/move` | `content:write` | Move the entry in its type's manual order: `{ "after": id \| null }` (null: first) or `{ "before": id \| null }` (null: last), exactly one → `{ id, contentTypeApiId, position }`. Live: no version, status or `updatedAt` change, and Delivery serves a published entry's new place at once (`entry.moved`). Moving it where it already is writes nothing. `422` for an anchor that is the entry itself, of another type or in the trash; `400` `invalid_state` for an entry in the trash (it keeps its place for a restore); `409` when the order changed under three attempts. Needs `write` on the type; read the order with `order=sys.position` |

### Assets

| Method | Path                                     | Scope             | Description                                                                                                                                                                                                                                                                                    |
| ------ | ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `…/assets`                               | `preview:read`    | List assets: `kind`, `mime` (`image/*`), `tag`, `folder` (id or `root`), `status` (archived hidden unless `archived`/`all`), `sort` (`updatedAt`, `createdAt`, `size`), `order`, `limit`, `cursor` → `{ items, nextCursor? }`                                                                  |
| POST   | `…/assets`                               | `content:write`   | Create draft + presigned upload URL (optional `folderId`)                                                                                                                                                                                                                                      |
| GET    | `…/assets/search`                        | `preview:read`    | Hybrid search of the library (full text and semantic, fused by rank): `q` (1–256 characters), `kind`, `tag`, `folder` (id or `root`), `status` (archived hidden unless asked), `limit` (≤ 100) → `{ items, total, facets: { kind, tag, folder } }`, each facet counted without its own filter  |
| POST   | `…/assets/reindex`                       | `content:write`   | Send assets through ingest as an `asset_reindex` bulk job `{ all? }` (202 `{ assets, job? }`): those never ingested or whose ingest failed, or every asset with a file; while one runs, that job comes back with `running: true`; 501 without the ingest queue                                 |
| POST   | `…/assets/:id/reingest`                  | `content:write`   | Run ingest on the current file again (202, the asset as `pending`); does nothing while it is `pending` or `processing`; 400 for a hosted video; 501 without the ingest queue                                                                                                                   |
| POST   | `…/assets/move`                          | `content:write`   | `{ ids (≤ 500), folderId \| null }` → `{ moved }`; 404 for an unknown folder                                                                                                                                                                                                                   |
| GET    | `…/assets/:id`                           | `preview:read`    | Get asset                                                                                                                                                                                                                                                                                      |
| GET    | `…/asset-renditions`                     | `preview:read`    | The space's rendition presets `{ items }` (the same in every environment)                                                                                                                                                                                                                      |
| POST   | `…/asset-renditions`                     | `content:manage`  | Create `{ name, width?, height?, fit?, format?, quality? }` (201); 409 for a taken name; at most 20                                                                                                                                                                                            |
| GET    | `…/asset-renditions/:name`               | `preview:read`    | Get a preset                                                                                                                                                                                                                                                                                   |
| PUT    | `…/asset-renditions/:name`               | `content:manage`  | Replace what it does (its URLs stay; their cached files are purged)                                                                                                                                                                                                                            |
| DELETE | `…/asset-renditions/:name`               | `content:manage`  | Delete (204); its URLs answer 404 once purged                                                                                                                                                                                                                                                  |
| POST   | `…/assets/:id/archive`                   | `content:publish` | Archive (leaves Delivery when published); idempotent                                                                                                                                                                                                                                           |
| POST   | `…/assets/:id/restore`                   | `content:write`   | Restore an archived asset as a draft; idempotent                                                                                                                                                                                                                                               |
| DELETE | `…/assets/:id`                           | `content:publish` | Delete an archived asset permanently (204); `400 invalid_state` if not archived; `409 asset_in_use` with `error.usage` (first 50, titled) and `error.total` while linked                                                                                                                                                                              |
| GET    | `…/asset-folders`                        | `preview:read`    | List folders, in path order                                                                                                                                                                                                                                                                    |
| POST   | `…/asset-folders`                        | `content:write`   | Create `{ name, parentId? }` (201); 409 for a sibling of the same name                                                                                                                                                                                                                         |
| PATCH  | `…/asset-folders/:id`                    | `content:write`   | Rename and/or move `{ name?, parentId? \| null }`, subtree along                                                                                                                                                                                                                               |
| DELETE | `…/asset-folders/:id`                    | `content:write`   | Delete an empty folder (204); 409 when it holds subfolders or assets                                                                                                                                                                                                                           |
| PATCH  | `…/assets/:id/metadata`                  | `content:write`   | Update alt text / tags metadata                                                                                                                                                                                                                                                                |
| GET    | `…/assets/:id/usage`                     | `preview:read`    | Reference usage                                                                                                                                                                                                                                                                                |
| GET    | `…/assets/:id/transform`                 | `preview:read`    | Image transform URL (`w,h,fit,fm,q`; `fm=auto` → AVIF/WebP), signed from a fresh 15-minute read URL for the current file version                                                                                                                                                               |
| POST   | `…/assets/videos`                        | `content:write`   | Create a video asset + one-time direct upload to the video host (501 without one)                                                                                                                                                                                                              |
| POST   | `…/assets/:id/video/refresh`             | `content:write`   | Refresh a video asset's status, playback URLs and poster                                                                                                                                                                                                                                       |
| POST   | `…/assets/:id/alt-text`                  | `content:write`   | AI alt-text generation                                                                                                                                                                                                                                                                         |
| POST   | `…/assets/:id/auto-tag`                  | `content:write`   | AI auto-tagging                                                                                                                                                                                                                                                                                |
| POST   | `…/assets/:id/published`                 | `content:publish` | Publish asset; `409 asset_embargoed` (with `embargoUntil`) before the embargo lifts, `409 asset_expired` (with `expiresAt`) once its rights expired                                                                                                                                            |
| POST   | `…/assets/bulk`                          | `content:write`   | A resumable bulk job over a selection (202, the job): `{ action, ids, folderId? (move), addTags?, removeTags? (tag) }`; `move` and `tag` need `content:write`, `publish`, `unpublish` and `archive` need `content:publish`. Follow it at `…/bulk/jobs/:id`; the report names each failed asset |
| POST   | `…/assets/:id/file`                      | `content:write`   | Start replacing the file `{ fileName, contentType }` (201): `{ asset, upload, commit }`, a signed PUT for the next version, to a key of this start's own (`commit.attempt`); the URL stores once (a second PUT is 412)                                                                         |
| POST   | `…/assets/:id/file/uploads`              | `content:write`   | Start replacing the file in parts `{ fileName, contentType, size }` (201 `{ asset, version, upload }`): sign, PUT and complete at `…/assets/:id/uploads/:uploadId/…`, where completing commits the version (409, upload dropped, when another replace or restore took it first)                |
| POST   | `…/assets/:id/file/commit`               | `content:write`   | Commit the uploaded replacement (`commit` from the call above) → the asset at its new version; 422 when nothing was uploaded, 409 when another replace or restore committed first; Delivery keeps the published file until a republish                                                         |
| GET    | `…/assets/:id/versions`                  | `preview:read`    | Every file version, newest first `{ items }`: `version`, `file` (short-lived URL), `createdAt`, `createdBy`, `current`, `published`, `restoredFrom?`                                                                                                                                           |
| POST   | `…/assets/:id/versions/:version/restore` | `content:write`   | Make an earlier file current again as a new version (422 for the current one, 404 for one it never had)                                                                                                                                                                                        |
| PUT    | `…/assets/:id/rights`                    | `content:publish` | Replace the rights `{ license?, credit?, expiresAt?, embargoUntil? }` (`{}` clears; dates ISO-8601 with a zone; 422 on a bad value or an expiry before the embargo); on a published asset they apply at once, and an embargo is refused                                                        |
| DELETE | `…/assets/:id/published`                 | `content:publish` | Unpublish asset                                                                                                                                                                                                                                                                                |

Every asset these routes return carries a short-lived signed `file.url` (at least 15 minutes,
`?exp=…&sig=…`), never the non-expiring URL the asset stores; a hosted video keeps its playback
URL, and none carries the server's own storage key (`r2Key`). The MCP asset tools answer the same
way: every Management and MCP asset response goes through one serializer
(`packages/http/src/api/asset-response.ts`). The environment export (`GET …/export`,
`environment_export`) is the exception: it is a snapshot for `…/import` and clones, which copy
the files by their keys.

### Asset collections, share links, uploads and zips

Every route is under `/spaces/:space/environments/:env`.

| Method | Path                                      | Scope             | Notes                                                                                                                                                                                         |
| ------ | ----------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `…/asset-collections`                     | `preview:read`    | By name; `nextCursor`                                                                                                                                                                         |
| POST   | `…/asset-collections`                     | `content:write`   | `{ name (1–128), description? (≤ 1,000) }` (201)                                                                                                                                              |
| GET    | `…/asset-collections/:id`                 | `preview:read`    | One collection with its `itemCount`                                                                                                                                                           |
| PATCH  | `…/asset-collections/:id`                 | `content:write`   | `{ name?, description? }` (`""` clears the description)                                                                                                                                       |
| DELETE | `…/asset-collections/:id`                 | `content:write`   | 204; the assets stay, links shared to it stop opening                                                                                                                                         |
| GET    | `…/asset-collections/:id/assets`          | `preview:read`    | Members in order, filtered as the library list is (archived left out unless `status` asks); `nextCursor`                                                                                      |
| POST   | `…/asset-collections/:id/assets`          | `content:write`   | `{ assetIds }` (1–500) appended in the order given; `409` past 1,000 members, the whole add refused                                                                                           |
| POST   | `…/asset-collections/:id/assets/remove`   | `content:write`   | `{ assetIds }` (1–500); ids that are not members are ignored                                                                                                                                  |
| PUT    | `…/asset-collections/:id/order`           | `content:write`   | `{ assetIds }` (1–500) go first in that order, the rest follow as they were                                                                                                                   |
| GET    | `…/share-links`                           | `content:publish` | Newest first, with each link's `url`; active links only unless `includeInactive=true`                                                                                                         |
| POST   | `…/share-links`                           | `content:publish` | `{ targetType: asset \| collection, targetId, expiresAt (5 minutes to 90 days out), allowDownload?, password? (8–256) }` (201); `409` for an unpublished asset, `404` for an unknown target   |
| GET    | `…/share-links/:id`                       | `content:publish` | One link: `hasPassword`, `revokedAt?`, `url`                                                                                                                                                  |
| DELETE | `…/share-links/:id`                       | `content:publish` | Revoke; idempotent                                                                                                                                                                            |
| POST   | `…/assets/uploads`                        | `content:write`   | Start a multipart upload `{ fileName, contentType, size, title?, description?, folderId? }` (201 `{ asset, upload: { uploadId, partSize, partCount } }`); `422` past `ASSET_UPLOAD_MAX_BYTES` |
| POST   | `…/assets/:id/uploads/:uploadId/parts`    | `content:write`   | `{ partNumbers }` (≤ 100) → a signed `PUT` URL per part; sign again to retry                                                                                                                  |
| POST   | `…/assets/:id/uploads/:uploadId/complete` | `content:write`   | `{ parts: [{ partNumber, etag }] }`, parts `1..n` once each; ingest starts                                                                                                                    |
| DELETE | `…/assets/:id/uploads/:uploadId`          | `content:write`   | Abort (204); the empty draft is deleted                                                                                                                                                       |
| POST   | `…/asset-zips`                            | `preview:read`    | `{ assetIds (1–1,000) \| collectionId, name? }` (202, the job; 409 while three are pending or running in the environment; refused for a key with content grants)                              |
| GET    | `…/asset-zips`                            | `preview:read`    | The latest 50 jobs                                                                                                                                                                            |
| GET    | `…/asset-zips/:id`                        | `preview:read`    | Status, `partsDone` / `partCount`, `error?`, and once `completed` a `downloadUrl` valid for 15 minutes                                                                                        |

A collection is a named, ordered, many-to-many set of assets of one environment (up to 1,000
members; a change names at most 500 ids). Deleting an asset removes it from its collections and
announces each. **Share links** are published-only: an unpublished asset cannot be shared, and a
collection's page lists only its published members. The media origin serves a link at
`https://media.<domain>/s/<space>/<env>/<linkId>/<token>`: the token is a 128-bit HMAC checked
before any lookup; the page is HTML, or JSON with `?format=json` or `Accept: application/json`; a
file is at `…/f/<assetId>/<fileName>`, and `?download` is honoured only when the link has
`allowDownload`. The link is checked on every request: an expired one answers `410` at once, a
revoked one as soon as the media worker's database replica has the revoke. A password is asked for
through a form (`POST …/unlock`, limited to 10 a minute per link and address, and 10 a minute per
link from all addresses together, by `RATE_LIMIT_SHARE_UNLOCK`) and remembered in a cookie scoped to
the link's path for at most 12 hours and never past the expiry. The MCP tools are
`asset_collections_list`, `asset_collections_get`, `asset_collections_create`,
`asset_collections_update`, `asset_collections_delete`, `asset_collection_assets_list`,
`asset_collection_assets_add`, `asset_collection_assets_remove`, `asset_collection_reorder`,
`share_links_list`, `share_link_create`, `share_link_get`, `share_link_revoke`,
`asset_upload_start`, `asset_upload_parts`, `asset_upload_complete`, `asset_upload_abort`,
`asset_zip_create`, `asset_zip_get` and `asset_zips_list`, with the same scopes. See
[Architecture](./architecture.md#collections-share-links-multipart-uploads-and-zips).

### Releases

| Method | Path                             | Scope             | Description                                                                              |
| ------ | -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| GET    | `…/releases`                     | `preview:read`    | List releases, newest first, each with `itemCount` (its members, from one grouped count) |
| POST   | `…/releases`                     | `content:write`   | Create release                                                                           |
| GET    | `…/releases/:id`                 | `preview:read`    | Get release                                                                              |
| DELETE | `…/releases/:id`                 | `content:write`   | Delete draft release                                                                     |
| POST   | `…/releases/:id/items`           | `content:write`   | Add entity to release                                                                    |
| DELETE | `…/releases/:id/items/:entityId` | `content:write`   | Remove item                                                                              |
| POST   | `…/releases/:id/published`       | `content:publish` | Publish release bundle                                                                   |

### Scheduled actions

| Method | Path                      | Scope             | Description                      |
| ------ | ------------------------- | ----------------- | -------------------------------- |
| GET    | `…/scheduled-actions`     | `preview:read`    | List scheduled publish/unpublish |
| POST   | `…/scheduled-actions`     | `content:publish` | Schedule action                  |
| DELETE | `…/scheduled-actions/:id` | `content:publish` | Cancel scheduled action          |

### Agent schedules

Recurring agent jobs (cron-cadence workflow runs over newly-published entries); see
[AI, agents & search](./ai-agents-and-search.md#agent-schedules).

| Method | Path                    | Scope             | Description                                                                                 |
| ------ | ----------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| GET    | `…/agent-schedules`     | `preview:read`    | List recurring agent jobs                                                                   |
| POST   | `…/agent-schedules`     | `content:publish` | Create schedule `{ workflow, cron (5-field UTC), contentTypeApiId?, enabled?, autoApply? }` |
| PATCH  | `…/agent-schedules/:id` | `content:publish` | Update cron / enabled / autoApply / content-type filter                                     |
| DELETE | `…/agent-schedules/:id` | `content:publish` | Delete schedule                                                                             |

### Agent reviews

Human-in-the-loop decisions on agent proposals; see
[AI, agents & search](./ai-agents-and-search.md#human-in-the-loop-reviews).

| Method | Path                          | Scope           | Description                                                                 |
| ------ | ----------------------------- | --------------- | --------------------------------------------------------------------------- |
| GET    | `…/agent-reviews`             | `preview:read`  | List reviews (`?status=pending`, `?entryId=`)                               |
| POST   | `…/agent-reviews/:id/approve` | `content:write` | Approve: applies the proposal exactly once (or signals the durable watcher) |
| POST   | `…/agent-reviews/:id/reject`  | `content:write` | Reject: nothing is applied                                                  |

### Collaboration

| Method | Path                     | Scope           | Description                 |
| ------ | ------------------------ | --------------- | --------------------------- |
| GET    | `…/entries/:id/comments` | `preview:read`  | List comments               |
| POST   | `…/entries/:id/comments` | `content:write` | Add comment                 |
| DELETE | `…/comments/:id`         | `content:write` | Delete comment              |
| GET    | `…/entries/:id/tasks`    | `preview:read`  | List tasks                  |
| POST   | `…/entries/:id/tasks`    | `content:write` | Create task                 |
| PUT    | `…/tasks/:id`            | `content:write` | Update task status/assignee |
| DELETE | `…/tasks/:id`            | `content:write` | Delete task                 |

### Workflows

| Method | Path                                | Scope            | Description                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `…/workflows`                       | `preview:read`   | List workflows (legacy `steps` plus the draft `graph`, `latestVersion`), each with how its latest published version starts: `publishedTrigger` (`{ type, label }`) and `startsAlongside`, the ids of the other published workflows that start on the same trigger for an overlapping content type (none listed covers every type). Both are `null` until it is published |
| POST   | `…/workflows`                       | `content:manage` | Create: legacy `{ name, steps }` is converted and published as v1 (answers the workflow); `{ name, description?, contentTypes?, graph?, gatesPublish? }` creates an unpublished draft (answers `{ workflow, validation }`)                                                                                                                                               |
| GET    | `…/workflows/:id`                   | `preview:read`   | Get workflow                                                                                                                                                                                                                                                                                                                                                             |
| DELETE | `…/workflows/:id`                   | `content:manage` | Delete workflow (published versions are kept for pinned runs)                                                                                                                                                                                                                                                                                                            |
| PUT    | `…/workflows/:id/draft`             | `content:manage` | Save the draft `{ name?, description?, contentTypes?, graph?, gatesPublish? }`; omitted fields are kept. Answers `{ workflow, validation }`                                                                                                                                                                                                                              |
| POST   | `…/workflows/:id/versions`          | `content:manage` | Publish the draft as the next immutable version (422 while validation has errors); `publishedBy` is the caller                                                                                                                                                                                                                                                           |
| GET    | `…/workflows/:id/versions`          | `preview:read`   | Published versions, newest first                                                                                                                                                                                                                                                                                                                                         |
| GET    | `…/workflows/:id/versions/:version` | `preview:read`   | One published version with its graph                                                                                                                                                                                                                                                                                                                                     |
| POST   | `…/workflows/validate`              | `preview:read`   | Validate `{ graph }` without saving → `{ ok, errors, warnings }`                                                                                                                                                                                                                                                                                                         |
| POST   | `…/workflows/copilot`               | `content:manage` | Propose a graph from `{ prompt, graph?, contentTypes? }`. Read-only (never saves); answers `{ graph, explanation, errors, warnings, changes, summary, provenance }`                                                                                                                                                                                                      |
| GET    | `…/entries/:id/workflow`            | `preview:read`   | Entry workflow state (legacy steps)                                                                                                                                                                                                                                                                                                                                      |
| POST   | `…/entries/:id/workflow/transition` | `preview:read`   | Transition step (legacy; step scope enforced in use-case)                                                                                                                                                                                                                                                                                                                |

#### Workflow runs and tasks

Runs execute on durable workflows (`EDITORIAL_WF`, see [Architecture](./architecture.md#editorial-workflow-runs)).
Without that binding the run actions below answer **501** (`not_configured`); reads still work.
A run acts as whoever started it: every node is authorized as if they made the call. Run and task
reads also need `read` on the entry's content type (role-bound keys); lists leave out what the
caller can't read. A run never exposes its starter's resolved principal, only `startedBy.id`.

| Method | Path                            | Scope           | Description                                                                                                                                                                                                                         |
| ------ | ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `…/entries/:id/workflow-runs`   | `content:write` | Start a run `{ workflowId, version?, input?, vars? }` of a published `trigger.manual` workflow. One active run per workflow and entry (409)                                                                                         |
| GET    | `…/workflow-runs`               | `preview:read`  | List runs; `entryId`, `workflowId`, `status`, `limit` (≤ 200)                                                                                                                                                                       |
| GET    | `…/workflow-runs/:id`           | `preview:read`  | Run: status, plan, node detail, what it waits on                                                                                                                                                                                    |
| GET    | `…/workflow-runs/:id/timeline`  | `preview:read`  | Timeline, oldest first                                                                                                                                                                                                              |
| GET    | `…/workflow-runs/:id/node-runs` | `preview:read`  | Finished node runs (timing, output, who it ran as)                                                                                                                                                                                  |
| POST   | `…/workflow-runs/:id/cancel`    | `content:write` | Cancel `{ reason? }`: terminate, undo finished compensable steps newest first, close tasks → `{ ok, undone }`                                                                                                                       |
| POST   | `…/workflow-runs/:id/events`    | `content:write` | Deliver `{ event, payload? }` to the waiting `control.wait_event` node; an early event is held (`buffered: true`)                                                                                                                   |
| GET    | `…/workflow-tasks`              | `preview:read`  | Approvals, event waits and agent reviews; `status`, `runId`, `entryId`, `kind`, `limit`                                                                                                                                             |
| GET    | `…/workflow-tasks/:id`          | `preview:read`  | One task                                                                                                                                                                                                                            |
| POST   | `…/workflow-tasks/:id/decide`   | `preview:read`  | `{ decision: approved\|rejected, note? }`. Also needs the task's `requiredScope` (default `workflow:approve`) and content-type grant; with separation of duties the starter can't decide and an API token can't decide at all (403) |
| GET    | `…/approvals/count`             | `preview:read`  | `{ workflowTasks, agentReviews, total }`: what waits in Approvals, counted uncapped; items on content types the caller can't read are left out                                                                                      |
| GET    | `…/workflow-settings`           | `preview:read`  | `{ separateDuties }`                                                                                                                                                                                                                |
| PUT    | `…/workflow-settings`           | `space:admin`   | Set the space default for approvals that leave `separateDuties` unset                                                                                                                                                               |

### Taxonomy

| Method | Path                              | Scope            | Description                                                                                                        |
| ------ | --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `…/taxonomy/schemes`              | `preview:read`   | List concept schemes                                                                                               |
| POST   | `…/taxonomy/schemes`              | `content:manage` | Create scheme                                                                                                      |
| DELETE | `…/taxonomy/schemes/:id`          | `content:manage` | Delete scheme                                                                                                      |
| GET    | `…/taxonomy/concepts`             | `preview:read`   | List concepts (`?scheme`), each with `usage: { count, byContentType }`                                             |
| POST   | `…/taxonomy/concepts`             | `content:manage` | Create concept: `{ schemeId, prefLabel, broaderId?, slug?, description?, labels? }`                                |
| PATCH  | `…/taxonomy/concepts/:id`         | `content:manage` | Change `prefLabel`, `slug`, `description`, `labels`; only the keys sent                                            |
| PUT    | `…/taxonomy/concepts/:id/broader` | `content:manage` | Set broader concept                                                                                                |
| DELETE | `…/taxonomy/concepts/:id`         | `content:manage` | Delete concept (and its usage counts)                                                                              |
| GET    | `…/taxonomy/tags`                 | `preview:read`   | List tags, each with `usage: { count, byContentType }`                                                             |
| POST   | `…/taxonomy/tags`                 | `content:manage` | Create tag: `{ name, slug?, description?, labels? }`                                                               |
| PATCH  | `…/taxonomy/tags/:id`             | `content:manage` | Change `name`, `slug`, `description`, `labels`; only the keys sent                                                 |
| DELETE | `…/taxonomy/tags/:id`             | `content:manage` | Delete tag (and its usage counts)                                                                                  |
| POST   | `…/taxonomy/repair`               | `content:manage` | Recount published usage from the published entries and give a slug to any term without one → `{ slugsAssigned }` |

A term's **slug** is normalized like a Slug field (`a-z`, `0-9`, single hyphens, at most 200
characters) and unique among the environment's tags, or within a concept's scheme (a unique index in
the database). Omitted on create, it is made from the label and numbered past the taken ones
(`news`, `news-2`); a label with nothing slug-worthy gives `tag` / `concept`. A slug asked for that
another term holds is a `409`; one with no letter or digit a `422`. The slug never changes with the
label: an archive URL moves only when a client sends a new slug. **`labels`** maps locales of the
space to labels (another locale is a `422`) and is replaced whole; the default locale's entry sets
`name` / `prefLabel`, the term's own label, and an empty value drops that locale. Every create,
change and delete commits a `taxonomy.changed` event, which purges Delivery's cache for the scope.

**Usage counts** are published entries only: how many carry the term, per content type. The database
store keeps them in `taxonomy_usage`, in the same batch that writes or removes the published
snapshot (publish, republish with other tags, unpublish, trash, bulk and release publishes), so a
read sums a few rows and never writes. `POST …/taxonomy/repair` rebuilds them from the snapshots;
the engine runs the same repair daily (`taxonomy-repair`).

### Redirects

Redirects are delivery data: CommerceWorker serves no site, so a front end (or an edge worker in
front of it) applies them. Reads need `preview:read`, writes `content:manage`; every write checks
the whole set and answers `422` for a loop or a duplicate source (a chain is allowed). Model in
[Domain model](./domain-model.md#redirects).

| Method | Path                           | Scope            | Description                                                                                                                              |
| ------ | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `…/redirects`                  | `preview:read`   | List: `q` (substring of source, destination or note), `limit`, `cursor`                                                                  |
| POST   | `…/redirects`                  | `content:manage` | Create `{ source, destination, status?, locale?, enabled?, note? }` (`201`, `{ redirect, chains }`)                                      |
| GET    | `…/redirects/:id`              | `preview:read`   | Get one                                                                                                                                  |
| PATCH  | `…/redirects/:id`              | `content:manage` | Change any of those fields                                                                                                               |
| DELETE | `…/redirects/:id`              | `content:manage` | Delete                                                                                                                                   |
| GET    | `…/redirects/resolve`          | `preview:read`   | `?path=&locale=` → what Delivery answers (`{ redirect, status, location }`); `404` when nothing matches                                  |
| GET    | `…/redirects/analysis`         | `preview:read`   | `{ duplicates, loops, chains, count, max }`                                                                                              |
| GET    | `…/redirects/export`           | `preview:read`   | `text/csv`: `source,destination,status,locale,enabled,note`                                                                              |
| POST   | `…/redirects/import`           | `content:manage` | `{ format: 'csv' \| 'json', data, dryRun? }`: all or nothing, at most 1,000 rows; a row whose source and locale exist updates that redirect |
| POST   | `…/redirects/collapse-chains`  | `content:manage` | Point each chain's first redirect at where the chain ends → `{ updated }`                                                                |

Every write appends `redirects.changed`. MCP: `redirects_list`, `redirects_get`,
`redirects_create`, `redirects_update`, `redirects_delete`, `redirects_import`, `redirects_resolve`,
`redirects_analyze`, `redirects_collapse_chains`; `model_create_content_type` takes `urlPattern`.

### SEO and the sitemap

An entry's SEO metadata is its type's `Seo` field ([Domain model](./domain-model.md#seo-and-the-sitemap)):
it is also written with the entry's other fields (`PUT …/entries/:id`).

| Method | Path                    | Scope           | Description                                                                                                                                                                       |
| ------ | ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH  | `…/entries/:id/seo`     | `content:write` | Change one locale `{ locale?, title?, description?, canonicalUrl?, noindex?, ogImage? }` (left out keeps, `null` clears) → the entry view, a new draft; `422` without a `Seo` field. A role's field rules apply to the `Seo` field (`403` when it is read-only or denied) |
| GET    | `…/sitemap`             | `preview:read`  | What Delivery's `sitemap` serves: `from`, `limit` → `{ items, next }`                                                                                                              |

MCP: `entries_set_seo` (audited) and `sitemap_list` (`readOnlyHint`, not audited).

### Block patches

Key-addressed edits to an entry's blocks fields ([Domain model](./domain-model.md#blocks)), saved
as a new draft through the same save as `PUT …/entries/:id` (`patchEntryBlocks` in
`packages/application/src/block-patches.ts`).

| Method | Path                   | Scope           | Description                                                                                                                                                                                                                                                                                                              |
| ------ | ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `…/entries/:id/blocks` | `preview:read`  | The current draft's blocks fields as a tree: `field`, `locale` narrow it → `{ entryId, version, fields: { [field]: { [locale]: [{ key, type, name, label?, path, ambiguous?, children? }] } } }`. Fields the role may not read are left out                                                                                 |
| PATCH  | `…/entries/:id/blocks` | `content:write` | `{ expectedVersion, ops }` (1–100 ops, at most 64 KB) → `{ entry, fields, keys, inverse }`, a new draft. `409` when the entry is past `expectedVersion`; `422` with `op` and `field: ops[i]` on the first op that can't apply (nothing saved); `403` for an op on a field the role denies or makes read-only |
| POST   | `…/entries/blocks/validate` | `content:write` | `{ entryId, expectedVersion, ops }`: the patch's dry run, with the same checks and errors (`409`, `403`, `422`), then the result judged as a save judges it → `{ valid, contentTypeApiId, fields, applied, keys, skippedHooks }`. Nothing is written; keys minted for new blocks are this answer's only. The entry is named in the body, as `…/entries/validate` names it |

Each op names `field` (a top-level blocks field) and optionally `locale` (default: the default
locale):

- `insert { parent?: { key, slot }, before | after | index, block: { _type, … }, ref? }`: at the end
  when no place is given. Keys the block carries are kept unless the field already holds them;
  missing ones (its own and those of blocks inside it) are minted with `ctx.ids.newId()`.
- `update { key, set?, unset? }`: only the named fields of that block. A field that holds blocks
  is refused; its children change through the structural ops.
- `move { key, to: { parent?, before | after | index } }`: with its children; the place is judged
  without the block itself; never into itself or a block inside it.
- `remove { key }` with its children; `duplicate { key, ref? }` right after itself, fresh keys
  throughout.

Ops apply in order, each to the result of the ones before; a later op on the same field and locale
addresses a new block by its `ref`, and `keys` maps each ref to its key. Ref names are unique in a
patch, and an inserted block may not carry a `_key` equal to one. A slot's admitted types are
checked on insert and move. A `_key` held by two blocks of the field's tree (validation only
refuses a duplicate within one list, so a key can repeat at two depths) is refused as ambiguous,
and the outline marks it `ambiguous`. An op on a block inside a block with no `_key` is refused
(save the entry once to key it). `inverse` is the ops that undo the patch: send them with the new
`currentVersion`. It is `null` when an `entry:beforeSave` plugin changed the blocks the patch
wrote, since an undo built from the patch would not restore them. The result is validated as any
save is (field issues at `body[i].heading`).

Refusals are structured, the same on REST and MCP, so a client acts on them without reading the
message:

- A `422` issue for an op carries `op` (its index), `code` (`unknown_key`, `ambiguous_key`,
  `keyless_parent`, `type_not_allowed`, `into_itself`, `placed_by_itself`, `not_in_slot`,
  `key_taken`, `bad_locale`, … : `BLOCK_PATCH_ISSUE_CODES` in the domain) and, when it is about an
  existing block, `key` (that block's `_key`).
- A `422` field issue from the result's validation also carries `block: { key, type, path }`: the
  innermost keyed block its position falls in and the path inside it (`label`), since positions
  say nothing once blocks move.
- Field issues in fields the caller's role denies (a stored value someone else left failing a
  rule) are never listed: they fold into one issue after the others,
  `{ field: "", code: "hidden", hidden: n, message }`, that counts the fields without naming them.
- A `403` for a field carries `details`: `{ reason: "read_only", field }` for a field the role can
  read but not write, or `{ reason: "hidden", hidden: n }` counting fields it can't read (never
  named). A `403` with no details is the role refusing the entry itself.

MCP: `entry_blocks_patch` (audited), `entry_blocks_validate` and `entry_blocks_outline` (`readOnlyHint`, not audited). Coworker offers `entry_blocks_outline` and proposes `entry_blocks_patch`; its card shows the dry run's field diff and holds Confirm while the dry run refuses.

### Menus

Navigation menus are delivery data too: named trees of links a front end renders. A menu is live,
not versioned; Delivery resolves its entry links against published entries when it reads it. See
[Domain model](./domain-model.md#menus).

| Method | Path                     | Scope            | Notes                                                                                                                                           |
| ------ | ------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `…/menus`                | `preview:read`   | `{ items, total }`: every menu by handle, `{ id, handle, name, description?, itemCount, revision, updatedAt }`, no items                         |
| POST   | `…/menus`                | `content:manage` | Create `{ handle, name, description?, items? }` (`201`); `409` for a taken handle, `422` naming each bad item (`items[0].children[1].link`)      |
| GET    | `…/menus/:id`            | `preview:read`   | The menu with its item tree and `revision`                                                                                                      |
| GET    | `…/menus/:id/preview`    | `preview:read`   | `?locale=` → `{ menu, locale, items }`: each item's label, URL and `status` (`live`, `unpublished`, `missing`, `no_url`, `hidden`), nothing dropped |
| GET    | `…/menus/resolve/:handle` | `preview:read`   | `?locale=` → the menu exactly as Delivery serves it, with the caller's content grants; `404` for an unknown handle |
| PATCH  | `…/menus/:id`            | `content:manage` | Fields left out keep their value; `items` replaces the tree (given item ids kept); with `revision`, a menu saved since is `409`                  |
| POST   | `…/menus/:id/move`       | `content:manage` | `{ itemId, parentId (null: top level), index, revision? }` moves an item and its subtree; `422` under itself or past the depth, `404` unknown ids |
| DELETE | `…/menus/:id`            | `content:manage` | `?revision=` optional (`409` when stale)                                                                                                        |

A link to an entry that doesn't exist, to an entry whose type has no `urlPattern`, or to a term
that doesn't exist is refused (`422`); only links a save adds are checked, and an entry of a type
the caller's content grants don't cover counts as not existing. Grants apply to every read too: a
type the caller can't read is `hidden` in a preview and dropped when resolved, a denied display
field never becomes a label, and a denied slug field drops the item. Every write appends
`menus.changed`. MCP: `menus_list`, `menus_get`, `menus_preview`, `menus_resolve` (`preview:read`),
`menus_create`, `menus_update`, `menus_move_item`, `menus_delete` (`content:manage`).

### Saved views

A saved view is a named entries-list query (`filters`, a `where` tree, `order`, `search`) and the
columns to show, for one content type or (`contentTypeApiId: null`) every type. Views belong to
the space, not an environment: every environment lists the same views, and the path's environment
is only where a run lists entries and a new view's type and columns are checked. See
[Domain model](./domain-model.md#saved-views).

| Method | Path                        | Scope          | Notes                                                                                                                                                                       |
| ------ | --------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `…/saved-views`             | `preview:read` | `?content_type=` → `{ items, total }`: the space's shared views and the caller's personal ones, by name (that type's and the every-type ones)                               |
| POST   | `…/saved-views`             | `preview:read` | Create `{ name, contentTypeApiId?, visibility?, query?, columns? }` (`201`); `shared` also needs `content:manage` (`403`); `422` naming each bad part (`query.where.or[1]`) |
| GET    | `…/saved-views/:id`         | `preview:read` | The view; columns naming a field the caller's role hides are left out, and `createdBy` for a key not served author ids                                                                                                       |
| GET    | `…/saved-views/:id/entries` | `preview:read` | `?limit=&cursor=&locale=` → `{ view, items, total, nextCursor?, ignored?, typeMissing? }`: one page of the Preview list for the view's query, as the caller; `typeMissing: true` with no items where its type isn't in this environment |
| PATCH  | `…/saved-views/:id`         | `preview:read` | `name`, `visibility`, `query` (replaced whole), `columns` (`null`: the default); the type is fixed; with `revision`, a view saved since is `409`; only the creator can make a shared view `personal` (`422` otherwise) |
| DELETE | `…/saved-views/:id`         | `preview:read` | `?revision=` optional (`409` when stale)                                                                                                                                    |

`visibility` is `personal` (the default, the creator's alone; only a person has personal views, so
an API key's create without `visibility: "shared"` is a `422`) or `shared` (everyone in the space who
can read the view's type). Creating, changing, sharing, unsharing or deleting a shared view needs
`content:manage`, and only the person who created a shared view can stop sharing it: anyone else
gets a `422` and can save a copy, and a view a key created stays shared until it's deleted. A new
visibility must fit the caps below. A view is a `404` (on every route, never a `403`) to anyone but the owner of a
personal view, to a role that can't read its type, and to a role whose field rules hide a field its
query filters, sorts or (with `search`) searches; such a view is also left out of the list, and a
role can't save one either (`403`, as the same query would be on the Preview list). A run applies
the caller's grants and masks the caller's denied fields, whoever saved the view, so a shared view
never widens what anyone sees. The query is checked by the live query's validators, strictly: top
level filters get the `where` tree's checks too (`match` needs a needle, `in` lists at most 100
values), values are JSON scalars or lists of them, at most 4 component paths across filters and the
tree, at most 3 sort keys. Keys a newer client sends go in `query.extra` (at most 10, 2 KB of JSON):
kept verbatim, never applied, and named in a run's `ignored`. A key the query string or the admin's
list reads is a `422` there (a filter key, `where`, `order`, `query`, `limit`, `space`, …), so
`extra` can't come alive in a URL. `columns` are `sys.status`,
`sys.updatedAt` or the type's own top-level fields (a view over every type, `sys.*` only), at most
20; columns the caller's role hides aren't theirs to drop, and stay where they stood. `columns: null`
needs no content type, so it and every other change except naming columns (`422`) work on a view whose
type isn't in the environment. A person keeps at most 50 personal views in a space, and a space at most 100 shared views.
Writes are audited. MCP: `views_list`, `views_get`, `views_run`, `views_create`, `views_update`,
`views_delete`.

### Platform configuration

| Method | Path                   | Scope            | Description                         |
| ------ | ---------------------- | ---------------- | ----------------------------------- |
| GET    | `…/functions`          | `preview:read`   | List event-triggered HTTP functions |
| POST   | `…/functions`          | `content:manage` | Register function                   |
| DELETE | `…/functions/:id`      | `content:manage` | Delete function                     |
| GET    | `…/app-extensions`     | `preview:read`   | List admin iframe extensions        |
| POST   | `…/app-extensions`     | `content:manage` | Register extension                  |
| DELETE | `…/app-extensions/:id` | `content:manage` | Delete extension                    |
| GET    | `…/ai-actions`         | `preview:read`   | List AI action templates            |
| POST   | `…/ai-actions`         | `content:manage` | Create AI action                    |
| DELETE | `…/ai-actions/:id`     | `content:manage` | Delete AI action                    |
| POST   | `…/ai-actions/:id/run` | `content:write`  | Run AI action on an entry           |
| GET    | `…/agent-runs`         | `space:admin`    | List agent run audit records        |
| GET    | `…/agent-runs/usage`   | `space:admin`    | Token usage aggregates              |

### Webhooks

| Method | Path                        | Scope         | Description    |
| ------ | ---------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| GET    | `…/webhooks`                | `space:admin` | List webhooks  |
| POST   | `…/webhooks`                | `space:admin` | Create webhook |
| PUT    | `…/webhooks/:id`            | `space:admin` | Update webhook |
| DELETE | `…/webhooks/:id`            | `space:admin` | Delete webhook |
| GET    | `…/webhooks/:id/deliveries` | `space:admin` | Delivery log   |
| POST   | `…/webhooks/:id/test`       | `space:admin` | Queue a `webhook.test` delivery (202) |
| POST   | `…/webhooks/:id/deliveries/:deliveryId/resend` | `space:admin` | Resend a logged delivery's event, signed afresh (202; 409 once the event is past retention) |

A webhook is scoped to the path's environment, or to every environment with
`allEnvironments: true` in the create body; responses carry `environmentId` (`null` for
space-wide). Under an environment the routes see its webhooks and the space-wide ones, and another
environment's webhook is a 404. On update `allEnvironments: true` makes it space-wide, `false`
scopes it to the path's environment, and omitting it keeps the scope. Under an alias a new
webhook is space-wide and `allEnvironments: false` is a 422 on create and update (a webhook is never
pinned to an alias's current target). The MCP tools
`webhooks_list`, `webhook_create`, `webhook_update`, `webhook_delete` and `webhook_deliveries` do
the same ([Events & webhooks](./events-and-webhooks.md#webhooks)).

---

## Delivery API (CDA)

Base path: `/delivery/:space/:env`. Reads the denormalized **published** read model (through the key-value
delivery cache when `KV_CACHE` is bound; up to ~60 s cross-location staleness after a publish). List/get responses apply granular RBAC when the key is role-bound.

| Method   | Path                                         | Scope           | Description                                                                                                                                                                                                                                                                                                                   |
| -------- | ----------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | `/delivery/:space/:env/entries`              | `delivery:read` | List published entries                                                                                                                                                                                                                                                                                                        |
| GET      | `/delivery/:space/:env/entries/:id`          | `delivery:read` | Get one published entry                                                                                                                                                                                                                                                                                                       |
| GET      | `/delivery/:space/:env/assets`               | `delivery:read` | List published assets: `limit`, `cursor` (or `skip`), `kind`, `tag`, `folder` (id or `root`), `locale` → `{ items, total, nextCursor? }`. With `q`, a hybrid search of published assets only (needs `search:read` too, else 403) → `{ items, total, facets }`; a content-granted key gets an empty result with empty `facets` |
| GET      | `/delivery/:space/:env/assets/:id`           | `delivery:read` | Get one published asset (`locale`)                                                                                                                                                                                                                                                                                            |
| GET      | `/delivery/:space/:env/collections/:id`      | `delivery:read` | A collection's name and its **published** members in the collection's order, in the delivered asset shape (`limit`, `cursor`, `locale`; `nextCursor?`); 403 for a key with content grants. Cached under the scope's tag, purged by `asset_collection.changed` |
| GET      | `/delivery/:space/:env/taxonomy/tags`        | `delivery:read` | Every tag, by slug: `{ items: [{ id, slug, label, labels?, description, count, countsByContentType }] }` (`locale`, `content_type`) |
| GET      | `/delivery/:space/:env/taxonomy/tags/:slug`  | `delivery:read` | One tag by slug (404 when none has it)                                                                                                         |
| GET      | `/delivery/:space/:env/taxonomy/concepts`    | `delivery:read` | Every concept, by slug, with `schemeId` and `broaderId` too (`scheme`, `locale`, `content_type`)                                              |
| GET      | `/delivery/:space/:env/taxonomy/concepts/:slug` | `delivery:read` | One concept by slug; `409` when two schemes share it and `scheme` is not given                                                              |
| GET      | `/delivery/:space/:env/redirects`            | `delivery:read` | The environment's **enabled** redirects → `{ items, total }`, each `{ id, source, destination, status, locale? }`; cached under the scope's tag, purged by `redirects.changed` |
| GET      | `/delivery/:space/:env/redirects/resolve`    | `delivery:read` | `?path=&locale=` → `{ redirect, status, location }`, or `404`. One request per path: to redirect every request, fetch the set once |
| GET      | `/delivery/:space/:env/menus`                | `delivery:read` | Every menu → `{ items, total }`, each `{ handle, name, description? }`, by handle (`listDeliveredMenus`, one statement) |
| GET      | `/delivery/:space/:env/menus/:handle`        | `delivery:read` | One menu resolved for `?locale=` (default: the space's default, with its fallbacks) → `{ handle, name, description?, locale, items }`, each item `{ id, label, url, target?, attrs?, entry?, term?, children }`. Entry links resolve to the published entry's path from its published type's `urlPattern`; an item that doesn't resolve (unpublished, deleted, no URL in the locale, a type the key can't read) is dropped and its children lifted. `404` for an unknown handle. One round trip (`DeliveryReadRequest.menu`: the menu, and its linked published entries, tags and concepts through `json_tree` over its own row); cached under the scope's tag, purged by `menus.changed` and the entry publish events |
| GET      | `/delivery/:space/:env/singletons/:apiId`    | `delivery:read` | A singleton type's published entry, in the shape of `…/entries/:id`, with `locale` and `include`; `404` when the type's published revision is not a singleton (a draft turning the flag on or off counts from its publish) or its entry is unpublished. One round trip for the type row and its entry (`DeliveryReadRequest.singleton`), plus one per include level (`getDeliveredSingleton`); a key without the type gets `403`. GraphQL: the singleton type's root without `id`. MCP: `singleton_get` with `published: true` |
| GET      | `/delivery/:space/:env/routes`               | `delivery:read` | Site routes: every **published** content type with a `urlPattern`, as last published (a draft revision changes nothing here until it is published) → `{ items, total }`, each `{ contentType, urlPattern }`, sorted by `contentType`; a key with content grants sees only the types it may read. One statement through `DeliveryReads` (`listDeliveredRoutes`); cached under the scope's tag, purged by `content_type.published`. MCP: `model_list_content_types` returns each type's `urlPattern` and `status` |
| GET      | `/delivery/:space/:env/sitemap`              | `delivery:read` | A page of the sitemap: published entries of every published type with a `urlPattern`, by entry id → `{ items, next }`, each `{ entryId, contentType, lastmod, urls: [{ path, locale }] }`; `noindex` entries and entries canonical elsewhere left out. `from` (a previous `next`), `limit` (1–5000, default 1000), `base` (the site's URL, to judge absolute canonicals). Content grants apply as for `routes`. Two round trips (`listDeliveredSitemap`); cached under the scope's tag, purged by any publish, unpublish or `content_type.published` |
| GET      | `/delivery/:space/:env/sitemap.xml`          | `delivery:read` | `application/xml` for crawlers: a sitemaps.org `urlset` of `base` + path with `lastmod` and `hreflang` alternates, or past one file an index of `<base>/sitemap.xml?page=<token>` (each page's range of entry ids). `base` (an absolute `http(s)` URL, path prefix kept) is required (`422` otherwise); `page` serves one page. A site proxies its own `/sitemap.xml` here with the query string |
| GET      | `/delivery/:space/:env/search`               | `search:read`   | Search, **hybrid by default**                                                                                                                                                                                                                                                                                                 |
| GET      | `/delivery/:space/:env/live`                 | `delivery:read` | **SSE** Live Content stream                                                                                                                                                                                                                                                                                                   |
| GET      | `/delivery/:space/:env/assets/:id/transform` | `delivery:read` | Deprecated: `301` to the media URL of the next width step at or above `w`, or `rendition` (cached); `302` to a signed transform when no media origin is set                                                                                                                                                                   |
| GET/POST | `/delivery/:space/:env/graphql`              | `delivery:read` | GraphQL Delivery endpoint                                                                                                                                                                                                                                                                                                     |

**Common query parameters:** shared [query language](#shared-query-language) plus `locale`,
`include` (reference depth 0–5), `limit`, `skip`, `since` (delta sync).

**Search parameters:** `q` (required), `top_k`, `mode` = `hybrid` (default) | `semantic` |
`lexical`.

**Taxonomy for archive pages.** The taxonomy reads serve each term's `label` in `?locale=` (its own
label in that locale, then its fallbacks', ending at the default locale's), or without `locale` the
default label plus `labels` for every locale. `count` is how many **published** entries carry the
term (of `content_type` only, when given) and `countsByContentType` the same per type; a key with
content grants counts only the types it may read. Each read is one database round trip (the space
config, the terms and their counts in one batch) and is cached under the scope's tag like every
delivery read, purged by a publish or a `taxonomy.changed`. Entries filter by term with
`metadata.tags` / `metadata.concepts` (ids) or `metadata.tags.slug` / `metadata.concepts.slug`
(slugs, `eq`, `ne`, `in`, `nin`): `GET …/entries?content_type=article&metadata.tags.slug=news`. A
slug filter resolves the slugs to ids in the same round trip as the space config; a slug no term has
matches nothing. Membership (`eq`, `in`) is pushed into SQL, so a tag archive scans only the entries
carrying the tag.

A delivered entry is `{ id, contentType, fields, publishedAt }`; with `?locale=` fields flatten to
that locale; with `?include=N` linked entries embed up to depth N (cycle-guarded). Links are
resolved wherever they sit: `Link` and array fields, `Component` values and blocks, and rich-text reference
nodes, whose `data.target` is replaced by the embedded entry or asset. An unpublished, missing or
cyclic target stays a `{ id, linkType }` stub.

A delivered asset, on its own or embedded, is one shape (`deliveredAsset`,
`packages/domain/src/asset/delivered.ts`): `{ id, title, description, altText, focalPoint,
contentType, size, width, height, kind, url, renditions, srcset, placeholder, video?, rights?, file }`.
`title`, `description` and `altText` flatten to `?locale` (with the space's fallbacks), else stay
per locale. `url`, `renditions` (`{ name: url }`) and `srcset` (`[{ width, url }]`, the ladder
320–2560 up to the image's own width) are built at read time on `MEDIA_PUBLIC_URL`; `file` is kept
for existing readers with `file.url` = `url`. `placeholder` is `{ thumbhash, dominantColor }`
(ThumbHash in base64, `#rrggbb`) for a raster image ingest has processed, else `null` (hosted
videos, other kinds, assets ingested before it existed: nothing is backfilled); the Management
`asset.file.placeholder` is the same pair, optional. `rights` carries only `credit` and `license`. A key
with content grants reads no assets (lists are empty, gets are 403, embeds stay stubs).

### GraphQL Delivery

`ALL /delivery/:space/:env/graphql` serves a schema **generated from Delivery's published view of the
content types** by `@commerceworker/graphql-gen`. Cached per `(space, environment)` keyed on a digest
of what shapes it (each visible type's id, fields and singleton flag in that view), so a draft of a
live type rebuilds nothing, and a merge or promotion that publishes other fields at a version already
served does.

- A live type is in the schema as last published: a draft revision's fields arrive with its publish.
- A type that was **never published** is in the schema as it stands, draft or not, and its published
  entries resolve, so queries that worked keep working. The same goes for a type left as a draft
  before definitions were kept (0030), until its next publish.
- Publishing an entry doesn't wait for its type: a value for a field only a draft has is served by
  REST at once (entries are delivered as stored), and GraphQL has no such field until the type is
  published. The same goes for a field whose type a draft changes: with `rating` an `Integer` as
  published and a `Symbol` in a draft, an entry published with `rating: "great"` is served by REST as
  it is, and GraphQL answers that field `null` with `Int cannot represent non-integer value` until the
  type is published (`publishing.ts` works from the current definition; the schema is the published
  one).
- A publish that changes a field's type changes its GraphQL type at that moment: a published value
  the new type can't represent is `null` with an error on that field.

- Query via `?query=` (GET) or JSON body `{ query, variables?, operationName? }` (POST).
- Resolvers call the same use-cases as REST with locale flattening and link resolution
  (`deliveryGraphResolvers` in `@commerceworker/application`, built per request with the caller's
  principal). A request reads the space config and content types once, with the schema, and
  reuses them in every field; each step's independent reads (an entry, one include level's links,
  an asset with its renditions) go to the database together, one round trip.
- `asset(id, locale)` is a typed `Asset`: `title`, `description` and `altText` each take
  `locale` (falling back to the query's, then the space default); `url(rendition, width)` picks a
  rendition or the width step at or above `width`; `srcset { width url }`, `renditions`,
  `placeholder { thumbhash dominantColor }` (type `AssetPlaceholder`, nullable),
  `focalPoint { x y }`, `video { status hlsUrl dashUrl thumbnailUrl durationSeconds }`,
  `rights { credit license }`, `file`.
- A list of scalars is a GraphQL list of that scalar: `[String]` for `Symbol`, `Text` and `Date`,
  `[Int]` for `Integer`, `[Float]` for `Number`. A list of links or components stays `JSON`.
  **Breaking (schema):** a list of `Symbol` values was `JSON` before; client types generated from
  the schema change from a JSON scalar to `[String]`.

### Live Content (SSE)

`GET /delivery/:space/:env/live` opens a Server-Sent Events stream. The route authorizes like any
Delivery route, then hands the connection to the `LiveHubDO` stateful edge object for that
space/environment (named by `liveHubName`, each id percent-encoded so no id can reach another
scope's hub), stamping the request with the authorized scope and the principal's content grants
(`x-cw-live-access`; the object refuses a request without it, and sends a subscriber only events
of its stamped scope). A stream ends after `LIVE_STREAM_MAX_MS` (10 minutes) so the client
reconnects and is authorized again: a revoked key or narrowed role stops receiving within that
bound. After the queue consumer
dispatches a domain event, it publishes the event to that object, which sends each connected
client only what `liveEventFor` (`packages/application/src/delivery.ts`) allows, filtered by
`?types=`:

- Published-content facts only (`LIVE_EVENT_TYPES`): entry, asset, bulk-publish, content-type,
  release and alias events. Workflow runs and tasks, bulk-job control and reindex requests never
  reach a subscriber.
- A key with content grants sees entries only of the types it may read, with its denied fields
  masked, content-type publishes for those types and alias changes, and no asset, bulk or release
  facts: the same rules as its REST reads.

Without a `LIVE_HUB` binding the in-process stream applies the same rules. Use it for real-time
cache invalidation or live previews on the read side.

---

## Preview API (CPA)

Base path: `/preview/:space/:env`. Reads **draft/current** versions. Supports the same
[query language](#shared-query-language) as Delivery. Granular RBAC applies on list/get.

| Method | Path                               | Scope          | Description                                                                                                                   |
| ------ | ---------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/preview/:space/:env/entries`     | `preview:read` | One page of current entries, each with `updatedAt`: `limit` (≤ 100), `cursor` → `{ items, total, nextCursor? }`                |
| GET    | `/preview/:space/:env/entries/:id` | `preview:read` | Get one current entry                                                                                                         |
| GET    | `/preview/:space/:env/singletons/:apiId` | `preview:read` | A singleton type's entry as it is now (a draft included), `locale`; `404` when it is not a singleton or has no entry outside the trash. MCP: `singleton_get` |
| GET    | `/preview/:space/:env/suggest`     | `preview:read` | Entries matching what is being typed                                                                                          |
| GET    | `/preview/:space/:env/assets`      | `preview:read` | Current assets (drafts included, archived left out) in Delivery's shape: `limit`, `cursor`, `kind`, `tag`, `folder`, `locale` |
| GET    | `/preview/:space/:env/assets/:id`  | `preview:read` | One current asset in Delivery's shape                                                                                         |

The entries list pages with a **keyset cursor**, not `skip` (refused with `422`): pass the
response's `nextCursor` back as `cursor`, with the same filters, search and `order`, until there is
none. It walks the list's own order (`order`, or least recently changed first, `sys.updatedAt`
ascending), ties broken by entry id. In the default order an entry edited between two pages is
never skipped; under another order, an edit to a sorted field can move an entry across the
cursor. A cursor from another order is refused (`422`). A role limited to some content types
pages over those types only, so every page is full and no cursor points at an entry it can't
read. `sys.updatedAt` sorts and filters like any `sys.*` field, and so does authorship: each
entry carries `createdAt`, `createdBy`, `updatedBy` and `firstPublishedAt` (null when unknown), and
`sys.createdBy=me` lists the caller's own. `me` is the caller's actor id: a person's own subject,
`admin-token`, or for an API key its kind (`cma`), so `me` from one CMA key also matches entries
any other CMA key wrote. `createdBy` and `updatedBy` go only to teammates and keys holding a
management scope (`content:write`, `content:publish`, `content:manage` or `space:admin`): a preview
key or preview token gets each entry without them (here, in `GET …/entries/:id`, in version
history, whose `createdBy` it also drops, and in the MCP trash listing), and a filter or `order`
on `sys.createdBy` or `sys.updatedBy` from one, anywhere in `where` too, is
`400 author_ids_not_served`. The MCP tool `entries_query` is the same read, paged the same way,
under the same rule.

Preview's asset URLs (original, renditions and srcset) are all signed and expire together (at
least 15 minutes), on the media origin when one is set. The MCP tools `asset_preview_list` and
`asset_preview_get` are the same reads, with the same scope; a key with content grants gets an
empty list and a refused get on both surfaces.

### Finding an entry by name

`GET /preview/:space/:env/suggest?q=…` returns entries whose display field matches what someone is
typing: `{ id, title, contentType, status }`, what a chooser renders, not whole entries.

| Parameter      | Meaning                                                            |
| -------------- | ------------------------------------------------------------------ |
| `q`            | What has been typed so far. Empty returns recent entries           |
| `content_type` | Restrict to one type, which is what a reference field always wants |
| `locale`       | Locale the title resolves in                                       |
| `limit`        | Default 20, capped at 50                                           |

This exists because a chooser cannot be built by listing entries and filtering in the browser. The
list endpoint is capped at 100, so on a space with more entries than that, the ones past the cap are
not slow to find; they are **impossible to pick**. Matching where the data is turns a silent ceiling
into an ordinary query.

Each content type is matched on **its own** display field, so a type that displays `name` is found by
name rather than missed. Trashed entries are excluded: offering one as a link target would create a
reference to content somebody deleted. Content-type grants apply, so a chooser cannot reveal types
the caller cannot read.

Cross-type search over every field is a different question; `/delivery/:space/:env/search` answers it.

MCP exposes this as `entries_suggest`, the tool an agent needs to turn a name it was given into an
id it can use.

---

## Reading the spec

`GET /openapi.json` is generated from the routes actually mounted, so it reflects this deployment's
`ROLE` rather than a checked-in file that can drift.

Operations documented with a request body take their schema from the _same_ zod schema the handler
parses with, so the document cannot describe something the route would reject. Bodies are rendered
from the schema's **input** side: a field with a default is optional to send, which is what a client
needs to know, even though the handler always sees it.

Coverage is partial. Routes registered with a `doc(...)` annotation carry a summary, a tag and, for
writes, a request-body schema. Every other mounted route is added by route introspection
(`addUndescribedRoutes`) with its path, method and path parameters only: no description, no
accepted body, no response shape. Closing that gap means annotating those routes, not extending
the mechanism.

## Error handling

The `onError` middleware (`toHttpError`, `packages/http/src/api/http.ts`) maps errors to HTTP
responses. The body is `{ "error": { "code", "message", ... } }`, except for the two guards that
run before routing (the last two rows).

| Error                                                                | Status     | `error.code`        | Body extras                                     |
| -------------------------------------------------------------------- | ---------- | ------------------- | ----------------------------------------------- |
| `NotFoundError`                                                      | 404        | `not_found`         |                                                 |
| `ValidationError`                                                    | 422        | `validation_failed` | `issues` (the `FieldIssue[]`)                   |
| `HookRejectedError`                                                  | 422        | `hook_rejected`     |                                                 |
| `ConflictError`, `TransactionConflictError`                          | 409        | `conflict`          | `details`, when the conflict carries them       |
| `LastAdminError`                                                     | 409        | `last_admin`        |                                                 |
| `PublishGatedError`                                                  | 409        | `publish_gated`     | `entries`: each `entryId` and its `workflows`   |
| `DomainError` code `unauthorized`                                    | 401        | `unauthorized`      |                                                 |
| `DomainError` code `forbidden`                                       | 403        | `forbidden`         |                                                 |
| `RateLimitedError`                                                   | 429        | `rate_limited`      |                                                 |
| `NotConfiguredError`                                                 | 501        | `not_configured`    |                                                 |
| `SecretUnreadableError`                                              | 500        | `secret_unreadable` |                                                 |
| other `DomainError` (`InvalidStateError`, `QueryTooBroadError`, ...) | 400        | its code            |                                                 |
| Hono `HTTPException`                                                 | its status | `http_error`        |                                                 |
| anything else                                                        | 500        | `internal`          | generic message                                 |
| Request body over `MAX_BODY_BYTES`                                   | 413        | `payload_too_large` | **no `error` wrapper**: `{ "code", "message" }` |
| Request-rate middleware (`RATE_LIMIT_*_PER_WINDOW` above 0)          | 429        | `rate_limited`      | **no `error` wrapper**; `Retry-After` header    |

MCP tools use the same mapping (`toHttpError`): a tool that fails with anything REST would answer
with `internal` (a database or binding error) reports only `Internal server error`, and refusals
(not found, forbidden, invalid, conflict, not configured) keep their own words.

Only `issues` (and a `PublishGatedError`'s `entries`) is carried over from a domain error's
`details`; `errBody` keeps `code` and `message` alone. So the `409` for a permanent delete blocked
by inbound links says how many published entries link to the target in its `message`, but the
`referencedBy` ids that `purgeEntry` attaches never reach the client, and a `RateLimitedError`'s
`retryAfterSeconds` is dropped (a `429` from the request-rate middleware is a separate response and
does send `Retry-After`). Both are gaps in `toHttpError`, not intended behaviour.

## Documentation (Guides)

The product's own documentation, served over the API so an agent can look up conventions with
the token it already holds. Requires **any valid token**: there is no space in the path and
nothing tenant-specific in a response, and is distinct from `/docs`, which serves the
generated OpenAPI browser.

| Method | Path             | Returns                                                         |
| ------ | ---------------- | --------------------------------------------------------------- |
| `GET`  | `/guides`        | Every page with its headings and size                           |
| `GET`  | `/guides/:path`  | One page as Markdown; `?section=<heading-slug>` for one section |
| `GET`  | `/guides/search` | `?q=` full-text search; optional `?path=` and `?limit=`         |

Search requires **every** term on the same line, and each match names the page, the nearest
heading above it, and the line number, so a hit can be followed with a section read rather
than pulling tens of KB into context. `?section=` returns a heading down to the next one of
the same or shallower depth.

The same three are exposed as the `docs_list`, `docs_read`, and `docs_search` MCP tools.

Pages are embedded into the build rather than read from disk: the endpoints have to answer
identically from an edge worker, which has no filesystem, and from a container image that
may not have shipped the Markdown. A test fails if the embedded copy drifts from `docs/`.


## Notes

- All write bodies are JSON; set `Content-Type: application/json`.
- Field values are always locale-keyed maps, e.g. `"fields": { "title": { "en-US": "Hello" } }`,
  even for non-localized fields (use the default locale).
- The same operations are exposed as **MCP tools** for AI agents; see
  [AI, agents & search](./ai-agents-and-search.md).
- The [Admin UI](./admin-ui.md) is a browser client of these Management endpoints.
