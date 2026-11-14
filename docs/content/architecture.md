# Architecture

CommerceWorker is a **ports & adapters (hexagonal)** monorepo that runs entirely at the edge.
An edge SQL database is the system of record; edge workers, queues, a key-value cache, object
storage, stateful edge objects, durable workflows, a vector index, edge inference (through an AI
gateway), edge image transforms, video streaming, edge email and plugin isolates do the rest.
The guiding constraint is the **dependency rule**: dependencies point inward, toward the domain,
and infrastructure is bound only at the edges.

```
   apps/studio ─────(API service binding, signed x-cw-principal)────▶ apps/api
   apps/delivery (public CDA, cached)                             apps/pipeline (queues, cron, stateful objects, workflows)
   apps/media (published asset files and share links, cached; key-value gate written by the engine)
        │                                                              │
        └──────────────┬───────────────────────────────────────────────┘
                       │ thin composition entries over
                       ▼
     @commerceworker/http (Hono surface)    @commerceworker/platform (env, config, wireEdge, stateful objects, workflows)
                       │                                   │ binds
                       ▼                                   ▼
          @commerceworker/application  ◀── implements ── @commerceworker/adapters (edge platform, one subpath each)
          (use-cases over ports)                         @commerceworker/store (SQL ContentStore)
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
   @commerceworker/domain   @commerceworker/ports
   (depends on nothing)    (interfaces only)
```

## Edge workers, split by traffic profile

