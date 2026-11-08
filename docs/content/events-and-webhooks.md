# Events, async backbone & webhooks

CommerceWorker uses a **transactional outbox** so that domain events are emitted exactly when (and
only when) their state change commits. The api worker relays new events onto queues right after
each write; the engine worker consumes them, sweeps the outbox every minute, keeps the media
worker's gate in line with what is published, and tells the delivery and media workers which cache
tags to purge.

## The pipeline

```
  publishEntry / unpublishEntry / publishContentType / setEnvironmentAlias …
        │  (ONE store.withTransaction = ONE database batch)
        ├─ write the denormalized read model (entry_published / removePublished)
        └─ outbox.append(event)                ← event is durable iff the batch commits
                                   │
        api fetch():       after each mutating request, waitUntil(drainOutbox(...))
        engine scheduled(): every minute, a cron sweep drains what a nudge missed
        ├─ outbox.readPending(N)               (60 s lease claim)
        ├─ queue.enqueueMany(topic, events)    → commerceworker-events
        │                                        (bulk.chunk_due, environment.purge_due → commerceworker-bulk)
        └─ outbox.markRelayed(ids)
                                   │
        engine queue(): consumer on commerceworker-events / commerceworker-bulk
        ├─ consumeEvent(ctx, deps, event)
             ├─ dispatchEvent
             │    ├─ webhooks  — fan out to subscribers (HMAC-signed)
             │    ├─ functions — invoke user-defined HTTP hooks (FunctionInvoker)
             │    ├─ cache     — invalidate the entry's tag + reverse-reference tags (key-value)
             │    ├─ gate      — asset.*: write or remove asset-gate:<space>:<env>:<id> (key-value)
             │    ├─ zip       — asset_zip.requested: start AssetZipWorkflow
             │    ├─ rag       — re-index (published) or delete (unpublished) embeddings
             │    └─ search    — SearchShardDO index / remove
             ├─ bus.publish(event)  →  LiveHubDO  →  Live Content SSE subscribers
             ├─ on entry.published: on-publish agents, forwarded to commerceworker-agents
             │  when that queue is bound, else run inline (runPublishAgents)
             └─ after the batch (apps/pipeline/src/purges.ts): ONE purge message with a tag per
                space:environment touched by a PURGING_EVENTS event  →  commerceworker-purge;
                ONE with the media tags (cwa:/cwr:/cwe:/cws:/cwc:)  →  commerceworker-media-purge, and
                what was revoked again 90 s later
                                   │
        delivery queue(): consumer on commerceworker-purge (concurrency 1)
        media queue():    consumer on commerceworker-media-purge (concurrency 1)
        └─ purge cache tags, ≤ 100 per call, one call per 12 s (@commerceworker/platform/purge)
                                   │
        scheduled() (every minute): runDueScheduledActions, the outbox sweep,
        stalled-bulk-job recovery, runDueAgentSchedules (AGENTS_SCHEDULES=true);
        pruneEventHistory, sweepAbandonedUploads, sweepAbandonedMultipartUploads and
        sweepExpiredZips on the top-of-hour tick
```

`EVENTS_TOPIC` is `commerceworker.events` and `BULK_TOPIC` is `commerceworker.bulk`. The
`@commerceworker/adapters/queue-cf` producer maps them onto the `EVENTS_QUEUE`
(`commerceworker-events`) and `BULK_QUEUE` (`commerceworker-bulk`) bindings. Without a
`BULK_QUEUE` binding, bulk chunks fall back to the events topic; the consumer handles both.

## Transactional outbox

The `OutboxRepo` port:

```ts
interface OutboxRepo {
  append(event: DomainEvent): Promise<void>; // same tx as the state change
  readPending(limit: number): Promise<DomainEvent[]>;
  markRelayed(eventIds: readonly string[]): Promise<void>;
}
```

In the database, the `outbox` table has a partial index on `occurred_at WHERE relayed_at IS NULL`,
so draining pending events is cheap. Because `append` is buffered into the same unit of work, and so
the same `db.batch()`, as the publish, there is **no window** where the read model is updated but
the event is lost, or vice versa.

