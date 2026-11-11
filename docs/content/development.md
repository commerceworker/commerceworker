# Development

How to run CommerceWorker locally, test it, and extend it: setup, suites, adding a use-case, changing
the database schema and the schema reference.

## Prerequisites

- Node.js ≥ 24 (`.nvmrc`) and pnpm 10 (`packageManager` in the root `package.json`).
- No platform account: local development runs every edge worker in the local runtime through the
  platform's Vite plugin, with a local database. Remote bindings are off;
  `COMMERCEWORKER_REMOTE=1 pnpm dev` turns them on (it needs a `wrangler login`).
- `jq`, for the Claude Code hooks in `.claude/` (without it they silently do nothing).
- For the device tests only: `pnpm --filter @commerceworker/studio exec playwright install webkit chromium`.

## Running locally

```bash
pnpm install
pnpm dev     # applies packages/store/migrations to the local D1 (db:migrate:local), then starts the stack;
             # the api seeds the demo dataset into space-1 on its first request
```

`pnpm db:migrate:local` is also the way to apply a new migration without restarting, and
`pnpm dev:reset` deletes `apps/studio/.wrangler/state` and migrates again, for a fresh database.

`pnpm dev:first-run` starts the stack as a new deployment meets it: a database of its own
(`apps/studio/.wrangler/first-run`, wiped each start), nothing seeded, and the admin closed until set
up, so `/setup` → `/setup/two-factor` → `/setup/space` can be walked. The setup code is
`local-first-run`. Plain `pnpm dev` stays open (anyone is "Admin, no sign-in" until a first admin
exists) and seeded. `COMMERCEWORKER_FIRST_RUN` only works under `pnpm dev`: a build refuses it.

