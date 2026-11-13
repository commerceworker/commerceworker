# Operations

Run the fleet: one CommerceWorker deployment per customer, each with its own Workers, D1 database, R2
bucket, AI Gateway, domain and secrets, all in CommerceWorker's Cloudflare account and all deployed by
CI.

Everything lives on one Cloudflare zone, `commerceworker.com`:

| Host | Serves |
|---|---|
| `commerceworker.com`, `www.commerceworker.com` | The marketing site (`apps/marketing`, static assets; `www` names the apex as canonical). The apex's MX stays with company mail |
| `docs.commerceworker.com` | The public docs (`apps/docs`) |
| `app.commerceworker.com` | CommerceWorker's own deployment (`deployments/commerceworker.jsonc`) |
| `shop.commerceworker.com` | Its storefront (the registry's `storefrontDomain`): buyers' cart pages and agentic checkout (UCP), uncached and with no admin |
| `catalog.commerceworker.com` | Its public catalog API (the registry's `catalogDomain`) |
| `demo.commerceworker.com` | The public demo |
| `<id>.commerceworker.com`, `shop.<id>.commerceworker.com`, `catalog.<id>.commerceworker.com` | A customer's deployment, its storefront and its catalog API |
| `studio.<host>`, `api.<host>`, `cdn.<host>`, `media.<host>` | The content stack, only for a deployment whose entry has `"content": true` ([The content stack](#the-content-stack)): the content admin, the Content Management and Preview API (REST, MCP, OAuth), published content (delivery's content side; its catalog stays on `catalog.<host>`) and the assets service. Others keep product media on their own DAM or CDN |

Order intake mail goes to `orders@`, `po@` and `purchasing@` at each deployment's own host (`orders@app.commerceworker.com`, `orders@<id>.commerceworker.com`). Email Routing is enabled per subdomain, so it never takes the apex's MX.

Session cookies are host-only (`__Host-` prefix, no `Domain`), so one deployment can't set or read another's. Every host on the zone is still the same site to a browser, which is why `SameSite=Lax` alone doesn't separate customers. Requests that change state also check `Origin` (`apps/web/app/lib/origin.ts`). Nothing but CommerceWorker's own code is served on the zone. Turn on DNSSEC, and set CAA records to the certificate authorities Cloudflare issues from.

A deployment shares nothing with another: not data, not secrets, not rate-limit counters. Isolating
a customer, choosing where their data lives and removing them are all per-deployment operations.
CommerceWorker itself (`app.commerceworker.com`) is a deployment like the others, the one in the `internal` ring.

## The registry

Each deployment is a file, `deployments/<id>.jsonc`. `scripts/fleet.ts` reads them.

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Lowercase letters, digits and dashes; matches the file name. Names that would read as part of CommerceWorker (`api`, `app`, `docs`, `www`, `staging` and the rest of `RESERVED` in `scripts/fleet.ts`) are refused unless the entry sets `domain` |
| `ring` | required | `staging`, `internal`, `canary` or `general`: when CI deploys it (see [Rings](#rings)) |
| `slot` | required | A number from 1 to 999, unique across the fleet. Rate-limit namespaces are per account, so the web Worker's are `<slot>001` through `<slot>005` (slot 1: `1001` to `1005`) and the storefront's `<slot>006` to `<slot>010` (`1006` to `1010`); the content Workers' sit at 500 above (`<slot>501` to `<slot>506`: slot 1 `1501` to `1506`) so no counter is shared |
| `domain` | `<id>.commerceworker.com` | The web app's custom domain |
| `catalogDomain` | `catalog.<domain>` | The public catalog API's custom domain, served by `commerceworker-delivery` (a host name; anything else is refused). Rendered into its `routes`, and into the deploy's `CATALOG_DOMAIN`, which the smoke test requests |
| `storefrontDomain` | `shop.<domain>` | The storefront's custom domain, served by `commerceworker-storefront` (a host name; anything else is refused): buyers' cart pages, their cart's files and product search, and UCP's `/.well-known/ucp` and `/ucp/*`. Rendered into its `routes`, into the engine's `STOREFRONT_ORIGIN` (where an external cart's start link is) and `OWN_HOSTS` (a cart's return never posts to it), into the web Worker's `STOREFRONT_ORIGIN` (where a plugin may send a buyer) and into the deploy's `STOREFRONT_DOMAIN`, which the smoke test requests |
| `content` | `false` | `true` or `false` (a boolean). Turns on the content stack for this deployment: published content and the assets service, each Worker with a separate content database. Off, the deployment renders, provisions and deploys exactly what it did before the field existed. See [The content stack](#the-content-stack) |
| `studioDomain`, `apiDomain`, `cdnDomain`, `mediaDomain` | `studio.<domain>`, `api.<domain>`, `cdn.<domain>`, `media.<domain>` | The content stack's hosts (host names; anything else is refused): the studio (content admin and human sign-in), the api, delivery's content side and the assets service. **Only with `content: true`**: setting one with it off is refused. No two hosts of a deployment may be the same, and no host may serve two deployments |
| `mediaScope` | `{ "space": "space-1", "environment": "main" }` | The content space and environment a product's `asset:<assetId>` reference resolves in (the media Worker's `/a/` route), rendered as `ASSET_REF_SPACE` and `ASSET_REF_ENV` on `apps/media` (the base config holds the defaults). One scope per deployment. Only with `content: true`; each is a space or environment id |
| `contentD1Id`, `contentKvId` | none | The content database's id and the content cache's KV namespace id (32 hex characters), written by `scripts/provision.sh` (`fleet.ts set-content-d1`, `set-content-kv`). Only with `content: true`; required to render the content Workers or to deploy (the plan stops without them, like `d1Id`) |
| `suffix` | `-<id>` | Added to every resource name. `commerceworker` uses `""`, so its resources keep the base names |
| `environment` | `deploy-<id>` | The GitHub environment holding the deployment's secrets. `commerceworker` uses `production` |
| `d1Id` | none | The D1 database's id, written by `scripts/provision.sh`. Every resource id in the registry (`d1Id`, `catalogKvId`, `contentD1Id`, `contentKvId` and each plugin's `d1Id`) belongs to one deployment: the fleet refuses to load two entries, or one entry twice, that share an id, which is what a copied registry file with a stale id would do. Provision the new deployment instead of copying ids |
| `standbyD1Id` | none | The standby D1 database's id (`commerceworker-standby<suffix>`), written by `scripts/provision.sh` (`fleet.ts set-standby-d1`). Only with `redundancy`, and never the same database as `d1Id` (refused: a restore wipes it). Required to render the engine's config or to deploy with `redundancy` (the plan stops without it, like `d1Id`) |
| `catalogKvId` | none | The id (32 hex characters; anything else is refused) of the catalog's KV namespace of listing cards, written by `scripts/provision.sh` (`fleet.ts set-catalog-kv`). Like `d1Id` (which the catalog's config also binds as its `DB`), required to render the catalog's config or to deploy |
| `jurisdiction` | none | `eu` or `fedramp`: where D1 and R2 (the docs and the catalog's buckets) keep data, set when they are created, and where the engine's Durable Objects (`OrderAgent`, `AssistantAgent`, `A2AAgent`) and the catalog's (`CatalogShard`, `CatalogMeta`, `CatalogFeeds`, `ListingIndexer`, `SearchShard`, `CatalogPublisher`) are created. Rendered into the engine's and the catalog's `DATA_JURISDICTION`; `renderEngine` and `renderCatalog` omit it when unset, leaving the base `""`. KV has no jurisdictions. Fixed for a deployment's life: see [Data residency](data-model.md#data-residency) |
| `limits` | none | Requests a minute per caller, replacing the base budgets it names: `api` (`/api/v1`, 600), `agents` (each of `/mcp` and `/a2a`, and each UCP platform's checkout calls, 300), `catalog` (each UCP platform's catalog search and lookup, 120), `webhooks` (each integration, 1,200). For example `"limits": { "webhooks": 6000 }` for a customer whose ERP sends in bursts |
| `auditRetentionDays` | `400` | Whole days audit events are kept before the daily sweep archives them to the R2 bucket and deletes them; at least 90 (refused below). Rendered into the engine's `AUDIT_RETENTION_DAYS` |
| `personalDataRetentionDays` | none (kept) | Whole days after an order finishes that the daily sweep erases its buyer's personal data; at least 30 (refused below). Rendered into the engine's `PERSONAL_DATA_RETENTION_DAYS`; see [Retention](data-model.md#personal-data-on-finished-orders) |
| `auditArchiveDays` | none (kept) | Whole days (at least 1; refused below) the R2 archive keeps audit events. `provision.sh` replaces the bucket's lifecycle rule `audit-archive` (prefix `audit/`) with that expiry on every run, and removes it when unset. It also locks `audit/` for the same number of days, or indefinitely when unset ([Bucket locks](#bucket-locks)) |
| `catalogBackupDays` | `90` | Whole days (at least 31, so a backup outlives Durable Objects' 30 days of point-in-time recovery; refused below or fractional) the catalog's daily backups are kept. `provision.sh` replaces the catalog bucket's lifecycle rule `backups` (prefix `backups/`) with that expiry, and its lock rule `catalog-backups` with the same age, on every run ([Catalog backups](#catalog-backups), [Bucket locks](#bucket-locks)) |
| `redundancy` | none (off) | `true`, or `{ "backupDays"?, "backupHourUtc"?, "drill"?, "except"?, "alerts"?, "offsite"? }`. Turns on the commerce D1's daily backup and its restore drill ([Redundancy](#redundancy)); off, the deployment renders, provisions and deploys exactly what it did before the field existed. `backupDays`: whole days (default 35, at least 31 so a backup outlives Time Travel's 30; refused above `personalDataRetentionDays`, which would keep personal data the sweep erased; the default is lowered to `personalDataRetentionDays` when that is shorter) a backup is kept and locked. `backupHourUtc`: the hour, 0 to 23 UTC, the daily backup starts (default 1). `drill`: `weekly` (Sundays) or `monthly` (the 1st), six hours after the backup's hour (default `weekly`). `except`: parts to leave off, from `d1Backup`, `objectBackup`, `r2Replica`, `kvBackup`, `queues`, `email`, `intake`, `aiFallback`, `alerts`, `canary`, `readReplicas`; today `d1Backup` (turns off the backup, the drill and the standby), `objectBackup` (turns off the Durable Object copy, restore and drill; the backups bucket stays while either `d1Backup` or `objectBackup` is on), `r2Replica` (turns off the docs replica, its queues and its reconcile) and `alerts` (turns off the alert policies and Health Checks) do something, and the rest are reserved for what comes later. `alerts` (`{ "webhook"?: "https://…", "pagerduty"?: "<routing key>" }`) makes the notification policies, the webhook and PagerDuty destinations and two Health Checks when `provision.sh` runs ([Alerting](#alerting)); `offsite` (`{ "provider": "s3" \| "gcs" \| "azure", "bucket", "region" }`) is parsed and validated now but **not acted on yet**. An unknown key or `except` name, a `backupDays` out of range, an `offsite.provider` that is none of those three, and the field on a `demo` are refused. `commerceworker` sets `true` |
| `logRetentionDays` | `400`, or `personalDataRetentionDays` when set | Whole days (at least 30; refused below or fractional, and refused above `personalDataRetentionDays` when that is set) the logs bucket `commerceworker-logs<suffix>` keeps the Workers' trace events Logpush writes there. `provision.sh` replaces the bucket's lifecycle rule `logs` (prefix `workers/`) with that expiry on every run ([Logs](#logs)) |
| `aiPersonalData` | `redact` | `redact` or `send` (anything else is refused). `send` lets the workflow AI nodes and the assistant's `assess_order` see buyers' contact details, names and addresses; see [Personal data](data-model.md#personal-data). Rendered into the engine's `AI_PERSONAL_DATA` |
| `payments` | `mock` on staging and internal entries with no `storefrontDomain`; otherwise required | `stripe` or `mock` (anything else is refused). `stripe` takes payments through Stripe with the environment's `STRIPE_SECRET_KEY`, and a deploy without that secret stops before it migrates anything. `mock` records payments without taking money. An unset field renders `mock`, so the fleet refuses to load an entry that leaves it out when it is on the `canary` or `general` ring, or has a `storefrontDomain` (a demo is exempt and is always `mock`): the error names the file and the two choices. `mock` is a deliberate choice for staging and internal deployments and canary trials, and is refused on `general`. A demo can't be `stripe`. Rendered into the engine's `PAYMENTS_MODE`. There is no `none` for an on-account deployment with no cards yet |
| `stripePublishableKey` | none | The Stripe publishable key (`pk_test_…` or `pk_live_…`) of the same account and mode as `STRIPE_SECRET_KEY`; only with `payments` `stripe`, and a deploy whose secret key is in the other mode stops. Agentic checkout gives it to platforms to tokenize cards with, and the storefront's hosted checkout takes cards with it, so the entry also needs a `turnstileSiteKey` (the fleet refuses it without one). Rendered into the engine's `STRIPE_PUBLISHABLE_KEY` |
| `assistantDailyTokens` | `1000000` | Whole number of model tokens each person's assistant conversations may use per UTC day; `0` is no limit (negative or fractional is refused). Rendered into the engine's `ASSISTANT_DAILY_TOKENS` |
| `aiGatewayLogs` | `false` | `true` or `false` (a boolean). Whether the deployment's AI Gateway keeps request logs (model, tokens, cost, duration and metadata, until they're deleted). They never hold the prompts or responses: every call sends `cf-aig-collect-log-payload: false`. Reviewers' verdicts on AI gates are sent as feedback on these entries ([Architecture](architecture.md)), so with logs off there is nothing to evaluate models against. Rendered into the engine's `AI_GATEWAY_LOGS`, which every model call sends as the gateway's `collectLog`; `provision.sh` also sets it as the default of a gateway it creates |
| `fxCurrencies` | none | A list of ISO 4217 codes other than `USD`, such as `["EUR", "GBP", "CAD"]`. The currencies the deployment sells in: the engine's daily cron (`30 3 * * *`) fetches the ECB's reference rates (`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`, public, no account) and writes these currencies' rates per one USD into `fx_rates`, adding a currency that had none. A feed that can't be fetched or read, or whose US dollar is outside 0.5–2 per euro (`USD_PER_EUR_BOUNDS`, a bad publish rather than a market move), leaves the rates as they were. The refresh runs whatever the cron's other daily jobs do, and a failure of any of them still fails the invocation. Rendered into the engine's `FX_CURRENCIES`. Orders in a currency without a rate are refused, so naming one here is what lets them through (from the day after it's added). An admin can set a rate by hand (the Commerce page's Exchange rates table, `POST /api/v1/fx-rates/:currency` or MCP's `set_fx_rate`; only for a currency that has a rate or is named here, never USD, within `FX_RATE_BOUNDS`). A rate a person set on the Commerce page, over REST or MCP holds until someone changes it: the refresh skips it and keeps the other currencies current (`REFRESH_OVERWRITES` in `packages/core/src/fx.ts`).; a rate for a currency not named here is never refreshed and holds until changed. Orders already priced keep their `fxRate` either way |
| `sso` | none | `{ "issuer": "https://…", "clientId": "…", "trustEmail"?: true }`: the customer's OpenID Connect identity provider and this deployment's client id; the issuer must be an https URL and the client id non-empty (refused otherwise). `trustEmail` (for Entra ID, which leaves out `email_verified`) lets a token without the claim match people by email. Rendered into the web Worker's `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_TRUST_EMAIL`; the client secret is the environment's `OIDC_CLIENT_SECRET`. See [Single sign-on](#single-sign-on) |
| `email` | none | `{ "from": "orders@mail.example.com", "fromName"?: "Example Shop", "fallbackFrom"?: "orders@backup.example.net" }`: where the engine's email goes from. `fallbackFrom` is a second sender on a second onboarded domain (never `from`'s own: the same domain fails the same way): the engine tries it when `from`'s is refused as not verified or Email Sending fails ([A fallback sender](#a-fallback-sender)); it renders a second binding (`EMAIL_FALLBACK`) and `EMAIL_FALLBACK_FROM`. With `redundancy` (and `email` not in `except`) mail goes through a queue with retries ([The mail queue](#the-mail-queue)). `from` `from` must be an address (anything else is refused) on a domain onboarded to Email Sending ([Email sending](#email-sending)); `fromName` a plain display name. Renders the engine's `send_email` binding (`EMAIL`) and its `EMAIL_FROM` and `EMAIL_FROM_NAME` (always set, empty without `email`). Without it the engine sends no email, and an order's confirmation is recorded unsent and says so |
| `turnstileSiteKey` | none | The public site key (`0x…`; Cloudflare's `1x`–`3x` test keys, which pass or fail whoever solves them, only on a `demo`; anything else is refused) of the deployment's Turnstile widget. Rendered into the web Worker's `TURNSTILE_SITE_KEY` (always, empty without one), which puts a Turnstile challenge on password sign-in and `/setup`. A deploy stops before it migrates anything when the environment lacks `TURNSTILE_SECRET_KEY`. See [Turnstile](#turnstile) |
| `plugins` | none | `{ "<plugin id>": { "alias": "/<segment>/", "d1Id": "…", "personalData": "send", "capabilities": ["orders:start"], "runtime": "sandboxed", "secrets": ["API_KEY"] } }`: the plugins (`plugins/<id>/`) this deployment installs. `runtime` is `worker` (the default) or `sandboxed`. A `worker` plugin is its own Worker `commerceworker-plugin-<id><suffix>` and D1 database of the same name, bound to the engine and web Workers as `PLUGIN_<ID>`; `d1Id` is written by `scripts/provision.sh` (`fleet.ts set-plugin-d1`) and required to deploy. A `sandboxed` plugin has no Worker, binding or database: CI publishes its bundle and the engine loads it (Worker Loader), and a `d1Id` on one is refused. `personalData` is optional and can only be `"send"`: it grants the plugin buyer details, which its manifest can ask for but not give itself; it is rendered into the engine's `PLUGIN_GRANTS`. `alias` is another path the plugin's pages answer at, besides `/plugins/<id>/` (commerceworker.com gives punchout `/punchout/`): one lowercase segment, not one of the app's own top-level paths (`RESERVED_PATH_SEGMENTS` in `scripts/fleet.ts`, which `fleet.test.ts` checks against `apps/web/app/routes.ts` and `apps/web/workers/app.ts`) and not another plugin's; it is rendered into the web Worker's `PLUGIN_ALIASES` (see [Aliases](plugins.md#aliases)). `capabilities` grants what the plugin may ask the core to do through its `COMMERCEWORKER` binding (`carts:external`, `orders:start`, `orders:cancel`, each at most once; see [The host API](plugins.md#the-host-api)): a plugin whose manifest asks for one not listed is refused; it is rendered into `PLUGIN_GRANTS` too, and gives a `worker` plugin its `COMMERCEWORKER` service binding. `secrets` lists the plugin's secret names (upper case, not `PLUGIN_KEY`, `PLUGIN_KEY_PREVIOUS`, `DB`, `SECRETS` or `STORAGE`) and is needed only with `secretsStore`, because Secrets Store bindings are per secret. Any other key, an unknown `runtime`, ids that aren't plugin ids or are the engine's own variable names (`bundles`, `secrets`, `grants`, `key`, `storage`, `dev-bundles`, `publishers`), the `example` and `fixture-carrier` fixtures, and ids without `plugins/<id>/wrangler.jsonc` are refused. A `worker` plugin's `wrangler.jsonc` may hold only vars and one D1 binding `DB`, or rendering refuses it. See [Plugins](plugins.md) |
| `secretsStore` | none | `{ "storeId": "<32 hex characters>" }` (anything else is refused): the Cloudflare Secrets Store of a deployment on its own Cloudflare account, where its plugins' secrets live as `PLUGIN_<ID>_<NAME>` instead of in the GitHub environment. Leave it out on a shared account (one store and 100 secrets an account). Rendered as `secrets_store_secrets` bindings for each plugin's listed `secrets`. See [Plugin secrets](#plugin-secrets) |
| `pluginInstalls` | none (off) | `{ "publishers"?: { "<name>": "<Ed25519 public key>" }, "assistant"?: true }`, with at least one: who may sign a sandboxed plugin an admin installs at runtime from the Plugins page, and whether the assistant may draft business-rule plugins for an admin to approve (rendered as the engine's `ASSISTANT_PLUGINS`; see [Plugins](plugins.md#assistant-drafted-plugins)). No publisher may be named `assistant`. A name is lowercase letters, digits and hyphens; a key is the raw 32 bytes in base64url (43 characters, from `pnpm plugin:pack keygen`). Rendered into the engine's `PLUGIN_PUBLISHERS`. Without it, runtime installs are off. See [Plugin publishers](#plugin-publishers) |
| `hold` | `false` | CI skips it: it stays on the version it runs now |
| `docs` | `false` | Deploy the docs site after it. Only `commerceworker` sets it |

With the suffix, deployment `acme` gets these resource names:

| Resource | Name |
|---|---|
| Web Worker | `commerceworker-web-acme`, at `acme.commerceworker.com` |
| Storefront Worker | `commerceworker-storefront-acme`, at `shop.acme.commerceworker.com` (no resource of its own: it binds only the deployment's engine, through the narrow `StorefrontApi` entrypoint, and no D1 or `DOCS` bucket) |
| Engine Worker | `commerceworker-engine-acme` (the web and storefront Workers' `ENGINE` bindings point at it; the web app's use entrypoint `EngineApi`, the storefront's `StorefrontApi`) |
| Catalog Worker | `commerceworker-catalog-acme` |
| Delivery Worker (the catalog's public API, content off) | `commerceworker-delivery-acme`, at `catalog.acme.commerceworker.com` |
| Workflows | `commerceworker-order-acme`, `commerceworker-replenish-acme`, `commerceworker-catalog-feed-acme`, `commerceworker-catalog-backup-acme`, `commerceworker-catalog-restore-acme`, and with `redundancy` `commerceworker-d1-backup-acme`, `commerceworker-d1-restore-acme` and `commerceworker-docs-reconcile-acme` (Workflow names are unique per account) |
| Plugin Worker and D1 | `commerceworker-plugin-<id>-acme` for each installed plugin (the Worker and its database share the name) |
| D1 | `commerceworker-acme` (bound by the engine, web and catalog Workers; the catalog writes variant names and prices into `products`); with `redundancy`, also `commerceworker-standby-acme` (bound by the engine only, as `STANDBY_DB`; id in `standbyD1Id`) |
| R2 | `commerceworker-docs-acme`, `commerceworker-catalog-acme` (the catalog's published documents, feed files and backups), `commerceworker-logs-acme` (the Workers' logs, from Logpush); with `redundancy`, `commerceworker-backups-acme` (the commerce D1's backups and the drills' evidence) and `commerceworker-docs-replica-acme` (the replica of the docs bucket) |
| Logpush | job `commerceworker-workers-acme` (`workers_trace_events`, filtered to the deployment's Workers) and the R2 API token it writes with, `commerceworker-logpush-acme` ([Logs](#logs)) |
| Queues | `commerceworker-catalog-feed-parts-acme` and its dead-letter queue `commerceworker-catalog-feed-parts-dlq-acme`; the purge queue `commerceworker-catalog-purge-acme` and its dead-letter queue `commerceworker-catalog-purge-dlq-acme`; the listing-changes queue `commerceworker-catalog-changes-acme` and its dead-letter queue `commerceworker-catalog-changes-dlq-acme` (queue names are unique per account) |
| Analytics Engine | dataset `commerceworker_catalog_delivery_acme` (dashes in the suffix become underscores) |
| Catalog KV | `commerceworker-catalog-cards-acme` (the catalog's `CARDS` namespace, id in `catalogKvId`) |
| AI Gateway | `commerceworker-acme` (`AI_GATEWAY_ID`) |
| Turnstile widget | `commerceworker-web-acme`, managed, for `acme.commerceworker.com` (site key in `turnstileSiteKey`) |
| Vectorize | `commerceworker-products-acme` (the engine's `PRODUCT_VECTORS`; none for a demo) |
| OAuth KV | created on the first deploy, bound to that web Worker |

With `content: true` it also has the content stack's resources ([The content stack](#the-content-stack)):

| Resource | Name |
|---|---|
| Content Workers | `commerceworker-pipeline-acme` (no route), `commerceworker-media-acme` at `media.acme.commerceworker.com`, `commerceworker-api-acme` at `api.acme.commerceworker.com`, `commerceworker-studio-acme` at `studio.acme.commerceworker.com`; and the delivery Worker `commerceworker-delivery-acme` also at `cdn.acme.commerceworker.com` |
| Content D1 | `commerceworker-content-acme` (`contentD1Id`), the `DB` of every content Worker, migrated from `packages/store/migrations`; the commerce D1 `commerceworker-acme` is a different database |
| Content KV | `commerceworker-content-cache-acme` (`KV_CACHE`, id in `contentKvId`) |
| Assets R2 | `commerceworker-media-acme` (`MEDIA_BUCKET`: originals, `imports/`, `dlq/`, `zips/`) |
| Content Vectorize | `commerceworker-vectors-acme` (768 dimensions, cosine, metadata indexes on `spaceId` and `environmentId`; none for a demo) |
| Content queues | `commerceworker-events-acme`, `-events-dlq-`, `-bulk-`, `-agents-`, `-purge-`, `-purge-dlq-`, `-media-purge-`, `-media-purge-dlq-`, `-asset-events-` and `-asset-events-dlq-` (each `commerceworker-<name>-acme` with the suffix last; the dead letters of `bulk` and `agents` are `events-dlq`) |
| Content Workflows | `commerceworker-agent-acme`, `commerceworker-editorial-acme`, `commerceworker-asset-ingest-acme`, `commerceworker-asset-zip-acme` |
| Analytics Engine | `commerceworker_metrics_acme` |
| AI Gateway | the deployment's own, `commerceworker-acme`, shared with the commerce Workers |

`node scripts/fleet.ts render <id>` writes `apps/catalog/wrangler.<id>.json`,
`apps/delivery/wrangler.<id>.json`, `apps/engine/wrangler.<id>.json`, `apps/storefront/wrangler.<id>.json` and `apps/web/wrangler.<id>.json` (with `content`, also `apps/pipeline`, `apps/media`, `apps/api` and `apps/studio`, and delivery's is then the dispatcher with both sides), and `plugins/<plugin>/wrangler.<id>.json` for each installed plugin: each app's `wrangler.jsonc` (the delivery Worker's `wrangler.catalog.jsonc`, the catalog's public API with the content stack off) with the deployment's names, ids, domain
and namespaces filled in. They sit next to `wrangler.jsonc` so relative paths (`main`,
`migrations_dir`) still resolve, and they are gitignored. The web build reads its rendered config
when `COMMERCEWORKER_WRANGLER_CONFIG` names it (`apps/web/vite.config.ts`). Rendering `commerceworker` gives
back the base files unchanged, and `pnpm test:fleet` checks that.

## The content stack

A deployment with `"content": true` also runs the content stack: published content (Content Management and Preview REST, MCP and OAuth, and public delivery) and the optional assets service. It is opt-in per deployment; without it nothing below exists for the deployment and its commerce renders are unchanged.

| Worker | App | Host | Role |
|---|---|---|---|
| `commerceworker-pipeline<suffix>` | `apps/pipeline` | none | The content engine: queue consumers, the minute cron, and the owner of every content Durable Object (`LiveHubDO`, `RateLimiterDO`, `CostGuardDO`, `SearchShardDO`, `AssistantAgent`) and Workflow |
| `commerceworker-media<suffix>` | `apps/media` | `mediaDomain` | Assets: R2 originals, Images variants, signed reads, share links, rationed purges |
| `commerceworker-api<suffix>` | `apps/api` | `apiDomain` | Content Management, Preview, MCP, OAuth and live |
| `commerceworker-delivery<suffix>` | `apps/delivery` | `catalogDomain` and `cdnDomain` | The same Worker as the catalog's public API; with content on it deploys its dispatcher entry (`src/index.ts`, from `wrangler.jsonc` with the catalog's bindings added) and serves published content at `cdn.<domain>` too |
| `commerceworker-studio<suffix>` | `apps/studio` | `studioDomain` | The content admin and human sign-in; it fronts the api with a signed principal |

The catalog learns whether the assets service exists from one var, `MEDIA_ORIGIN`: `renderCatalog` sets it to `https://<mediaDomain>` for a `content` deployment and renders none otherwise (commerce-only configs are unchanged). It isn't a secret. The catalog reads it twice (`mediaOrigin` in `apps/catalog/src/config.ts`): `mediaRules` accepts an `asset:<assetId>` media reference only when it is set, and publishing writes such a reference as `<MEDIA_ORIGIN>/a/<assetId>` (`resolveMediaSrc` in core), so the document holds a stable URL and a stored product keeps its reference. The media Worker answers that path with a 302 to the asset's current published URL (`apps/media/src/asset-ref.ts`), in the deployment's one media scope (the registry's `mediaScope`, rendered as `ASSET_REF_SPACE` and `ASSET_REF_ENV`; `space-1` and `main` when unset), so set it when the content lives in another space or environment. The redirect is `public, max-age=60` (a 404 `public, max-age=30`, so unknown ids don't reach the replica every time) and is never purged: a replaced or unpublished asset reaches readers within a minute, and the file's own purges are what remove the bytes. Commerce-only deployments have no `MEDIA_ORIGIN`, so the catalog refuses `asset:` at write.

The content stack has its own database, `commerceworker-content<suffix>`, migrated from `packages/store/migrations`; the commerce database keeps `packages/db/migrations`. Every content Worker's `DB` binding names the content database (`renderPipeline`, `renderApi`, `renderMedia`, `renderStudio`, and delivery's content side in `scripts/fleet.ts`); a content Worker never binds the commerce database and the commerce Workers never bind the content one. The content Workers share the deployment's AI Gateway and its jurisdiction (`DATA_JURISDICTION`).

Secrets come from the same GitHub environment. The commerce Workers' `PRINCIPAL_KEY`, `DATA_KEY` and `PASSWORD_PEPPER` are also the studio's and api's, and `TOKEN_PEPPER` and `MEDIA_SIGNING_SECRET` are new: a deploy of a content deployment stops before it migrates anything when either is missing, and `provision.sh` generates them ([Configuration](configuration.md#content-stack-secrets)). The studio's single sign-on uses the same `sso` entry as the admin's, so register a second redirect URI, `https://<studioDomain>/login/sso/callback`.

Turning it on for an existing deployment: set `"content": true`, run `./scripts/provision.sh <id>` (it creates everything above that doesn't exist, and records `contentD1Id` and `contentKvId`), commit the registry file, and merge. Until `contentD1Id` and `contentKvId` are in the registry, the plan stops (or hold the deployment). Turning it off again doesn't delete anything: the Workers stay as deployed (delivery's next deploy is catalog-only again) and removing them and their resources is a separate decision ([Removing a customer](#removing-a-customer)).

## Adding a customer

1. Create `deployments/<id>.jsonc` with `id`, `ring` (usually `canary` first), the next free
   `slot` and, for EU data, `"jurisdiction": "eu"`. Set it now: D1, R2 and the Durable Objects take
   it at creation, so adding or changing it after the first order strands that order's live state
   (see [Data residency](data-model.md#data-residency)).
2. Run `./scripts/provision.sh <id>`, logged in to `wrangler` and `gh`. It creates the D1
   database, the R2 bucket and the catalog's R2 bucket (in the jurisdiction; the Durable Objects get theirs from each Worker's `DATA_JURISDICTION`, rendered at deploy), the catalog's KV namespace (KV has none; its id is written as `catalogKvId`), the AI Gateway (with the `commerceworker` gateway's settings:
   120 requests a minute, no cache, authentication on, request logs only when `aiGatewayLogs` is `true`), and the GitHub environment. For a gateway that already exists, it compares the gateway's default log setting with `aiGatewayLogs` and prints a warning if they differ; it doesn't change the gateway. The engine sends the setting on every call either way, so the default matters only for calls made outside it; match it in the dashboard (**AI** > **AI Gateway** > the gateway > **Settings**), where logs kept so far are deleted too.
   It creates the product index, Vectorize `commerceworker-products<suffix>` (768 dimensions, cosine, fixed at creation), unless the deployment is a demo; a deploy fails while the engine's binding names an index that doesn't exist. The engine's hourly cron fills it, up to 3,000 SKUs a run, so a large catalog's first backfill takes several hours. An admin can start a run now, after a big import say, with **Update product index** under Inventory on the Commerce page (`EngineRpc.reindexProducts`); it is the same run, so it also takes at most 3,000. A run holds the lease in `product_index_lease` for up to 15 minutes, so one that overlaps the cron's (or a second click) answers that the index is already being updated and does nothing; a run that dies leaves the lease to lapse.
   For each plugin in the file's `plugins` it creates the D1 database `commerceworker-plugin-<plugin><suffix>` and writes its id as `plugins.<plugin>.d1Id` (see [Plugins](plugins.md#installing)).
   It creates the catalog's two feed queues, the two purge queues and the two changes queues (a deploy fails while a consumer's queue doesn't exist; one that exists is kept) and sets every one of them to keep messages 14 days (`--message-retention-period-secs 1209600`, the most Queues allows), existing ones too. It replaces two lifecycle rules on the catalog bucket: `feeds`, which expires `feeds/` (uploaded feed files and their parts) after 30 days, and `dlq`, which expires `dlq/` ([Dead letters](#dead-letters)) after 30 days; and two for
   [catalog backups](#catalog-backups): `backups`, which expires `backups/` after
   `catalogBackupDays`, and `restores`, which expires `restores/` after 30 days; and `health`, which expires `health/`
   after a day, the deploy smoke test's [write check](deploy.md#the-write-check) objects whose
   delete never ran (the docs bucket gets the same `health` rule). It sets the catalog
   bucket's lock rule `catalog-backups` on `backups/` for `catalogBackupDays` days
   ([Bucket locks](#bucket-locks)).
   It creates the logs bucket `commerceworker-logs<suffix>` (in the jurisdiction), replaces its lifecycle rule `logs` with a `logRetentionDays` expiry, and creates or updates the deployment's Logpush job ([Logs](#logs)); the job needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and without them it says it skipped it.
   With `redundancy` it also creates the backups bucket and the standby D1 database, each only if it isn't there, and writes `standbyD1Id`; and, unless `r2Replica` is an exception, the docs replica bucket, its queue and dead-letter queue and the docs bucket's notification rule ([Redundancy](#redundancy)).
   It also sets the R2 lifecycle rule that expires the audit archive after `auditArchiveDays`, or removes it when that is unset, and the docs bucket's lock rules ([Bucket locks](#bucket-locks)); re-run it after changing the number.
   With `"content": true` it also creates the content stack's resources, each found or created so a re-run changes nothing: the content D1 database (read replication turned on through the API when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set, else it says where in the dashboard) with its id written as `contentD1Id`; the content cache KV namespace (`contentKvId`); the assets bucket, with lifecycle rules `imports` (`imports/`, 7 days), `dlq` (`dlq/`, 30 days), `zips` (`zips/`, 2 days) and `abort-multipart` (unfinished multipart uploads, 2 days), replaced on each run; the Vectorize index `commerceworker-vectors<suffix>` (768 dimensions, cosine) with metadata indexes on `spaceId` and `environmentId`, unless a demo; the ten content queues, each keeping messages 14 days; and the R2 notification that announces every object written to the assets bucket on the asset-events queue (asset ingest). It also generates `TOKEN_PEPPER` and `MEDIA_SIGNING_SECRET`, and never a `TOKEN_PEPPER` the api Worker already holds. A commerce-only deployment gets none of this.
   It sets the environment's `PRINCIPAL_KEY`, `DATA_KEY` and `PASSWORD_PEPPER` (`openssl rand -hex 32`, never written to disk) when it lacks them, for a deployment that already runs too, since a deploy fails without the first two. It never replaces a `DATA_KEY` or `PASSWORD_PEPPER` the web Worker already holds: when the environment has lost one, it stops and asks for the deployment's own value, since a new one would leave every secret sealed under the old key, or every password hashed with the old pepper, unreadable. It writes `d1Id` into the registry file and sets the environment's `SETUP_TOKEN`, the one-time setup code. New values are generated and saved in `.secrets/<id>/` (gitignored; the code is `.secrets/<id>/setup-code`); a secret
   the environment already has is left alone, and once the web Worker exists it sets none, since a
   generated one would replace the Worker's own on the next deploy. Re-running it is safe.
   With the API token and account id it also finds or creates the deployment's Turnstile widget
   and copies its secret into the environment; see [Turnstile](#turnstile).
3. If `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` aren't repository secrets, add them to
   the environment. Add `SHOPIFY_WEBHOOK_SECRET`, `INTAKE_ALLOWLIST`, `SHIPPING_CARRIER_AUTH`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` or `OIDC_CLIENT_SECRET` ([single sign-on](#single-sign-on)) there if the customer uses them (Stripe also
   needs `"payments": "stripe"` in the registry file, and invoices through Stripe need
   the [Stripe webhook](deploy.md#stripe-webhook)). To gate this customer's deploys, add a required reviewer to the
   environment. For `production`, then run the `Escrow secrets` workflow so the keys survive losing
   the environment ([Escrowing secrets](content/backup-and-restore.md#escrowing-secrets); it refuses
   until the owner has pinned the escrow key, and plugin secrets aren't in it).
4. Commit the registry file and merge. CI deploys the customer in its ring, and the custom domain
   creates its DNS record in the `commerceworker.com` zone.
5. Send the customer's first admin `https://<domain>/setup` and the code from
   `.secrets/<id>/setup-code`. They enter it with their email and a password of their own, which
   creates their admin account and signs them in; they add their team from there. The code works
   once. Until then the workspace refuses every request but `/setup`.

**The public catalog API is the delivery Worker**, `commerceworker-delivery-<id>` (`apps/delivery`, entry `src/catalog/worker.ts`, no content code), on the catalog's host, bucket, KV namespace and purge queue.

**Deployments that predate feeds.** Provisioning only runs when you run it, and CI never does. A deployment provisioned before the catalog's feed import needs the queues and the `feeds/` rule too, and one that predates the public catalog API needs the two purge queues before the deploy that carries the delivery Worker, and one that predates listing indexes needs the two changes queues before the deploy that carries them: run `./scripts/provision.sh <id>` again, before the deploy that carries the feed code (re-running is safe and sets no secrets once the web Worker exists). The script keeps a queue that already exists (`queues info`) and stops if one can neither be found nor created, since a deploy fails without its consumer's queue; it replaces the `feeds` lifecycle rule on each run. Keyword search needs no new resource (its Durable Objects come with the deploy and the `CATALOG` service binding resolves to the deployment's own catalog), but it fills only from changes published after it deploys: run `reindex` once for products already published. Segmented listing indexes are the same: the delivery Worker reads only the per-segment blobs (`idx/f1/<channel>/<category>/<segment>.bin`), which exist only once listing changes reach each segment's indexer, so after the deploy that carries segmented listings, run `reindex` once per deployment (`POST /api/v1/catalog/reindex` on the web app, an `admin` call; it republishes every product, which forces every listing to rebuild). Until it has run, category listings are empty (`404`) or hold only the products changed since the deploy. The old single-blob indexes are left in R2 unread; deleting the channel sweeps them. The `commerceworker` deployment's queues and `feeds` rule were created through the Cloudflare API rather than by `provision.sh` (on 2026-10-23), and so were its purge queues, `commerceworker-catalog-purge` and `commerceworker-catalog-purge-dlq` (also on 2026-10-23), and its changes queues, `commerceworker-catalog-changes` and `commerceworker-catalog-changes-dlq` (also on 2026-10-23); re-running the script for it now only sets the queues' 14-day retention, the `dlq` lifecycle rule and the docs bucket's locks.

**Deployments that predate the storefront.** It needs no resource provisioned: its custom domain (`storefrontDomain`) is created by the deploy, in the zone, like the web app's, and it binds only the deployment's engine (no D1, no `DOCS` bucket) and holds only `STOREFRONT_KEY` (and `STOREFRONT_KEY_PREVIOUS` during a rotation), which the deploy derives from the `PRINCIPAL_KEY` the environment already has. It never holds `PRINCIPAL_KEY` itself: rotating `PRINCIPAL_KEY` rotates the storefront's key with the next deploy, and the engine, deployed first, accepts both while it finishes. The deploy that adds it also repoints the engine's `STOREFRONT_ORIGIN`, so an external cart's start links are on the storefront from then on (start links are good for five minutes, so a buyer mid-click can fail once; a customer's procurement system opens the catalog again). Run `./scripts/provision.sh <id>` once for each deployment that exists, so its Logpush job's filter names the storefront too (the Worker sets `logpush: true` either way, but the job keeps only the Workers it names; a deploy never waits on it).

**Deployments that predate the write check.** The `health` lifecycle rules on the docs and catalog buckets come only from `provision.sh`: re-run `./scripts/provision.sh <id>` for each existing deployment, `commerceworker` included, to add them. The write check works without them; they only expire an R2 probe object whose delete never ran.

A deployment without `payments` on the `canary` or `general` ring, or with a `storefrontDomain`, or one that shares a resource id with another, fails the plan the same way. A deployment without `d1Id`, `catalogKvId`, a plugin's `d1Id` or (with `content`) `contentD1Id` or `contentKvId` stops the whole CI plan, so provision a customer before merging their
file, or merge it with `"hold": true`.

Email intake still needs Email Routing rules per deployment (see
[Email intake](deploy.md#email-intake)), pointing at that deployment's engine Worker.

## Rings

On a push to `main`, after the checks pass, CI's `plan` job runs `node scripts/fleet.ts matrix` and
deploys ring by ring: `staging`, then `internal`, then `canary`, then `general`. A ring starts only
when the one before it finished without a failure; an empty ring is skipped. Inside a ring every
deployment is its own job (`general` runs four at a time), and one deployment failing doesn't stop
the others in its ring, but it does stop later rings.

Each deployment's job, `.github/workflows/deploy.yml`, runs in that deployment's environment:

1. Render its configs and collect its secrets from the environment. With plugins installed, the **Collect plugin secrets** step also writes each Worker plugin's secrets file and, for sandboxed plugins on a shared account, the engine's `PLUGIN_SECRETS`. Then **Check plugin secrets** builds each plugin's bundle, reads its manifest and fails the deploy, before anything changes, if a required (not `optional`) secret isn't set: in the environment, or on a `secretsStore` deployment listed in the registry and present in the store (names only).
   With `content`, **Collect content secrets** also writes each content Worker's own secrets file and fails the deploy, before anything changes, without `TOKEN_PEPPER` or `MEDIA_SIGNING_SECRET`.
2. Record a D1 Time Travel bookmark (in the run summary) and apply migrations to its D1. With `content`, the same for the content database (`Record content D1 bookmark`, `Migrate content D1`, from `packages/store/migrations`, through the pipeline's rendered config), right after the commerce one. Both migrations are expand-only.
3. Deploy its catalog, then, with `content`, its pipeline, media and api (generating the gitignored embeds first), then its delivery (with content, the dispatcher at both hosts; it needs the pipeline's Durable Objects to exist), then each installed plugin (its D1 migrations, then its Worker with its own `--secrets-file`: `PLUGIN_KEY` derived from `PRINCIPAL_KEY` for that plugin alone, and the environment's `PLUGIN_<ID>_*` secrets under their own names, unless the deployment has a `secretsStore`; the engine and web Worker bind to it), then **Publish sandboxed plugins** (each sandboxed plugin's bundle goes to the deployment's `DOCS` bucket as `plugins/<id>/<sha>.json` and the shas are pinned in the engine config's `PLUGIN_BUNDLES`), then its engine, then build and deploy its storefront, then its web app, then, with `content`, build and deploy its studio (it binds the api and delivery); the engine, storefront and web app
   each with `--secrets-file` (the catalog has no secrets, delivery has the content stack's only with `content`; the storefront's are its two derived keys alone, never the principal key). That adds the
   environment's secrets to the Worker and never removes one, so a secret set by hand survives.
4. Smoke-test `https://<domain>/health`, `/health/deep` and `/login`, then `https://<catalogDomain>/health`, then `https://<storefrontDomain>/health` and `/health/deep` (the engine's D1 and R2, over its binding: the storefront has neither), then, with `content`, **Smoke test content** (its own step, 20 minutes at most): the studio's `/health`, `/health/deep` and `/login`, the api's `/health` and `/openapi.json`, `https://<cdnDomain>/health`, the media origin's `/health`, an unknown media URL answering 404 and an anonymous delivery read answering 401; then the write check (`node scripts/fleet.ts write-check <id>`, `POST /health/write` signed from `PRINCIPAL_KEY`): every store the Workers write to takes a write, gives it back and loses it again, and a failure names the store ([Deploy](deploy.md#the-write-check)). Like each read, it tries for five minutes (10 seconds an attempt) before it fails and rolls the deploy back; the step itself stops at 28 minutes, inside the job's 75, so a hang fails the step and the rollback still runs.
5. If anything fails after the catalog deployed, roll back each Worker that deployed: the engine, then the pipeline (with `content`), then the storefront and the web app, the plugins, the studio, api and media, delivery and the catalog. The pipeline has the engine's rule: if it can't go back, the api, media, delivery and studio stay on its version, and the commerce Workers are rolled back as usual. A Worker on its first deploy has no earlier version and is left as it is. If the engine can't be rolled back (a Durable Object migration since its last version prevents it, for one), the step fails with an error and nothing else is rolled back, so the storefront and the web app stay on the version that matches the engine; fix forward. Any other Worker that fails to roll back is an error too, after the rest have gone back ([CI](deploy.md#ci)). Rolling the engine back restores its previous `PLUGIN_BUNDLES` pins; the bundles stay in `DOCS` (nothing removes them), so the old version finds the ones it pins. D1 isn't rolled back (see [Restoring D1](deploy.md#restoring-d1)).

To gate a ring, add a required reviewer to its deployments' environments: the `canary` jobs then
wait for approval after `internal` succeeds.

### What provisioning sets on the environment

`provision.sh` limits each deployment's GitHub environment to the `main` branch: its
`deployment_branch_policy` is `{protected_branches: false, custom_branch_policies: true}` with one
branch policy, `main`. A workflow on any other branch can't deploy to the environment or read its
secrets; the deploy jobs run from `main` (CI's `plan` runs them only for a push to `main`), and the
nightly demo reset runs from the default branch. A PUT to an environment replaces its protection
rules, so the script reads the environment first: one already on custom branch policies is not
written again, and otherwise the wait timer, required reviewers and self-review setting it has are
sent back with the policy. It adds the `main` policy only when the list lacks one, and it stops
without writing if it can't read the environment (a token without admin access).

To apply it to the live environments, the owner re-runs provisioning with `gh` signed in as a repository
admin (a token with the `repo` scope) and `wrangler` logged in; it changes nothing else that exists:

```bash
./scripts/provision.sh commerceworker   # the `production` environment
./scripts/provision.sh demo             # `deploy-demo`
```

Run `./scripts/provision.sh bench` too once `bench` is provisioned (until then it has no
environment to lock). The `npm` environment isn't provisioned by the script; its tag rule is set by
hand ([Releasing the SDK](content/deployment.md#releasing-the-sdk)).

To check an environment (read-only):

```bash
gh api repos/commerceworker/commerceworker/environments/production \
  --jq '{policy: .deployment_branch_policy, rules: [.protection_rules[].type]}'
gh api repos/commerceworker/commerceworker/environments/production/deployment-branch-policies \
  --jq '[.branch_policies[] | {name, type}]'
```

Expect `custom_branch_policies: true` and a single `main` branch policy. A 404 means the
environment doesn't exist yet: GitHub creates one, with no branch limit, the first time a job names
it, so provision a deployment before its first deploy.

## Plugins

A plugin is installed by listing it under `plugins` in a deployment's file (see the registry above
and [Plugins](plugins.md)). To install one: add it, run `./scripts/provision.sh <id>` (it creates the
plugin's D1 database), and merge. To remove one from a deployment: run
`COMMERCEWORKER_API_TOKEN=ol_… pnpm plugin:check <id> <plugin>` with an admin's API token, which fails
while a published flow or a running order uses the plugin's nodes; take it out of `plugins` and merge
so CI deploys without it; then delete its Worker `commerceworker-plugin-<plugin><suffix>` and its D1
database. Delete `plugins/<plugin>/` once no deployment lists it.

A plugin whose manifest asks for `personalData: "send"` is refused until its registry entry says
`"personalData": "send"`; merge that to grant it, and remove it to withdraw it (the plugin is refused
at once on the next deploy, even from its last good manifest). A plugin's keys are derived from
`PRINCIPAL_KEY` (`PLUGIN_KEY`) and `PRINCIPAL_KEY_PREVIOUS` (`PLUGIN_KEY_PREVIOUS`), so rotating the
principal key rotates them too, and each plugin's secrets are written per plugin
(`fleet.ts secrets plugin <out> <plugin>`). The old `PLUGIN_KEY_PREVIOUS` is not removed from the
plugin's Worker when it stops being written: run `wrangler secret delete PLUGIN_KEY_PREVIOUS`
against `commerceworker-plugin-<plugin><suffix>` after the rotation.

A sandboxed plugin is installed the same way with `"runtime": "sandboxed"`: there is nothing to
provision (`provision.sh` skips it) and no Worker or database to delete on removal; take it out of
`plugins` and merge, and the engine stops loading it. Its pinned bundles stay in the `DOCS` bucket
as `plugins/<plugin>/<sha>.json`; delete them by hand if you want them gone. Its storage (the engine's
`PluginStorage` object for that id) stays too, so installing the id from a file finds its data; an
upload never deletes it. Uninstalling it from the Plugins page exports the storage to `DOCS` as
`plugin-exports/<plugin>/<time>.ndjson` and only then deletes it (audited as `plugin.data_exported` and
`plugin.data_wiped`). Exports aren't under a bucket lock; the daily retention sweep deletes them
at 30 days (sooner if `PERSONAL_DATA_RETENTION_DAYS` is shorter), so download or re-import one within that time. Worker Loader, which
runs sandboxed plugins, is in open beta and needs Workers Paid; the engine's `LOADER` binding is
declared in every deployment and unused until one is installed. Cloudflare enforces the per-call CPU
and subrequest limits; local workerd does not.

### Plugin secrets

A plugin's secrets are named `PLUGIN_<ID>_<NAME>` (`API_KEY` of `shipstation` is
`PLUGIN_SHIPSTATION_API_KEY`) and live where the deployment's Cloudflare account puts them
([Plugins](plugins.md#secrets)).

**Shared account** (no `secretsStore`): set `PLUGIN_<ID>_<NAME>` in the deployment's GitHub
environment (`deploy-<id>`), e.g. `gh secret set PLUGIN_SHIPSTATION_API_KEY --env deploy-acme`, and
deploy. A Worker plugin gets it as `<NAME>` in its secrets file; a sandboxed plugin's go to the
engine as `PLUGIN_SECRETS`. To rotate, change the value and redeploy (merge, or re-run the
deployment's job). `--secrets-file` never removes a secret, so one you stop setting stays on the
Worker: delete it with `wrangler secret delete <NAME>` against the plugin's Worker (or, for a
sandboxed plugin, rotate it at its issuer; `PLUGIN_SECRETS` is rewritten whole on each deploy).

**Own account** (`secretsStore` in the registry): put the secret in the account's Secrets Store
under the same `PLUGIN_<ID>_<NAME>` name, with the Workers scope, and list its `<NAME>` under
`plugins.<id>.secrets`:

```sh
wrangler secrets-store secret create <store id> --name PLUGIN_SHIPSTATION_API_KEY --scopes workers --remote
```

or use the dashboard (Secrets Store). Rotate it in the store (`wrangler secrets-store secret update`,
or the dashboard): the plugin reads the new value on its next call, with no deploy. To revoke,
delete or rotate it in the store. `provision.sh` checks the store exists (create it with
`wrangler secrets-store store create <name> --remote`; one store an account) and reminds you to add
each plugin's secrets.

The deployment's CI token (`CLOUDFLARE_API_TOKEN`) needs **Account Secrets Store Edit** for any
deployment with a `secretsStore`: **Check plugin secrets** lists the store's secret names with it
(Read is enough for that) and deploying a Worker that binds a store needs Edit. Without it the
check stops the deploy with `CLOUDFLARE_API_TOKEN needs Account Secrets Store Edit`. A deploy also
stops, naming the missing `PLUGIN_<ID>_<NAME>`, when a required secret isn't set. A required
secret removed afterwards fails the plugin's manifest, so deep health names it.

Moving a deployment onto its own account's Secrets Store: a Worker plugin's old plain secrets stay
on its Worker (`--secrets-file` never removes one), and a Secrets Store binding of the same name
then fails its deploy. Delete each first (`wrangler secret delete <NAME> --name
commerceworker-plugin-<id><suffix>`), then merge the registry change. Two deployments must never share
a `secretsStore`: its names (`PLUGIN_<ID>_<NAME>`) aren't per deployment.

### Plugin publishers

Runtime installs ([Plugins](plugins.md#installing-at-runtime)) are off until the registry lists who
may publish them. To trust a publisher, they run `pnpm plugin:pack keygen <name> <name>.pem`, keep the
PEM and send the public key it prints; add it in a reviewed registry PR:
`"pluginInstalls": { "publishers": { "<name>": "<public key>" } }`. `loadDeployments` refuses a name
that isn't lowercase letters, digits and hyphens, or a key that isn't 43 base64url characters.
Merging deploys the engine with `PLUGIN_PUBLISHERS`.

To rotate a key, list the new one under a second name (`acme-2026`) next to the old, have the
publisher sign with it, then remove the old name. An upgrade must come from the publisher that
signed the installed version, so a publisher that changes name has its plugin uninstalled and
installed again. Removing a publisher stops new uploads from it and the approving, rolling back to
or turning on of any of its versions; one already running keeps running.
A leaked publisher key: remove it from the registry and merge, then review, and if need be turn
off, each plugin it signed (the Plugins page names the publisher).

## Alerting

Failures reach a person through Cloudflare Notifications, which are set on the account, not per
Worker. Every app Worker turns on Workers Issues (`observability.issues.enabled` in its
`wrangler.jsonc`): uncaught exceptions, failed invocations, `5xx` responses and logs written with
`console.error` become issues, so an error-level log line (a dead letter's `dlq_message`, a failed
retention sweep, a model call that fell back to the heuristic) alerts without a rule of its own. The order lifecycle logs `order_index_failed`, `order_index_stuck` (a D1 index row still behind after five retries: the order's list row and its retention erasure are wrong until it lands), `order_index_missing` (the order has no D1 row), `rollback_failed` (a failed order's rollback did not complete: look at the order's timeline for what was left), `cancel_terminate_failed` / `cancel_not_stopped` (a cancel couldn't stop the Workflow; the order is not cancelled and the agent keeps retrying) and `order_workflow_mismatch` (see [the Workflow sweep](#the-workflow-instance-sweep)).

**What gets made.** With `redundancy.alerts` set in the registry (and `alerts` not in `except`), `./scripts/provision.sh <id>` creates, on the deployment's account:

| Policy | Alert type | Fires on |
|---|---|---|
| CommerceWorker: Worker issues | `workers_observability_real_time_issue` | A new or recurring issue on any Worker with Issues on |
| CommerceWorker: HTTP DDoS | `dos_attack_l7` | An HTTP DDoS attack mitigated on one of the account's zones |
| CommerceWorker: Universal SSL | `universal_ssl_event_type` | Universal certificate validation, issuance, renewal and expiry |
| CommerceWorker: Advanced certificates | `dedicated_ssl_certificate_event_type` | Advanced certificate validation, issuance, renewal and expiry |
| CommerceWorker: commerceworker-web<suffix> health, and the same for `-storefront` | `health_check_status_notification` | A Health Check going unhealthy or recovering |

The four named policies are the account's: on a shared account one set covers every deployment, so the script finds each by name and adds this deployment's destinations to it, never a second policy and never removing one already there. Health Checks are zone level: `commerceworker-web<suffix>` on `https://<app host>/health/deep` and `commerceworker-storefront<suffix>` on `https://<storefront host>/health/deep`, every minute from Western Europe and Eastern North America, unhealthy after two failures in a row (the deep check is a 200 only when D1, R2 and the engine behind the app answer). Each has a policy of its own, filtered to its check. The script finds each by name first and creates what is missing; a second run changes nothing but the webhook's URL and the checks' settings, which it sets again.

**Destinations.** A policy sends to every destination below that is set:

| Destination | How |
|---|---|
| Webhook | Export `ALERT_WEBHOOK_URL` in the shell that runs `provision.sh` (a secret: Slack, an incident tool or your own endpoint; it is sent to the API in a request body, never printed or written). The registry's `alerts.webhook`, a URL that holds no secret, is used when the variable is unset. The destination is `commerceworker-alerts<suffix>`, updated in place on a re-run, so a rotated URL is one re-run |
| PagerDuty | Set `alerts.pagerduty` in the registry. PagerDuty itself is connected **in the dashboard** (Notifications > Destinations > PagerDuty > Connect), since the API only lists a connected service; until it is, the script says so and the policies don't page it. Run `provision.sh` again after connecting |
| Email | Export `ALERT_EMAIL` (an address verified on the account) |

With none of them the script stops: alerts that go nowhere are worse than none. `CLOUDFLARE_API_TOKEN` needs Notifications Write, Health Checks Write and Zone Read besides the permissions provisioning already asks for. Without a token the script says it skipped the alerts. Create nothing by hand that the script makes: it finds by name.

Policies that exist from before the script (the account's email ones, created 2026-10-25 under these same names) are kept and gain the new destinations. Log-match alert rules (Workers Observability alerts on a
query) can only be made in the dashboard; prefer an error-level log, which Issues already catches. A deployment with `alerts` off still has Issues; it has no one told.

### Metrics

Web, engine and storefront write operational metrics to the deployment's Analytics Engine dataset `commerceworker_ops<suffix>` (binding `METRICS`, rendered by `scripts/fleet.ts`; the dataset is created by its first write). They are on for every deployment, with no registry flag: a data point is a non-blocking write with no cost on the request path, nothing is stored in D1 or R2, and the alerting above has nothing to read without a record of what the apps saw. Writing never blocks a request and never throws; a write that fails is dropped with a warning (not an error-level line, which would page).

One data point per event. `index1` and `blob1` are the event, `blob2` the app (`web`, `engine`, `storefront`), `blob3` what it was about, `blob4` the status class for requests; `double1` is 1 (sum it) and `double2` is milliseconds.

| Event (`blob1`) | `blob3` | Written when |
|---|---|---|
| `request` | The route group (`health`, `api`, `mcp`, `a2a`, `agents`, `oauth`, `scim`, `ucp`, `assets`, `app`), never a path | Every request to the web app, the storefront and the engine's fetch; `blob4` is `2xx` to `5xx` (a Worker that throws counts as `5xx`) |
| `step_failed` | The node type that failed (`run` when none was to blame) | An order's run fails, once per run |
| `d1` | The key path: `health` (the web app's deep health, so every minute) and `order_sweep` (the hourly sweep's query) | A D1 round trip, in `double2` |
| `failover` | `ai_heuristic` (a model call answered from its heuristic because the model failed), `email_failed` (an order confirmation was refused or failed); `docs_replica_read` (a read of the docs bucket served from its replica) | The fallback is used |

Query them from the dashboard (Analytics Engine, SQL API) or `GET /accounts/<id>/analytics_engine/sql`, for example the 5xx rate by app and group over the last hour:

```sql
SELECT blob2 AS app, blob3 AS route_group,
       SUM(_sample_interval * double1) AS requests,
       SUM(IF(blob4 = '5xx', _sample_interval * double1, 0)) AS errors
FROM commerceworker_ops
WHERE blob1 = 'request' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY app, route_group
```

Analytics Engine keeps data for 93 days. The metrics are for looking, not paging: what pages is above.

### The Workflow instance sweep

The engine's hourly cron (`15 * * * *`) compares each order D1 calls `running` whose row has been quiet for 15 minutes with its Workflow instance. An instance that is `errored`, `terminated`, `complete` (an order still running in D1 whose Workflow has ended) or not found leaves the order running for ever: nothing reports and nothing fails it. Each mismatch is logged as an error-level line, `{"type":"order_workflow_mismatch","orderId","instanceId","order":"running","workflow":"errored|terminated|complete|unknown"}`, which Workers Issues turns into an alert. It checks at most 200 orders an hour, least recently changed first (it logs `order_workflow_sweep_capped` when it stops there), and logs the same mismatch again every hour until someone acts: the sweep repairs nothing. Waiting orders (approvals, supplier waits) are not checked.

### When you're paged

Start from the Worker issue or Health Check named in the page, then:

**The deep health fails with D1 down** (`/health/deep` answers 503 with `"db":"fail"`; the web app's `5xx` rate jumps; `commerceworker_ops` shows `d1` latency rising or gone). Check [Cloudflare's status](https://www.cloudflarestatus.com) and the D1 dashboard for the database. A bad write or migration: restore from Time Travel ([Restoring D1](deploy.md#restoring-d1)); the database lost: [Restoring commerce D1 from a backup](#restoring-commerce-d1-from-a-backup). Orders that were running keep their Workflows and their OrderAgents (their state is in Durable Objects) and their D1 index rows catch up afterwards (`order_index_failed`, `order_index_stuck` clear on their own once D1 answers). Don't redeploy to "fix" it: CI migrates before it deploys.

**The engine is down** (the deep health fails with `"engine":"fail"` on both apps while D1 is fine; every `request` group on the engine goes `5xx`, or none are written). The apps reach it only over the service binding. Look at the engine's latest deploy in the Actions run (a failed smoke test rolls the Workers back but not D1) and at its Worker issues; a bad deploy is fixed by merging the fix or reverting the change, never by hand ([Rollback](deploy.md)). Running orders resume when it is back: Workflows retry, and the OrderAgent catches up with the Workflow's reports. After an outage, look for `order_workflow_mismatch`: an order whose instance errored out needs a person.

**Stripe is down** (card payments fail, `5xx` on the storefront's checkout group, authorize nodes failing: `step_failed` with `payments.authorize`). Check [Stripe's status](https://status.stripe.com). Orders fail or wait at the authorize node; nothing is charged twice, since every write is keyed by its step key. Nothing here to switch: with Stripe back, orders that failed are placed again by their buyers, and ones still waiting continue. Confirm on the Payments page and in Stripe's dashboard that no PaymentIntent is left with no order (`settleOrphanedHolds` voids a hold a card payment left behind within the hour).

**Email is down** (`failover` with `email_failed` rising, which with the mail queue is a message that has used its retries and is in the dead-letter queue; a confirmation email logs `order confirmation failed`). Orders are not affected: a confirmation that can't be sent is recorded on the order's message and the order completes. Check Email Sending in the dashboard and the sender's domain ([Email sending](#email-sending)); the unsent confirmation is on the order's timeline ("its confirmation email was not sent"). Intake by email stops while Email Routing is down, and senders retry on their own.

**The docs bucket** failing shows as `"docs":"fail"` in the web app's deep health, and `failover` with `docs_replica_read` rising on the engine's side: its reads are being served from the replica ([Redundancy](#redundancy)); the web app's own reads don't fall back. **Not covered yet:** KV and Queues failing over.

### An outside probe (optional)

Health Checks run from Cloudflare's network, so they say nothing when Cloudflare itself is the problem. For a probe that doesn't share its fate, point a second service at `https://<app host>/health/deep` (200 when healthy, 503 with the failing check named when not): Amazon Route 53 health checks (HTTPS, string match `"ok":true`, an SNS topic for the page) or Google Cloud uptime checks (an alerting policy to the channel that pages); Azure Monitor's availability tests work the same and are the last to consider. Nothing in the repo creates these: they are set up in that provider's console, with the same destination as `ALERT_WEBHOOK_URL` where it takes one.

## Logs

Workers Logs keeps 7 days. Every app Worker (web, storefront, engine, catalog, delivery) and every
plugin Worker also sets `logpush: true` ([Configuration](configuration.md#runtime-limits-and-observability)),
and each deployment has one Workers Logpush job, `commerceworker-workers<suffix>`, that writes their
trace events to the deployment's own bucket, `commerceworker-logs<suffix>` (in its jurisdiction), under
`workers/<yyyymmdd>/` as gzipped NDJSON, one record per invocation. They are kept
`logRetentionDays` days (default 400, or `personalDataRetentionDays` when that is set), then the
bucket's lifecycle rule `logs` deletes them. `provision.sh` makes the bucket, the rule and the job;
CI does nothing here, so deploys never depend on it. Without the deployment's own job, `logpush`
doesn't keep the logs anywhere of ours, but it isn't inert: on a shared account any other
`workers_trace_events` job whose filter lets these Workers through (one with no filter at all, say)
collects them. `provision.sh` refuses to go on while such a job exists (`foreignJobsReaching` in
`scripts/fleet.ts`), but it only looks when it runs: after making a Logpush job on a shared account
for anything else, filter it to its own Workers' `ScriptName`, and re-run `provision.sh` for each
deployment there to check.

**What a record holds.** The job's fields are `LOG_FIELDS` in `scripts/fleet.ts`:
`EventTimestampMs`, `EventType` (`fetch`, `queue`, `scheduled`, `alarm`, `worker_rpc`, …),
`Outcome`, `ScriptName`, `Entrypoint` (the Durable Object or Workflow class), `ScriptVersion` (to
match a deploy), `Exceptions` (with stacks), `Logs` (every `console` line: the `audit_event`
lines, dead letters, retention sweeps and the rest) and `CPUTimeMs`/`WallTimeMs`. Logpush cuts
`Logs` and `Exceptions` together at 16,384 characters an invocation; past that a record says
`<<<Logpush: … truncated>>>`. The audit log itself is in D1 and its R2 archive, so a truncated
line loses nothing of record.

**What it leaves out, and why.** The `Event` field is not pushed. It is what started the
invocation: for a request its URL, method, headers and `cf` object. Cloudflare redacts headers by
name (`cookie`, `set-cookie`, and any name containing `auth`, `key`, `secret`, `token` or `jwt`)
and long ID-like strings in the URL, but the headers still carry the client's IP
(`cf-connecting-ip`), user agent and any credential header with another name, and
`observability.redact_query_string` is documented for Workers Logs and traces, not for Logpush.
Leaving `Event` out keeps query strings, `Authorization`, cookies and client addresses out of the
bucket entirely; what it costs is the request line and response status of each invocation, and a
queue's or cron's own details. The app's own lines are kept, so what the code logs is what the
bucket holds: `audit_event` lines carry the actor (an email), target and IP of each audited
action, as the audit log does, and error text can quote whatever the failing code held. Erasure
never reaches the bucket: the retention sweep's erasure of personal data doesn't touch it,
and expiry after `logRetentionDays` is the only way a record leaves. That is why
`logRetentionDays` defaults to `personalDataRetentionDays` when a deployment sets it, and may not
be longer. To get the request line back, attach a Logpush
transformer to the job that selects only the method, path and status from `Event`, and test it
against a sample record first: the job then can't also have its filter (a transformer takes the
`WHERE` instead).

**One job per deployment, filtered.** A `workers_trace_events` job takes every Worker on the
account that sets `logpush`, so each job's filter names its own deployment's Workers
(`ScriptName in [...]`; `logpushJob` in `scripts/fleet.ts`, which refuses a filter past Logpush's
1,000 bytes). `pnpm test:fleet` checks no two deployments' jobs share a Worker, a job or a bucket.
Cloudflare documents a limit of 4 Logpush jobs per zone and publishes no account figure for
account datasets such as `workers_trace_events`. If the same 4 applies to an account, a shared
account holds four deployments' jobs (today `commerceworker` and `demo` would take two). When
`provision.sh` can't create one, it stops and says so: then ask Cloudflare to raise the limit, or
put the customer on their own account, which any deployment is built to allow. One job for the
whole account is not an option: it would put every deployment's logs behind one credential and
in one place.

**The credential.** Logpush writes to R2 as an S3 client. `provision.sh` makes the key itself: an
account-owned API token, `commerceworker-logpush<suffix>`, whose only permission is Workers R2 Storage
Bucket Item Write on the logs bucket (`logpushToken` in `scripts/fleet.ts`: one policy, one
resource naming the bucket and its jurisdiction, and the permission group found by its exact
name); the access key id is the token's id and the secret the SHA-256 of its value. A re-run that
needs a key rolls the existing token only after checking it still holds exactly that policy
(`tokenMatches`), and stops otherwise. The value exists only in the script's shell and in the job's destination
(Cloudflare keeps it there); it is never printed or written to disk, the script turns off
`set -x` while it runs, and any API error it echoes has `access-key-id` and `secret-access-key`
values replaced with `REDACTED`. A deployment in a
jurisdiction is reached through its S3 endpoint (`<account>.<jurisdiction>.r2.cloudflarestorage.com`)
instead of `r2://`. Creating the job or the token needs `CLOUDFLARE_API_TOKEN` with Logs Write
and Account API Tokens Write; re-runs only update the job (filter, fields) and need Logs Write.
That token is a person's, made in the dashboard (**Manage Account** > **Account API Tokens**), not
CI's: token-making is not something the deploy should be able to do. To replace the key (a
suspected leak, or a job whose last push failed for its credentials), run
`ROTATE_LOGPUSH_KEY=1 ./scripts/provision.sh <id>`: it rolls the token's value and gives the job
the new one. The bucket has no lock rule: Logpush's own writes are the only ones the token
allows, and how its destination check writes has not been confirmed against a lock. So the
bucket is not tamper-evident: anyone who can write it (that token, or an account admin) could
change or remove a log file unseen. For evidence, use the audit log: its hash chain in D1 and its
locked R2 archive ([Bucket locks](#bucket-locks)) are; the logs bucket is for investigation.

**Reading them.** Download a day and search it:

```bash
wrangler r2 object get commerceworker-logs<suffix>/workers/20261027/<file> --file part.gz --remote
gunzip -c part.gz | jq -c 'select(.Outcome != "ok") | {EventTimestampMs, ScriptName, Exceptions}'
gunzip -c part.gz | grep -F audit_event | jq -c '{EventTimestampMs, ScriptName, Logs}'
```

(Add `--jurisdiction` for a deployment in one. Wrangler can't list a bucket; list a day's files
in the dashboard, **R2** > the bucket, or with any S3 client and an R2 read token.) The job's state, its last push and last error, is in
the account's **Logpush** page in the dashboard. Cost: Workers Logpush is 10 million
pushed records a month included on the account, then $0.05 a million, and R2 storage of the
gzipped files.

## Holding and checking deployments

- **Hold a customer** on what they run now (a change freeze, an incident) with `"hold": true` in
  their file. Remove it to catch them up on the next deploy; migrations apply in order, so they
  catch up in one deploy.
- **Fleet status:** `node scripts/fleet.ts status` calls each deployment's `/health/deep` and
  prints its ring, domain and health.

## Dead letters

A message that a catalog queue gives up on (feed parts after 5 deliveries, listing changes and
purges after 11; each retry backs off, up to 5 or 15 minutes) goes to that queue's dead-letter
queue, `commerceworker-catalog-<feed-parts|changes|purge>-dlq<suffix>`. The catalog Worker consumes
all three: it writes each message to the catalog bucket at
`dlq/<queue>/<yyyy-mm-dd>/<message id>.json` (`queue`, `id`, `timestamp`, `attempts` and the
original `body`), logs one line, and acknowledges it. The line is logged at error level
(`console.error`), and Workers Observability counts error logs in the Worker's Issues: alert on new
Issues for `commerceworker-catalog<suffix>`, since the API can't create an alert that matches a log
line. To find them in the logs, query the catalog Worker's events for `"type":"dlq_message"`:

```json
{"type":"dlq_message","queue":"commerceworker-catalog-changes-dlq-acme","id":"…","attempts":1}
```

`attempts` is the delivery count on the dead-letter queue, not the original one. Objects under
`dlq/` expire after 30 days (the lifecycle rule `dlq`), and every queue keeps undelivered messages
14 days, so a consumer that is down over a weekend loses nothing.

**Inspect.** In the dashboard, **R2** > `commerceworker-catalog<suffix>` > **Objects**, filter by the
prefix `dlq/<queue>/`; or fetch one with
`wrangler r2 object get commerceworker-catalog<suffix>/dlq/<queue>/<date>/<id>.json --remote --pipe`
(add `--jurisdiction eu` for an EU deployment). Look at the catalog Worker's logs around the
message's `timestamp` for why its consumer failed, and fix that first: a replay into a consumer that
still fails comes back to the dead-letter queue.

**Replay.** Replaying is sending the object's `body` back to the original queue (the dead-letter
queue's name without `-dlq`). Find the queue's id with `wrangler queues info <queue>`, then send the
body through the Queues API (`POST /accounts/<account>/queues/<queue id>/messages` with
`{"body": <body>, "content_type": "json"}`, a token with Queues edit), or send it from the queue's
page in the dashboard (**Queues** > the queue). What each needs:

- **Listing changes** (`commerceworker-catalog-changes`) are idempotent by `at`: replay the body as it
  is. For many, a `reindex` (`POST /api/v1/catalog/reindex`, `admin`) republishes every product and
  rebuilds every listing instead.
- **Feed parts** (`commerceworker-catalog-feed-parts`) point at `feeds/<feed>/parts/…`, which expire
  after 30 days; replay one only while that object exists. Its shard batch id is the part id, so a
  replay never applies a row twice. Usually it is simpler to import the feed again.
- **Purges** (`commerceworker-catalog-purge`) are rarely worth replaying: documents refresh on their own
  within `max-age`. Replay one only for a takedown or price correction that must leave the cache
  now.

Delete a dead letter's object once it is handled, or leave it to expire.

## Catalog backups

The catalog's source of truth is the SQLite storage of its Durable Objects: `CatalogMeta` (types,
channels, categories) and the 64 `CatalogShard`s (products, alias claims, and the product editor's
feed rows, overrides, staged edits, drafts, history, refused rows, gap index and board). Durable
Objects keep 30 days of point-in-time recovery; the backup Workflow keeps a copy past that, and is
the catalog's export.

**What and when.** `commerceworker-catalog-backup<suffix>` runs daily at 02:45 UTC (its `schedules`). It
copies every table of record of `meta` and `shard-0` … `shard-63`, one step per object, into the
catalog bucket (`apps/catalog/src/backup.ts`):

| Key | Holds |
|---|---|
| `backups/<yyyy-mm-dd>/<object>/<table>-<n>.ndjson` | Up to 1,000 rows (about 8 MB) of one table, a JSON object a line, keyed by column name |
| `backups/<yyyy-mm-dd>/<object>/bookmark.json` | The object's point-in-time-recovery bookmark when its copy started |
| `backups/<yyyy-mm-dd>/manifest.json` | Written last: `format`, `date`, `finishedAt`, `docFormat`, `shards`, and per object its `bookmark` and per table `rows`, `chunks` and `columns`. A day without one is a backup that hasn't finished |

Not copied: a shard's `outbox`, `applied`, `published` and `gap_rebuild` (transient, or a record of
what is in R2 now, which a restore keeps), and the objects that hold nothing of record:
`ListingIndexer` and `SearchShard` (rebuilt by the republish a restore ends with),
`CatalogPublisher` (stores nothing) and `CatalogFeeds` (the history of past imports, whose files
expire after 30 days anyway). Rows are read a page at a time while writes go on, so a backup isn't
one instant across pages; its bookmarks are exact points. A second run on a day that has a
manifest copies nothing; a run that failed resumes where its chunks stop (each records the last
row it holds), and every write skips a key that exists, since the lock refuses an overwrite.

**Retention.** Backups expire after `catalogBackupDays` (default 90; the lifecycle rule `backups`)
and are locked for as long (`catalog-backups`, [Bucket locks](#bucket-locks)), so nothing deletes
or overwrites one before then.

**Check the latest.** In the dashboard, **Workflows** > `commerceworker-catalog-backup<suffix>` lists
each day's instance. Or read a day's manifest (add `--jurisdiction eu` for an EU deployment):

```bash
wrangler r2 object get commerceworker-catalog<suffix>/backups/<yyyy-mm-dd>/manifest.json --remote --pipe \
  | jq '.finishedAt, ([.objects[].tables.products.rows] | add)'
```

To take one now (an export before removing a customer), run `wrangler workflows trigger
commerceworker-catalog-backup<suffix>`; it is named by the UTC date it starts on, so on a day that
already has one it copies nothing.

### Restoring the catalog

Restores run as the operator-only Workflow `commerceworker-catalog-restore<suffix>`
(`apps/catalog/src/restore.ts`): nothing routes to it, and it starts only from `wrangler workflows
trigger` with the deployment's own Workflow name (`commerceworker-catalog-restore` for commerceworker,
`commerceworker-catalog-restore-acme` for acme). Pause feeds and product edits while it runs: a write
that lands mid-restore may be lost.

Every mode ends the same way: every channel still published somewhere (in the shards' records
or R2's documents) that the restored config lacks is taken down (as deleting a channel does), the
category trees republished, the config revision moved past every one served before, and every
product, and every key published before, republished in full, so delivery, listings, search
and the order prices in D1 follow the restored catalog and nothing it removed stays published.
Watch it with `wrangler workflows instances describe commerceworker-catalog-restore<suffix> <instance
id>`. Its output is `{ mode, undo, rev, republished, channelsRemoved }`; `undo` maps each object to
its bookmark from before the restore, also kept at `restores/<instance id>/before.json` (expired
after 30 days). Keep it.

**If a restore fails**, its error says so and names that instance: what it changed stays changed.
Run the same restore again with `"merge": ["<failed instance id>"]` added to finish it (list several
earliest first); the new run takes the failed one's `before`, so its `undo` is still the catalog
from before either, and joins the `published` copies the failed one made. Or restore the `undo`
bookmarks in its `before.json` to take it back:

```bash
wrangler r2 object get commerceworker-catalog<suffix>/restores/<instance id>/before.json --remote --pipe | jq .undo
```

**To a time in the last 30 days** (point-in-time recovery; milliseconds or ISO 8601):

```bash
wrangler workflows trigger commerceworker-catalog-restore<suffix> --params '{"at": "2026-10-27T09:30:00Z"}'
```

Every object's bookmark for that time is found first, so a time out of reach changes nothing. Then
each object in turn copies its `published` table to `restores/<instance id>/` and sets its rewind
in one call, with nothing able to publish in between, and restarts on the restored storage; the
step checks that it did restart before going on. The copy is joined back, so the republish takes
down what the rewound products no longer publish.

**Undo a restore** by restoring the bookmarks in its output's `undo` (any of `meta` and
`shard-<n>`):

```bash
wrangler workflows trigger commerceworker-catalog-restore<suffix> --params '{"bookmarks": {"meta": "…", "shard-0": "…"}}'
```

**From a backup** (any day still kept, older than 30 days included):

```bash
wrangler workflows trigger commerceworker-catalog-restore<suffix> --params '{"backup": "2026-10-20"}'
```

It first checks the whole backup without changing anything: the manifest (its format and shard
count), every table in it with columns the tables still have, and every chunk there with the rows
the manifest counts. A backup that fails that is refused, naming what is wrong. Then it replaces
each object's tables with the backup's rows, one step per object (a retried step clears and loads
again); nothing publishes until every object is loaded. Shards keep their `published` table, so
the republish takes down what the backup doesn't have, and their product id counter never goes
back. Its `undo` bookmarks rewind the objects to just before the load, while that is within 30
days.

## Redundancy

`redundancy` in a deployment's registry entry turns on protection for the commerce database beyond Time Travel. Today that is three things: a daily backup of the commerce D1 into a bucket of its own, with a restore drill that proves each backup by rebuilding it in a second database; restore tooling and a nightly copy for the engine's Durable Objects ([Durable Object state](#durable-object-state)); a replica of the docs bucket (the order documents, the audit archive, plugin bundles and carts' files) that every create and delete is copied to as it happens; and, for a deployment that sends mail, a queue for order and sign-in email with retries, a dead-letter queue and a fallback sender ([The mail queue](#the-mail-queue)). Later changes add the rest of what `except` names; `alerts` is acted on by [Alerting](#alerting); `offsite` is accepted and checked now and **does nothing yet**. A deployment without the field renders, provisions and deploys exactly as it did before. `commerceworker` has it on.

**Set it** in `deployments/<id>.jsonc`: `"redundancy": true` for the defaults, or an object ([The registry](#the-registry)). It must be provisioned before the merge that carries it: `./scripts/provision.sh <id>` creates the backups bucket `commerceworker-backups<suffix>` (in the deployment's jurisdiction, with a lifecycle rule and a bucket lock on `d1/` and on `objects/` for `backupDays`, [Bucket locks](#bucket-locks)) and the standby D1 database `commerceworker-standby<suffix>`, and writes `standbyD1Id` into the entry (commit it). Each is read before it is created, so a re-run changes nothing but the retention, and it stops if the standby it finds is the live database. A deployment with `redundancy` and no `standbyD1Id` fails to render and stops the deploy plan, like one without `d1Id`; hold it (`"hold": true`) until it is provisioned.

**What runs.** The engine gets two Workflows, started by their `schedules`:

| Workflow | When | Does |
|---|---|---|
| `commerceworker-d1-backup<suffix>` (`D1Backup`) | daily at `backupHourUtc` (default 01:00 UTC) | Copies every table of record to `commerceworker-backups<suffix>` |
| `commerceworker-d1-restore<suffix>` (`D1Restore`) | Sundays (`weekly`) or the 1st of the month (`monthly`), six hours after the backup's hour; or by hand | Rebuilds the newest backup, or the one it is given, in the standby database and checks it |

**The backup** (`apps/engine/src/d1-backup.ts`, the logic in `packages/application/src/commerce/database-backup.ts`) reads the database through its binding a table at a time, in pages of up to 1,000 rows (about 4 MB), and writes each as a gzipped NDJSON chunk, one Workflow step a chunk:

| Key | Holds |
|---|---|
| `d1/<yyyy-mm-dd>/<table>/<n>.ndjson.gz` | A page of one table, a JSON object a row, with its SHA-256 and row count in the object's metadata |
| `d1/<yyyy-mm-dd>/manifest.json` | Written last: the date, `startedAt` and `finishedAt`, the newest applied migration (`migrationHead`), the schema (every table's `CREATE` statement and columns, in load order; indexes, triggers and views; the search index), and each table's chunks with their hashes and row counts. A day without one is a backup that hasn't finished |
| `drills/<yyyy-mm-dd>.json` | A drill's evidence: `outcome`, the backup it restored, `minutes` taken and each check's result |

A second run on a day that has a manifest copies nothing; a run that failed resumes after the chunks already stored, and every write skips a key that exists, as the lock needs. Rows are read a page at a time while writes go on, so a backup is not one instant across tables: `startedAt` and `finishedAt` bound it. The manifest has no Time Travel bookmark (a Worker can't read one): `timeTravelBookmark` is always `null`, and `wrangler d1 time-travel info DB --timestamp=<startedAt>` finds the bookmark for a backup's start. Not copied: SQLite's and D1's own tables, and the `products_search` keyword index with its shadow tables (D1 can't export a virtual table either): its definition and settings are in the manifest and a restore rebuilds it from `products`. A backup refuses a value it can't carry (a BLOB). Workflows allow 10,000 steps an instance and a restore takes about two steps for each chunk, so the copy suits a database up to a few million rows; past that, the page size must be raised first (a drill fails at the step limit rather than restoring less).

**The drill** restores into `STANDBY_DB` and nowhere else; the engine has no other restore target. It:

1. finds the newest backup that finished (or the `date` it was given) and refuses a day with no manifest;
2. checks every chunk against the manifest's hash, **before anything is wiped**, and refuses one that is missing or doesn't match;
3. empties the standby (which must be empty, or have been made by an earlier restore: it refuses a database holding other tables, so a binding pointed at the live database wipes nothing), creates the tables from the manifest's schema, loads the chunks in foreign-key order, then creates indexes, triggers and views and rebuilds the search index;
4. checks the result against the manifest: the tables present, each table's row count, the newest migration (`d1_migrations`), `PRAGMA foreign_key_check` (no violations), the audit trail's hash chain (verified end to end) and that the search index holds every product;
5. writes `drills/<date>.json`. A failed drill sets `outcome` to `failed`, says why in `error`, writes the line `d1 restore drill failed` with `console.error` and fails the Workflow instance.

The schema comes from the backup's manifest, not from `packages/db/migrations`, so a backup restores into the schema it was taken with even after the repo has moved on; the migration check compares the restored database's `d1_migrations` with the manifest's `migrationHead`. A failed drill is a problem with the backup, not a reason to wait: read the evidence and the instance's error, and fix it before the next backup replaces the one before it. Nothing else alerts on a failed drill yet beyond the failed Workflow instance and the error-level log line, which [Workers Issues](#alerting) groups.

**Check the latest** (add `--jurisdiction eu` for an EU deployment; `--remote` reads the real bucket):

```bash
wrangler r2 object get commerceworker-backups<suffix>/drills/<yyyy-mm-dd>.json --remote --pipe | jq '{outcome, backup, minutes, error}'
wrangler r2 object get commerceworker-backups<suffix>/d1/<yyyy-mm-dd>/manifest.json --remote --pipe | jq '.startedAt, .finishedAt, .migrationHead'
```

To take a backup or run a drill now, `wrangler workflows trigger commerceworker-d1-backup<suffix>` or `commerceworker-d1-restore<suffix>` (a backup is named by the UTC date it starts on, so on a day that has one it copies nothing).

The backup is not a request path, so it changes no query count in `packages/db/test/query-counts.json`.

### The docs replica

With `redundancy` on and `r2Replica` not an exception, every object written to or deleted from the docs bucket (`commerceworker-docs<suffix>`) is copied to `commerceworker-docs-replica<suffix>`, in the same jurisdiction.

**Provision it before the merge** that carries it, as for the backups: `./scripts/provision.sh <id>` creates the bucket; its queue `commerceworker-docs-replica<suffix>` and dead-letter queue `commerceworker-docs-replica-dlq<suffix>` (14-day retention, like every queue here; a dead-letter queue must share its queue's jurisdiction, and both are created the same way); and one notification rule on the docs bucket that sends `object-create` and `object-delete` to the queue. The engine's deploy fails if either queue is missing. Everything is read before it is created, so a re-run only sets the retention, the lifecycle rules and the locks again. Rules on the replica:

| Rule | Prefix | Does |
|---|---|---|
| lifecycle `deleted-copies` | `deleted/` | Expires moved copies after 30 days |
| lifecycle `dlq` | `dlq/` | Expires kept dead letters after 30 days |
| lifecycle `audit-archive` | `audit/` | Expires after `auditArchiveDays`, as in the docs bucket; none when unset |
| lock `audit-archive`, `plugin-bundles` | `audit/`, `plugins/` | The same as the docs bucket's ([Bucket locks](#bucket-locks)) |

**What runs** (`apps/engine/src/docs-replica.ts`):

- **The consumer** applies each notification, a batch of 10 at a time. A create copies the object with its content type and custom metadata, and records the source's etag in `cw-source-etag`; it first compares size and that etag, so a redelivered event copies nothing. A delete moves the copy to `deleted/<yyyy-mm-dd>/<key>` (the date of the event), so an erasure in the docs bucket is complete in the replica within 30 days; a delete for a key that has been written again moves nothing. `audit/` and `plugins/` are copied once and never refreshed or moved: their locks refuse it, so the replica's lifecycle rule expires them instead. `health/` (the deploy's write check) is not copied. An event that fails is retried (30 seconds, doubling, five retries) and then goes to the dead-letter queue.
- **Dead letters** are kept in the replica as `dlq/<queue>/<date>/<id>.json` and logged at error level (`{"type":"dlq_message",...}`), which Workers Issues counts; the nightly reconcile copies the object regardless.
- **The reconcile** (`commerceworker-docs-reconcile<suffix>`, `DocsReplicaReconcile`, daily at 04:00 UTC, or `wrangler workflows trigger`) lists both buckets a hundred objects a step, re-copies what the replica lacks or holds stale, and lists what the replica holds that the docs bucket doesn't (**extras**: flagged, never moved, since they mean a delete event was lost). It writes `replica/<yyyy-mm-dd>.json` to the replica: `outcome` (`clean`, `repaired` or `attention`), the object counts on each side, `copied`, the `held` keys (locked keys whose copy differs from the original), `failed` keys with their errors, and the `extras` count with up to 100 keys. A failed or held key is logged at error level, extras at warning level. It suits a bucket of up to a few hundred thousand objects (10,000 steps).
- **Reads fall back.** The engine's reads of the docs bucket (a document's body, a cart's file for its buyer, an image for Clef, a pinned plugin bundle) read the replica when the docs bucket answers with a service error or doesn't answer within 3 seconds, and log `{"type":"docs_replica_read","key":...,"reason":"error"|"timeout","found":...}` at warning level: count those lines to see how often. A missing object is not an error and is not looked up in the replica. **Writes never fail over**: a write that fails fails. The web app's own reads of the docs bucket don't fall back.

**Check it:**

```bash
wrangler r2 object get commerceworker-docs-replica<suffix>/replica/<yyyy-mm-dd>.json --remote --pipe | jq '{outcome, primary, replica, copied, held, failed, extras}'
```

The replica is in the same Cloudflare account as the docs bucket: it survives losing an object, a bucket or R2 in a region, not the account. An object is copied within seconds of its write, so the replica trails by what is in the queue.

### The mail queue

With `redundancy` on, `email` set and `email` not an exception, the engine sends an order's confirmation and retries a sign-in code through a queue instead of inline. Without them, mail is sent inline exactly as before: a failed confirmation is recorded on its message and the Workflow step retries three times; a failed sign-in code answers the shopper "couldn't send".

**Provision it before the merge** that carries it: `./scripts/provision.sh <id>` creates four queues (14-day retention): `commerceworker-email<suffix>`, its dead-letter queue `commerceworker-email-dlq<suffix>`, `commerceworker-email-events<suffix>` (Email Sending's delivery events) and its `commerceworker-email-events-dlq<suffix>`; and one Email Sending event subscription per sending domain (`from`'s and, if set, `fallbackFrom`'s) to the events queue, found by the domain's zone in the account and read before it is made. A domain whose zone isn't in the account is reported and skipped (its messages just show no delivery status). Queues are account-level: a dead-letter queue is in its queue's account by construction, and a queue can't be pinned to a jurisdiction. The engine's deploy fails if a queue is missing. A registry id can't be, or start with, `dlq` or `events`, since the engine tells the queues apart by name.

**What runs** (`apps/engine/src/email-queue.ts`, the rules in `packages/application/src/commerce/email-queue.ts`):

- **A confirmation.** The Workflow's confirmation step files the `messages` row (`msg_<orderId>_confirmation`, kept unsent) and queues a job that names the order and carries nothing else. The consumer builds the email (minting the receipt credential only then, so no queue message or dead letter ever holds one), sends it and sets `sent_at` and the id Email Sending returned (`provider_id`). **A redelivery finds `sent_at` set and sends nothing.** Email Sending's binding takes no idempotency key, so a crash between the binding accepting a message and `sent_at` being written can still send it twice; that is the one duplicate this design allows.
- **Retries.** A refusal leaves the row unsent with its last error (`messages.error`) and is retried after 30 seconds, doubling, up to 15 minutes, six retries; then the message goes to `commerceworker-email-dlq<suffix>`.
- **Dead letters** are kept in the docs replica as `dlq/commerceworker-email-dlq<suffix>/<date>/<id>.json`, logged at error level (`{"type":"dlq_message",...}`, which Workers Issues counts) and counted as `failover` `email_failed` in [Metrics](#metrics). Without the docs replica (`r2Replica` an exception) there is nowhere to keep them: the error line is logged with the id, and the order's message still says it never went. A confirmation that dead-lettered is redriven ([Redriving dead letters](#redriving-dead-letters)), or found by `sent_at IS NULL`.
- **Delivery status.** Email Sending's events (`delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained`) arrive on the events queue and set `delivery_status`, `delivery_at` and `delivery_detail` (the SMTP reason) on the message whose `provider_id` they name. A later status replaces an earlier and never the reverse (a complaint outranks a delivery), so redelivered or reordered events are safe. An event for a message with no row (a sign-in code's) is retried twice, for one that beat its own `sent_at`, then dropped. Bounces, failures, rejections and complaints are logged at warning level (`email_delivery_problem`). Read them with `SELECT id, delivery_status, delivery_detail FROM messages WHERE delivery_status NOT IN ('delivered', 'deferred')`.

**Sign-in codes keep a direct first attempt.** A queued send adds a batch wait and a hop to the one email a person is staring at the form for, so the code is sent inline, as it always was; only when that attempt fails is it queued as the retry (and the shopper is told it is on its way, not that it failed). The queue job carries the code's expiry (ten minutes) and is dropped, unsent, once the code is dead. A sign-in has no `messages` row: it holds a live credential, belongs to no order, and `messages` is read by staff. Its job is therefore the code itself, so a dead-lettered one is kept with the code and address removed (`redacted`) and is never redriven. The shopper-facing timing is unchanged unless Email Sending is failing.

#### A fallback sender

`email.fallbackFrom` names a second address on a second domain onboarded to Email Sending (`wrangler email sending enable <domain>`), and the engine binds it as `EMAIL_FALLBACK`. A send that the first sender's binding refuses with `E_SENDER_NOT_VERIFIED` or `E_SENDER_DOMAIN_NOT_AVAILABLE` (the domain isn't, or is no longer, onboarded) or `E_INTERNAL_SERVER_ERROR` (Email Sending's own failure, the only 5xx) is sent again from the fallback; if that fails too, both errors are recorded. The binding's other errors are not tried again from the fallback, since it is the same account and message: `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_ACCOUNT_SUSPENDED`, `E_RECIPIENT_SUPPRESSED`, validation errors and `E_DELIVERY_FAILED`; the queue's retries handle the transient ones. The fallback shares the account, so it survives an unverified or misconfigured domain and a failing sender, not an account-wide suspension or an Email Sending outage that covers every domain.

### Redriving dead letters

A dead letter kept in R2 (`dlq/<dead-letter queue>/<date>/<id>.json`: the docs replica for the docs replica's and the mail queues', the catalog bucket for the catalog's, [Dead letters](#dead-letters)) is sent back to the queue it failed on by an operator, once Email Sending (or whatever failed) is working again:

```bash
export CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=…   # a token with Queues edit
export R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=…         # an R2 API token with read and write on the bucket
node scripts/fleet.ts redrive <id> email --dry-run       # what would be sent
node scripts/fleet.ts redrive <id> email 2026-11-12      # the day's dead letters; omit the date for all kept
```

`<queue>` is `email`, `email-events`, `docs-replica`, `catalog-feed-parts`, `catalog-changes` or `catalog-purge` (the ones the deployment runs). For each kept object the command writes a marker `dlq/redriven/<dead-letter queue>/<date>/<id>.json` **first**, then pushes the original `body` to the queue; if the push itself fails it removes the marker, so a message is redriven **at most once** (a crash between the two leaves a marker with nothing sent: delete it to try again, and look for the message on the queue first). A second run skips marked objects, a sign-in code's redacted dead letter is skipped, and the markers expire with the objects after 30 days. It prints what it sent, skipped and failed as JSON and exits non-zero on a failure. It sends production messages with an operator's credentials, so it refuses to run when `CI` or `GITHUB_ACTIONS` is set, and no workflow runs it. Fix the cause first: a message redriven into a consumer that still fails comes straight back. A redriven confirmation finds `sent_at` set if it went after all, and sends nothing.

### Durable Object state

An order, a cart, an A2A caller's tasks and a sandboxed plugin's database each live in a Durable Object, which D1 backups and Time Travel don't cover. Their own protection is point-in-time recovery (PITR): any object can be rewound to any moment of the last 30 days. With `redundancy` on and `objectBackup` not an exception, the engine adds a way to use it, a nightly copy that outlasts the 30 days, and a drill. PITR does not run in local dev or in tests; what a restore does to an object can be seen only on a deployment.

| Workflow | When | Does |
|---|---|---|
| `commerceworker-objects-restore<suffix>` (`ObjectsRestore`) | By hand only | Rewinds named objects to a time or a bookmark, and writes a report with each one's undo |
| `commerceworker-objects-backup<suffix>` (`ObjectsBackup`) | daily, two hours after `backupHourUtc` (default 03:00 UTC) | Copies the live orders' and open carts' state to `objects/<yyyy-mm-dd>/` |
| `commerceworker-objects-drill<suffix>` (`ObjectsDrill`) | with the D1 drill's `drill` days, an hour after it | Rewinds a probe object, checks it, undoes the rewind |

The objects answer three internal calls (`pitrBookmark`, `restoreTo`, `exportState`), reachable only from the engine through its own Durable Object bindings: no route, socket or `@callable` reaches them. `restoreTo` sets the object to restart on the bookmark's storage, keeps the bookmark that undoes it in the backups bucket, and aborts the object, which restarts restored.

**The nightly copy** (`apps/engine/src/objects.ts`, the logic in `packages/application/src/commerce/objects-restore.ts`) lists the orders that haven't reached a final status and the carts that are open from D1, 25 at a time in id order, and writes each one's tables (and the Agents SDK's synced state, which is where the order or cart itself is) as one line of a gzipped NDJSON chunk, a Workflow step a chunk:

| Key | Holds |
|---|---|
| `objects/<yyyy-mm-dd>/OrderAgent/<n>.ndjson.gz`, `…/CartAgent/<n>.ndjson.gz` | A page of objects, `{ "name", "state": { "tables": … } }` a line, or `{ "name", "error" }` for one that couldn't be read; its SHA-256 and counts are in the object's metadata |
| `objects/<yyyy-mm-dd>/manifest.json` | Written last: each class's chunks with their hashes, the object and error counts, and `capped`. A day without one didn't finish |
| `objects/restores/<time>.json` | A restore's report (below) |

At most 20,000 objects of a class are copied a night (`capped: true` says it stopped there), which keeps the run under the Workflow's 10,000 steps. A second run on a day that has a manifest copies nothing; a run that failed resumes after the chunks already stored. Objects are read while writes go on, so the copy is not one instant. A copy is kept and locked `backupDays` days, like `d1/`. A2A callers and plugin storage are not in the copy (a plugin's database is exported when it is uninstalled). **There is no import tool**: a copy is read and its rows put back by hand (`wrangler r2 object get … --pipe | gunzip | jq`), for the case where PITR's 30 days have passed.

**The drill** writes a row to its own probe object (`HealthProbe` named `drill`, never the smoke test's), notes the bookmark, writes a second row, restores to the bookmark and checks only the first row is there, then restores to the undo bookmark and checks both are back. It writes `drills/objects-<yyyy-mm-dd>.json` (`outcome`, the two bookmarks, both checks, `minutes`). A failed drill says why in `error`, logs `objects restore drill failed` at error level and fails the instance.

**Check the latest:**

```bash
wrangler r2 object get commerceworker-backups<suffix>/drills/objects-<yyyy-mm-dd>.json --remote --pipe | jq '{outcome, minutes, checks, error}'
wrangler r2 object get commerceworker-backups<suffix>/objects/<yyyy-mm-dd>/manifest.json --remote --pipe | jq '.classes | map_values({objects, errors, capped})'
```

### Restoring an order's or cart's live state

Use this when a bad deploy or a bug corrupted what named orders or carts hold (their state, timeline, waits or chat), and the damage is in the last 30 days. It rewinds those objects only: not D1, not other objects.

1. **Find the objects and the time.** The names are the order ids (`ord_…`) or cart ids; one run takes at most 50, so run it again for more. Choose `at` just before the damage began, in RFC 3339 (`2026-11-12T09:30:00Z`): the deploy's time in CI, or the first bad entry in the order's timeline, minus a margin. Everything the object wrote after `at` is lost, including legitimate events: a smaller margin loses less. A time older than 30 days, or in the future, is refused, and nothing is changed.
2. **Start it** The class is `OrderAgent`, `CartAgent`, `A2AAgent` or `PluginStorage`:

   ```bash
   wrangler workflows trigger commerceworker-objects-restore<suffix> --params '{"class":"OrderAgent","names":["ord_1","ord_2"],"at":"2026-11-12T09:30:00Z"}'
   wrangler workflows instances describe commerceworker-objects-restore<suffix> latest
   ```

   It finds every object's bookmark before it touches one, so a time out of reach for any of them changes nothing. For each object it then records the bookmark that undoes the restore, sets the restore and aborts the object, which restarts restored; an OrderAgent or CartAgent then writes its D1 row again from the restored state. An object that fails is recorded and the others go on; the instance fails and says which.
3. **Read the report**, `objects/restores/<time>.json` in `commerceworker-backups<suffix>`: `outcome`, each object's `bookmark`, `undo` and `reindexed`, and `undo`, the map to keep.

   ```bash
   wrangler r2 object list commerceworker-backups<suffix> --remote --prefix objects/restores/
   wrangler r2 object get commerceworker-backups<suffix>/objects/restores/<time>.json --remote --pipe | jq '{outcome, objects, undo}'
   ```

4. **Check the index.** The Orders and Carts lists read D1, which the restore re-wrote from the restored state: open the order or cart and compare, or read the row (`wrangler d1 execute <db> --remote --command "SELECT id, status, updated_at FROM orders WHERE id = 'ord_1'"`). `reindexed: false` on an order or cart means the step failed: its error is in the report.
5. **Undo it** by restoring to the undo bookmarks (the object keeps its `undo` for the same 30 days):

   ```bash
   wrangler workflows trigger commerceworker-objects-restore<suffix> --params '{"class":"OrderAgent","names":["ord_1"],"bookmarks":{"ord_1":"<undo from the report>"}}'
   ```

Caveats: **the object is rewound, nothing around it is.** An order's Workflow instance, Stripe, carriers and webhooks already sent keep what they did, and the restored order may be behind them: restore an order whose Workflow has ended, or cancel its instance first, and reconcile payments by hand. D1 rows other than the order's and cart's own index row are not rewound. Retrying the Workflow is safe: an object whose undo is already kept is not rewound again. The copy under `objects/<date>/` is for what PITR can't reach.

### Restoring R2 objects from the replica

Use this when objects are missing or damaged in the docs bucket (deleted by mistake, overwritten, or the bucket is gone), or the docs bucket is down for long enough that you want it repaired rather than waited out (reads already fall back).

1. **Find the damage.** The last reconcile's `replica/<date>.json` says how many objects the replica holds beyond the docs bucket (`extras`: objects deleted there) and how many it re-copied the other way (`copied`: objects missing from the replica). Objects deleted from the docs bucket, by anyone and for any reason, are under `deleted/<date>/<key>` for 30 days.
2. **List what you will restore.**

   ```bash
   wrangler r2 object list commerceworker-docs-replica<suffix> --remote --prefix orders/<order id>/   # live copies
   wrangler r2 object list commerceworker-docs-replica<suffix> --remote --prefix deleted/<yyyy-mm-dd>/ # a day's deletes
   ```

3. **Leave erasures erased.** A copy under `deleted/` is data someone deleted, possibly to erase it for a buyer. Restore only what you meant to lose.
4. **Copy objects back**, through the S3 API or `wrangler r2 object get <replica>/<key> --remote --file <tmp>` then `wrangler r2 object put commerceworker-docs<suffix>/<key> --remote --file <tmp> --content-type <type>` (with `--jurisdiction` as provisioned). Put back the original key (drop `deleted/<date>/`). Each restored object raises a create notification, which copies it into the replica again: that is expected and changes nothing.
5. **A whole bucket lost:** recreate `commerceworker-docs<suffix>` with `provision.sh` (it sets the lifecycle rules, the locks and the notification rule), then copy every live key of the replica (everything outside `deleted/`, `replica/` and `dlq/`) back with the S3 API or Rclone, with each object's content type.
6. **Check:** trigger `commerceworker-docs-reconcile<suffix>`; its report should read `clean` or `repaired` with no `held` or `failed` keys, and no extras beyond what you chose not to restore.

Caveats: the docs bucket's D1 records (`documents`) are in the database, not the bucket: a restored object is reachable again by its key. A copy keeps its content type and custom metadata, not other HTTP metadata (`cacheControl`, `contentDisposition`). An object written and deleted before its create event was applied has no copy. A restored `audit/` or `plugins/` object is refused if one with that key exists in the docs bucket.

### Restoring commerce D1 from a backup

**Prefer Time Travel** when the loss is inside its 30 days: it restores to the minute, in place, with no registry change ([Restoring D1](deploy.md#restoring-d1)). Use a backup when the database is gone or can't be restored in place, or the point you need is older than 30 days.

1. **Hold the deployment** (`"hold": true`) and, if the database is still answering, stop writes you don't want to lose: nothing else changes until step 5.
2. **Pick the backup.** List `d1/` in `commerceworker-backups<suffix>` and read the manifests' `finishedAt`; the newest finished one loses the least. Check the last drill's evidence is `passed` for it.
3. **Restore it into the standby:**

   ```bash
   wrangler workflows trigger commerceworker-d1-restore<suffix> --params '{"date": "2026-11-12"}'
   wrangler workflows instances describe commerceworker-d1-restore<suffix> latest
   ```

   Read `drills/<today>.json`: the outcome is `passed` only when every check is. A chunk that fails its hash, or a standby that isn't empty and wasn't made by a restore, stops it before anything is written.
4. **Look before you promote.** The standby is a complete database: `wrangler d1 execute <standby name> --remote --command "SELECT count(*) FROM orders"`, and its `d1_migrations` head against what is deployed. A deploy applies any migration after the head, so a backup older than a migration is fine.
5. **Promote it.** In `deployments/<id>.jsonc` put the standby's id in `d1Id` (and keep the old `d1Id` aside), remove `hold`, and merge: CI renders `d1Id` into the web, engine and catalog configs, applies the migrations after the backup's head, and deploys. The standby needs no schema step of its own.
6. **Provision a new standby** for the next drill: the promoted database can't also be one. Create another D1 database (`wrangler d1 create`), write its id as `standbyD1Id`, and delete the database you replaced once you no longer need it.

Caveats:

- **What is lost is everything written since the backup began**, up to a day: orders, approvals, audit events and carts. Stripe and the carriers know about charges and shipments the database doesn't: reconcile them by hand. Files in the docs bucket for lost orders stay there, unreferenced.
- **Durable Object state is not in D1** and is not restored: live orders' and carts' agents keep what they held, which may name rows the restore doesn't have. Check running orders against the restored `orders` table before resuming anything; rewind objects with [Restoring an order's or cart's live state](#restoring-an-orders-or-carts-live-state) if they need it.
- **The restore wipes and rebuilds the standby each time**, so promote only once you have what you need from the drill's result: a drill run after the promotion has a different standby.
- **Webhook deliveries marked sent after the backup are pending again** and go out a second time; receivers dedupe on the delivery id.
- **`provision.sh` finds databases by name.** The promoted database keeps the name `commerceworker-standby<suffix>`, so re-running the script for the deployment would write the old database's id back as `d1Id`. Don't re-run it for a deployment after a promotion; until it learns the swap, resource names and ids disagree on purpose and the ids are the truth. `wrangler d1 time-travel` works from the new `d1Id` as usual.
- **AUTOINCREMENT counters** start again after the highest row loaded (SQLite's `sqlite_sequence` is not copied), which only matters for ids a deleted row once held.
- A backup older than 30 days has no Time Travel behind it; a restore from it is the only recovery for its date.

### What is recovered, and how fast

| What went wrong | Recovered from | Data lost (RPO) | Time to recover (RTO) |
|---|---|---|---|
| A migration or a bad write corrupted rows, within the last 30 days | D1 Time Travel to a minute or a deploy's bookmark ([Restoring D1](deploy.md#restoring-d1)) | About 1 minute: restore to any minute in the last 30 days | One `wrangler d1 time-travel restore`; the database is replaced in place |
| The database is lost or can't be restored in place; or the point is older than 30 days | The daily backup in `commerceworker-backups<suffix>`, restored into the standby and promoted ([above](#restoring-commerce-d1-from-a-backup)) | Up to 24 hours (since the last backup began); kept `backupDays` days (default 35) | The drill's `minutes` for the restore, which the latest evidence records, plus one deploy |
| An order document, the audit archive or a plugin bundle is deleted or overwritten in the docs bucket, or the bucket is lost | The replica `commerceworker-docs-replica<suffix>`, filled by R2 event notifications ([The docs replica](#the-docs-replica), [Restoring R2 objects from the replica](#restoring-r2-objects-from-the-replica)); deleted files stay in its `deleted/` for 30 days | Seconds (an object is copied when written); anything still in the queue, which the nightly reconcile repairs | The time to copy the keys back. Reads of the docs bucket fall back to the replica after a 5xx or 3 seconds, so an outage of the docs bucket is not downtime for reads |
| Email Sending refuses or is down when an order is confirmed or a shopper signs in | The mail queue's retries, then the fallback sender if the registry sets one ([The mail queue](#the-mail-queue)); a confirmation that dead-letters is redriven ([Redriving dead letters](#redriving-dead-letters)) | No order data: the message is filed in `messages` before it is queued. A mail not sent is late, not lost, until its retries (about 15 minutes) are spent | Retries start 30 seconds after a failure and back off to 15 minutes; a redrive is one command once Email Sending is back |
| The account or R2 is lost | Not covered yet: `offsite` is accepted and not acted on | The bucket's contents | None |
| A bad deploy or bug corrupted named orders' or carts' live state, within the last 30 days | Point-in-time recovery through `commerceworker-objects-restore<suffix>` ([above](#restoring-an-orders-or-carts-live-state)); the restore's undo bookmark takes it back | The object's writes after the time you choose; to the second | Minutes: a bookmark and a restart for each object, 50 at most a run |
| The same, past 30 days (a long-running subscription) | The nightly copy `objects/<date>/` of active orders and open carts, kept `backupDays` days | Up to 24 hours | By hand: no import tool |

The backup and the replica are in the same Cloudflare account as what they protect: they survive losing D1 or an object, not losing the account.

## Bucket locks

`provision.sh` sets two R2 bucket lock rules on the deployment's docs bucket
(`commerceworker-docs<suffix>`, in its jurisdiction), one on its catalog bucket
(`commerceworker-catalog<suffix>`) and, with `redundancy`, two on its backups bucket
(`commerceworker-backups<suffix>`), so nothing (a person, a script, a compromised token) can delete what
audits, rollbacks and restores rely on:

| Bucket | Rule | Prefix | Retention |
|---|---|---|---|
| docs | `audit-archive` | `audit/` | `auditArchiveDays` days from each object's creation, the same as the lifecycle rule of that name, so the lifecycle rule deletes an archive only once its lock has lapsed; indefinitely when `auditArchiveDays` is unset (and then there is no lifecycle rule) |
| docs | `plugin-bundles` | `plugins/` | Indefinitely: a pinned sandboxed-plugin bundle is what a rollback loads again |
| catalog | `catalog-backups` | `backups/` | `catalogBackupDays` days, the same as the lifecycle rule `backups` ([Catalog backups](#catalog-backups)) |
| backups | `d1-backups` | `d1/` | `redundancy.backupDays` days, the same as the lifecycle rule `d1-backups` ([Redundancy](#redundancy)); `drills/` has no lock and is kept |
| backups | `object-backups` | `objects/` | `redundancy.backupDays` days, the same as the lifecycle rule `object-backups`: the Durable Object copies and restore reports ([Durable Object state](#durable-object-state)); each rule exists only while its part (`d1Backup`, `objectBackup`) is on |
| docs replica | `audit-archive`, `plugin-bundles` | `audit/`, `plugins/` | The same two rules as the docs bucket's, with the same retention ([The docs replica](#the-docs-replica)) |

It writes them with `wrangler r2 bucket lock set`, which replaces the bucket's whole lock
configuration in one call: a re-run changes the audit retention without a moment unlocked, and a
lock rule added to this bucket by hand is dropped (add it to the script instead). Nothing in the
engine deletes under either prefix: erasure deletes `orders/<id>/` and inbound mail, never the
audit archive. Nothing overwrites under them either, since a locked object can't be written again:
the sweep and the deploy name each object by what it holds (an archive by its first event and
count, a bundle by its sha) and skip one that is already there; the catalog's backup Workflow
looks before every write the same way, and so does the commerce D1's. Shortening `auditArchiveDays` or `catalogBackupDays`
shortens its rules on the next run. Each bucket's `lock set` replaces that bucket's whole
configuration, so a rule added by hand is dropped. List the rules with
`wrangler r2 bucket lock list commerceworker-docs<suffix>` (or `commerceworker-catalog<suffix>`, or `commerceworker-backups<suffix>`).

## The bench deployment

`bench` (`deployments/bench.jsonc`, at `bench.commerceworker.com`) is a throwaway deployment for
catalog benchmarks and scale tests ([Catalog benchmark](testing.md#catalog-benchmark)), so they
never write to `commerceworker`'s catalog or its bill. It holds no customer data, takes mocked payments
and installs no plugins. To bring it up:

1. Run `./scripts/provision.sh bench`. It writes `d1Id` and `catalogKvId` into the file.
2. Commit the ids and remove `"hold": true` in the same change, then merge. CI deploys it in the
   `internal` ring.
3. Open `https://bench.commerceworker.com/setup` with the code from `.secrets/bench/setup-code`, then
   create an operator token for `COMMERCEWORKER_API_TOKEN`.

Its idle cost is close to nothing (every resource is billed by use). A run's cost is in its Durable
Object rows written: at the shape the benchmark generates, plan on roughly 200 rows a product,
counting the import and the delete.

## The demo

`demo.commerceworker.com` is a public demo, the `demo` deployment, with `"demo": true` in its
registry file. Compared with a customer's deployment:

- **Demo data.** Each deploy loads `packages/db/seed/0001_demo.sql` after the migrations (the
  customers, catalog, stores, sellers and rates local development uses), so the dashboard's
  scenarios are there.
- **One-click sign-in.** `DEMO_MODE` is `"true"`, so the sign-in page offers **Explore the demo**,
  which signs a visitor in as the shared operator `demo@commerceworker.com` (created on first use, with
  no password). People with their own account on the demo sign in below it as usual.
- **Guardrails.** Visitors can start and cancel orders, decide approvals, run scenarios and edit and
  publish flows. They can't change the Team or Account pages (people, roles, tokens, two-factor,
  sessions, settings), and integrations, webhook subscriptions and connecting apps (`/mcp`, `/a2a`)
  are closed, so the demo can't be pointed at anything outside it.
- **No spend, fast time.** Models are mocked (`AI_MODE=mock`, no AI Gateway) and waits run 1440×
  faster (`TIME_SCALE`), as in local development.
- **Failing scenarios.** `SIMULATE_FAILURES` is `"true"`, so the scenarios that fail on purpose do.
  A customer's deployment leaves it off and drops `meta.simulate` from every order.
- **Nightly reset.** `.github/workflows/demo-reset.yml` runs at 04:00 UTC (and from the Actions
  tab), once the repository variable `DEPLOY_ENABLED` is `true`: it stops the orders still running, applies `packages/db/reset/demo.sql` (everything
  visitors made, the audit log (`demo.sql` drops the `audit_events_keep_90_days` trigger around the delete and recreates it) and the demo visitor's sessions; people, settings, integrations,
  `cus_internal`, `USD` and the price sources stay) and loads the demo data again. Durable Object
  state of old orders stays behind, unreachable once their rows are gone.

To bring it up: `./scripts/provision.sh demo`, then set `"hold": false` in `deployments/demo.jsonc`
and merge. The demo's own setup code (`.secrets/demo/setup-code`) is for you, not visitors: it creates an admin account for managing the demo.

## Single sign-on

A customer signs in through its own OpenID Connect provider (Okta, Entra ID, Google Workspace, …):

1. At the provider, register a web application (authorization code flow) with the redirect URI
   `https://<domain>/login/sso/callback`. Scopes `openid email profile`; PKCE is used. Note the
   issuer (as its `/.well-known/openid-configuration` names it), the client id and the client secret.
2. Add `"sso": { "issuer": "https://…", "clientId": "…" }` to the registry file, and set
   `OIDC_CLIENT_SECRET` in the deployment's GitHub environment.
3. Merge. The next deploy renders `OIDC_ISSUER` and `OIDC_CLIENT_ID` into the web Worker and sets the
   secret. With all three set the sign-in page shows **Sign in with single sign-on**.
4. Tell the customer's admins. On the Team page they choose who may join and from which email
   domains, and can turn on **Single sign-on only** once they have signed in that way themselves.

Removing `sso` from the registry (the Worker then has no issuer) turns the button off. A saved
**Single sign-on only** then has no effect (`ssoOnlyInEffect` in `settings.server.ts` needs a
configured provider), so passwords and passkeys work again; people single sign-on added have no
password and need an admin to reset one for them.
A session single sign-on starts ends 12 hours after sign-in (`SESSION_SSO_MAX_MS`, a constant, not a
registry setting), so a person disabled at the provider is signed out within that, and signs in at
the provider again to continue; passwords and passkeys keep 30 days. An admin disabling them on the
Team page ends it now, or the provider can do it through SCIM (below). A first sign-in that links
an existing account with a password and an authenticator code (`/login/sso/link`) still gets the
password lifetime, once, as the code step starts that session.

## Email sending

The engine mails a buyer once, when their order is confirmed: a hosted checkout's order (channel
`web`, started under the engine's reserved `hosted:` key, as every hosted checkout's is) gets a transactional confirmation (lines, totals, ship-to and a
link to its receipt on the storefront). It goes through [Cloudflare Email
Sending](https://developers.cloudflare.com/email-service/) over the engine's `send_email` binding,
with no API key. The other mail the engine sends is a shopper's sign-in code and link (`/account/sign-in` on the
storefront; see [Shoppers](architecture.md#shoppers)), through the same sender and domain. `commerce.notify` still
only queues a message in `messages`, and intake's acknowledgement goes through Email Routing.

To turn it on for a deployment:

1. **Onboard a sending domain** on the deployment's Cloudflare account, one the owner controls and
   whose DNS Cloudflare serves. The domain, or a subdomain such as `mail.<domain>`, must be enabled
   for sending: `npx wrangler email sending enable mail.example.com`, or **Email** > **Email
   Sending** in the dashboard. Cloudflare adds the SPF and DKIM records; add a DMARC record too
   (`v=DMARC1; p=quarantine; rua=mailto:…`), or confirmations may reach the spam folder. A send from
   a domain that isn't onboarded is refused (`E_SENDER_NOT_VERIFIED`).
2. **Set the sender in the registry**: `"email": { "from": "orders@mail.example.com", "fromName":
   "Example Shop" }`, on that domain, and merge. The deploy renders the binding and `EMAIL_FROM`.
3. **Check one order.** Complete a hosted checkout with a real address you control. The order's
   message (`messages`, `msg_<orderId>_confirmation`) has `sent_at` set; if not, its `error` says
   why, and the order's timeline has a line (`Completed, but its confirmation email was not sent: …`).

A deployment without `email` sends nothing: each confirmation is recorded unsent with
`Email sending is not configured on this deployment`, and no receipt credential is minted. Once the
binding is there, the next call for that order (the order's authorization step calls it) sends it;
nothing retries on its own after the order has ended, so an unsent one is found with
`sent_at IS NULL` on a `confirmation` message. A send is keyed by the order, so a repeat sends
nothing once `sent_at` is set; only a crash between Email Sending accepting a message and the row
being marked can send one twice, because the binding has no idempotency key.

The receipt link (`<storefront>/orders/<id>?t=<token>`) carries a random credential that is stored
only as a hash and expires after 30 days. It is a bearer secret: anyone holding the link sees the
order's lines, totals, status, ship-to and tracking (never its timeline, audit or notes), so the
page is never cached, sends no referrer and is kept out of search. Erasing a data subject, or the
retention sweep erasing an order's buyer, deletes the order's credentials. The stored copy of the
email keeps the link without its token, so staff reading `messages` never see one.

With `redundancy` the confirmation is queued and retried, and a failed sign-in code is retried from a queue ([The mail queue](#the-mail-queue)); the rest of this section is the same either way. A shopper's sign-in email is not recorded in `messages` (it holds a live credential and belongs to no order):
the engine keeps only the hashes in `shopper_sign_ins`, and a send that fails is logged as
`shopper_sign_in_unsent`. A deployment without `email` answers every sign-in request with "isn't available".
Each address is sent at most one code a minute; the storefront's `SIGNIN_EMAIL_LIMIT` and `SIGNIN_IP_LIMIT`
budgets (the registry's `limits` don't set them) are the first line against someone aiming the sender at an
address.

## Turnstile

Password sign-in, `/setup` and a card payment on the storefront's hosted checkout can ask for a
[Turnstile](https://developers.cloudflare.com/turnstile/) challenge, so bots can't stuff passwords,
race a new deployment's first admin or test stolen cards. The one widget serves all three (it covers
`shop.<domain>` as a subdomain, and the storefront checks the `checkout_pay` action on its own host);
the storefront needs the same `TURNSTILE_SECRET_KEY`, which the deploy writes to it too. A shopper's request for a sign-in code (`/account/sign-in`, action `shop_sign_in`) is a fourth form it guards, so the form can't be aimed at strangers' mailboxes; it needs script, and Turnstile should be on for any production storefront (without it only the per-address and per-client budgets and the engine's one-a-minute and daily caps stand between the form and a mailbox). It is per
deployment and off until the registry has a site key. Passkeys, single sign-on and the two-factor
step aren't gated: the first two can't be stuffed, and the two-factor page is reached only through
a password sign-in that passed the challenge. How the check works is under `TURNSTILE_SITE_KEY` in
[Configuration](configuration.md#web-variables).

1. Run `./scripts/provision.sh <id>` with `CLOUDFLARE_API_TOKEN` (with **Turnstile Sites Write**)
   and `CLOUDFLARE_ACCOUNT_ID` set. It reads every page of the account's widgets. When the registry
   already has `turnstileSiteKey` it uses that widget, and stops if the account has none with that
   key; otherwise it finds the widget named like the web Worker (`commerceworker-web<suffix>`, warning
   when more than one has that name), or creates it: managed mode, the deployment's domain only. It
   warns when the widget it found has any domains but exactly the deployment's. Named per
   deployment, it works the same on a shared or a dedicated account. When the environment has no
   `TURNSTILE_SECRET_KEY`, it reads the widget's secret from the API and sets it there through
   `gh secret set`, without printing it or writing it to disk. It prints the site key.
2. Put that key in the registry file as `"turnstileSiteKey": "0x…"` and merge. The deploy renders
   `TURNSTILE_SITE_KEY` and sets the secret; a deploy without the secret stops before migrating.

Without the API token, create the widget in the dashboard (**Turnstile** > **Add widget**, managed,
the deployment's domain, named `commerceworker-web<suffix>`), set its secret as `TURNSTILE_SECRET_KEY` in
the GitHub environment, then add the site key to the registry.

A widget works on its domains' subdomains too, so `commerceworker.com`'s also runs on
`demo.commerceworker.com`; the check accepts a token only for the host the form was posted to, so one
deployment's tokens never sign in at another. To turn it off, remove `turnstileSiteKey` and merge;
the Worker keeps the secret unused. To rotate the secret, rotate it in the dashboard, set the new
value in the environment and redeploy: tokens fail with `invalid-input-secret` (logged as
`turnstile_refused`) in between. The web Worker logs `turnstile_misconfigured` when it has a site
key but no secret, and refuses every attempt.

## Card payment on the hosted checkout

A hosted checkout takes a card on the storefront with [Stripe's Payment Element](https://docs.stripe.com/payments/payment-element)
(card, Apple Pay, Google Pay and Link; no redirect or asynchronous method) when the deployment's
payments are live. The card goes from the buyer's browser to Stripe; the engine holds the quoted total
on it (authorize, capture later) and the order's authorize step adopts that hold. Turning it on, as
the owner:

1. **Live payments.** In the registry file set `"payments": "stripe"` and `"stripePublishableKey":
   "pk_…"`, and add `STRIPE_SECRET_KEY` (same mode, test or live) to the deployment's GitHub
   environment. The deploy refuses a mismatched pair. Without a publishable key the page offers no
   card ("Card payment isn't set up here").
2. **Radar stays on.** Leave Stripe Radar at its defaults (it is on by default for card payments) and
   don't switch off CVC or postal-code checks in the Payment Element's settings: card testing is
   guarded by Radar, Turnstile (below), the per-address and per-cookie `PAY_LIMIT`, and a cap of five
   attempts on each checkout.
3. **Turnstile (required).** Set up the widget as in [Turnstile](#turnstile) and add `turnstileSiteKey`
   to the registry. The fleet refuses a registry entry with a `stripePublishableKey` and no
   `turnstileSiteKey`: hosted checkout is switched on at runtime, and without the check a stolen link
   is guarded only by the limits and Radar.
4. **Payment methods.** In the Stripe Dashboard (**Settings** > **Payments** > **Payment methods**)
   enable cards, Apple Pay, Google Pay and Link. The page offers only card and Link (its wallets
   appear under card), and the engine creates every PaymentIntent with `allow_redirects: never`, so a
   method that needs a redirect never shows, whatever is enabled.
5. **Register the storefront's domain for wallets.** Apple Pay and Google Pay on a custom domain
   need it registered with Stripe, for `shop.<your domain>` (the registry's `storefrontDomain`) and
   not the admin's host: **Settings** > **Payments** > **Payment method domains** > **Add a new
   domain**, or `POST /v1/payment_method_domains` with `domain_name` set to the storefront's host.
   This is an owner step, not part of provisioning: it is Stripe account state (one domain per
   account and mode, so a test-mode and a live-mode registration are two steps) that
   `scripts/provision.sh` can't check or undo safely. Registration fetches the Apple Pay file below,
   so do step 6 first.
6. **The Apple Pay file.** On the same page Stripe offers **Download** for the domain association
   file (named `apple-developer-merchantid-domain-association`). Copy its contents into the
   deployment's GitHub environment as the secret `APPLE_PAY_DOMAIN_ASSOCIATION` (it is public text,
   kept there so the deploy has somewhere to read it from) and let the deploy run: the storefront
   serves it at `https://shop.<domain>/.well-known/apple-developer-merchantid-domain-association`
   (cached five minutes; check it with `curl`). Then press **Validate** (or add the domain) in
   Stripe. Without the file Apple Pay shows no button; cards and Google Pay still work.
7. **Check with a test card** in test mode: `4242 4242 4242 4242` is held and the order adopts it;
   `4000 0025 0000 3155` asks for 3-D Secure; `4000 0000 0000 9995` is declined. The hold shows in
   Stripe as **Uncaptured** until the flow's capture step runs.

A payment that began and never finished (the buyer left their bank's page, or a Worker died between
the hold and the order) is found by the engine's hourly job and its daily retention sweep: a checkout
claimed for more than 15 minutes whose hold is open becomes its order (started under the checkout's
own key, so never twice), and anything else is released (the PaymentIntent canceled and the checkout
reopened). This covers a UCP platform's checkout as well as a hosted buyer's: completion records the
PaymentIntent on the session before it starts the order, so a Worker that died in between leaves the
sweep the hold to find, and the platform's next `complete` (or `get`) sees the order or a reopened
checkout. With test payments there is no hold: the sweep completes a claimed checkout with the order it
already started, and otherwise reopens it. The sweep logs `card holds` with what it placed and
released, and `orphaned_hold_failed` for a checkout it could not settle (tried again next run). A hold
that nothing ever settles still expires with the card network, in about seven days. The one gap left is
a Worker that dies after Stripe makes the hold and before the session records it: nothing names that
PaymentIntent, so it is left to expire.

**Orders that never started.** An order started over REST with no `Idempotency-Key` is written as a
`queued` row before its Workflow is created. If the start fails in between, the caller is told it
failed and the row stays. The hourly job (`unstarted orders` in the log) marks every such row older than
an hour with no Workflow instance `failed`, with the reason "The order could not be started; place it
again." It fails the order rather than starting it: the row keeps none of the request, and the caller
may have placed the order again since, so a late start could make two. A row started with an
`Idempotency-Key` is left alone, since its caller's retry finishes it. `unstarted_order_failed` is
logged for a row the job could not settle (tried again next run).

### Provisioning (SCIM)

For a customer whose provider pushes people and groups (Okta, Entra ID), set single sign-on up first:
people SCIM creates are viewers with no password, so they can only sign in through it (linked by
email on their first sign-in). Then ask the customer's admin to open **SCIM provisioning** on the
Team page, make a token (`cmw_scim_…`, shown once; only its SHA-256 is stored) and paste the
**Endpoint** (`https://<domain>/scim/v2`) and token into the provider's provisioning settings. No
registry entry, secret or deploy is involved. The admin maps pushed groups to roles on the same
page. Deactivating at the provider ends the person's sessions, connected apps and the API tokens
they made. Without a token every `/scim/v2` request is a `401`; demo deployments lock the path.

## Rotating the principal key

`PRINCIPAL_KEY` signs the principal header the web Worker forwards to the engine, and each signature
lasts 60 seconds, so a rotation needs no downtime when it runs in two deploys:

1. In the deployment's GitHub environment, set `PRINCIPAL_KEY_PREVIOUS` to the current key and
   `PRINCIPAL_KEY` to a new one (`openssl rand -hex 32`). Deploy. The engine deploys first and
   accepts both; the web Worker then signs with the new one.
2. Remove `PRINCIPAL_KEY_PREVIOUS` from the environment and deploy again.

Removing a secret from the environment does not remove it from the Worker: `fleet.ts secrets` writes
only the ones set and `--secrets-file` never deletes, so also run
`wrangler secret delete PRINCIPAL_KEY_PREVIOUS` against the deployment's engine Worker
(`commerceworker-engine-<id>`), or the old key stays accepted (with `content`, also against the api, `commerceworker-api-<id>`; the studio signs with it and the pipeline's assistant keys are derived from it, so the same two deploys rotate those). Each installed plugin's `PLUGIN_KEY` is derived from it, so the same two deploys rotate those ([Plugins](#plugins)).

## Rotating the data key

`DATA_KEY` encrypts the secrets a deployment stores: two-factor secrets, integration and webhook
subscription secrets, the secrets admins enter for plugins installed at runtime, and the credentials
of A2A push configs. A stored value names the key it was
sealed under, so both keys can be read during a rotation and nothing needs to be re-entered:

1. In the deployment's GitHub environment, set `DATA_KEY_PREVIOUS` to the current key and
   `DATA_KEY` to a new one (`openssl rand -hex 32`). Deploy. New writes use the new key; values
   under the old one are still read.
2. Wait for the next daily retention sweep (03:30 UTC) or longer, and check its log shows
   `secrets.unreadable` of 0. The sweep (`resealSecrets`) moves every value under
   `DATA_KEY_PREVIOUS` onto `DATA_KEY`, writing conditionally so a concurrent rotation isn't undone;
   `secrets.resealed` counts what it moved.
3. Remove `DATA_KEY_PREVIOUS` from the environment, deploy again, and also run
   `wrangler secret delete DATA_KEY_PREVIOUS` against both the deployment's web and engine Workers
   (`commerceworker-web-<id>`, `commerceworker-engine-<id>`): `--secrets-file` never deletes, so the old key
   would stay readable.

A2A push configs live in each `A2AAgent`'s SQLite and are resealed when loaded, not by the sweep.
A config on an idle task still under the old key is dropped once that key is gone (logged); the
caller registers its URL again.

Never lose `DATA_KEY`: values sealed under a key the deployment no longer has can't be recovered.
Two-factor must be reset for those people, and integration, webhook and plugin secrets rotated. Values stored
before encryption existed have no prefix, are read as they are, and are encrypted by the next sweep.

## Recovering admin access

When no admin can sign in (everyone forgot their password, or the admins are disabled), issue a new
setup code:

```bash
./scripts/setup-code.sh <id>
```

Logged in to `wrangler` and `gh`. It writes a new code to `.secrets/<id>/setup-code` (never
printed), sets it as `SETUP_TOKEN` on the deployment's GitHub environment, so the next deploy keeps
it, and on the web Worker with `wrangler secret put`, so it works now. Send the person recovering
`https://<domain>/setup` and the code. They create a new admin account with an email not already on
the team, which is audited as `team.recovery_admin` (a wrong code as `team.setup_refused`), and
they can then reset the others. If the workspace was **Single sign-on only**, redeeming the code
turns that off (audited as `team.sso_settings` with `via: "setup code"`), so the new admin can sign
in with their password even when the identity provider is the problem. The code works once; the last active admin can never be demoted or
disabled, so recovery is only needed when the admins can't sign in.

Break-glass: recommend that each customer keeps a second admin account with two-factor sign-in on,
its credentials and recovery codes stored offline. It can be disabled any time and enabled when
needed. The setup code is the last resort.

## Removing a customer

A deployment holds only that customer's data, so removing it is the erasure:

1. Export what the contract requires first (a D1 export with
   `wrangler d1 export commerceworker-<id> --remote --output <file>`, and the R2 bucket's documents, including the audit archive under `audit/`: events past `auditRetentionDays` live only there, as NDJSON with their hashes). The catalog's products live in its Durable Objects; their export is a [catalog backup](#catalog-backups), `backups/<date>/` in `commerceworker-catalog-<id>` (NDJSON per table, with `manifest.json`; trigger one first for the latest state); its published documents there are a rendered copy.
   With `redundancy`, [the commerce D1 backup](#redundancy) is the same export without that step: `commerceworker-d1-backup<suffix>` copies every table of record (the search index is rebuilt from `products`), so trigger one first for the latest state.
   D1 can't export a database that has a virtual table (Cloudflare's D1 import and export docs,
   "Known limitations"), and `products_search` (migration 0058, the products' keyword index) is
   one. Drop it and its triggers first, in one `wrangler d1 execute commerceworker-<id> --remote
   --command`: `DROP TRIGGER products_search_insert; DROP TRIGGER products_search_update; DROP
   TRIGGER products_search_delete; DROP TABLE products_search;` (the triggers too, or every write
   to `products` fails on the missing table). Nothing else depends on it: until it's back, a
   cart's product search errors and nothing else changes. If the database is kept, recreate it
   afterwards with `wrangler d1 execute commerceworker-<id> --remote --file
   packages/db/migrations/0058_products_search.sql`, which creates the table and triggers again
   and rebuilds the index from `products` (`d1_migrations` still lists 0058, so
   `db:migrate:remote` won't run it). The same `rebuild` repairs an index in doubt at any time:
   `INSERT INTO products_search(products_search) VALUES('rebuild')`.
2. Delete `deployments/<id>.jsonc` and merge, so CI stops deploying it.
3. Delete the Workers (`commerceworker-web-<id>`, `commerceworker-storefront-<id>`, `commerceworker-engine-<id>`, `commerceworker-catalog-<id>`, `commerceworker-delivery-<id>` and `commerceworker-plugin-<plugin>-<id>` for each plugin, which removes their Durable
   Objects and Workflow instances), the D1 database, the R2 buckets (`commerceworker-docs-<id>` and `commerceworker-catalog-<id>`; empty them first, and before emptying `commerceworker-docs-<id>` remove its [bucket locks](#bucket-locks), `wrangler r2 bucket lock remove commerceworker-docs-<id> --name audit-archive` and `--name plugin-bundles`, and before emptying `commerceworker-catalog-<id>` its `--name catalog-backups` (with `--jurisdiction` as provisioned), since a locked object can't be deleted and so neither can the bucket), the backups bucket `commerceworker-backups-<id>` and the standby database `commerceworker-standby-<id>` (with `redundancy`; remove the bucket's lock first, `wrangler r2 bucket lock remove commerceworker-backups-<id> --name d1-backups`, and export what the contract requires, since the backups hold the same data as the database), the docs replica `commerceworker-docs-replica-<id>` (remove its `audit-archive` and `plugin-bundles` locks first, as for the docs bucket; it holds the same files) and its two queues `commerceworker-docs-replica-<id>` and `commerceworker-docs-replica-dlq-<id>` with the docs bucket's notification rule (`wrangler r2 bucket notification delete commerceworker-docs-<id> --queue commerceworker-docs-replica-<id>`), the catalog's KV namespace, the two feed queues, the two purge queues and the two changes queues, each plugin's D1 database (`commerceworker-plugin-<plugin>-<id>`), the AI
   Gateway and its logs, the OAuth KV namespace, the GitHub environment and `.secrets/<id>/`. With `content`, also its Workers (`commerceworker-pipeline-<id>`, `-media-`, `-api-`, `-studio-`), the content database `commerceworker-content-<id>` (export it first, like the commerce one), the assets bucket `commerceworker-media-<id>` (empty it first; its originals are the customer's assets), the cache KV `commerceworker-content-cache-<id>`, the Vectorize index `commerceworker-vectors-<id>` and the ten content queues. Delete the Logpush job `commerceworker-workers-<id>` and its token `commerceworker-logpush-<id>` (the account's **Logpush** page in the dashboard, and **Manage Account** > **Account API Tokens**), and empty and delete `commerceworker-logs-<id>` once the contract no longer needs its logs; until then the bucket keeps them for `logRetentionDays` on its own.