`readPending` is a **lease claim** (`packages/store/src/store.ts`, `OUTBOX_LEASE_MS` = 60 s): one
`UPDATE … SET claimed_by, claimed_until … WHERE id IN (SELECT … pending AND (unclaimed OR lease
expired) ORDER BY occurred_at LIMIT n) RETURNING *`, executed immediately even inside a unit of
work. Concurrent relayers never receive the same row, and a relayer that dies before
`markRelayed` lets its lease lapse, so the rows become claimable again.

## Relay

`relayOutbox(ctx, queue, opts?)` (`events/relay.ts`) claims a batch of pending events (default
250), enqueues them grouped by topic, and marks them relayed. A crash between enqueue and
`markRelayed` re-sends the batch after the lease lapses, which is why consumers are idempotent.
`drainOutbox` repeats that until the outbox is empty or `maxIterations` is hit.

`drainOutbox` runs from three places:

- **Post-commit nudge** (api) — after every `POST`/`PUT`/`PATCH`/`DELETE`, inside `waitUntil`, so
  events reach the queue sub-second without delaying the response.
- **Post-batch** (engine) — after a queue batch is consumed, so events appended during consumption
  (reindex continuation slices, moderation retractions) don't wait for the cron.
- **Cron sweeper** (engine) — every minute (`* * * * *`), capped at 20 iterations; it covers a nudge lost to
  a crash or isolate eviction.

Delivery is **at-least-once**, which is why dispatch is idempotent (keyed on `event.id`).

## Dispatch

`consumeEvent(ctx, deps, event)` (`events/consume.ts`) is the queue consumer's body. The engine runs
a batch's events in lanes (`apps/pipeline/src/lanes.ts`): one lane per entry, so an entry's publish
and unpublish never overtake each other, and one per space:environment for every other event; up to
six lanes run at once, since each event spends most of its time waiting on the database, the
key-value store, the search shard and the live hub (a batch of 25 went from ~2.2 s to ~0.35 s
locally). It calls `dispatchEvent(ctx, deps, event)` (`events/dispatch.ts`), which fans out to:

1. **Webhook fan-out** — active subscribers for `event.type` in the event's environment (its own
   hooks and the space-wide ones), HMAC-signed POST, delivery log.
2. **User-defined functions** — `FunctionInvoker` POSTs to registered HTTP functions for matching
   event types (`packages/application/src/functions.ts`).
3. **Cache invalidation** (on `entry.published` / `entry.unpublished`) — tag set includes reverse
   references; `cache.invalidateTag` per tag. One tag set is shared per queue batch, so a burst of
   same-type publishes writes each tag once.
4. **RAG indexing** — `indexEntryEmbeddings` on publish, `removeEntryEmbeddings` on unpublish. The
   engine passes RAG deps only when `EMBEDDINGS_PROVIDER` is set.
5. **Lexical search index** (when `SEARCH` is bound) — the published entry's text is indexed into
   its `SearchShardDO` shard on publish and removed on unpublish.