`pnpm dev` runs `react-router dev` in `apps/studio` (Vite, http://localhost:5173; `PORT=5174 pnpm
dev` for another port). The port is fixed rather than "the next free one": the local OAuth issuer
(`OAUTH_ISSUER`, so MCP clients can connect with OAuth as on a deployment), the MCP smoke scripts
and these docs all name it, so a busy port fails fast. The web worker's Vite config
(`apps/studio/vite.config.ts`) starts the **api, engine, media and delivery workers as auxiliary
workers** in the same session, all on one local database, with the queues, cron, stateful edge
objects and durable workflows emulated. The media worker isn't routable from the browser locally
and `MEDIA_PUBLIC_URL` stays empty, so delivered assets keep the api's signed URLs (no renditions
or srcset); its suite (`pnpm --filter @commerceworker/media test`) runs it in the local runtime
instead. Asset ingest still runs after an upload: with no object-storage notifications locally,
the api's signed `PUT` is its one trigger
([Architecture](./architecture.md#asset-ingest-and-search)). Their vars are overridden with
`LOCAL_STACK_VARS`:

| Var                               | Local value                                   | Why                                                                                  |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `REQUIRE_SECURE_SECRETS`          | `false`                                       | Allow the dev tokens below                                                           |
| `ADMIN_TOKEN`                     | `dev-admin-token`                             | Root bearer token                                                                    |
| `CMA_KEY` / `CDA_KEY` / `CPA_KEY` | `dev-cma-key` / `dev-cda-key` / `dev-cpa-key` | The seeded space's Management, Delivery and Preview keys                             |
| `MCP_TOKEN`                       | `dev-mcp-token`                               | Mounts `/mcp`                                                                        |
| `TOKEN_PEPPER`                    | `dev-pepper`                                  |                                                                                      |
| `MEDIA_SIGNING_SECRET`            | `dev-media-signing-secret`                    |                                                                                      |
| `PRINCIPAL_KEY`                   | `commerceworker-local-dev-principal-key`       | The same `DEV_PRINCIPAL_KEY` the web worker uses locally                             |
| `ASSISTANT_PRINCIPAL_KEY`         | `DEV_ASSISTANT_PRINCIPAL_KEY`                 | Derived from the dev `PRINCIPAL_KEY`, for the engine                                 |
| `OAUTH_ISSUER`                    | `http://localhost:<port>`                     | OAuth for MCP clients on the admin origin, as on a deployment                        |
| `AI_MODE`                         | `mock`                                        | No model calls                                                                       |
| `AI_GATEWAY_ID`                   | empty                                         | No AI gateway                                                                        |
| `EMBEDDINGS_PROVIDER`             | `local`                                       | Hash embeddings                                                                      |
| `VECTOR_STORE`                    | `kv`                                          | The vector index has no local emulator; the key-value store is shared by the workers |
| `ALLOW_FAKE_ADAPTERS`             | `all`                                         | Accept every dev fake                                                                |
| `SEED_DEV`                        | `true` (`false` under the e2e harness)        | Load the demo dataset; refused wherever secure secrets are required                  |
| `SEED_SCALE`                      | `1`, or the shell's `SEED_SCALE`              | Demo size (~550 entries); raise it for a benchmark corpus                            |

Local dev always runs on the demo dataset (`@commerceworker/seed`): on its first request the api
seeds a space, dev API keys and a corpus covering every capability (content model, entries,
assets, taxonomy, releases, workflows, automation, agents). Seeded images and documents have real
files in the local bucket (gradient PNGs and one-page PDFs generated by
`packages/seed/src/placeholders.ts`), so the media library and image transforms work; videos are
metadata only. Seeding is idempotent, so restarts
keep the data; to start over, run `pnpm dev:reset`.

The same package holds the **sample starter** a real space can start with (`installStarter` and
`createSpaceWithStarter` in `packages/seed/src/starter.ts`, behind `POST /spaces` `starter:
"sample"` and the `space_create` MCP tool): the demo content model, a 39-entry slice of the corpus,
the taxonomy, eight sample images and documents when a blob store is bound, and one open release.
None of the dev-only rest (API keys, comments and tasks, webhooks and functions, agent runs,
schedules, reviews, audit entries). It installs inside the request: about 550 database calls,
held under a 600-call budget by `packages/store/test/starter.test.ts` against the 1,000 queries one
invocation may make. If it has to grow past that, it becomes a background job.

The **enterprise starter** (`starter: "enterprise"`, `packages/seed/src/enterprise/`) is that
background job: a fictional global professional-services firm, Aldermoor, in 13 locales, too big
for one request. `createSpaceWithStarter` creates the space with the brand's locales and fallbacks
added to the caller's, then `startEnterpriseInstall` persists one `starter_install` bulk job per
phase, each naming the next in `config.next`, and returns `installing: { install, jobId, steps }`
at once. The engine runs each phase's single chunk through `starterChunkRunner` (injected into
dispatch as `starterChunk`); the next phase's job is created in the write that finalizes the last,
only after a clean run, so a phase that fails for good stops the install there. Every phase is
idempotent, so creating the space again with the same starter finishes it. Progress is read from
the environment's jobs (`getStarterInstall`, `GET …/starter-installs/:install`, the
`starter_install_get` MCP tool). It is offered only where `DEMO_STARTERS=true` on the api (demo
deployments, and `pnpm dev`, not under the device tests); anywhere else it is a `422` on
`starter`. `GET /starters` and `space_starters_list` list what a deployment offers. Each phase's
D1 calls (and its cheaper rerun) are held under an 800-call budget by
`packages/store/test/enterprise-starter.test.ts`; a phase that grows past it splits in two. Local dev
also installs the brand, in process, into its own space, `aldermoor`, beside the demo dataset
(`seedDev`; a marker tag makes later boots one query).

The brand covers 21 content types in seven groups. Every field type is used, along with
components and page-building blocks, editor layouts, conditional rules, presets and URL patterns.
It also includes:

- about 300 entries in draft, published, changed and trashed states, plus locale-only legal pages;
- 44 assets in folders and collections, with credits, an expiry and an embargo;
- five concept schemes with translated labels, and editorial tags;
- custom roles with field-level grants, and 22 team members;
- seven workflow graphs with approvals parked in the inbox, and a newsroom step board;
- comments, tasks, agent reviews and agent schedules;
- releases and scheduled actions;
- inactive webhooks and functions on the reserved `aldermoor.example` domain, admin extensions and
  AI actions;
- menus per market, redirects, shared saved views and a month of audit history.

For a larger corpus, seed it into a database of its own so the everyday one stays small:

```bash
cd apps/studio
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/scale
SEED_SCALE=10 COMMERCEWORKER_STATE=.wrangler/scale pnpm dev   # ~4,500 entries, seeded in ~25 s
```

The api relays the seed's events right after seeding (local dev has no cron sweep), so search
indexing and cache purges start at once; at `SEED_SCALE=10` the engine takes a while to work
through them one entry at a time.
While the database has no people, the admin on localhost is open (no sign-in); adding the first
person through `/setup` turns sign-in on.

