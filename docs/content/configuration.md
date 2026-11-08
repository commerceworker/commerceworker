# Configuration

Every setting is a platform binding, a `vars` entry in an app's `wrangler.jsonc`, or a secret.
Vars and bindings are typed in `packages/platform/src/env.ts` (`EdgeEnv`, used by the api,
delivery and engine workers) and parsed in `packages/platform/src/config.ts` (`loadConfig`).
The web worker's own settings are read in `apps/studio/app/lib/*.server.ts`. Per-deployment values
(names, ids, routes, `OAUTH_ISSUER`, `MEDIA_BASE_URL`, `MEDIA_PUBLIC_URL`, `AI_GATEWAY_ID`, SSO,
email) are filled in by `scripts/fleet.ts render`; see [Deployment](./deployment.md).

**Worker** columns below: **W** web, **A** api, **D** delivery, **E** engine; the media worker
has its own section, [Media worker](#media-worker). "Template" means the var is set in that
worker's committed `wrangler.jsonc`; a var not listed there falls back to its code default.

## Adapter selection

Every binding is optional. An absent binding selects a dev fallback, and on a **persistent**
deployment (one with `DB` bound) the fail-closed guard (`assertNoFakeAdapters`) refuses to boot
behind a fake unless `ALLOW_FAKE_ADAPTERS` names it.

| Port                 | With the binding                                                           | Without it                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ContentStore`       | The database (`DB`), through a database session                            | Seeded in-memory store (demo, node route tests)                                                                                     |
| `BlobStore`          | Object storage (`MEDIA_BUCKET`) + signed `/media/*` URLs                   | `FakeBlobStore` (fake `blob`)                                                                                                       |
| `AIProvider`         | Edge inference (`AI`, `AI_PROVIDER=workers-ai`), via the AI gateway if set | Stub provider (fake `ai`)                                                                                                           |
| `EmbeddingsProvider` | Edge inference (`EMBEDDINGS_PROVIDER=workers-ai`)                          | Hash embeddings (fake `embeddings`; `local` accepts it explicitly)                                                                  |
| `VectorStore`        | The vector index (`VECTORIZE`), unless `VECTOR_STORE=kv` or `memory`       | Key-value-backed or in-memory (fake `vectors`)                                                                                      |
| `SearchIndex`        | `SearchShardDO` shards (`SEARCH`)                                          | Bounded substring scan in the store                                                                                                 |
| `Cache`              | The key-value store (`KV_CACHE`)                                           | No delivery cache                                                                                                                   |
| `Queue`              | `EVENTS_QUEUE` (+ `BULK_QUEUE`, `AGENTS_QUEUE`, `PURGE_QUEUE`)             | Outbox stays pending; no async dispatch                                                                                             |
| `EventBus` (live)    | `LIVE_HUB`                                                                 | Keepalives only                                                                                                                     |
| Plugin runtime       | Plugin isolates (`PLUGIN_LOADER`)                                          | Installed plugins never execute                                                                                                     |
| `EmailSender`        | `send_email` (`EMAIL`) + `EMAIL_FROM`                                      | `content.notify` nodes fail with a clear error; scheduler alerts are logged only; web: no password reset by email (an admin resets) |

## Bindings

| Binding                                                  | W   | A   | D   | E   | Notes                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | --- | --- | --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB` (database)                                          | ✓   | ✓   | ✓   | ✓   | One database per deployment; web uses the auth tables, delivery reads only                                                                                                                                                                                                             |
| `API` (service)                                          | ✓   |     |     |     | The api worker, for the gateway                                                                                                                                                                                                                                                        |
| `DELIVERY` (service)                                     | ✓   |     |     |     | The delivery worker, for bearer-key `/delivery/*` calls on the admin origin                                                                                                                                                                                                            |
| `KV_CACHE` (key-value)                                   |     | ✓   | ✓   | ✓   | Delivery cache, cached principals, and the media gate (`asset-gate:*`, written by the engine)                                                                                                                                                                                          |
| `MEDIA_BUCKET` (object storage)                          |     | ✓   | ✓   | ✓   | Asset bytes, import staging, plugin bundles, dead letters                                                                                                                                                                                                                              |
| `VECTORIZE`                                              |     | ✓   | ✓   | ✓   | 768-dim cosine index; dropped from a demo's rendered config                                                                                                                                                                                                                            |
| `AI` (edge inference)                                    |     | ✓   | ✓   | ✓   |                                                                                                                                                                                                                                                                                        |
| `IMAGES`                                                 |     | ✓   |     | ✓   | Transforms on `/media/*` GETs (api); image dimensions during asset ingest (`info`, engine)                                                                                                                                                                                             |
| `STREAM`                                                 |     | ✓   |     | ✓   | Video assets; absent → video routes answer 501                                                                                                                                                                                                                                         |
| `PLUGIN_LOADER` (plugin isolates)                        |     | ✓   |     | ✓   |                                                                                                                                                                                                                                                                                        |
| `EVENTS_QUEUE`, `BULK_QUEUE`, `AGENTS_QUEUE`             |     | ✓   |     | ✓   | Producers; the engine consumes all three                                                                                                                                                                                                                                               |
| `PURGE_QUEUE`                                            |     |     |     | ✓   | Producer; delivery consumes `commerceworker-purge`                                                                                                                                                                                                                                      |
| `MEDIA_PURGE_QUEUE`                                      |     |     |     | ✓   | Producer; the media worker consumes `commerceworker-media-purge`. Absent → a revoked asset's cached files stay until the cache lets them go                                                                                                                                             |
| `LIVE_HUB`, `SEARCH` (stateful objects)                  |     | ✓   | ✓   | ✓   | Classes owned by the engine; api and delivery bind by `script_name`                                                                                                                                                                                                                    |
| `AI_BUDGET` (stateful object)                            |     | ✓   |     | ✓   | `CostGuardDO`: per-space AI budget windows                                                                                                                                                                                                                                             |
| `AUTH_LIMITER` (stateful object)                         |     | ✓   |     |     | `RateLimiterDO`, owned by the engine (which has no binding of its own): failed-authentication limiter                                                                                                                                                                                  |
| `ASSISTANT_AGENT` (stateful object)                      |     | ✓   |     | ✓   | The admin's assistant, one object per person; the api forwards `/agents/assistant-agent/*`                                                                                                                                                                                             |
| `AGENT_WF`, `EDITORIAL_WF` (durable workflows)           |     | ✓   |     | ✓   | Absent `EDITORIAL_WF` → run operations answer 501                                                                                                                                                                                                                                      |
| `ASSET_INGEST_WF` (durable workflows)                    |     |     |     | ✓   | `AssetIngestWorkflow`, one run per asset file version, started by the `commerceworker-asset-events` consumer. Absent → asset events are acknowledged and nothing is ingested                                                                                                            |
| `ASSET_ZIP_WF` (durable workflows)                       |     |     |     | ✓   | `AssetZipWorkflow` (`commerceworker-asset-zip`), one run per zip download, started from `asset_zip.requested`. Absent → a requested zip fails at once with "Zip downloads are not available on this deployment"                                                                         |
| `ASSET_EVENTS_QUEUE`                                     |     | ✓   |     | ✓   | Producer onto `commerceworker-asset-events` (the api on a completed signed upload and a re-ingest; the engine for `asset_reindex` chunks); the engine consumes it (+ `-dlq`), which the media bucket's object-create notification also feeds. Absent on the api → re-ingest answers 501 |
| `EMAIL` (`send_email`)                                   | ✓   |     |     | ✓   | Added by fleet render only when the deployment sets `email`; web sends password reset codes with it                                                                                                                                                                                    |
| `METRICS` (metrics store)                                |     | ✓   | ✓   | ✓   | Absent → counters fall back to log lines                                                                                                                                                                                                                                               |
| `RATE_LIMIT_READ` / `_WRITE` / `_AI` (edge rate limiter) |     | ✓   | ✓   |     | api: 600 / 120 / 20 per 60 s, inert until a `RATE_LIMIT_*_PER_WINDOW` var is set (see [Rate limits](#rate-limits)); delivery: `RATE_LIMIT_READ` 1200 per 60 s, always applied                                                                                                          |
| `RATE_LIMIT_SHARE_UNLOCK` (edge rate limiter)            |     |     |     |     | The media worker's: 10 password attempts per 60 s per share link and client address, and per link overall (namespace `1006`, rendered per slot). Absent → attempts are limited only by PBKDF2's cost                                                                                   |
| `API_LIMIT` (edge rate limiter)                          | ✓   |     |     |     | 600 per 60 s on sign-in paths that need no session, and on SCIM                                                                                                                                                                                                                        |

## Deployment shape

| Var                      | W   | A   | D   | E   | Default                  | Purpose                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --- | --- | --- | --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROLE`                   |     | ✓   | ✓   | ✓   | `all`                    | Mounted API surfaces: `all`, `management`, `preview`, `delivery`, or a comma-separated union. Template: api `management,preview,delivery`, delivery `delivery`, engine `all`                                                                                                                                                                                                  |
| `REQUIRE_SECURE_SECRETS` |     | ✓   | ✓   | ✓   | `true` in every template | Refuse dev default tokens, short secrets and `SEED_DEV=true`. `pnpm dev` sets `false`, which also lets a content type's preview URL be `http://localhost`                                                                                                                                                                                                                                                                                         |
| `ALLOW_FAKE_ADAPTERS`    |     | ✓   |     | ✓   | empty                    | Comma-separated fakes a persistent deployment accepts: `ai`, `blob`, `embeddings`, `vectors`, or `all`                                                                                                                                                                                                                                                                        |
| `MAX_BODY_BYTES`         |     | ✓   |     |     | `5242880`                | Request body cap; oversized → 413                                                                                                                                                                                                                                                                                                                                             |
| `TRUSTED_PROXY_COUNT`    |     | ✓   |     |     | `1`                      | Only used without `cf-connecting-ip`: hops of `X-Forwarded-For` to trust                                                                                                                                                                                                                                                                                                      |
| `DATA_JURISDICTION`      |     | ✓   | ✓   | ✓   | empty                    | `eu` or `fedramp`, rendered by `fleet.ts` from the registry's `jurisdiction`. The api, delivery and engine pin every stateful-object namespace there at each entry point and in `wireEdge` (`withJurisdiction`, `packages/platform/src/env.ts`); the database and object storage carry it from creation. `fleet.ts` never renders it for web, which binds no stateful objects |
| `QUEUE_SUFFIX`           |     |     | ✓   | ✓   | empty                    | Appended to the base queue names (`commerceworker-purge<suffix>`); consumers route by queue name. Rendered by `fleet.ts` from the registry's `suffix`                                                                                                                                                                                                                          |
| `AI_GATEWAY_LOGS`        |     | ✓   | ✓   | ✓   | empty                    | `true`/`false`: whether the AI gateway logs each call (`cf-aig-collect-log`, set per call by the edge inference adapter). Prompts and answers are never logged (`cf-aig-collect-log-payload: false`). Rendered from the registry's `aiGatewayLogs` for every worker that sets `AI_GATEWAY_ID`; empty leaves the gateway's own setting                                         |

## Secrets and keys

| Secret                             | W   | A   | D   | E   | Purpose                                                                                                                                                                                                                                                              |
| ---------------------------------- | --- | --- | --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRINCIPAL_KEY`                    | ✓   | ✓   |     |     | Signs (web) and verifies (api) `x-cw-principal`. Required. Same value on web and api; the engine never holds it (it gets the derived key below)                                                                                                                      |
| `PRINCIPAL_KEY_PREVIOUS`           | ✓   | ✓   |     |     | Rotation only: accepted by the api until the web worker has moved                                                                                                                                                                                                    |
| `ASSISTANT_PRINCIPAL_KEY`          |     |     |     | ✓   | The assistant's principal key: HKDF-SHA256 of `PRINCIPAL_KEY` (`@commerceworker/security/assistant-key`), derived by CI, never set by hand. Verifies the principal signed for `/agents/*`                                                                             |
| `ASSISTANT_PRINCIPAL_KEY_PREVIOUS` |     |     |     | ✓   | Derived from `PRINCIPAL_KEY_PREVIOUS`, while a rotation finishes                                                                                                                                                                                                     |
| `DATA_KEY`                         | ✓   | ✓   | ✓   | ✓   | AES-256-GCM key sealing secrets in the database (webhook secrets, header values, secret plugin settings; web: authenticator secrets). Required on persistent deployments. Rotates only through `DATA_KEY_PREVIOUS` ([procedure](./auth-and-rbac.md#secrets-at-rest)) |
| `DATA_KEY_PREVIOUS`                | ✓   | ✓   | ✓   | ✓   | Rotation only: opens values sealed under the old key until the daily 03:30 UTC reseal has moved them                                                                                                                                                                 |
| `TOKEN_PEPPER`                     |     | ✓   | ✓   | ✓   | Mixed into every API key hash. Required. Never changes                                                                                                                                                                                                               |
| `PASSWORD_PEPPER`                  | ✓   |     |     |     | Mixed into every password hash (`pbkdf2p:`). Never change or remove once set                                                                                                                                                                                         |
| `MEDIA_SIGNING_SECRET`             |     | ✓   | ✓   | ✓   | HMAC key for `/media/*` URLs and for the token in published media URLs (made wherever `MEDIA_PUBLIC_URL` is set). Required when `MEDIA_BUCKET` is bound. The media worker holds it too, to verify both                                                               |
| `SETUP_TOKEN`                      | ✓   |     |     |     | One-time setup code redeemed at `/setup` for the first (or a recovery) administrator; its hash is recorded on use                                                                                                                                                    |
| `OIDC_CLIENT_SECRET`               | ✓   |     |     |     | The identity provider's client secret for admin SSO                                                                                                                                                                                                                  |
| `ADMIN_TOKEN`                      |     | ✓   |     |     | Root bearer token: all scopes, all spaces. Unset with `DB` bound means off; the dev default `dev-admin-token` applies only without `DB`, and is refused when secure secrets are required                                                                             |
| `SESSION_SECRET`                   |     | ✓   |     |     | Optional. Falls back to a dev string; used only to sign OAuth consent forms when no `PRINCIPAL_KEY` is set (local and test wiring). No template sets it                                                                                                              |
| `MCP_TOKEN`                        |     | ✓   |     |     | Admin bearer for `/mcp`. On a persistent deployment there is no default: without it MCP is not mounted                                                                                                                                                               |
| `STREAM_WEBHOOK_SECRET`            |     | ✓   |     |     | Enables `POST /webhooks/stream`, together with the `STREAM` binding (the route is not mounted without both)                                                                                                                                                          |

Keys are at least 32 characters (`openssl rand -hex 32`); `scripts/fleet.ts` refuses shorter
ones at deploy.

## Admin sign-in (web worker)

| Var                | Default | Purpose                                                                                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `OIDC_ISSUER`      | empty   | OpenID Connect issuer. With `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, the sign-in page offers single sign-on; admins set the rest on Team |
| `OIDC_CLIENT_ID`   | empty   | Client id the provider issued                                                                                                              |
| `OIDC_TRUST_EMAIL` | empty   | `true` when the provider omits `email_verified` for addresses it owns (Entra ID)                                                           |

Rendered from the registry's `sso` field. Passwords, passkeys, TOTP and SCIM need no vars.
Password reset by email needs the `EMAIL` binding with `EMAIL_FROM` and `EMAIL_FROM_NAME`
(empty by default), rendered from the registry's `email` field like the engine's. As on the
engine, a bound `EMAIL` without `EMAIL_FROM` is a configuration error: the web worker throws
rather than treating the deployment as sending no email.

## API keys and seeding (api, engine)

| Var                               | Default                                                           | Purpose                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CMA_KEY` / `CDA_KEY` / `CPA_KEY` | `dev-cma-key` / `dev-cda-key` / `dev-cpa-key` (only without `DB`) | Keys seeded into the in-memory store; with `DB` bound an unset one is empty. A deployment with a database gets keys from the API (`POST /spaces/:space/api-keys`) or the demo seed |
| `SEED_DEV`                        | `false`                                                           | `true` runs the idempotent `@commerceworker/seed` demo dataset on the first request per isolate; `pnpm dev` sets it. Never in production                                            |
| `SEED_SCALE`                      | `1`                                                               | Corpus multiplier: `1` ≈ 550 entries, `100` ≈ 44k                                                                                                                                  |
| `DEMO_STARTERS`                   | `false`                                                           | api only. `true` offers the enterprise starter (a large demo brand installed in the background by the engine) when a space is created; else it is a `422`. Rendered `true` for a `demo` deployment; `pnpm dev` sets it |
| `SEED_SPACE_ID`                   | `space-1`                                                         | Seed space (also MCP's default space)                                                                                                                                              |
| `SEED_ENV_ID`                     | `main`                                                            | Seed environment                                                                                                                                                                   |
| `SEED_DEFAULT_LOCALE`             | `en-US`                                                           | Seed default locale                                                                                                                                                                |
| `SEED_LOCALES`                    | `en-US`                                                           | Comma-separated seed locales                                                                                                                                                       |

## Rate limits

| Var                           | Default   | Purpose                                                                                                                              |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `RATE_LIMIT_READ_PER_WINDOW`  | `0` (off) | > 0 mounts the request-rate middleware on the api (the native bindings then enforce their own limits)                                |
| `RATE_LIMIT_WRITE_PER_WINDOW` | `0` (off) | Same, for mutations                                                                                                                  |
| `RATE_LIMIT_AI_PER_WINDOW`    | `0` (off) | Same, for model and embeddings calls (`entries/generate`, moderation, translation, alt text, AI actions, search)                     |
| `RATE_LIMIT_WINDOW_SECONDS`   | `60`      | Window, also the `Retry-After` value                                                                                                 |
| `AUTH_RATE_LIMIT_MAX`         | `10`      | Failed authentications per client IP per window before 429. Read by `RateLimiterDO` from the **engine's** env (the class runs there) |
| `AUTH_RATE_LIMIT_WINDOW_MS`   | `60000`   | Failed-auth window, read the same way                                                                                                |

The api's request-rate middleware mounts only when at least one `RATE_LIMIT_*_PER_WINDOW` var is
above 0. The `RATE_LIMIT_READ`, `_WRITE` and `_AI` bindings in `apps/api/wrangler.jsonc` (600, 120
and 20 per 60 s) then enforce the limits; with all three vars at 0 the bindings are never
consulted. No committed `wrangler.jsonc`, and no registry entry the maintainers keep, sets any of the vars, so the api
applies no per-client request limit by default; set them to turn it on. The native bindings are per
edge location and approximate. The delivery gateway is different: it always applies
`RATE_LIMIT_READ` by client IP. The web worker's `API_LIMIT` binding covers the sign-in paths that
need no session and SCIM.

## OAuth 2.1 for MCP clients (api)

| Var                               | Default                                             | Purpose                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OAUTH_ISSUER`                    | empty; rendered `https://<domain>` (the admin host) | Enables the authorization server (`/oauth/*`, `/.well-known/oauth-*`). The web gateway forwards those paths and `/mcp`, so consent uses the person's web sign-in |
| `OAUTH_RESOURCE`                  | `<issuer>/mcp`                                      | Canonical URI of the protected MCP resource (empty, as the templates declare it, means the default)                                                              |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS`  | `3600`                                              | Access-token lifetime                                                                                                                                            |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000`                                           | Refresh-token lifetime                                                                                                                                           |

Consent forms are signed with a key derived from `PRINCIPAL_KEY`. See
[Auth & RBAC](./auth-and-rbac.md#oauth-21-for-mcp-clients).

## Media (api, delivery, engine)

| Var                      | Default                                  | Purpose                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEDIA_BASE_URL`         | empty; rendered `https://api.<domain>`   | Origin for signed `/media/*` URLs; empty gives root-relative URLs                                                                                                                                                                                                                                 |
| `ASSET_UPLOAD_MAX_BYTES` | `5368709120` (5 GiB)                     | Largest file a multipart upload takes (`POST …/assets/uploads` answers `422` past it; never more than 10,000 parts of 100 MiB). One signed `PUT` still takes 100 MiB                                                                                                                              |
| `IMAGES_ZONE_ORIGIN`     | empty                                    | Zone with edge image transforms, for images not served from `MEDIA_BUCKET`                                                                                                                                                                                                                        |
| `MEDIA_PUBLIC_URL`       | empty; rendered `https://media.<domain>` | The media worker's origin (`ctx.mediaPublicUrl`). Delivered assets get their URLs there, built at read time, and Preview's signed draft URLs point there. Empty (local dev): delivered assets keep the api's signed URL, with no renditions or srcset, and the deprecated transform stays a `302` |

## Media worker

`apps/media` (`commerceworker-media`, route `media.<domain>`) reads `EdgeEnv` but binds only what
it serves from, all read-only:

| Binding / var / secret          | Notes                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB` (database)                 | Read-replica sessions (`first-unconstrained`): the gate's fallback and rendition presets                                                                                                                                  |
| `KV_CACHE` (key-value)          | The gate the engine writes (`asset-gate:<space>:<env>:<id>`), read with a 60 s `cacheTtl`. Share links are read from the database, not the key-value store                                                                |
| `MEDIA_BUCKET` (object storage) | Asset bytes                                                                                                                                                                                                               |
| `IMAGES`                        | Width steps and renditions; absent → only originals are served. Ranges need no binding: the `Media.range` RPC reads `MEDIA_BUCKET`                                                                                        |
| `METRICS` (metrics store)       | `commerceworker_media_purge_dead_letters_total`                                                                                                                                                                            |
| `RATE_LIMIT_SHARE_UNLOCK`       | Password attempts on a share link: 10 per 60 s per link and client address, and per link overall (namespace `1006`)                                                                                                       |
| `QUEUE_SUFFIX`, `ROLE=media`    | Template vars; consumers `commerceworker-media-purge` (+ `-dlq`, logged, kept and acked)                                                                                                                                         |
| `MEDIA_SIGNING_SECRET`          | Its only secret: verifies published paths' tokens and signed `/media/*` GETs (with `exp`), the share-link tokens, and signs a share link's unlock cookie. Required with `DB` bound; dev uses the dev key, as the api does |

Its `exports` put the edge cache on the `Media` entrypoint only; the default (gateway) entrypoint
is uncached.

## AI, embeddings and search

| Var                                                                                                    | W   | A   | D   | E   | Default                                    | Purpose                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | --- | --- | --- | --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                                                                                          |     | ✓   | ✓   | ✓   | `workers-ai` when `AI` is bound            | `workers-ai` is the only provider                                                                                       |
| `AI_MODE`                                                                                              |     | ✓   |     | ✓   | `live`                                     | `mock` answers every `generateJson` from its heuristic (demo, tests, `pnpm dev`)                                        |
| `AI_TIMEOUT_MS`                                                                                        |     | ✓   |     | ✓   | `20000`                                    | Per-call cap for `generateJson`                                                                                         |
| `AI_GATEWAY_ID`                                                                                        |     | ✓   | ✓   | ✓   | rendered per deployment                    | Route edge inference calls through the AI gateway; empty calls edge inference directly                                  |
| `WORKERS_AI_MODEL_FLAGSHIP`                                                                            |     | ✓   |     | ✓   | `@cf/moonshotai/kimi-k2.6`                 | Model for the `flagship` tier                                                                                           |
| `WORKERS_AI_MODEL_BALANCED`                                                                            |     | ✓   |     | ✓   | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Model for `balanced`                                                                                                    |
| `WORKERS_AI_MODEL_FAST`                                                                                |     | ✓   |     | ✓   | `@cf/zai-org/glm-4.7-flash`                | Model for `fast`                                                                                                        |
| `EMBEDDINGS_PROVIDER`                                                                                  |     | ✓   | ✓   | ✓   | `workers-ai` when `AI` is bound            | `workers-ai` or `local` (hash embeddings; `pnpm dev`). The engine indexes vectors only when it is set                   |
| `EMBEDDINGS_MODEL`                                                                                     |     | ✓   | ✓   | ✓   | `@cf/baai/bge-base-en-v1.5`                | Edge inference embeddings model                                                                                         |
| `EMBEDDINGS_DIM`                                                                                       |     | ✓   | ✓   | ✓   | `768`                                      | Must match the vector index                                                                                             |
| `VECTOR_STORE`                                                                                         |     |     |     |     | —                                          | `kv` (local stack: vectors in `KV_CACHE`, shared across workers) or `memory` (one isolate) ignore `VECTORIZE`; dev only |
| `SEARCH_SHARDS`                                                                                        |     |     |     |     | `8`                                        | Search shards per space:environment; changing it requires a reindex                                                     |
| `AI_MAX_REQUESTS_PER_WINDOW`                                                                           |     | ✓   |     | ✓   | `60`                                       | Per-space interactive AI requests per window (`CostGuardDO`); `0` disables metering                                     |
| `AI_MAX_TOKENS_PER_WINDOW`                                                                             |     | ✓   |     | ✓   | `200000`                                   | Per-space interactive AI tokens per window                                                                              |
| `AI_BUDGET_WINDOW_SECONDS`                                                                             |     | ✓   |     | ✓   | `60`                                       | Window length                                                                                                           |
| `AI_AGENT_MAX_REQUESTS_PER_WINDOW`, `AI_AGENT_MAX_TOKENS_PER_WINDOW`, `AI_AGENT_BUDGET_WINDOW_SECONDS` |     |     |     |     | the interactive values                     | Separate ceilings for background agent spend. Leave genuinely unset (an empty string counts as set)                     |

`VECTOR_STORE`, `SEARCH_SHARDS` and the `AI_AGENT_*` vars are in no template; set them per
worker when needed.

## Agents, workflows, email and plugins

| Var                             | A   | E   | Default                             | Purpose                                                                                                              |
| ------------------------------- | --- | --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `AGENT_RUNTIME`                 | ✓   | ✓   | `cloudflare-workflows` in templates | With `AGENT_WF`, on-publish agents run durably on `AgentWorkflow`; otherwise in-process                              |
| `AGENTS_ENRICH`                 | ✓   | ✓   | `false`                             | Run the enrich agent on publish                                                                                      |
| `AGENTS_MODERATE`               | ✓   | ✓   | `false`                             | Run the moderation agent on publish (post-publish; retracts flagged content)                                         |
| `AGENTS_AUTO_APPLY`             | ✓   | ✓   | `false`                             | Apply enrich proposals without review                                                                                |
| `AGENTS_MODERATE_BLOCKING`      |     |     | `false`                             | `true` runs moderation before single-entry publish and blocks flagged content                                        |
| `AGENTS_SCHEDULES`              | ✓   | ✓   | `false`                             | Run recurring agent schedules on the engine's cron                                                                   |
| `VERSION_ARCHIVE`               | ✓   | ✓   | `false`                             | Move superseded entry version bodies to the media bucket on the engine's cron (turn on once every worker reads them) |
| `AGENT_SCHEDULE_MAX_ENTRIES`    |     |     | `25`                                | Entries per scheduled run                                                                                            |
| `AGENT_SCHEDULE_MAX_RUN_TOKENS` |     |     | `100000`                            | Token cap per scheduled run                                                                                          |
| `EMAIL_FROM`, `EMAIL_FROM_NAME` | ✓   | ✓   | empty                               | Edge email sender for workflow `content.notify` nodes and the scheduler alerts; rendered from the registry's `email` |
| `PLUGIN_MIN_RELEASE_AGE_HOURS`  | ✓   | ✓   | empty                               | Minimum age of a plugin release installed from a URL; callers may ask for longer, never shorter                      |
| `PLUGIN_SOURCE_HOSTS`           | ✓   | ✓   | empty                               | Comma-separated hosts plugins may be installed from; callers may narrow, never widen                                 |

## Caches and retention

| Var                          | A   | D   | E   | Default | Purpose                                                                                            |
| ---------------------------- | --- | --- | --- | ------- | -------------------------------------------------------------------------------------------------- |
| `DELIVERY_CACHE_TTL_SECONDS` | ✓   | ✓   | ✓   | `86400` | TTL on key-value delivery-cache entries: a garbage-collection bound; tag versions decide freshness |
| `DELIVERY_LIST_TTL_SECONDS`  | ✓   | ✓   | ✓   | `3600`  | TTL for cached delivery list results                                                               |
| `EVENT_RETENTION_HOURS`      | ✓   |     | ✓   | `168`   | Relayed outbox rows and webhook deliveries older than this are pruned at the top of each hour      |

The delivery worker's HTTP cache headers (`public, max-age=60, stale-while-revalidate=86400,
stale-if-error=604800`) are fixed in `apps/delivery/src/delivery.ts`, not configurable.

## Local development values

`pnpm dev` runs the api, engine, media and delivery as auxiliary workers of the web app's Vite
session and overrides their vars with `LOCAL_STACK_VARS` (`apps/studio/vite.config.ts`).
`MEDIA_PUBLIC_URL` is left empty: the media worker runs (it consumes its purge queue) but isn't
routable from the browser, so delivered assets keep the api's signed URLs locally. The values,
the seed settings and how to reset them are in [Development](./development.md#running-locally).