Some event types are control messages rather than facts: `search.reindex_requested` runs one
bounded reindex slice, `bulk.chunk_due` runs one bulk-job chunk, `environment.purge_due` runs a
deleted environment's next purge steps, `entries.published_bulk` replaces N per-entry fan-outs
with one bulk-shaped fan-out. An administrator's webhook test or resend is not an event at all but
a `WebhookSendRequest` on the same queue (see [Webhooks](#webhooks)).

`DispatchDeps` is `{ sender, cache?, rag?, invoker?, onWebhookDelivery?, scheduleWebhookRetry?,
searchIndex?, blob?, invalidatedTags? }`; optional deps degrade gracefully. `onWebhookDelivery`
observes each delivery outcome (the host's metrics); `scheduleWebhookRetry` queues the delayed
retry of one webhook, and without it a failed delivery is recorded and not retried.

After dispatch, `consumeEvent` publishes the event to the scope's **`LiveHubDO`** stateful edge
object (when `LIVE_HUB` is bound), which fans it out to Live Content SSE clients
(`GET /delivery/:space/:env/live`). An `entry.published` goes out through `liveEventOf` first,
which reads the space's config and drops the locales it doesn't deliver from `fields` (webhooks
and the outbox keep the event as published). A live-publish failure is logged and never blocks
dispatch.

On `entry.published`, on-publish agents run when `AGENTS_ENRICH` / `AGENTS_MODERATE` are enabled.
With `AGENTS_QUEUE` bound, the consumer enqueues a job on `commerceworker-agents` instead of running
them inline; that consumer starts durable `AgentWorkflow` instances. See
[AI, agents & search](./ai-agents-and-search.md).

Each message is acked or retried individually, so one poison message doesn't recycle a batch.
Malformed messages are dropped (acked) with a log line. After `max_retries` (5 on
`commerceworker-events`), a message goes to `commerceworker-events-dlq`, whose consumer logs it, keeps
a record and acks it.

Every dead-letter consumer keeps its record at `dlq/<queue>/<day>/<message id>.json` in object
storage, where a lifecycle rule removes it after 30 days (`recordDeadLetters`,
`@commerceworker/platform/dead-letters`). A record holds only the keys that identify the message
(ids, type, scope, version, cache tags, an object's key), and `omitted` names the ones it left out,
so `fields`, a webhook `payload` and anything a new event adds stay out of both the record and the
log line. To recover a domain event, [replay it from the outbox](./backup-and-restore.md#replaying-events-from-the-outbox)
by its `id` while the row is kept. If the write fails, the message goes back for the queue's own
retries, then is dropped with only its log line.

### Delivery cache purges

After each `commerceworker-events` batch, the engine collects one `deliveryScopeTag` per
space:environment touched by any event in `PURGING_EVENTS` (`apps/pipeline/src/purges.ts`):
`entry.published`, `entry.unpublished`, `entries.published_bulk`, `asset.published`,
`asset.unpublished`, `asset.deleted`, `asset.rights_changed`, `asset_collection.changed` (Delivery lists a
collection's published members), `taxonomy.changed` (Delivery serves tags and concepts),
`redirects.changed` (Delivery serves the enabled redirects), `menus.changed` (Delivery serves each
menu resolved), `entry.moved` when `published` (Delivery's lists in manual order; a draft's move
purges nothing), `content_type.published` (Delivery
serves each published type's `urlPattern` at `…/routes`, the sitemap built from it, and GraphQL's schema), `content_type.deleted` (the same, for a type that is gone), `release.published`,
`environment_alias.changed`, `environment.deleted`, `space_locales.changed`. The sitemap (`…/sitemap`, `…/sitemap.xml`) has no
event of its own: it is a delivery read under the scope's tag, so the publishes that change it purge it. It sends them as **one** message on `commerceworker-purge`, so a burst
of publishes costs one tag, not one purge call per entry. An alias change carries the alias name as
`scope.environmentId`, so the alias's tag is purged; delivery responses are tagged with both the
path's environment and the one it resolves to. `asset_renditions.changed` and
`space_locales.changed` add the tag of every environment of the space (presets and locale settings
belong to the space). `asset.ingested` adds the tag only when
its `published` is true: ingest of a draft changes nothing Delivery serves. A failed enqueue is logged, counted
(`commerceworker_purge_enqueue_errors_total`) and not retried: responses then go stale for their
60 s `max-age`.

The delivery worker drains the queue at concurrency 1 (`drain`, `@commerceworker/platform/purge`): up
to 100 tags per purge call, a 12 s pause after each (the platform allows 5 calls a minute), at most
40 calls per batch; the rest, or a refused call, goes back with exponential backoff. After 10
retries a message lands in `commerceworker-purge-dlq`, whose consumer (the delivery worker) keeps a
record of the tags, counts `commerceworker_purge_dead_letters_total` and drops it. Those responses age out on their
`max-age` plus stale-while-revalidate. The cache layers these purges feed are described in
[Consistency & guarantees](./consistency.md#delivery-cache).

### Media purges and the gate

The edge cache is per worker, so the media worker's published files have their own queue. The same
batch plans them (`planPurges`): `asset.published` purges `cwa:<space>:<env>:<id>` (a republish can
move the focal point, and so a crop, under the same URL), and revokes it when it carries
`replacedVersion` (the republish put a new file in place of the old one, whose URLs must stop
working); `asset.unpublished`, `asset.deleted` and `asset.rights_changed` (an expiry caps how long a
file may be cached) revoke that tag, `asset_renditions.changed` revokes `cwr:<space>:<name>`, and
`environment.deleted` revokes `cwe:<space>:<env>`. Share pages have tags too:
`asset_collection.changed` purges `cwc:<space>:<env>:<collection>`; `asset.published`,
`asset.unpublished` and `asset.rights_changed` purge the `cwc:` tag of each collection holding the
asset (at most 100, `MAX_COLLECTIONS_PURGED`); and `asset_share.revoked` revokes
`cws:<space>:<env>:<link>`. Everything goes in one message on `commerceworker-media-purge`; what was
revoked goes again with `delaySeconds: 90` (`REVOCATION_REPURGE_SECONDS`), once the key-value
store's 60 s read cache and replica lag have passed, so a location that re-cached a file from a
stale gate read loses it too. The media worker drains it with the same `drain`; dead letters land in
`commerceworker-media-purge-dlq` and are logged and kept (`commerceworker_media_purge_dead_letters_total`).

Before that, `dispatchEvent` runs `syncAssetGate` for `asset.published`, `asset.unpublished`,
`asset.deleted` and `asset.rights_changed` when `assetGate` is bound: it reads the current published snapshot and writes
`asset-gate:<space>:<env>:<id>` (`{v, r2Key, contentType, fileName, focal, expiresAt}`) or removes
it, so a redelivered or out-of-order event converges. Nothing on a request path writes the gate.
For `asset.file_replaced` it hands the new file to ingest (`AssetIngestQueue.objectCreated`, with
the commit's `etag`), the same message an upload sends.

## Scheduled work

The engine's cron tick runs `runDueScheduledActions` (deferred publish/unpublish), so scheduled
publishing has **one-minute granularity**, and `runDueAssetExpiries`, which unpublishes every
published asset whose `rights.expiresAt` has passed (at most 100 a tick, across scopes;
`asset.unpublished` and `asset.expired` in one unit each). Its outbox events are then picked up by the sweep in the
same tick.

When `AGENTS_SCHEDULES=true`, the tick also calls `runDueAgentSchedules` to execute recurring
agent jobs over entries published since each schedule's previous run. Firings are claimed via
compare-and-swap on the schedule's `nextRunAt`, so overlapping ticks never double-run one. See
[AI, agents & search](./ai-agents-and-search.md#agent-schedules).

On the top-of-hour tick, `pruneEventHistory` trims relayed outbox rows and webhook delivery records
older than `EVENT_RETENTION_HOURS` (default 168).
The same tick runs `sweepAbandonedMultipartUploads` (multipart uploads unfinished after a day are
aborted) and `sweepExpiredZips` (archives past their day are deleted with their jobs), each recorded
in the heartbeat (`abandoned-multipart-uploads`, `expired-zips`).

Once a day, on the 04:15 UTC tick, `repairAllTaxonomies` runs `repairTaxonomy` for every
environment of every space (heartbeat job `taxonomy-repair`): it rebuilds the published usage
counts in `taxonomy_usage` from the published snapshots and gives a slug to any tag or concept
without one. The counts are kept as entries publish, in the same batch, so this is the backstop for
snapshots written without them (code older than the counts, during a deploy), not the mechanism. One
environment's failure is counted (`commerceworker_taxonomy_repair_failed_total`) and the rest go on.

## Webhooks

Register a webhook through the Management API (`POST …/webhooks`, scope `space:admin`) or the
`webhook_create` MCP tool:

```jsonc
{
  "url": "https://example.com/hook",
  "topics": ["entry.published", "entry.unpublished"], // or ["*"] for all
  "secret": "whsec_...", // HMAC signing secret
  "active": true,
  "headers": { "X-Env": "prod" }, // optional static headers
  "allEnvironments": false // optional; true = every environment's events
}
```

A webhook belongs to a space and is scoped to **one environment or all of them**:
`Webhook.environmentId` (`webhooks.environment_id`, migration `0005_webhook_environments`) is the
environment's id, or `null` for space-wide. A hook created under `/environments/{env}` is scoped to
that (resolved) environment; `allEnvironments: true` makes it space-wide. On update,
`allEnvironments: true` sets `null`, `false` sets the route's environment, and omitting it keeps the
current scope (`updateWebhook`, `packages/application/src/webhooks.ts`). Rows from before 0005 are
`NULL`, so they stay space-wide.

A hook is never pinned to an alias's resolved target: after the alias was repointed it would stop
hearing the environment it was meant for, and the purge of the old target would delete it. Both
surfaces hand the use-case the environment name as given (`WebhookRequest.requestedEnvironment`:
the route's raw `:env`, or the MCP wrapper's pre-resolution `environment`, kept in a `WeakMap`
keyed by the resolved args); a name that differs from `scope.environmentId` was an alias (an alias
can't share an environment's name). Under an alias, create with `allEnvironments` omitted makes the
hook space-wide, and `allEnvironments: false` on create or update is a `ValidationError` (422)
asking for a concrete environment id or `allEnvironments: true`.

Every `WebhookRepo` read, update and delete sees the hooks the scope's environment covers:
`space_id = ? AND (environment_id IS NULL OR environment_id = ?)` (`webhookVisibleIn` in
`packages/store/src/store.ts`; `coversEnvironment` in the domain for the in-memory store). So the list
under an environment returns its hooks plus the space-wide ones, another environment's hook is a
404, and `listByTopic(event.scope, type)` delivers an event only to its environment's hooks and the
space-wide ones. A space-wide hook still gets every environment's events, so its receiver filters
on `scope.environmentId` if it cares; `environment_alias.changed` (whose scope names the alias)
reaches only space-wide hooks. A retry re-reads the hook through `listByTopic`, so one rescoped
away from the event's environment gets no further attempts. The environment purge deletes the hooks
scoped to the environment (`webhooks` is in `ENVIRONMENT_SCOPED_TABLES`; a `NULL` row never matches);
their delivery rows are left to the retention sweep. The environment's own `environment.deleted`
events race that purge, so a hook scoped to it may or may not receive them: they are reliably
delivered only to space-wide hooks.

Webhooks are not part of environment snapshots (export, import, clone): their secrets are
credentials.

`url` is screened on create and update with `assertSafeExternalUrl`
(`packages/application/src/url-safety.ts`, shared with function endpoints): `http`/`https` only,
and no loopback, link-local or private literal address, `localhost`, `*.local` or `*.internal`
(a `ValidationError`, 422). It is DNS-free, so the sender complements it by not following
redirects.

Routes and MCP tools (all scope `space:admin`; `packages/http/src/api/routes/management/webhooks.ts`
and `packages/http/src/mcp/tools/webhooks.ts`, on the same use-cases and body schemas). Both return the hook
without its `secret` or `headers`; the secret is the caller's own and is never echoed:

| Operation  | Route                                                   | MCP tool             |
| ---------- | --------------------------------------------------------- | -------------------- |
| List       | `GET …/webhooks`                                        | `webhooks_list`      |
| Create     | `POST …/webhooks` (201)                                 | `webhook_create`     |
| Update     | `PUT …/webhooks/:id` (partial; omitted fields are kept) | `webhook_update`     |
| Delete     | `DELETE …/webhooks/:id` (204)                           | `webhook_delete`     |
| Deliveries | `GET …/webhooks/:id/deliveries?limit=`                  | `webhook_deliveries` |
| Test       | `POST …/webhooks/:id/test` (202)                        | `webhook_test`       |
| Resend     | `POST …/webhooks/:id/deliveries/:deliveryId/resend` (202) | `webhook_resend`   |

The `WebhookSender` (`createWebhookSender` in `@commerceworker/adapters/http-effects`) signs
`<timestamp>.<body>` with HMAC-SHA256 using the webhook's `secret` and POSTs the JSON payload with
`x-commerceworker-signature: sha256=<hex>`, `x-commerceworker-timestamp`, and
`x-commerceworker-event` and `x-commerceworker-event-id` headers (and `x-commerceworker-resend-of` on
a resend). Receivers should dedupe on the event id: a retry and a resend carry the same one.
Redirects are not followed and each attempt times out after 10 s.
The `secret` and every header value are encrypted at rest under `DATA_KEY` (see
[Auth → Secrets at rest](./auth-and-rbac.md#secrets-at-rest)); the dispatcher reads them decrypted.
Each attempt is logged as a `webhook_deliveries` row with its attempt number. A failed delivery
is retried **for that webhook alone**: dispatch hands it to `scheduleWebhookRetry`, and the engine
enqueues a `webhook.retry` message on the events queue with a delay, so a down receiver neither
loses the event nor re-drives the rest of the dispatch (cache purges, indexing, other webhooks).
The engine's consumer re-sends it (`redeliverWebhook`) with backoff of 30 s, 2 min, 8 min, 32 min,
~2 h, then 6 h, up to `WEBHOOK_MAX_ATTEMPTS` (8, about a day), after which the last failed row is
the record. A webhook deleted, deactivated or unsubscribed in the meantime gets nothing. Receivers
should dedupe on the event `id`, since a retry can follow a delivery whose response was lost.
A bulk publish's chunk is retried the same way. A per-entry subscriber gets one delivery row per
chunk, and a retry of **only the entries that failed**: the `webhook.retry` message carries the
`entries.published_bulk` event cut down to them, the retry re-reads their published snapshots
(skipping any unpublished since), sends each again with the same derived id
(`${jobId}:${chunkId}:${entryId}`), and narrows the next retry to what still fails. A subscriber
to `entries.published_bulk` itself gets the bulk event again.

Each delivery row also records the event's `eventType` (null on rows from before migration 0022)
and, for a resend, `resendOf`: the id of the row it resent.

**Tests and resends** (`sendWebhookTest`, `resendWebhookDelivery` in
`packages/application/src/webhooks.ts`) are what an administrator asks for. Both append a
`WebhookSendRequest` (`packages/domain/src/webhook/webhook.ts`) to the outbox, and the request
returns 202 with `{ webhookId, eventId, eventType, resendOf? }`. A send request is not a domain
event: it has `kind: 'webhook.send'` and no `type` (its outbox row's `type` column is the kind), so
the relay routes it to `commerceworker-events` and the engine hands it to `deliverWebhookRequest`;
an engine without that branch (a rollback) drops it at `isDomainEvent` as malformed, so it never
reaches topic fan-out, functions or the live bus. Both screen the hook's URL again
(`assertSafeExternalUrl`, as at create) and reach one hook only, whatever its topics and even
while it is paused; each is **one attempt, never retried**. A test carries its `webhook.test`
event (the hook's id and a fixed `message`), and the row's id is the event's. A resend carries
only `{ deliveryId, eventId }`, so its queue message stays small: the engine reads the event back
from the outbox when it sends (`OutboxRepo.get`, scoped to the space by the payload's own
`scope`), sends it with the same `id`, signs it with the time it is sent (`WebhookSender.send`'s
`timestamp`), adds `x-commerceworker-resend-of: <deliveryId>`, and logs the attempt with
`resendOf`. A bulk chunk goes to a per-entry subscriber entry by entry from the entries' published
snapshots as they are now, as a retry does. An event swept between the request and the send, or
a publish chunk none of whose entries is still published, is logged as a failed attempt rather
than dropped. The outbox and the delivery log are trimmed on the same retention window
(`pruneEventHistory`) but by different clocks (relay time, attempt time), so a delivery still in
the log can already have lost its event: that resend is a **409**. A hook deleted (or scoped
away) before the engine gets to it gets nothing; a redelivered request sends again, with the same
event id. During a mixed-version deploy or an engine rollback, a test or resend can be accepted
(202) by the api and then dropped by an engine without the send-request branch, with no log row.
A resend whose hook no longer covers the event's environment (rescoped since) is logged as a
failed attempt.

### Event payloads

Domain events (`packages/domain/src/events.ts`):

| `type`                                                                             | Payload (besides `id`, `scope`, `occurredAt`)                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry.published`                                                                  | `entryId`, `contentTypeApiId`, `version`, `fields`                                                                                                                                                                   |
| `entry.unpublished`                                                                | `entryId`, `contentTypeApiId`                                                                                                                                                                                        |
| `entries.published_bulk`                                                           | `jobId`, `chunkId`, `action` (`publish` / `unpublish`), `entryIds`                                                                                                                                                   |
| `asset.published`                                                                  | `assetId`, `replacedVersion` (only when the publish delivered a new file in place of that version)                                                                                                                   |
| `asset.unpublished`                                                                | `assetId` (also when a published asset is archived or deleted)                                                                                                                                                       |
| `asset.deleted`                                                                    | `assetId`, `r2Key` or `videoId` (the engine removes those bytes)                                                                                                                                                     |
| `asset.file_replaced`                                                              | `assetId`, `version`, `previousVersion`, `r2Key`, `etag`, `restoredFrom` (a restore) (the draft's file changed; Delivery keeps the published one until a republish)                                                  |
| `asset.rights_changed`                                                             | `assetId` (a published asset's rights changed, and with them the delivered credit, license and expiry)                                                                                                               |
| `asset.expired`                                                                    | `assetId`, `expiresAt` (the expiry sweep unpublished it; sent with `asset.unpublished`)                                                                                                                              |
| `asset.ingested`                                                                   | `assetId`, `version`, `published`, `contentHash` (absent over 512 MiB), `duplicateOf` (ingest finished a file version: hashed, measured, enriched where empty, indexed)                                              |
| `asset_renditions.changed`                                                         | `name` (a space's rendition preset was created, replaced or deleted; every environment of the space is purged; `scope` is the environment it was changed through, so other environments' scoped hooks don't hear it) |
| `space_locales.changed`                                                            | `undelivered` (the locales Delivery no longer serves; a space's locale settings changed, and every environment of the space is purged, in Delivery's cache and at the edge) |
| `asset_collection.changed`                                                         | `collectionId` (a collection was created, renamed or deleted, or its members were added, removed or reordered; also sent for each collection a deleted asset leaves; Delivery's collection read and every share page that shows it are purged) |
| `asset_share.created` / `asset_share.revoked`                                      | `linkId` (the media origin reads the link's row itself; a revoke purges its cached page, now and after 90 s) |
| `taxonomy.changed`                                                                 | `termKind` (`tag` or `concept`), `termId` (a tag or concept was created, changed or deleted; Delivery's taxonomy reads are purged with the scope's tag) |
| `asset_zip.requested`                                                              | `jobId` (a control event: the engine starts `AssetZipWorkflow`, or fails the job when `ASSET_ZIP_WF` is unbound; no webhooks apply) |
| `redirects.changed`                                                                | `count` (redirects written or removed by a create, update, delete, import, chain collapse or snapshot import; Delivery's `redirects` reads are purged. A publish whose slug change writes redirects does not send it: its `entry.published` purges the same responses) |
| `menus.changed`                                                                    | `menuId?`, `handle?` (a menu was created, saved, moved or deleted; both absent when a snapshot import wrote several; Delivery's `menus` reads are purged. A publish or unpublish that changes what a menu resolves to does not send it: its entry event purges the same responses) |
| `entry.moved` | `entryId`, `contentTypeApiId`, `position`, `published` (an entry moved in its type's manual order, `order=sys.position`; live, no version; Delivery is purged when `published`, and the type's cached lists are invalidated) |
| `content_type.published`                                                           | `contentTypeApiId`, `version`                                                                                                                                                                                        |
| `content_type.deleted`                                                             | `contentTypeApiId`, `version` (the type had no entries left, the trash included; Delivery's responses are purged, and cached lists of the type and the scope's renders invalidated; on the live stream for keys that may read the type) |
| `release.published`                                                                | `releaseId`, `entryIds`                                                                                                                                                                                              |
| `environment_alias.changed`                                                        | `targetEnvironmentId` (null when removed); `scope.environmentId` is the alias                                                                                                                                        |
| `environment.deleted`                                                              | `entryIds` (published entries whose search documents and vectors go; chunks of 500)                                                                                                                                  |
| `promotion.awaiting_approval`                                                      | `promotionId`, `source`, `requestedBy`, `reasons` (`scope` is the target environment)                                                                                                                                |
| `environment.promoted`                                                             | `promotionId`, `source`, `contentTypes`, `entries` (counts; `scope` is the target environment)                                                                                                                       |
| `bulk.job_completed`                                                               | `jobId`, `action` (`publish` / `unpublish` / `trash` / `restore` / `purge` / `import` / `asset_reindex` / `asset_move` / `asset_tag` / `asset_publish` / `asset_unpublish` / `asset_archive` / `content_type_delete` / `set_fields` / `starter_install`), `total`, `succeeded`, `failed`                        |
| `workflow_run.completed` / `.declined` / `.cancelled` / `.failed` / `.rolled_back` | `runId`, `workflowId`, `version`, `entryId`, `contentTypeApiId`, `reason`                                                                                                                                            |
| `workflow.task_opened`                                                             | `taskId`, `runId`, `nodeId`, `kind` (`approval` / `event` / `review`), `entryId`, `contentTypeApiId`, `title`, `assignee` (or null), `requiredScope` (or null), `deadline`                                           |
| `workflow.webhook`                                                                 | `runId`, `nodeId`, `entryId`, `payload`                                                                                                                                                                              |
| `search.reindex_requested`                                                         | `contentTypeApiId?`, `afterEntryId?`, `entriesSoFar?` (control message; the last two only on self-enqueued continuation slices)                                                                                      |
| `bulk.chunk_due`                                                                   | `jobId`, `chunkId` (control message, routed to `commerceworker-bulk`)                                                                                                                                                 |
| `environment.purge_due`                                                            | none: `scope` is the deleted environment (control message, routed to `commerceworker-bulk`; runs its next purge steps)                                                                                                |
| `webhook.test`                                                                     | `webhookId`, `message` (an administrator's test: sent to that webhook only, once; travels inside a `WebhookSendRequest`, never appended or fanned out on its own)                                                     |
| `invite.email_due`                                                                 | `inviteId`, `version`, `origin` (control message: the engine emails the link when the deployment sends email; no token, no address, no webhooks; `scope` is `*`)                                                     |

## Queue adapter

`createCfQueueProducer` (`@commerceworker/adapters/queue-cf`) implements the producer side of the
`Queue` port over queue bindings, one binding per topic. Retries, backoff and
dead-lettering are queue configuration in `apps/pipeline/wrangler.jsonc` and
`apps/delivery/wrangler.jsonc` and `apps/media/wrangler.jsonc` (`max_retries`, `retry_delay`, `dead_letter_queue`), not code.
The platform's queues have no producer-side dedupe, so consumers stay idempotent on the event id.

| Queue                       | Producer    | Consumer | Batch / concurrency / retries  |
| --------------------------- | ----------- | -------- | ------------------------------ |
| `commerceworker-events`      | api, engine | engine   | 25 / 10 / 5 → events DLQ       |
| `commerceworker-bulk`        | api, engine | engine   | 1 / 10 / 5 → events DLQ        |
| `commerceworker-agents`      | api, engine | engine   | 25 / 4 / 3 → events DLQ        |
| `commerceworker-events-dlq`  | (queues)    | engine   | logged, kept and acked         |
| `commerceworker-purge`       | engine      | delivery | 100 / 1 / 10 → purge DLQ       |
| `commerceworker-media-purge` | engine      | media    | 100 / 1 / 10 → media purge DLQ |
| `commerceworker-purge-dlq`   | (queues)    | delivery | logged, kept and dropped       |