Each deployment runs five edge workers (plus the docs site on CommerceWorker's own deployment). They
are split by how their traffic behaves, so each has its own CPU limit, placement, sampling rate
and failure blast radius. `AGENTS.md` lists each worker's role; this table adds where it is
served and how it is configured. Routes are rendered per deployment by `scripts/fleet.ts`
(`hosts()`): the admin at `<domain>`, the api at `api.<domain>`, delivery at `cdn.<domain>`,
media at `media.<domain>`.

| Edge worker     | Route            | Config highlights (`apps/*/wrangler.jsonc`)                                                                                           |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio`      | `<domain>`       | `cpu_ms` 5000; binds `DB` (auth tables), `API` and `DELIVERY` (service bindings to the api and delivery), `EMAIL` when the deployment sends email |
| `apps/api`      | `api.<domain>`   | Placement near the database, `cpu_ms` 5000; `ROLE=management,preview,delivery`; binds engine stateful objects and workflows by script |
| `apps/delivery` | `cdn.<domain>`   | No placement near the database, `cpu_ms` 2000, head sampling 0.05, the edge cache on the `Delivery` entrypoint                        |
| `apps/media`    | `media.<domain>` | No placement near the database, `cpu_ms` 1000, head sampling 0.01, the edge cache on the `Media` entrypoint                           |
| `apps/pipeline`   | none             | Placement near the database, `cpu_ms` 30000; owns stateful-object migrations                                                          |
| `apps/docs`     | docs host        | Deployed only by the deployment with `docs: true`                                                                                     |

### apps/studio: the admin and the gateway

`apps/studio/workers/app.ts` answers `/health` and `/health/deep` (its database plus the api's
`/health` over the binding), forwards the api's surfaces, serves SCIM, refuses cross-origin
state-changing requests, and otherwise renders React Router.

The gateway (`apps/studio/app/lib/gateway.server.ts`) forwards these paths to the api over the
`API` service binding, so the admin, REST, GraphQL, MCP, OAuth and the API docs share one
origin: `/spaces`, `/spaces/*`, `/preview/*`, `/delivery/*`, `/oauth/*`,
`/.well-known/oauth-*`, `/media/*`, `/mcp`, `/openapi.json`, `/docs`, `/docs/*`, `/guides*`,
`/agents/*` (the assistant's WebSocket and its message history), `/health/api`, `/auth/me`.
Credentials never cross the binding as the browser sent them:

1. A request with `Authorization: Bearer …` (API key, personal access token, OAuth token) goes
   through unchanged except that any caller-supplied `x-cw-principal` and cookies are removed. A
   bearer `/delivery/*` call goes to the delivery worker over the `DELIVERY` binding instead, so it
   gets the same gateway, cache, ETag and purge as on the `cdn.` host.
2. Otherwise a same-origin request with a live web session has its cookies removed and a signed
   `x-cw-principal` added (`@commerceworker/security/principal`): HMAC-SHA256 under
   `PRINCIPAL_KEY`, payload `{ sub, email, name, role, sid?, iat, exp, path }` (`sid`: the
   session it came on), valid for 60 seconds and for that exact method and path
   (`principalTarget`, `packages/security/src/principal.ts`). The assistant's paths (`/agents/*`)
   are signed with a key derived from `PRINCIPAL_KEY` instead (HKDF, `ASSISTANT_PRINCIPAL_KEY` on
   the engine), which the REST surface never accepts.
3. Otherwise it goes through with no credentials, and the api answers 401 where it needs one.

`x-cw-bookmark` passes through both ways untouched. While a deployment has no people yet, every
page redirects to `/setup` (see [Auth & RBAC](./auth-and-rbac.md#first-run-setup-and-recovery)).

### apps/api: the synchronous HTTP surface

`apps/api/src/index.ts` is a thin entry over `@commerceworker/http`. Per request it:

- opens a database session from the `x-cw-bookmark` header, or `first-primary` for a mutating method
  and `first-unconstrained` for a read, and returns the session's new bookmark on the response
  (see [Consistency](./consistency.md));
- pins every stateful-object namespace to `DATA_JURISDICTION` when one is set (`withJurisdiction`
  in `packages/platform/src/env.ts`; the delivery and engine entry points and `wireEdge` do the
  same);
- mounts media routes, the live route on a stateful object (when `LIVE_HUB` is bound), MCP (only
  with an explicit `MCP_TOKEN` on a persistent deployment) and the REST app from `createApp`;
- after a mutating request, drains the outbox onto `commerceworker-events` in `waitUntil` (the
  "nudge"; the engine's cron covers anything it misses).

`ROLE` is `management,preview,delivery`: delivery routes are mounted here so the admin's own
reads of published content (compare, search, live), signed by the web principal, work through
the web origin. Public delivery clients use the delivery worker.

### apps/delivery: the public CDA

`apps/delivery/src/index.ts` is an **uncached gateway** in front of a **cached `Delivery`
entrypoint** (`exports` in its worker config: `default` has cache disabled, `Delivery` enabled,
with `cross_version_cache`). Per request the gateway:

1. rate-limits by client IP (`RATE_LIMIT_READ`, 1200/min);
2. authenticates the bearer CDA/CPA key with `authenticateCached`
   (`packages/application/src/auth.ts`): the principal is held in the key-value cache under the tag
   `principals:<spaceId>` (`principal-cache.ts`) and dropped on any key or role change in that
   space, so the steady state reads no database;
3. reduces the principal to a **visibility profile** (`apps/delivery/src/profile.ts`): a hash of
   space, key kind, sorted scopes and content grants, nothing else;
4. forwards a canonical URL, `https://delivery.internal/_p/<profile>/<path>?<sorted query>`, with
   the principal in an internal header, to `Delivery`.

Equal readers therefore share one cache entry, and authorization runs on every request even when
the body comes from cache. The live SSE stream and `/graphiql/*` are answered by the gateway
itself, and GraphQL `POST` is served uncached (`private, no-store`).

On a miss, `Delivery` (`apps/delivery/src/delivery.ts`) runs the same delivery routes the api
mounts against a database read-replica session (`first-unconstrained`), sets a strong ETag, and
caches 200s with `public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800` and a
`cache-tag` for the path's environment and the environment it resolves to (so alias repoints purge
too). It always returns the full body, because a `304` stored in the cache would be an empty answer;
the gateway compares `If-None-Match` with the ETag and answers `304` itself.

Its queue consumer drains `commerceworker-purge` with `drain` (`@commerceworker/platform/purge`):
up to 100 tags per purge call, one call every 12 s (the platform allows 5 a minute), at most 40
calls per batch, handing the rest back with exponential backoff. The edge cache is per worker, so
the media worker drains its own queue with the same function.

A `301` from the deprecated `…/assets/:id/transform` (a redirect to an immutable media URL) is
cached and tagged like a `200`.

### apps/pipeline: async and stateful work

`apps/pipeline/src/index.ts` exports every stateful-object and durable-workflow class (the api and
delivery bind them by `script_name`) and handles:

- **Queues**: `commerceworker-events` (batch 25, concurrency 10), `commerceworker-bulk` (batch 1),
  `commerceworker-agents` (batch 25, concurrency 4), `commerceworker-asset-events` (batch 25,
  concurrency 4; see [Asset ingest](#asset-ingest-and-search)), and `commerceworker-events-dlq` and
  `commerceworker-asset-events-dlq` (logged, kept redacted under `dlq/`, and acked). The events consumer runs `consumeEvent` per
  message (webhooks, key-value cache tags, search and vector indexing, functions, reindex slices,
  bulk chunks, environment purge steps, live fan-out), in 6 lanes at once (`runInLanes`,
  `apps/pipeline/src/lanes.ts`): one entry's events keep their order, other entries run side by side.
  Environment import and clone are bulk jobs, so their chunks run here too ([Environments and
  snapshots](./environments-and-snapshots.md)). It forwards `entry.published` to the agents queue
  when it is bound, and sends one coalesced purge message per batch for every space:environment
  touched by an event in `PURGING_EVENTS` (`entry.published`, `entry.unpublished`,
  `entries.published_bulk`, `asset.published`, `asset.unpublished`, `asset.deleted`,
  `asset.rights_changed`, `asset_collection.changed`, `taxonomy.changed`, `redirects.changed`,
  `menus.changed`, `content_type.published`, `content_type.deleted`, `release.published`, `environment_alias.changed`,
  `environment.deleted`; the sitemap is purged with the rest of the scope; `asset.ingested` only
  when `published`; `asset_renditions.changed` purges every environment of the space). Asset events
  also write or remove the media gate (`assetGate`, key-value store) and send the media worker's
  tags on `commerceworker-media-purge` (`apps/pipeline/src/purges.ts`): see
  [Assets](#assets-object-storage-image-transforms-video-and-the-media-worker).
- **Cron** (`* * * * *`): due scheduled actions, the asset expiry sweep (`runDueAssetExpiries`;
  see [Assets](#assets-object-storage-image-transforms-video-and-the-media-worker)), the outbox
  relay sweep, bulk-job stall recovery, the restart of deleted-environment purges that stopped
  progressing, agent schedules (`AGENTS_SCHEDULES=true`), retention, the abandoned-upload sweep (see
  [Asset ingest](#asset-ingest-and-search)), the abandoned multipart-upload sweep and the expired-zip
  sweep (see [Collections, share links, multipart uploads and zips](#collections-share-links-multipart-uploads-and-zips)) at the top of each hour, the daily
  secret reseal at 03:30 UTC, and the daily taxonomy repair at 04:15 UTC (`repairAllTaxonomies`:
  recounts each environment's published usage counts and fills missing term slugs). Each sweep runs through `sweep` (`apps/pipeline/src/heartbeat.ts`): a
  failure is logged and recorded, and never skips the rest of the tick. At the end of the tick one
  database batch writes the heartbeat (`scheduler_jobs`: each sweep's last run, success and redacted
  error, plus the `tick` row); a failed write is logged and the next tick writes again. The api's
  `/health` reports `scheduler: stale` once the `tick` row is more than five minutes old, and
  `/health/scheduler` answers `503` then, for an external uptime check. After the heartbeat the
  tick evaluates the stale alerts (`alertOnSchedulerTick`, `packages/application/src/scheduler-alerts.ts`):
  a sweep the deployment runs (`cronSchedule` in `heartbeat.ts`) is stale once it has gone two of
  its runs without a success, five minutes for the every-minute ones. Each stale episode emails the
  deployment's alert recipients once through the `EmailSender` (edge email), and once more when
  it recovers; a tick that finds the previous one more than five minutes old emails that the cron
  is back. The episodes live in the deployment setting `scheduler-alerts:state`, written by the
  cron only and only when something changes, each write a compare-and-set so overlapping ticks
  never both send; a notice a tick has claimed is leased to it for two minutes, retried on later
  ticks if undelivered and given up after five tries. Every episode is also a log line
  (`scheduler job stale`, `scheduler job recovered`, `scheduler resumed`), with or without email.

| Stateful object  | Keyed by                                             | Purpose                                                             |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `LiveHubDO`      | space:environment                                    | Live Content SSE fan-out                                            |
| `SearchShardDO`  | space:environment:shard (8 default, `SEARCH_SHARDS`) | FTS5 lexical index (`packages/platform/src/do/search-shard.ts`)     |
| `CostGuardDO`    | space                                                | AI request/token budget windows (interactive and background)        |
| `RateLimiterDO`  | client IP                                            | Failed-authentication limiter                                       |
| `AssistantAgent` | person (`usr_…`, or `local`)                         | The admin's assistant: its conversation, model turns and page edits |

The assistant (`packages/http/src/assistant/`, hosted by `apps/pipeline/src/assistant.ts`) is an
AIChatAgent whose tools are the MCP tools `ASSISTANT_TOOLS` names (`@commerceworker/domain`), run
in-process through the `/mcp` handler as the person's own principal, always in the space and
environment the page sent. The api forwards `/agents/assistant-agent/<person>` to it; who may open
that socket, what a client may send and how writes are confirmed are in
[Auth & RBAC](./auth-and-rbac.md#the-assistants-socket). The model is edge inference's flagship tier
through the AI gateway, then its fast tier, then a deterministic mock (always, under
`AI_MODE=mock`); each model step is a request against `CostGuardDO` and the turn's tokens are
settled however it ends.

Durable workflows: `AgentWorkflow` (`commerceworker-agent`), `EditorialWorkflow`
(`commerceworker-editorial`), `AssetIngestWorkflow` (`commerceworker-asset-ingest`) and
`AssetZipWorkflow` (`commerceworker-asset-zip`), in `apps/pipeline/src/workflows/`.

Stateful-object migration tags only ever append (`apps/pipeline/wrangler.jsonc`, checked by
`scripts/do-migrations.test.ts`).

### Editorial workflow runs

A workflow run is one durable workflow instance of `EditorialWorkflow`
(`apps/pipeline/src/workflows/editorial-workflow.ts`, binding `EDITORIAL_WF`, workflow name
`commerceworker-editorial`). Its payload is the run's `WorkflowRunParams`; its id is the run id, or
`${runId}-g${n}` after a continue-as-new. The class wires exactly as a request does (`wireEdge`:
the database store, AI, cost guard, plugin hooks, edge email, webhook sender) and hands the
platform's `WorkflowStep` to the graph interpreter (`runGraph` in `@commerceworker/agent-runtime`),
which owns every step name.

`CloudflareWorkflowEngine` (`packages/platform/src/workflows.ts`) implements the `WorkflowEngine`
port over the binding, so the same use-cases drive real instances from REST and MCP: start is
`create({ id, params })` (idempotent), decisions and business events are `sendEvent`, cancel is
`terminate()` followed by compensation in the request. Approval deadlines, event-wait timeouts and
`control.wait` timers are durable workflow waits; no cron is involved. Without the binding, run
actions answer 501 while definitions and reads keep working. An instance has a step ceiling
(about 1024), so long loops should pass through a `control.continue_as_new` node.

`content.notify` nodes send through edge email when the engine has the `EMAIL` binding and
`EMAIL_FROM` (rendered from the registry's `email`); unbound, they fail with "email sending is not
configured".

### Assets: object storage, image transforms, video and the media worker

**Uploads and draft reads** go through signed `/media/*` URLs (`packages/http/src/routes/media.ts`,
`@commerceworker/adapters/blob-r2`):

- **Object storage (`MEDIA_BUCKET`)**: the binding has no presigned URLs, so the api issues its own.
  `createAsset` returns a signed `PUT /media/<key>?…&sig=…` URL (HMAC with
  `MEDIA_SIGNING_SECRET`, short expiry, bound to the content type). The asset still stores a
  non-expiring signed `GET` URL in `file.url` on `MEDIA_BASE_URL`, which the api keeps honouring,
  but no read hands it out: Management and MCP reads replace it with a short-lived one
  (`withReadUrl`, `READ_URL_TTL_SECONDS` = 900; `exp` is covered by the signature and rounded up
  to a 15-minute window so a browser's cache keeps working). A single signed `PUT` takes at most
  100 MiB (the platform's request-body cap); larger files upload in parts
  ([below](#collections-share-links-multipart-uploads-and-zips)). User bytes are served with
  `nosniff` and `CSP: sandbox`. Rotating `MEDIA_SIGNING_SECRET` invalidates every signed URL.
- **Image transforms (`IMAGES`)**: transform params (`w,h,fit,fm,q,g`, and `exp`) are covered by the
  signature, so clients cannot mint arbitrary transforms; `fm=auto` picks AVIF/WebP from
  `Accept`; the focal point becomes gravity when `fit=crop`.
- **Preview** (`GET /preview/:space/:env/assets[/:id]`) projects drafts in the delivered shape,
  with every URL signed and expiring together, on `MEDIA_PUBLIC_URL` when it is set.

**Published files** are served by the media worker (`apps/media`) at
`https://media.<domain>/<space>/<env>/<assetId>/v<n>/<token>/<variant>/<fileName>`. The `token`
makes the URL unguessable: HMAC-SHA256 under `MEDIA_SIGNING_SECRET` over the space, environment,
asset id and version, truncated to 16 bytes as base64url (`createMediaPathSigner`, through the
`MediaPathSigner` port), so editing a URL (another environment's copy of the same asset id, which
an import keeps, or another version) reaches nothing, and a takedown in one environment can't be
read around through another. `variant` is `o` (the original), `w<width>` from the fixed ladder 320/640/960/1280/1920/2560 (`fm=auto`
negotiates the format), or `r-<name>`, a space's rendition preset (`asset_renditions`, migration
`0008`; at most 20 per space). Delivery builds these URLs at read time from `MEDIA_PUBLIC_URL`,
the published snapshot's `version` (migration `0009`) and that version's token, through one
projector,
`deliveredAsset` (`packages/domain/src/asset/delivered.ts`), used by REST get and list, entry
embeds, Preview and GraphQL's `Asset` type.

The **asset reference route** (`apps/media/src/asset-ref.ts`) gives an asset an address that
survives a replace: `/a/<assetId>` and `/a/<assetId>/<variant>` answer `302` to the published URL
above, built from the gate's current version and file name and the path signer's token (KV, then a
replica; nothing is written). The catalog publishes a product's `asset:<assetId>` media as it. The
space and environment are the deployment's one media scope (`ASSET_REF_SPACE`, `ASSET_REF_ENV`, from the registry's `mediaScope`). A bad variant
is `400` (`no-store`); an unknown, unpublished, expired, video or (for a variant) non-image asset is
`404`, cached 30 s. The `302` is `public, max-age=60`, capped by the rights' expiry, and varies on nothing;
it is never purged, the short age is the freshness. Only a path of three or four segments is this
route, so a space named `a` keeps its eight-segment URLs.

- The **gateway** (default entrypoint, uncached) trusts no header. It checks the path's token
  first, so a guessed or edited URL is a `404` (`no-store`) that costs a MAC and no cache, key-value
  or database read. It then maps the URL to a canonical
  one on `https://media.internal` (the path, plus `?f=avif|webp|src` for a variant, negotiated
  from `Accept`; every other parameter dropped, so `?download` never reaches the cache key), adds
  `Vary: Accept` when it negotiated, answers `304` on `If-None-Match`, and serves signed
  `/media/*` GETs (never a PUT, never one without `exp`) uncached. It forwards one `Range: bytes=`
  header (`singleByteRange`) and `If-Range` to the cached entrypoint; the edge cache strips the
  range on a miss, stores the full `200` and slices `206`/`416` itself. When that fetch comes back
  `200` for a range on an original (no cache in front, as in local dev and tests, or a file the
  cache didn't keep), the gateway calls the RPC method `Media.range(url, range, ifRange)`, which
  reads the range from object storage (`bucket.get(key, { range })`) and answers `206` with
  `Content-Range`, `Content-Length` and `ETag`, or `416` with `Content-Range: bytes */<size>` and
  `no-store`. RPC is never cached, so a partial never stands in for the whole file. Several ranges,
  another unit, a malformed header, a variant (served whole when uncached) and an `If-Range` that
  isn't the current strong ETag get the whole file as `200`; unsatisfiable is a start at or past the
  size, an inverted range, or `bytes=-0`. Every `200`/`206` carries `Content-Disposition: inline;
  filename="<ascii>"; filename*=UTF-8''<RFC 8187>`, or `attachment` with `?download` (any value)
  and for types `safeHeaders` already forces to `attachment` (SVG, HTML); CORS exposes `etag`,
  `cf-cache-status`, `accept-ranges`, `content-range`, `content-length` and `content-disposition`.
- The cached **`Media`** entrypoint, on a miss, checks the token again and then reads the **gate**
  (`asset-gate:<space>:<env>:<id>` in `KV_CACHE`: `{v, r2Key, contentType, fileName, focal,
  expiresAt}`, `@commerceworker/adapters/asset-gate-kv`), falling back to a database replica
  (`first-unconstrained`), and applies one rule, `mediaServability`
  (`packages/application/src/asset-gate.ts`): no entry, another version or file name is `404`
  (as are an unknown variant and a variant of something the image transforms can't resize); past
  `expiresAt` is `410`; both `no-store`. A `200` is `public, max-age=31536000, immutable`, except
  for an asset whose rights expire: then `public, max-age=<seconds left>`, without `immutable`, so
  no cache holds it past the expiry. A `200` is tagged `cwa:<space>:<env>:<id>`, `cwe:<space>:<env>`
  and, for a rendition, `cwr:<space>:<name>`. The miss path always returns the whole file, never a
  `206` (the edge cache would not store it), with `Accept-Ranges: bytes` on originals. Its ports
  (the gate, a replica store, the path signer) come from `wireMedia`, the media worker's
  composition root. It writes nothing.
- The **engine** owns the gate: `syncAssetGate` runs for `asset.published`, `asset.unpublished`,
  `asset.deleted` and `asset.rights_changed` and writes or removes the entry from the current published snapshot (so a
  redelivered event converges; a hosted video gets none, nor does an asset of an environment
  being deleted). Deleting an environment removes all of its gate entries (`AssetGate.deleteScope`,
  a paged key-value prefix delete) on `environment.deleted` and again when its purge finishes,
  before the environment's id is free, so a re-created environment never inherits them. It sends the
  asset's tag on `commerceworker-media-purge`; a revocation (unpublish, archive, delete, expiry, a
  rights change, a republish that replaced the file (`asset.published` with `replacedVersion`), a
  rendition change, environment deletion and each purge step, whose last one follows the final gate
  removal) is
  sent again after `REVOCATION_REPURGE_SECONDS` (90 s), past the key-value
  store's 60 s read cache and replica lag, so a colo that re-cached from a stale gate is purged too.
- The media worker drains `commerceworker-media-purge` with the same rationed `drain` as delivery.
  `/assets/:id/transform` on Delivery is deprecated: a cacheable `301` to the matching ladder step
  or rendition when `MEDIA_PUBLIC_URL` is set, else the earlier signed `302`.
- **Video streaming (`STREAM`)**: `POST …/assets/videos` creates a draft asset and a one-time direct
  upload; `POST /webhooks/stream` (mounted only with both `STREAM` and `STREAM_WEBHOOK_SECRET`)
  verifies `Webhook-Signature` and then re-reads the video from the streaming service's API;
  `POST …/assets/:id/video/refresh` does the same on demand. When the asset is published, the
  refresh also updates the published snapshot in the same unit and emits `asset.published`, so
  caches purge. Playback is public; hosted videos are never gated by the media worker.
- **Versions.** Replacing a file is two calls: `POST …/assets/:id/file` (`replaceAssetFile`)
  returns a signed `PUT` for the next version's key, and `POST …/assets/:id/file/commit`
  (`commitAssetFile`) checks the bytes are there (`BlobStore.head`) and, in one unit, bumps
  `assets.version`, writes the previous file to `asset_versions` and appends
  `asset.file_replaced` (`AssetRepo.replaceFile` compares the version at commit, so a second
  commit for the same version is a `409`). Each replace start uploads to a key of its own (the
  commit object carries its `attempt`), so replaces started side by side never share a key: an
  upload URL stores once and object storage completes a multipart upload unconditionally, so a
  shared key would let one attempt refuse or overwrite another's file. The first to commit wins; a
  later commit for that version is a `409`, never "already committed". Past 100 MiB, `POST
  …/assets/:id/file/uploads` (`startMultipartAssetFileReplacement`) starts a multipart upload for
  its attempt's key; completing it runs the same commit unit (`commitStoredReplacement`, which also
  deletes the `asset_uploads` row), refuses with `409` and aborts when the version was taken
  meanwhile, and deletes its own bytes if it loses at commit. A version's key is
  `space/env/asset/fileName` for the first file and `space/env/asset/v<n>/file-<attempt>/fileName`
  after (`assetObjectKey`; keys minted before attempts read `…/v<n>/file/…`): never five
  segments, which is where a version's extracted text lives (`…/v<n>/text.md`), so derived files
  are never an asset file. `assetFileKey` ignores a recorded key that isn't this asset's file key
  or names a version past the asset's own (an uncommitted upload). `POST
  …/assets/:id/versions/:n/restore` (`restoreAssetVersion`) makes an old file current as a new
  version pointing at the same bytes; `GET …/assets/:id/versions` lists them, each with a
  short-lived read URL. The published snapshot keeps its version until a republish, so the old
  URLs keep working until then; the republish's `asset.published` carries `replacedVersion` and
  the engine purges the asset's media as a revocation. The engine sends `asset.file_replaced` to
  ingest as an upload message (`AssetIngestQueue.objectCreated` with the commit's `etag`), so object
  storage's own notification of the upload starts no second run.
- **Rights and expiry.** `PUT …/assets/:id/rights` (`setAssetRights`, `content:publish`) validates
  them (`validateAssetRights`: text at most 500 characters, dates ISO-8601 with a zone, expiry
  after embargo). On a published asset they apply at once: the snapshot's rights change in the
  same unit with `asset.rights_changed`, which re-syncs the gate and purges both caches. Publishing
  refuses before `embargoUntil` and after `expiresAt` (`AssetRightsError`, `409 asset_embargoed` /
  `asset_expired`), and an embargo can't be set on a published asset. The cron's expiry sweep
  reads `asset_published.expires_at` (migration `0012`, indexed, copied from `rights.expiresAt` on
  every snapshot write) across all scopes and unpublishes each expired asset (`expireAsset`) with
  `asset.unpublished` and `asset.expired` in one unit; `removeExpiredPublished` re-checks the
  expiry at commit, so an asset republished or extended meanwhile stays delivered. Between the
  expiry and the sweep, the media worker already answers `410`.
- **Bulk jobs.** `POST …/assets/bulk` (`startAssetBulkJob`) runs move, tag, publish, unpublish or
  archive over a selection as a resumable bulk job (`asset_move`, `asset_tag`, …) on the entry
  bulk-job machinery: chunks of 200, CAS-claimed, swept when stalled. Each asset goes through its
  single-asset use-case (`assetBulkChunkRunner`), and a failure carries the asset's `name` (title or
  file name) in the job report.
- **Deleting** an asset (`DELETE …/assets/:id`, only once it is archived, and refused with
  `409 asset_in_use` while entries link to it, drafts and the trash included) removes the row and
  its version history in one unit with an `asset.deleted` event; the
  engine then deletes every version's bytes under the asset's key prefix (and, for an imported
  asset replaced here, under this environment's prefix too) and its hosted video, unless another
  environment of the space still holds an asset with that id (an environment import shares
  files). An environment purge keeps the files (of every version) another environment's assets
  may share, and removes the rest.

The admin's **Assets** screen (`/assets`; `/media` redirects there) is the library over these
routes: folders, filters, search with facets, archive and delete, bulk actions (a job past 50
assets), each asset's versions and rights, and each asset's ingest state
(processing, or an error with a retry), duplicate marker and AI-suggested alt text and tags. The
api's `/media/*` byte route keeps its name.

### Collections, share links, multipart uploads and zips

Migration `0016_asset_collections` adds five environment-scoped tables (mirrored in
`packages/store/src/schema.ts`; the environment purge clears them): `asset_collections`,
`asset_collection_items` (one row per membership, ordered by `position`), `asset_share_links`
(`password_hash` is PBKDF2, `revoked_at` set once), `asset_zip_jobs` and `asset_uploads`.

- **Collections** (`packages/application/src/asset-collections.ts`, domain
  `packages/domain/src/asset/collection.ts`) are named, ordered, many-to-many sets of assets: at most
  `MAX_COLLECTION_ITEMS` (1,000) members, a change of at most `MAX_COLLECTION_CHANGE` (500) ids per
  call, passed to the store as one JSON parameter. An add past the cap is refused whole (`409`).
  `content:write` changes them, `preview:read` reads them. Every change emits
  `asset_collection.changed`. Deleting an asset removes its memberships in the same unit and emits
  one `asset_collection.changed` per collection it leaves (at most 100). Export, import and clone
  carry collections (`snapshots.ts`), keeping the members whose asset the snapshot carries or the
  target already has. Delivery serves `GET …/collections/:id` (published members only), cached under
  the scope's tag and purged by `asset_collection.changed`.
- **Share links** (`asset-shares.ts`; `apps/media/src/share.ts`) are expiring, revocable links to a
  published asset or a collection, served read-only by the media worker at
  `/s/<space>/<env>/<linkId>/<token>`. Only published assets are shared: an unpublished asset is
  `409`, and a collection's page lists only its published members, so a draft is never exposed. The
  `token` is a 128-bit HMAC (`MediaPathSigner`) checked before any lookup. The link is then read on
  every request, from a database replica (`openShareLink`): no cache or engine step stands between a
  revoke and the link closing. Expired is `410` at once; revoked is `410` as soon as the replica has
  the row (replication lag, usually well under a second). The page is HTML, or JSON with `?format=json` or `Accept:
  application/json`; files are at `…/f/<assetId>/<fileName>` through the published file's own cached
  URL, and `?download` is honoured only when the link has `allowDownload`. The page renders in the
  cached `Media` entrypoint, tagged `cws:<space>:<env>:<link>`, `cwa:<space>:<env>:<asset>` for an asset link or
  `cwc:<space>:<env>:<collection>` for a collection, and `cwe:<space>:<env>`, and cached at the edge for at most an hour and never past the expiry; the
  gateway hands the browser `private, no-store` for a page and `private, max-age=300` for a file.
  A wrong password re-renders the form (`200`), a locked page's file is `401`, the limit is `429`.
  `asset_share.revoked` revokes the link's tag now and again after 90 s; `asset_collection.changed`
  purges the collection's tag; `asset.published`, `asset.unpublished` and `asset.rights_changed`
  purge the tag of each collection holding the asset (at most 100, `MAX_COLLECTIONS_PURGED`). An
  optional password (8 to 256 characters) is hashed with PBKDF2 (`@commerceworker/security`
  `credentials`, moved from `apps/studio`) and never returned. The unlock form (`POST …/unlock`) is
  limited to 10 a minute per link and client address by the media worker's `RATE_LIMIT_SHARE_UNLOCK`
  binding (namespace `1006`), and sets a cookie scoped to the link's path for at most 12 hours
  (`UNLOCK_SECONDS`) and never past the expiry. Expiry is 5 minutes to 90 days out. Create, list
  and revoke need `content:publish` (a listing carries the URLs).
- **Multipart uploads** (`asset-uploads.ts`, `@commerceworker/adapters/blob-r2`) serve files past
  what one signed `PUT` takes (100 MiB), up to `ASSET_UPLOAD_MAX_BYTES` (default 5 GiB). Starting
  one creates the draft (same hooks and key rules as a single `PUT`) and a multipart upload in
  object storage, and records it in `asset_uploads`. Parts are 8 MiB, grown in whole MiB to stay
  within 10,000 parts. Each part's URL is signed with the upload id, part number and exact length.
  Completing needs parts `1..n` once each with their etags and sends the same ingest notice a
  finished `PUT` does. Aborting discards the parts and deletes the draft while it has no bytes (a
  replacement's upload, whose key names a version past 1, leaves the asset alone). The top-of-hour
  sweep `sweepAbandonedMultipartUploads` (`abandoned-multipart-uploads`) aborts uploads unfinished
  after a day (at most 100 a sweep), before the draft sweep above removes their drafts; an
  object-storage lifecycle rule (`abort-multipart`, bucket-wide, 2 days) is the backstop.
- **Zip downloads** (`asset-zip.ts`, `zip.ts`, `apps/pipeline/src/workflows/asset-zip-workflow.ts`)
  put up to `MAX_ZIP_ASSETS` (1,000) assets, 20 GiB at most, in one archive. `requestAssetZip`
  writes the job (`pending`) and `asset_zip.requested` in one unit; the engine starts
  `AssetZipWorkflow` (`ASSET_ZIP_WF`, instance per job) from that event, or fails the job when the
  binding is absent. The workflow plans the archive from each asset's current file (a hosted video
  and a file whose bytes never landed are skipped), then runs one step per 8 MiB multipart
  part from ranged reads, so one part is in memory and never the archive. Entries are stored
  (no compression) with data descriptors, and Zip64 where a size or offset passes 4 GiB. The
  archive lives at `zips/<space>/<env>/<job>/<name>.zip` (`zips` is a `RESERVED_SPACE_IDS`
  entry) and is kept a day. `GET …/asset-zips/:id` adds a `downloadUrl`, a 15-minute signed URL
  (`READ_URL_TTL_SECONDS`), once the job has `completed`. The sweep `expired-zips` (at most 100 a
  sweep), the `zips/` lifecycle rule (2 days) and an environment purge remove archives.
  `preview:read` requests and reads them.

### Asset ingest and search

Every file that lands in the media bucket is ingested once per version
(`packages/application/src/asset-ingest.ts`):

```
Storage object-create event ────┐
api signed PUT completed ───────┴→ commerceworker-asset-events → engine → AssetIngestWorkflow
                                                                          (one per file version)
```

- **Triggers.** `scripts/provision.sh` creates an object-storage event notification rule
  (`object-create`, no prefix: asset keys `space/env/asset/file` share none) to
  `commerceworker-asset-events`. Wherever `ASSET_EVENTS_QUEUE` is bound, the api's signed
  `PUT /media/<key>` also sends a message shaped like a storage notification there when the upload
  succeeds, so production has two triggers and local development, which has no storage
  notifications, still has one (`mediaRoutes`' `onUploaded`; a failed send is logged, never the
  upload's). The engine's consumer (`startAssetIngestForObject`) ignores any key that isn't an
  asset's current file (`parseAssetObjectKey` and `assetFileKey`: extracted text, version bodies,
  staged jobs, an older version) and starts the run under
  `assetIngestInstanceId(scope, assetId, version, { etag })`, so both triggers and any redelivery
  start one run (the signed PUT answers with the stored etag, the storage notification carries it).
  The signed PUT is create-once (`If-None-Match: *`, which object storage checks atomically with the
  write): a second PUT through the same URL is a `412` and stores nothing, so committed or ingested
  bytes can't be overwritten; a part URL stops working once its upload completes (`NoSuchUpload`,
  `404`). `CloudflareAssetIngestStarter` creates through `createBatch`'s object form and treats only
  its duplicate-id code (`10405`) as the run that exists; any other error retries the message. The
  `pending` mark is written only over a status that isn't `processing`, and put back to `ready` or
  `error` when the run already existed. A re-run (`POST …/assets/:id/reingest`, a no-op while
  pending or processing; the `asset_reindex` bulk job, of which one runs per environment at a
  time) adds a token of its own. Both answer `501` without `ASSET_EVENTS_QUEUE`.
- **Steps** (`runAssetIngest`), each a `step.do` and one unit of work, each re-checking the asset is
  still on the run's version: `begin` (`ingest_status` processing), `hash` (SHA-256 streamed from
  object storage, skipped above 512 MiB; `duplicate_of` set to the oldest other asset in the scope
  with that hash, on this asset and on later copies, and re-pointed at the oldest copy left when the
  original is deleted), `probe` (the image-transform binding's `info`, skipped above 70 MiB: width,
  height, and the format when the upload declared `application/octet-stream`), `placeholder`
  (raster types `isTransformableImage` accepts, at most 20 MiB, `MAX_PLACEHOLDER_BYTES`: the
  image-transform binding shrinks the file to a 32 px `scale-down` PNG, one billed transformation,
  and `packages/adapters/src/images-cf/placeholder.ts` decodes it with `fast-png` and computes a
  `thumbhash` ThumbHash (base64) and a dominant colour, `#rrggbb` from 4-bit-per-channel binning
  that skips transparent pixels; stored as `file.placeholder` in the `file` JSON, no column; a
  failure leaves none and never fails the run), `alt-text` and
  `tags` (images: `generateAltText` and `autoTagAsset` under the AI budget, the uploader's text
  wrapped as untrusted, only where empty, existing tags only, recorded in `ai_suggestions`; a
  spent budget skips them, and a model that still fails after the step's retries records
  `failed` without failing the run), `extract-text` (documents through edge inference's
  `toMarkdown`, audio through Whisper large v3 turbo, metered by the AI budget and absent under
  `AI_MODE=mock`; at most 20 MiB and 10 MiB read, handed over as the stream's chunks, 500,000
  characters kept, at `space/env/asset/v<n>/text.md`, which no media URL can name, and removed if
  the asset was deleted meanwhile), `embed`, `index` and `finish` (`ingest_status` ready, the
  measured size, dimensions and placeholder written into a published snapshot of the same version, and
  `asset.ingested` with `published`, in one unit). A step that still fails after its retries
  records `ingest_status` error and the message, credentials redacted.
- **Writes.** `AssetRepo.recordIngest` writes only `ingest_status`, `ingest_error`,
  `content_hash`, `duplicate_of` and the file's measurements, and only while the asset is on the
  run's version; `save` leaves those columns alone, so an editor's save from an older read never
  undoes a step. Alt text and tags go through `applyAssetMetadata` and `save` after a re-read, so
  a value an editor saved meanwhile wins; a save through the metadata path clears the
  `ai_suggestions` marks of the alt text locales it changed and the suggested tags it removed.
- **Abandoned uploads.** A presigned PUT URL lives 15 minutes; a draft whose bytes never landed
  has `ingest_status` and `size` NULL. On the top-of-hour cron tick (after the event-history
  prune) the engine runs `sweepAbandonedUploads` (`packages/application/src/assets.ts`) over
  drafts created more than `ABANDONED_UPLOAD_TTL_MS` (24 h) ago, across every space and
  environment, oldest first, at most 50 per sweep (`AssetRepo.listAwaitingUpload`, served by the
  partial index `assets_awaiting_upload`, migration `0014`). Per draft, `BlobStore.head` on its
  key (a store without `head` sweeps nothing): bytes exist → the size is recorded and the
  reindex job ingests it (`landed`); no bytes and an entry links it → `ingest_status` `error`,
  "The upload never completed", the asset kept (`linked`); no bytes and unlinked → `deleteAsset`
  (row, `asset.deleted`, and the engine removes anything under the asset's storage prefix)
  (`removed`). A store or blob error leaves the draft for the next sweep (`failed`). The engine
  logs `abandoned uploads swept` and counts `commerceworker_abandoned_uploads_total{outcome}`.
- **Trash retention.** A space's `trash_retention_days` (migration `0023`; null, the default, is
  off) is how long its trashed entries are kept. On the top-of-hour tick the engine runs
  `sweepExpiredTrash` (`packages/application/src/trash-retention.ts`, heartbeat job
  `trash-retention`): for every environment of every space with a window, the entries trashed
  before it (an archived entry's `updated_at` is its trashing), oldest first, leaving out any a
  published entry links to (`EntryRepo.listExpiredTrash`, on the partial index `entries_trashed`),
  each through `purgeEntry` without `force`. At most `TRASH_SWEEP_LIMIT` (40) purges and twice
  that many refusals a tick (a purge is about 10 D1 statements, and the tick shares one
  invocation's query budget), one at a time. The environments take turns going first, hour by
  hour; first pages are read only until they hold the budget, which is shared evenly between the
  environments that have expired trash. A purge a rule refuses (a plugin's veto, a race) uses no
  slot, and each environment resumes after the last entry it looked at
  (`environments.trash_sweep_cursor`, a keyset cursor on `(updated_at, id)`), with at most
  `TRASH_SWEEP_REFUSALS_PER_ENVIRONMENT` (10) refusals a tick there, so held entries never stall
  the ones behind them. Once an environment's expired trash has been read to its end, the cursor
  clears and the next tick retries from the oldest. The engine logs `expired trash swept` and
  counts `commerceworker_trash_purged_total{outcome}` (`purged`, `refused`).
- **Search.** Assets are indexed apart from entries, in two corpora (`AssetSearchCorpus`): the
  library (every asset as it is now) and the published assets (their published snapshots, written
  on publish and ingest, removed on unpublish). Each has its own SearchShard objects
  (`space:env:assets:<n>` and `space:env:pubassets:<n>`, the same class, so no new migration tag)
  and its own vector-index namespace (metadata `kind: 'asset'`, `spaceId`, `environmentId`,
  `assetId`), so entry search, related entries and RAG answers never see asset text, and
  Delivery's candidates are never drafts. The indexed text is the file name, title, description,
  alt text, tag names and an excerpt of the extracted text of the snapshot's own file version.
  Queries and documents are embedded only with `EMBEDDINGS_PROVIDER` set: `wireEdge` builds one
  `assetSearch` that the api, delivery, MCP, the engine and ingest share. `searchAssets` (Management `GET …/assets/search`, MCP `assets_search`) and
  `searchDeliveredAssets` (Delivery `GET …/assets?q=`) fuse the two legs by rank (RRF), filter by
  kind, tag, folder and (Management) status, and count facets; Delivery returns only published
  assets, projected, and a search there (and MCP's `delivered: true`) needs `search:read` as well
  as `delivery:read`. Without a bound index the lexical leg scans the 500 most recent assets.
- **Cleanup.** `asset.deleted` removes both corpora's vectors and documents and the extracted
  text; `environment.deleted` clears the environment's asset shards (both corpora), and its purge removes each asset's
  vector, a page of 200 per event, before the rows go.

## Data placement

| Store                                   | Holds                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database** (`DB`, primary + replicas) | Everything authoritative: spaces, environments, aliases, content types, entries and versions, published read models, assets, releases, schedules, taxonomy, redirects, menus, workflows, roles, team, API keys, OAuth, webhooks, the outbox, audit; plus the web app's auth tables (`0002_auth.sql`) |
| **Object storage** (`MEDIA_BUCKET`)     | Asset bytes, import staging (`imports/`, 7-day lifecycle), plugin bundles, dead letters (`dlq/`, 30-day lifecycle), zip downloads (`zips/`, 2-day lifecycle) and in-progress multipart uploads (aborted by a bucket-wide 2-day rule)                                                                 |
| **Key-value store** (`KV_CACHE`)        | Tag-versioned delivery cache, the authenticated-principal cache, and the media gate (shared by api, engine, delivery and media)                                                                                                                                                                      |
| **Stateful-object SQLite**              | Search shards, live hubs, AI budgets, auth-failure counters                                                                                                                                                                                                                                          |
| **Vector index**                        | Embeddings (768 dims, cosine), metadata-indexed on `spaceId` and `environmentId`                                                                                                                                                                                                                     |
| **Metrics store** (`METRICS`)           | Operational counters (`commerceworker_*`)                                                                                                                                                                                                                                                             |
| **Edge cache**                          | Delivery responses, keyed by visibility profile and canonical URL; published media files, keyed by canonical media URL                                                                                                                                                                               |

## The layers

### `packages/domain`: the core

Pure TypeScript that depends on nothing: content types and field types, the entry publish state
machine, validation (`validateEntryFields`, the single source of truth for human and AI writes),
locale fallback, references, assets, webhooks, domain events, RBAC (`SCOPES`, `scopesForKind`,
`authorize`, `Principal`), and `DomainError` subclasses with stable codes. See
[Domain model](./domain-model.md).

### `packages/ports`: the interfaces

Interfaces only:

- `content-store.ts`: the **single database seam**. `ContentStore` exposes per-aggregate repos
  and `withTransaction`, documented as a **unit of work** (read first, then write; reads inside
  the unit do not see its own writes; a lost compare-and-set surfaces at commit as
  `TransactionConflictError`). No SQL, ORM or driver type crosses this boundary.
- `infra.ts`: `Queue`, `EventBus`, `BlobStore`, `Cache`, `WebhookSender`, `AIProvider`,
  `EmbeddingsProvider`, `VectorStore`, `SearchIndex`, `HookDispatcher` and friends.
- `workflow-engine.ts`: `WorkflowEngine`, the durable-run port.
- `import.ts`: the import source port (`ImportSource`) that `import-structured` implements.
- `support.ts`: `Clock`, `IdGenerator`, `Hasher`, which keep use-cases deterministic, and
  `SecretSealer`, which seals secrets at rest.

### `packages/application`: the use-cases

Functions that orchestrate the domain over the ports. Every use-case takes an `AppContext`
(`store`, `clock`, `ids`, optional `cache`, `hooks` and more) and a `Scope`. One module per
capability (`entries`, `publishing`, `releases`, `scheduling`, `workflows`, `taxonomy`, `assets`,
`delivery`, `preview`, `webhooks`, `roles`, `team`, `auth`, `oauth`, `setup`, `snapshots`,
`rag`, `search-index`, `generation`, `agent-*`, `events/*`, …). These modules are the **only**
way state changes: the HTTP API, MCP, and the queue consumers all call them.

### `packages/store`: the database store

- `schema.ts` and `auth-schema.ts` (drizzle `sqlite-core`) mirror the hand-written migrations
  `migrations/0001_init.sql` (content), `0002_auth.sql` (the web app's users, sessions,
  passkeys, SCIM groups, admin audit), `0003_environment_purges.sql` (deleted environments
  still being purged), `0004_version_bodies.sql` (`entry_versions.body_key`, for superseded
  version bodies moved to object storage), `0005_webhook_environments.sql`
  (`webhooks.environment_id`), `0006_environment_promotions.sql` (promotions between environments)
  `0007_dam.sql` (the asset library's columns, `asset_folders` and `asset_versions`),
  `0008_asset_renditions.sql` (a space's rendition presets), `0009_asset_published_delivery.sql`
  (the published asset's version, key, kind and rights) and
  `0010_asset_published_backfill_again.sql` (0009's backfill again, for snapshots the old api wrote
  mid-deploy). Timestamps are epoch milliseconds; JSON is `TEXT`.
- `exec.ts`: `directExec` and the `UnitOfWork` behind `withTransaction`: writes are buffered and
  sent as one `db.batch()`; `expectChanged()` adds a guard statement
  (`INSERT INTO _guard SELECT changes() = n`, with `CHECK (ok = 1)`) so a lost compare-and-set
  aborts the whole batch and maps to `TransactionConflictError`. `chunked` / `selectChunked`
  keep statements under the database's 100-parameter cap.
- `store.ts`: `createD1Store`, every repo, and the lease-claimed outbox (`OUTBOX_LEASE_MS`
  = 60 s).
- `query-pushdown.ts`: JSON field filters as `json_each` SQL with the filter values bound as one
  JSON parameter.

### `packages/adapters`: platform implementations

One subpath per adapter, each implementing a port against one binding:

| Subpath               | Port(s)                                  | Technology                                                                                                                                            |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-workers`          | `AIProvider`, `EmbeddingsProvider`       | Edge inference, through the AI gateway when configured                                                                                                |
| `asset-gate-kv`       | `AssetGate`                              | The key-value store (the media worker's gate)                                                                                                         |
| `blob-r2`             | `BlobStore`, media URL signer            | Object-storage binding + signed `/media/*` route                                                                                                      |
| `cache-kv`            | `Cache`                                  | The key-value store, tag-versioned                                                                                                                    |
| `queue-cf`            | `Queue`                                  | Platform queues producer                                                                                                                              |
| `vector-vectorize`    | `VectorStore`                            | The vector index                                                                                                                                      |
| `vector-kv-dev`       | `VectorStore`                            | Local-dev only (`VECTOR_STORE=kv`): brute-force cosine over the key-value store, shared by the workers of a dev session; counts as the fake `vectors` |
| `images-cf`           | image transformer                        | Edge image transforms binding                                                                                                                         |
| `video-stream`        | video host                               | Video streaming binding                                                                                                                               |
| `email-cf`            | `EmailSender`                            | Edge email (`send_email`)                                                                                                                             |
| `plugins-cf-loader`   | plugin runtime                           | Isolated edge workers                                                                                                                                 |
| `http-effects`        | `WebhookSender`, function invoker, fetch | `fetch`                                                                                                                                               |
| `import-structured`   | import sources                           | CSV / JSON / WordPress parsers                                                                                                                        |
| `import-space-export` | `SpaceExportReader`                      | The JSON space export format: model, locales, tags, entries (links remapped), assets                                                                  |

### `packages/platform`: wiring

`env.ts` (the `EdgeEnv` bindings and vars), `config.ts` (`loadConfig`), `wire.ts` (`wireEdge`,
the only place adapters are bound to ports, run per request / batch / tick), ids, metrics, queue
message shapes (`messages.ts`, including `deliveryScopeTag` and the media tags), the rationed
purge-queue `drain` (`purge.ts`), the stateful-object classes and
their clients (`do/`), and the durable-workflow clients. Every binding is optional; an absent
binding selects a dev fallback (in-memory store, fake blob, stub AI, in-memory vectors), and
`assertNoFakeAdapters` refuses those on a persistent deployment (one with `DB`) unless
`ALLOW_FAKE_ADAPTERS` names them.

Studio's workspace settings and setup-code claims use the `AdminSettings` port, bound to D1 in
`apps/studio/app/lib/wire.server.ts`. D1 and in-memory implementations share a contract: a setup
code is claimed by one guarded write, and a failed account creation returns the claim only while
its hash still owns it. The composition-root test holds these handlers to importing no tables or ORM.
Studio's sign-in module uses `AdminAuth` from that same root for people, sessions, failure windows,
challenges, and one-use TOTP and recovery-code guards. Two-factor management uses the same port;
replacing recovery codes and disabling TOTP each commit as a single D1 batch. It shares the neutral credential record shapes
with commerce but binds only the content database. The D1 and in-memory implementations share a
contract covering expiry, disabled accounts, guarded rehashes and concurrent code consumption.
Passkeys use the shared `PasskeyStore` interface with Studio's own `admin-passkeys` D1 adapter,
bound in the same root. The shared contract runs against the in-memory fake and both databases'
adapters, including concurrent one-use challenges, credential ownership and challenge replacement.
The Team page, Account session management and access revocation now use `AdminTeam` and `AdminAuth`,
and the shell's admin contacts come from `AdminTeam`. Role and disable writes guard the presence of
another active admin in the statement itself, including mixed concurrent changes. Ending sessions
returns the actual deleted count in one statement, retaining only the requested current session.
SSO identity lookups, account creation and linking, and invitation account creation and promotion,
use these same ports. Both passwordless and password-confirmed SSO links use a single guarded write:
the account must still be unlinked and the subject must be unclaimed. The shared contract tests
both kinds of concurrent claim, and the D1 suite verifies that non-constraint storage errors propagate.
Self-service password resets use `AdminPasswordResets` from the same root: atomic code replacement,
scoped live-code reads, one-use claims, and a single batch that changes the password and removes the
person's reset codes, pending second-factor challenges and sessions. D1 and in-memory implementations
share a contract; D1 failure tests cover replacement and password/revocation rollback.
SCIM provisioning uses `AdminScimDirectory`; token metadata, rotation and revocation, and the
group-to-role map use `AdminSettings`. SCIM retains the member/admin deployment roles, passwordless
creation and the protocol's email-lock rules. Directory pages read their count and rows in one
D1 batch, group deletion batches the group and its memberships, and membership lists are chunked
below the 100-parameter limit. Role and deactivation writes preserve an active admin even under
concurrent requests. Studio's audit chain uses `AdminAuditLog` for concurrent append, timestamp/id pagination and sequence
reads for verification, with the chain rules still in the pure audit-chain module. Email Sending and
the database health probe are also bound in `apps/studio/app/lib/wire.server.ts`. The composition-root
test scans every Studio app and Worker source: no other file imports a store, adapter or ORM, reads
D1 or calls a database factory. The legacy `db()` helper is gone, and Studio uses Drizzle only in
its integration tests.

The media gateway and cached entrypoint compose their R2 reads, safe response headers and Images
transforms through `@commerceworker/platform/media`. The serving functions take these dependencies;
they import no store or Cloudflare adapter. `scripts/composition-root.test.ts` enforces that boundary.

### Other packages

- `@commerceworker/http`: the Hono surface as a library (REST routes, auth middleware, OpenAPI
  3.1 + Scalar, the OAuth 2.1 authorization server, MCP server and skills, media, live). It has no
  setup routes and no sign-in of its own: people reach it through the web principal.
- `@commerceworker/security`: the signed principal (`principal.ts`) and deployment roles.
- `@commerceworker/agent-runtime`: engine-agnostic agent workflow logic and the in-process
  executor (the engine runs the same workflows as durable workflows).
- `@commerceworker/graphql-gen`: the GraphQL delivery schema from Delivery's published view of the
  content types.
- `@commerceworker/seed`: the demo dataset (`SEED_DEV`, `SEED_SCALE`).
- `@commerceworker/test-kit`: in-memory `ContentStore` (enforcing the same unit-of-work rule),
  fake blob store, in-memory vectors, deterministic clock and ids.
- `@commerceworker/telemetry`: structured JSON logs on `console` (the platform's worker logs).
- `@commerceworker/redaction`: credential redaction for logged errors.
- `@commerceworker/docs-index`: `docs/*.md` embedded for the MCP and HTTP docs tools.
- `@commerceworker/design`, `@commerceworker/ui`: the Ledger design system for `apps/studio`.
- `packages/sdk/*`: the workspace SDKs, published together as `@commerceworker/sdk`
  (`packages/sdk/sdk`); see [SDKs](./sdks.md).
- `@commerceworker/cli`: the `commerceworker` command over the Management SDK, shipped as
  `@commerceworker/sdk`'s binary; see
  [Developer tooling](./developer-tooling.md).

## The key invariant: one set of use-cases, every caller

```
   Admin (apps/studio) ──signed principal──▶ api: REST ───┐
   HTTP client ───────────bearer────────▶ api: REST ───┤
   AI agent ──────────────bearer/OAuth──▶ api: /mcp ───┼─▶ application use-cases ─▶ ports ─▶ adapters
   Delivery client ───────bearer────────▶ delivery ────┤
   events ─────────────────────────────▶ engine queue ─┘
```

Because REST, MCP, delivery and the queue consumers all go through the same application
functions, validation and RBAC have one enforcement point. **An AI agent can never do something
a human API client can't**, and the reverse.

## Multi-tenancy

Each customer gets its own deployment (one registry entry, `<id>.jsonc`): its own database, object storage,
key-value store, vector index, queues, AI gateway and workers. Inside a deployment, every store and
use-case operation carries a `Scope` of `{ spaceId, environmentId }`; `(space_id, environment_id)`
leads the primary key or a unique index on every content table.

## Request flow (write → deliver)

1. The admin `POST`s to `/spaces/...` on the web origin; the gateway signs `x-cw-principal`
   (or an API client sends a CMA bearer token to `api.<domain>`).
2. The api's auth middleware resolves a `Principal`; `requireScope` authorizes it.
3. The route calls a use-case (e.g. `publishEntry`), which reads what it needs, then commits one
   database batch: the aggregate, the published read model and the **outbox row** together.
4. The response carries `x-cw-bookmark`. In `waitUntil`, the api relays the outbox onto
   `commerceworker-events`.
5. The engine consumes the event: webhooks, functions, cache tags, search shards and vectors,
   live fan-out, agents; and enqueues one purge tag for the space:environment.
6. The delivery worker purges the tag (rationed). The next CDA read misses, reads a database
   replica, and is cached again. For an asset, the engine also updates the media gate and the
   media worker purges the asset's files.

See [Events & webhooks](./events-and-webhooks.md) for the async half.

## Hooks: the synchronous write-path seam

Everything reactive goes through the **transactional outbox**: it commits with the write,
retries, and cannot fail the request. What the outbox cannot do is _change or refuse_ a write.
`HookDispatcher` (`ports/infra.ts`) is the seam for that:

| hook                  | fires                                          | mutate | veto |
| --------------------- | ---------------------------------------------- | ------ | ---- |
| `entry:beforeSave`    | `createEntry` / `updateEntry`                  | ✅     | ✅   |
| `entry:beforePublish` | in `publishEntryTx`, before the unit commits   | —      | ✅   |
| `entry:beforeTrash`   | `trashEntry`                                   | —      | ✅   |
| `entry:beforePurge`   | `purgeEntry`                                   | —      | ✅   |
| `asset:beforeCreate`  | `createAsset`, before the upload URL is minted | ✅     | ✅   |

Rules the seam holds:

- **Absent means absent.** With no dispatcher the write path is untouched.
- **A veto writes nothing.** `entry:beforePublish` runs before the unit of work commits, so a
  refusal discards the aggregate, read model and outbox row together. Hooks are pre-commit only:
  nothing can roll back after the database commits the batch.
- **Hooks never see the store**, and `entry:beforeSave` runs before normalization and
  validation. Handlers for one hook run sequentially in plugin id order, each seeing the previous
  one's mutations; the first veto wins and the rest do not run.
- **A failing handler is skipped.** One that throws, times out or fails its checksum check is
  logged and the write proceeds: a broken plugin must not make the CMS unwritable. There is no
  per-handler `reject` policy; only an explicit veto from a plugin refuses a write.

A veto with field issues surfaces as `ValidationError` (422); anything else as
`HookRejectedError` (422) naming the handler.

Hooks are registered by installing plugins. With a `PLUGIN_LOADER` binding, `wireEdge` sets
`AppContext.hooks` to `createPluginHookDispatcher` over the plugin-isolate runtime; without it,
installed plugins never execute. Manifests, grants and checksums live in the database
(`plugins`); bundle bytes in object storage at `plugins/<space>/<id>/<checksum>.js`, with the
checksum verified on every load. See [Plugins](./plugins.md#hooks).

## Why these choices

- **Edge workers split by traffic profile**: the delivery hot path is cache-first with no
  placement near the database; the api and engine make several database round-trips and run near
  the primary.
- **Ports & adapters** keep the domain testable with zero infrastructure.
- **UUIDv7 IDs** are time-ordered, always minted through the injected `IdGenerator`, never
  `crypto.randomUUID`.
- **Transactional outbox**: an event is enqueued **iff** its state change commits, because the
  outbox row rides in the same database batch.
- **Denormalized read models** (`entry_published`, `asset_published`) make a delivery read a
  single-row lookup.
- **Batched Delivery reads**: the reads one step of a Delivery request needs that don't depend on
  each other (an entry and the space config, an include level's entries, assets and renditions)
  go through `ContentStore.delivery.read`, which the database store sends as one `batch()`: one
  round trip, id lists still chunked under the 100-parameter cap. A request's `DeliveryReads`
  (`deliveryReads(ctx)`, made per request, never kept) reads the space config, content types and
  renditions once per scope, so GraphQL fields don't read them again.
- **Derived indexes off the database**: search lives in FTS5 shards in stateful edge objects, so
  search maintenance never competes with content writes for the database's single writer.