Everything the api serves is reachable on the same origin through the web gateway, with a
bearer token: e.g. `curl -H 'authorization: Bearer dev-admin-token' http://localhost:5173/spaces`,
and MCP at `http://localhost:5173/mcp` with `dev-mcp-token`.

The docs site runs on its own: `pnpm docs:dev`.

## Common commands

```bash
# Test / typecheck / lint everything (what CI's verify job runs; turbo, cached)
pnpm check-types && pnpm test && pnpm lint

# The SDK as npm sees it: pack @commerceworker/sdk, then load and type-check every subpath
pnpm sdk:pack && pnpm sdk:check

# One package
pnpm --filter @commerceworker/application test

# A single test file or test name (vitest)
pnpm --filter @commerceworker/application exec vitest run test/releases.test.ts -t "publishes"

# Fleet registry and DO-migration golden tests
node --test scripts/*.test.ts

# Bundle check for a Worker (nothing is uploaded)
pnpm --filter @commerceworker/api exec wrangler deploy --dry-run --outdir /tmp/api

# Rebuild the docs and MCP skills embeds (gitignored; install and every turbo
# check-types, test, build and dev already do this)
pnpm generate
```

### Where each suite runs

| Package                        | Environment                                                                                                                                       | What it covers                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@commerceworker/domain`        | node                                                                                                                                              | Pure rules                                                                                                                                                                      |
| `@commerceworker/application`   | node, `@commerceworker/test-kit` fakes                                                                                                             | Every use-case                                                                                                                                                                  |
| `@commerceworker/store`            | the local runtime (`@cloudflare/vitest-plugin`), a local database with the migrations applied                                                     | The database store contract, unit of work and guards, query pushdown equivalence, secrets at rest, database statements per request                                              |
| `@commerceworker/http`          | node, in-memory fakes                                                                                                                             | REST routes, auth, OpenAPI, MCP tools, the skills embed                                                                                                                         |
| `@commerceworker/pipeline`        | the local runtime                                                                                                                                 | Stateful edge objects (search shard, live hub, cost guard, rate limiter), real durable workflow runs with `AI_MODE=mock`, the media gate and both purge queues                  |
| `@commerceworker/media`         | the local runtime, a local key-value store, object storage and database, a fake image-transform binding                                           | The media worker end to end: gate and replica fallback, 404/410, `Accept` negotiation, purge drain, signed draft reads                                                          |
| `@commerceworker/docs-index`          | node                                                                                                                                              | The `docs/` embed (built, not committed) matches disk                                                                                                                           |
| `@commerceworker/adapters`      | node, fakes of each binding                                                                                                                       | One suite per adapter subpath (`test/<adapter>/`), including the structured, WXR and space export import parsers                                                                |
| `@commerceworker/agent-runtime` | node                                                                                                                                              | The agent workflows and the graph interpreter, without the platform                                                                                                             |
| `@commerceworker/security`      | node                                                                                                                                              | The signed principal, the derived assistant key, roles and session lifetimes                                                                                                    |
| `@commerceworker/delivery`      | node                                                                                                                                              | Visibility profiles, canonical URLs, client cache headers and the purge drain                                                                                                   |
| `@commerceworker/studio`           | vitest, two projects: `node` (`tests/**/*.test.ts`) and `dom` (jsdom, `tests/**/*.test.tsx`); Playwright (`pnpm --filter @commerceworker/studio e2e`) | Auth and lib units; CMS screens; device and CMS e2e with axe in WebKit and Chromium                                                                                             |
| `packages/sdk/*`               | node (vitest)                                                                                                                                     | The Delivery and Management clients, codegen, and the published `@commerceworker/sdk`'s subpaths                                                                                 |
| `@commerceworker/cli`           | node (vitest), a scripted fake server                                                                                                             | The `commerceworker` CLI's commands, device flow and token file, model plans, and the drift check on `skills/` ([Developer tooling](./developer-tooling.md))                     |
| `scripts/*.test.ts`            | `node --test` (`pnpm test:fleet`)                                                                                                                 | Fleet registry rendering, stateful-object migration tags (append-only), the pnpm catalog, assistant key derivation, and a guard on names that must not appear in the repository |

`@commerceworker/platform` has no suite of its own: its wiring is exercised through the http, db and
engine suites. Also `@commerceworker/graphql-gen`, `seed`, `redaction`, `design` and `docs` run
`vitest` in node.

The web e2e harness starts its own dev server on port 5390 with a fresh local database in
`.wrangler/e2e` (`COMMERCEWORKER_E2E=1`: offline, no remote bindings, and unseeded: the tests
create what they need; the first-run spec sees a deployment with no spaces by filtering
`GET /spaces` to the space it creates, since the database is shared), so it coexists with a
`pnpm dev` session. `E2E_PORT` picks another port, for a second suite (another worktree's)
beside one already on 5390: outside CI the harness reuses whatever answers on its port, and a
server from another checkout has another database. Install browsers once with
`pnpm --filter @commerceworker/studio exec playwright install webkit chromium`.

### Query counts

`packages/store/test/query-counts.test.ts` runs representative Delivery and Management requests
(entry by id, with a locale and with `include`, filtered and searched lists, a link list past the
100-parameter cap, GraphQL entry, collection and asset queries, asset delivery, create, publish,
get and list entries) through their use-cases over the real database store (GraphQL through the
route's own resolvers, `deliveryGraphResolvers`), with no delivery cache, and counts the
statements and round trips each sends to the database (a `batch()` is one round trip). The
counts are compared with the committed `packages/store/test/query-counts.json`; any change fails the
`@commerceworker/store` suite with a report of what moved and, for an increase, the SQL the request now
runs. When the change is intended, rewrite the snapshot and commit it:

```bash
pnpm --filter @commerceworker/store test:query-counts:update
```

Delivery read counts may only go down. A PR that raises one says why in its description; a
decrease is committed the same way, so the next increase is measured from it.

### MCP smoke scripts

Against a running `pnpm dev` stack; both default to `http://localhost:5173/mcp` (override the URL
with `MCP_URL`, the token with `MCP_TOKEN`):

```bash
node apps/api/scripts/mcp-smoke.mjs          # tool surface end-to-end
node apps/api/scripts/mcp-search-smoke.mjs   # search tools
```

## Conventions

The rules every change keeps (strict TypeScript, ESM import specifiers, TypeScript 7 having no JS
API, the pnpm catalog, Biome, UUIDv7 ids from `ctx.ids`, time from `ctx.clock`, scoped operations,
code for the edge runtime only, and the unit of work) are in `AGENTS.md`; see also
[Consistency](./consistency.md) for the unit-of-work rule.

## Adding a use-case

1. Add the function to the right module in `packages/application/src/` (exported from
   `index.ts`). It takes `AppContext` and a `Scope`.
2. Keep pure rules (state transitions, validation) in `packages/domain`.
3. If it needs a new persistence capability, add a method to the port in
   `packages/ports/src/content-store.ts`, implement it in `packages/store/src/store.ts` **and** the
   test-kit in-memory store, and add a contract test in `packages/store/test/`.
4. Test it in `packages/application/test/<capability>.test.ts` with `@commerceworker/test-kit`
   fakes. Name tests for the capability, never for a roadmap phase.
5. Expose it on **both** surfaces: an HTTP route in its area's file,
   `packages/http/src/api/routes/management/<area>.ts` (with its OpenAPI doc, response schemas in
   `packages/http/src/api/docs/schemas/<area>.ts`), and an MCP tool in
   `packages/http/src/mcp/tools/<area>.ts`; a new area adds its own file. Or an event handler in
   `consumeEvent` when it is reactive.

## Changing the database schema

1. Add a new numbered file, `packages/store/migrations/NNNN_<what>.sql`. Expand-only: new tables,
   new nullable or defaulted columns, new indexes. Never edit an applied migration; drop or
   rename only in a later change once no deployed code reads the old shape.
2. Mirror it in `packages/store/src/schema.ts` (or `auth-schema.ts` for web auth tables).
   Timestamps are `integer` epoch milliseconds (`mode: 'timestamp_ms'`), JSON is `text`
   (`mode: 'json'`), booleans are `integer` 0/1.
3. Apply locally with `pnpm db:migrate:local` (`pnpm dev` does it too). The
   `@commerceworker/store` tests apply the migrations to a local database themselves.
4. Remote databases are migrated only by CI, before the new code deploys
   ([Deployment](./deployment.md#migrations)); never by hand.

Keep the database limits in mind: at most 100 bound parameters per statement (`chunked`,
`selectChunked`, or one JSON parameter with `json_each`), one writer per database (no writes on
read paths), 10 GB per database.

## Database schema reference

`(space_id, environment_id)` leads the primary key or a unique index of every content table.
`0001_init.sql` creates:

| Tables                                                                                                                                            | Purpose                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `spaces`, `environments`, `environment_aliases`                                                                                                   | Spaces, branches, alias → environment                                                     |
| `content_types`                                                                                                                                   | Content-type definitions (`fields` JSON; group, description, icon, `layout` JSON from 0026; `agent_instructions` from 0032; `preview_url_template` from 0035) |
| `entries`, `entry_versions`, `entry_published`, `entry_metadata`, `entry_unique_values`                                                           | Entry aggregate, version ledger, published read model, tags/concepts, unique-field claims |
| `assets`, `asset_published`                                                                                                                       | Asset metadata and its published read model                                               |
| `references`                                                                                                                                      | Link graph (reverse lookups for invalidation and usage)                                   |
| `api_keys`, `roles`, `space_members`, `member_invites`, `oauth_clients`, `oauth_grants`, `preview_tokens`, `deployment_settings`                  | Access                                                                                    |
| `webhooks`, `webhook_deliveries`, `functions`, `app_extensions`, `plugins`, `plugin_settings`, `plugin_kv`                                        | Integrations (`plugin_kv`: a plugin's `kv:storage`, per environment)                      |
| `releases`, `release_items`, `scheduled_actions`, `bulk_jobs`, `bulk_job_chunks`                                                                  | Publishing at scale                                                                       |
| `comments`, `tasks`                                                                                                                               | Collaboration                                                                             |
| `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_node_runs`, `workflow_tasks`, `workflow_timeline`, `entry_workflow_state` | Editorial workflows                                                                       |
| `concept_schemes`, `concepts`, `tags`                                                                                                             | Taxonomy (`taxonomy_usage`, its published counts, from 0018)                              |
| `redirects`, `redirect_sets` (`0017`)                                                                                                             | Redirects and their revision                                                              |
| `saved_views` (`0029`)                                                                                                                            | Saved views of the entries list (space-scoped)                                            |
| `menus` (`0020`)                                                                                                                                  | Navigation menus, each item tree a JSON column                                            |
| `ai_actions`, `agent_runs`, `agent_reviews`, `agent_schedules`                                                                                    | AI actions and the agent ledger                                                           |
| `audit_log`, `audit_log_entries` (`0033`)                                                                                                         | Per-space audit trail; `0031` adds the indexes its filters read through, `0032` the `detail` of changed paths, `0033` which entries each row is about |
| `outbox`                                                                                                                                          | Transactional outbox (`claimed_until` lease, `relayed_at`)                                |
| `_guard`                                                                                                                                          | Always empty; its `CHECK (ok = 1)` aborts a batch whose compare-and-set lost              |

`0008_asset_renditions.sql` adds `asset_renditions` (`space_id`, `name`, `width`, `height`, `fit`,
`format`, `quality`, `created_at`, `updated_at`; primary key `(space_id, name)`): a space's
rendition presets, not environment-scoped. `0009_asset_published_delivery.sql` adds `version`,
`r2_key`, `kind` and `rights` to `asset_published` (backfilled from each snapshot's asset row), with
the indexes `asset_published_by_time` (publish order, keyset paging) and
`asset_published_by_kind`; the delivery list's folder filter reads `assets.folder_id` live.
`0010_asset_published_backfill_again.sql` changes no schema: it runs 0009's backfill again, only
for snapshots still holding the column defaults (`kind` `'other'` or no `r2_key`) whose asset row
knows better, which the pre-0009 api wrote while a deployment rolled out.

`0012_scheduler_jobs.sql` adds `scheduler_jobs` (`job` primary key, `last_run_at`,
`last_success_at`, `last_error_at`, `last_error`): the engine cron's heartbeat, one row per sweep
plus `tick`, written in one batch at the end of each tick and nowhere else. Not space-scoped. The
upsert merges in SQL (a success keeps the last error, and an older run never moves a timestamp
back), so the cron never reads before it writes.

`0014_asset_upload_sweep.sql` adds only the partial index `assets_awaiting_upload` on
`assets(created_at)` where `status = 'draft'`, `ingest_status` and `size` are NULL and `r2_key` is
set: the drafts whose presigned upload never landed, for the engine's hourly abandoned-upload sweep
(see [Architecture](./architecture.md#asset-ingest-and-search)). Nothing is backfilled. The
placeholder ingest computes lives in the `file` JSON, so it needs no migration.

`0015_asset_expiry.sql` adds `asset_published.expires_at` (epoch ms, the snapshot's
`rights.expiresAt`, written on every snapshot write), backfills it from existing snapshots' rights,
and indexes it (`asset_published_by_expiry`, only where set) for the engine's expiry sweep.

`0016_asset_collections.sql` adds five new tables and touches no existing one: `asset_collections`,
`asset_collection_items` (a membership per row, ordered by `position`), `asset_share_links`
(`password_hash` is PBKDF2, `revoked_at` is set once), `asset_zip_jobs` (indexed by `expires_at`
for the engine's hourly zip sweep) and `asset_uploads` (multipart uploads in progress, indexed by
`created_at` for the abandoned-upload sweep). Every table is environment-scoped, and the environment purge clears it. Nothing is backfilled (see
[Architecture](./architecture.md#collections-share-links-multipart-uploads-and-zips)).

`0017_redirects.sql` adds two environment-scoped tables (the environment purge clears them) and one
column, and backfills nothing. `redirects` holds one row per redirect (`source`, `locale`,
`destination`, `status`, `enabled`, `note`, `origin`, `entry_id`, epoch-ms `created_at` and
`updated_at`); `locale` is `''` for a redirect that applies to every locale, because SQLite treats
NULLs as distinct and the unique index `redirects_by_source` on `(space_id, environment_id, source,
locale)` must hold one redirect per source per locale. `redirects_by_destination` serves a slug
change's read of the redirects pointing at an old path. `redirect_sets` holds one `revision` per
environment, bumped by every write to the set: the compare-and-set that keeps two writers, each of
which checked the set for loops and the cap, from both committing (a loser surfaces as
`TransactionConflictError`). `content_types.url_pattern` (nullable) is a type's
[URL pattern](./domain-model.md#content-type); existing types have none, so no slug redirects
until someone sets one.

`0018_taxonomy_slugs_counts.sql` adds `slug` (nullable), `description` (nullable) and `labels`
(JSON, default `{}`: labels in the space's other locales) to `tags` and `concepts`, with unique
indexes `tags_by_slug` (`space_id`, `environment_id`, `slug`) and `concepts_by_slug` (the same plus
`scheme_id`); and the table `taxonomy_usage` (`kind` `tag` or `concept`, `term_id`,
`content_type_api_id`, `published_count`; primary key `(space_id, environment_id, kind, term_id,
content_type_api_id)`), environment-scoped. It backfills a slug for every existing term from its
label (lowercase ASCII letters and digits, every other run one hyphen, at most 200 characters,
`tag` / `concept` when nothing survives; a slug two terms of a namespace share keeps the first by id
and gives the others their id's tail) and counts usage from the existing published snapshots. A
NULL slug is what code older than the migration writes; the daily `taxonomy-repair` sweep gives
it one (see [Domain model](./domain-model.md#taxonomy)).

`0019_member_invites.sql` adds `member_invites` and touches no existing table: invitations to the
admin, deployment-wide (`grants` JSON names each space). Only the links' token hashes are stored
(`token_hash`, `email_token_hash`, each uniquely indexed); `version` is the compare-and-set that
makes a link work once, and `expired` is read from `expires_at`, never written (see
[Auth & RBAC](./auth-and-rbac.md#invitations)). Nothing is backfilled.

`0021_password_resets.sql` adds `password_resets` and touches no existing table: the web app's
self-service password reset codes (`user_id`; `code_hash`, HMAC-SHA256 with `PASSWORD_PEPPER` over
the row id and the code, never the code; `browser_hash`, the SHA-256 of the asking browser's
nonce, which a typed code must come with; `created_at`, `expires_at`, `used_at`), indexed by
`(user_id, created_at)` and by `expires_at`. Tries are counted in `auth_failures` (`reset-try`). Nothing is backfilled (see
[Auth & RBAC](./auth-and-rbac.md#password-reset)).

`0029_saved_views.sql` adds `saved_views` and touches no existing table: one **space-scoped** row
per saved view (no `environment_id`: every environment shows the same views), `name`,
`content_type` (null for every type), `visibility` (`personal` or `shared`), `created_by` (the
owner of a personal view), `query` (the structured query as JSON, never a query string), `columns`
(JSON, null for the default), `revision` and epoch-ms `created_at` and `updated_at`, keyed
`(space_id, id)`, with the index `saved_views_by_owner` on `(space_id, visibility, created_by)` for
the shared-plus-own list. Nothing is backfilled (see
[Domain model](./domain-model.md#saved-views)). 0024 to 0028 are other branches' numbers; wrangler
applies migrations by name, so the gap is harmless.

`0020_menus.sql` adds `menus` and touches no existing table: one environment-scoped row per
navigation menu (`handle`, `name`, `description`, `items` as a JSON tree written whole, `revision`,
epoch-ms `created_at` and `updated_at`), with the unique index `menus_by_handle` on `(space_id,
environment_id, handle)`. `revision` is the compare-and-set every save rides with (a loser surfaces
as `TransactionConflictError`). Delivery reads a menu by handle and, in the same batch, the
published entries, tags and concepts its links name, through `json_tree` over the row's `items`.
The environment purge clears it; nothing is backfilled (see
[Domain model](./domain-model.md#menus)).

`0022_webhook_delivery_resends.sql` adds two nullable columns to `webhook_deliveries`:
`event_type` (the event a delivery carried) and `resend_of` (the delivery row an administrator's
resend repeated). Code older than the migration neither reads nor writes them, and rows from
before it keep NULL; nothing is backfilled (see
[Events & webhooks](./events-and-webhooks.md#webhooks)).

`0023_trash_retention.sql` adds the nullable `spaces.trash_retention_days` (NULL, every existing
space's value, means off), the nullable `environments.trash_sweep_cursor` (JSON `{ trashedAt, id }`:
where the retention sweep resumes in that environment; NULL is from the oldest) and the partial index `entries_trashed` on `(space_id, environment_id,
updated_at, id) WHERE status = 'archived'`, which the engine's trash retention sweep reads. Nothing
is backfilled (see [Architecture](./architecture.md)).

`0030_published_definition.sql` adds the nullable JSON `content_types.published_definition`, the
definition a live type serves while a draft revision holds its row, and two triggers on `status`
that keep it: `content_types_keep_published` copies the old row when a save leaves `published`, and
`content_types_clear_published` clears it on a publish. Triggers, not the store, because CI migrates
before deploying and a rollback leaves the migration: code that doesn't know the column saves rows
here too, and a copy only new code made would go stale under it. The store's upsert doesn't name
the column. Delivery reads the row whenever it is published, so nothing left beside it can be
served. Nothing is backfilled: NULL serves the row as before. While a draft is outstanding a row
holds its fields twice, against D1's 2 MB row limit; a save that would pass it is refused, which is
about 1 MB of field definitions (see [Domain model](./domain-model.md#content-type)).

The reads tolerate a read replica that hasn't reached 0030. CI migrates and then ships the Workers
with no wait, and Delivery's session starts on any replica (`first-unconstrained`), so a new Worker
can name the column on a replica still catching up. Delivery's read retries without it on `no such
column`, and `ContentTypeRepo.publishedDefinitions` answers empty, which is right: nothing is kept
on a database from before 0030. The column is always read table-qualified (`keptDefinition`):
Drizzle leaves a single table's columns bare, and SQLite takes a double-quoted name it can't find
for a string, so a bare read returns the text `published_definition` instead of failing. Management
reads don't name the column. The triggers need no such care: writes go only to the primary. The
retry can itself land on a replica past 0030, where it ignores a kept definition and serves the row:
one response, possibly cached until the next purge or its max-age, and the next read is right. That
is accepted as rare and self-clearing, with no marker to keep it out of the cache. Remove the retry
once every deployment is past 0030.

`0033_audit_log_entries.sql` adds `audit_log_entries` (`audit_id`, `space_id`, `environment_id`,
`entry_id`, `at`), which entries each audit row is about: its target when that is an entry, and each
entry its `detail` names. An entry's activity reads it as one range of
`audit_log_entries_by_entry` (`space_id`, `environment_id`, `entry_id`, `at`, `audit_id`) instead of
every row's JSON. The trigger `audit_log_index_entries` fills it in the statement that appends a
row, for the reason 0030's triggers give: code that has never heard of the table appends rows during
a deploy and after a rollback. A `detail` that isn't valid JSON indexes only its target rather than
failing the append. The migration backfills the rows already written. Nothing deletes from it, as
nothing deletes audit history; deleting an environment leaves it.

`0035_content_type_preview.sql` adds the nullable `content_types.preview_url_template`, a type's
`preview.urlTemplate`, as plain text for the same reason: on a replica behind the migration
`toContentType` sees the column's own name and treats it as unset, which JSON could not survive.
Delivery never reads it.

`0032_content_type_agent_instructions.sql` adds the nullable `content_types.agent_instructions`.
Delivery names its columns and never reads it. Management reads can start on a replica behind the
migration, where the bare column reads as its own name, so `toContentType` treats that text as
unset; the check goes once every deployment is past 0032.

`0026_content_type_details.sql` adds four nullable columns to `content_types`: `group_name`,
`description`, `icon` and `layout` (JSON, the entry form's tabs and field groups; editor-only and
never delivered). Code older than the migration neither reads nor writes them, and its upsert
names only the columns it knows, so a save from it leaves them as they were. Nothing is
backfilled (see [Domain model](./domain-model.md#content-type)).

`0025_locale_settings.sql` adds the nullable JSON `spaces.locale_settings` (`{ delivered?,
direction? }` by locale) beside `locales`, which stays the string array older code reads; NULL,
every existing space's value, means every locale is delivered in its language's direction.
Nothing is backfilled (see [Domain model](./domain-model.md#locales--fallback)).

`0024_entry_authorship.sql` adds nullable authorship columns: `entries.created_at`, `created_by`,
`modified_by` and `first_published_at`, `entry_versions.created_by`, and
`entry_published.first_published_at` (the read model's copy, so Delivery sorts by it without a
join), with the index `entries_by_creator` on `(space_id, environment_id, created_by)`. Code older
than the migration names its columns on every write, so it never touches them. It backfills only
`entries.created_at`, from each entry's version 1 (a primary-key read, and only where it is NULL,
so a re-run changes nothing); who created an entry and when it was first published aren't recorded
anywhere exact, so existing rows keep NULL (see [Domain model](./domain-model.md#authorship)).

`0007_dam.sql` adds the asset library's columns to `assets` (`kind`, `mime`, `size`, `width`,
`height`, `content_hash`, `folder_id`, `version`, `r2_key`, `created_at`, `created_by`,
`archived_at`, `rights`, backfilled from the `file` JSON, with indexes for filtering and sorting)
and two tables: `asset_folders` (materialized `path`, sibling names unique) and `asset_versions`
(the files an asset had before its current one).

`0005_webhook_environments.sql` adds `webhooks.environment_id` (the one environment a webhook
receives events from; `NULL`, as every existing row stays, means every environment) and the
`webhooks_by_environment` index on `(space_id, environment_id)` (see
[Events & webhooks](./events-and-webhooks.md#webhooks)).

`0006_environment_promotions.sql` adds `environment_promotions`: promotions between environments
with their pinned entries, risk check, status and result (see [API reference](./api-reference.md)).

`0004_version_bodies.sql` adds `entry_versions.body_key` (a superseded version's body moves to
object storage under that key, and `fields` becomes `{}`) and `version_archive_queue` (versions
waiting to move, queued as they are superseded and due a day later), backfilling the queue with
every version already superseded (see [Consistency](./consistency.md)).

`0003_environment_purges.sql` adds `environment_purges`: deleted environments whose rows the engine
is still removing in bounded steps (their ids can't be reused until it finishes).

`0002_auth.sql` adds the web app's tables: `users`, `sessions`, `recovery_codes`,
`sign_in_challenges`, `passkeys`, `passkey_challenges`, `scim_groups`, `scim_group_members`,
`workspace_settings`, `auth_failures`, `admin_audit`.

The lexical search index is not in the database: it lives in `SearchShardDO` (FTS5). Vectors live
in the vector index. See [AI, agents & search](./ai-agents-and-search.md).

## Testing approach

The application layer is tested against `@commerceworker/test-kit` fakes: an in-memory
`ContentStore` that enforces the same unit-of-work rule as the database (no reading your own
uncommitted writes), fake blob, vector and embeddings stores, and deterministic `Clock` and
`IdGenerator`. The database store runs the same contract suite in the local runtime, plus
concurrency tests (racing publishes: exactly one wins; outbox leases never double-claim). Because
the fakes implement the same ports as the real adapters, a passing application test exercises the real use-case logic.
