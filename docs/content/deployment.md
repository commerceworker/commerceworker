# Deployment

CommerceWorker deploys to the edge platform as **one isolated stack per customer**: each deployment
has its own database, object storage bucket, key-value namespace, vector index, queues, AI gateway
and five edge workers (engine, media, api, delivery, web). Spaces and environments live inside a
deployment's database. Merging to `main` is releasing: CI migrates the database and deploys every
deployment, ring by ring. Nobody deploys from a workstation or an agent session.

> **This page describes the content stack's original, separate fleet.** In this repository the
> content Workers are rendered, provisioned and deployed by the same `scripts/fleet.ts`,
> `scripts/provision.sh` and `.github/workflows/deploy.yml` as the commerce Workers, opt-in per
> deployment with `"content": true` in its `deployments/<id>.jsonc`: the Workers are `pipeline`
> (the content engine), `media`, `api`, `delivery` (with its content side) and `studio` (the
> content admin), with a separate content database `commerceworker-content<suffix>`. Read
> [Operations](../operations.md#the-content-stack), [Deploy](../deploy.md#the-content-stack) and
> [Configuration](../configuration.md#content-stack-secrets) for what is current; the sections
> below stay as background on the content stack's design.

The code, `scripts/fleet.ts`, `scripts/provision.sh` and `deploy.yml` are in this repository, and so
is the registry, `deployments/`.

For bindings and vars, see [Configuration](./configuration.md); for what each worker does, see
[Architecture](./architecture.md); for restore points, see
[Backup & restore](./backup-and-restore.md).

## The registry: `<id>.jsonc` files

One file per deployment in `deployments/`, parsed by `toDeployment` in `scripts/fleet.ts`:

| Field           | Meaning                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | Lowercase id; reserved words (`api`, `cdn`, `admin`, `docs`, …) need an explicit `domain`                                                                                      |
| `ring`          | `staging`, `internal`, `canary` or `general`                                                                                                                                   |
| `slot`          | 1–999, unique; keeps each deployment's rate-limit namespaces apart (`slot × 1000 + n`)                                                                                         |
| `domain`        | The admin host; default `<id>.commerceworker.com`. The api is `api.<domain>`, delivery `cdn.<domain>`, media `media.<domain>`                                                   |
| `suffix`        | Appended to every account-wide resource name; default `-<id>` (`""` keeps the base names in `apps/*/wrangler.jsonc`)                                                                                    |
| `environment`   | The GitHub environment holding its secrets; default `deploy-<id>`                                                                                                              |
| `d1Id`, `kvId`  | Recorded by `scripts/provision.sh`; required to render                                                                                                                         |
| `jurisdiction`  | `eu` or `fedramp`, for the database, object storage and stateful objects (set at creation)                                                                                     |
| `hold`          | Skipped by CI: stays on what it runs now                                                                                                                                       |
| `docs`          | Also deploys the public docs site                                                                                                                                              |
| `demo`          | Public demo: models mocked (`AI_MODE=mock`, no AI gateway), no vector index, `ALLOW_FAKE_ADAPTERS=ai,vectors` on the api, delivery and engine, and the enterprise starter offered (`DEMO_STARTERS=true` on the api); never in `general` |
| `aiGatewayLogs` | Rendered as `AI_GATEWAY_LOGS`: whether the AI gateway logs each call (prompts and answers never)                                                                               |
| `sso`           | `{ issuer, clientId, trustEmail? }`: the customer's OIDC provider for admin sign-in (secret `OIDC_CLIENT_SECRET`)                                                              |
| `email`         | `{ from, fromName? }`: edge email sender (workflow notify nodes, invitations, scheduler alerts; password reset codes on web); adds the engine's and web's `send_email` binding |

`scripts/fleet.ts` commands (`pnpm fleet <command>` is the same script):

```sh
node scripts/fleet.ts render <id>          # write apps/{engine,api,delivery,web}/wrangler.<id>.json
node scripts/fleet.ts matrix               # deployments per ring, for CI (holds excluded)
node scripts/fleet.ts secrets <app> <out>  # that app's secrets from the environment, as JSON
node scripts/fleet.ts names <id>           # resource names as shell variables
node scripts/fleet.ts set-d1 <id> <uuid>   # record the D1 id in the registry
node scripts/fleet.ts set-kv <id> <kv id>  # record the KV namespace id
node scripts/fleet.ts status               # /health/deep of every deployment
node scripts/fleet.ts doctor <id>          # check one deployment's configs, then its scheduler
node scripts/fleet.ts demos                # provisioned demo deployments (those with a D1 id), as JSON
```

A rendered config is the app's `wrangler.jsonc` with the deployment's names, ids, routes
(custom domains) and vars filled in: `OAUTH_ISSUER=https://<domain>` on the api (OAuth for MCP
clients is served on the admin host, so its consent screen can use the person's web sign-in) and
`MEDIA_BASE_URL=https://api.<domain>`, the AI gateway id with `AI_GATEWAY_LOGS` on every worker
that sets `AI_GATEWAY_ID`, `DATA_JURISDICTION`, SSO vars on web, and edge email on the engine and web.

`doctor <id>` is read-only. It renders every app for the deployment and checks that each has the
bindings its code reads (`REQUIRED_BINDINGS` in `scripts/fleet.ts`), the database and key-value
ids are the deployment's, the engine has its `* * * * *` cron and consumes its queues, every
stateful object and durable workflow bound by `script_name` names this deployment's engine and a
class or workflow it defines, each public worker has its custom-domain route, and no secret is
declared as a plain var; it lists the secrets the deployment's GitHub environment must hold. Then,
for a provisioned deployment CI deploys (or with `--url <api base>`, e.g.
`http://localhost:8787`), it reads `https://api.<domain>/health` and fails on `scheduler: stale`.
`--offline` skips the fetch. It exits `1` on any error.

## Scheduler alerts

The engine's per-minute cron runs the sweeps nothing else would notice stopping: the outbox relay,
scheduled actions, asset expiry, retention, the reseal and the rest. Two things watch it:

- **The cron watches its sweeps.** At the end of each tick it checks every sweep the deployment
  runs; one that has gone two of its runs without a success (five minutes for the every-minute
  sweeps, two hours for the hourly ones, two days for the daily ones) is stale. The deployment's
  alert recipients get one email when it goes stale and one when it succeeds again, never one per
  tick. Set them with `PUT /deployment/scheduler/alerts` (or the `scheduler_alerts_set_recipients`
  MCP tool) as a deployment administrator; the emails need the deployment's `email` sender. With no
  recipients or no sender the engine still logs every episode (`scheduler job stale`), which a
  platform log alert can match. `GET /deployment/scheduler/alerts` shows what is stale and how
  each email went.
- **Something outside watches the cron.** When the cron itself stops (the engine fails to deploy
  or boot, the trigger is gone) nothing of it runs to say so. Point an uptime monitor (a
  platform health check with a notification, or any external checker) at
  `https://api.<domain>/health/scheduler`, which answers `503` once the last tick is more than
  five minutes old. `/health` itself stays `200`: it is the api's liveness, and CI's smoke test
  reads it right after a deploy, before a new deployment's first tick. When the cron comes back,
  its first tick emails the recipients that it is ticking again, with how long it was out.

`doctor <id>` reads the same state from `/health` and fails on `scheduler: stale`.

## Provisioning a deployment

`scripts/fleet.ts` and `scripts/provision.sh` read the registry in `deployments/`, and
`provision.sh` creates the deployment's GitHub environment and secrets on this repository, and limits the
environment to the `main` branch, keeping any reviewers and wait timer it has ([what it sets and how to
check it](../operations.md#what-provisioning-sets-on-the-environment)). To lock an environment that
already exists, run `./scripts/provision.sh <id>` again as a repository admin.

1. Add `<id>.jsonc` to the registry (`id`, `ring`, `slot`, optionally `domain`, `sso`, `email`).
2. Run `./scripts/provision.sh <id>` (needs `wrangler login` and `gh auth login`; no token to
   paste: its two API calls use `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` when set, else
   wrangler's login). It is safe to re-run; it:
   - creates the database, records its id, and turns on read replication (`mode: auto`; when the
     API refuses, it says how);
   - creates the shared key-value namespace and records its id;
   - creates the object storage bucket with lifecycle rules (`imports/` 7 days, `dlq/` 30 days,
     `zips/` 2 days, and `abort-multipart`, which aborts multipart uploads left unfinished for 2
     days anywhere in the bucket);
   - creates the vector index (768 dimensions, cosine; metadata indexes on `spaceId` and
     `environmentId`), except for a demo;
   - creates the queues (events, events DLQ, bulk, agents, purge, purge DLQ, media purge, media
     purge DLQ, asset events, asset events DLQ) with 14-day retention;
   - creates the storage event notification rule that sends the bucket's `object-create` events to
     `commerceworker-asset-events<suffix>` (asset ingest), unless one to that queue exists;
   - creates the AI gateway (authenticated, rate-limited, retries, logs per `aiGatewayLogs`);
   - creates the GitHub environment and generates `PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER`,
     `MEDIA_SIGNING_SECRET` and `PASSWORD_PEPPER` if absent (refusing to generate a new
     `DATA_KEY`, `TOKEN_PEPPER` or `PASSWORD_PEPPER` when the api worker already holds one);
   - writes the first administrator's one-time setup code to `.secrets/<id>/setup-code`
     (gitignored) and sets it as `SETUP_TOKEN`.
3. Add `CLOUDFLARE_API_TOKEN` (with the permissions in [The deploy token](#the-deploy-token))
   and `CLOUDFLARE_ACCOUNT_ID` to the environment if they are not repository secrets, commit the
   registry file, and merge. CI deploys it in its ring.
4. Send the customer's first admin `https://<domain>/setup` and the setup code.

Edge image transforms and the video streaming service are account features; their bindings need
no ids. The routes (`<domain>`, `api.`, `cdn.` and `media.<domain>`) are custom domains on the
edge workers: the deploy creates each one and its certificate, on a zone in the same platform
account, so there is no DNS record to add by hand.

**A deployment that predates the media worker** needs its two queues before the merge that ships
it (`commerceworker-media-purge<suffix>` and `…-dlq<suffix>`; the engine binds the first as a
producer and the media worker consumes both, so a deploy without them fails). Re-run
`./scripts/provision.sh <id>` for each such deployment first: it creates only what is missing. To
receive the video streaming service's webhook, point it at
`https://api.<domain>/webhooks/stream` and set `STREAM_WEBHOOK_SECRET`.

**A deployment that predates zip downloads and multipart uploads** needs the two object storage
lifecycle rules (`zips/` and `abort-multipart`) and, in the fleet render, the `ASSET_ZIP_WF`
workflow binding and the media worker's `RATE_LIMIT_SHARE_UNLOCK` rate limit (`scripts/fleet.ts`
renders both; the namespace is `slot × 1000 + 6`). Re-run `./scripts/provision.sh <id>` for the
rules; they are backstops for the engine's hourly sweeps, so nothing fails without them, but an
abandoned part or an archive then stays until the sweep removes it. The workflow
(`commerceworker-asset-zip<suffix>`) is created by the engine's deploy.

**A deployment that predates asset ingest** needs `commerceworker-asset-events<suffix>`, its
`…-dlq<suffix>` and the storage notification rule before the merge that ships it: the engine
consumes both queues and the api binds the first as a producer, so a deploy without them fails.
Re-run `./scripts/provision.sh <id>` for each such deployment first. Assets uploaded before then
were never ingested; once deployed, `POST /spaces/<space>/environments/<env>/assets/reindex` (or
the `assets_reindex` MCP tool) sends them through ingest as a bulk job, per environment.

## Secrets

Secrets live in each deployment's GitHub environment and reach the workers through
`wrangler deploy --secrets-file` (which adds and never removes, so a secret set by hand
survives). Which worker gets which is `SECRETS` in `scripts/fleet.ts`:

| Worker   | Secrets                                                                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web      | `PRINCIPAL_KEY`, `PRINCIPAL_KEY_PREVIOUS`, `DATA_KEY`, `DATA_KEY_PREVIOUS`, `SETUP_TOKEN`, `PASSWORD_PEPPER`, `OIDC_CLIENT_SECRET`                                                                    |
| api      | `PRINCIPAL_KEY`, `PRINCIPAL_KEY_PREVIOUS`, `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`, `STREAM_WEBHOOK_SECRET`, `MCP_TOKEN`, `ADMIN_TOKEN`                               |
| engine   | `ASSISTANT_PRINCIPAL_KEY`, `ASSISTANT_PRINCIPAL_KEY_PREVIOUS` (derived from the `PRINCIPAL_KEY` pair; never the pair itself), `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET` |
| delivery | `DATA_KEY`, `DATA_KEY_PREVIOUS`, `TOKEN_PEPPER`, `MEDIA_SIGNING_SECRET`                                                                                                                               |
| media    | `MEDIA_SIGNING_SECRET` (verifies published paths' tokens and Preview's short-lived signed reads; it signs nothing)                                                                                    |

`PRINCIPAL_KEY`, `DATA_KEY`, `TOKEN_PEPPER` and `MEDIA_SIGNING_SECRET` are required
(`REQUIRED_SECRETS`); keys must be at least 32 characters (`openssl rand -hex 32`). Every
worker of a deployment holds the same value of each. `TOKEN_PEPPER` and `PASSWORD_PEPPER` never
change once a deployment runs (escrow them, and `DATA_KEY` with them). `DATA_KEY` and
`PRINCIPAL_KEY` rotate through their `*_PREVIOUS` companions: `DATA_KEY` by the procedure in
[Auth & RBAC](./auth-and-rbac.md#secrets-at-rest), `PRINCIPAL_KEY` below.

**Rotating `PRINCIPAL_KEY`:** set `PRINCIPAL_KEY_PREVIOUS` to the current key and `PRINCIPAL_KEY`
to a new one in the GitHub environment and deploy; once every worker runs the new key, remove
`PRINCIPAL_KEY_PREVIOUS` and deploy again. The engine's assistant pair follows on its own: `fleet.ts
secrets` derives `ASSISTANT_PRINCIPAL_KEY` from `PRINCIPAL_KEY` and `ASSISTANT_PRINCIPAL_KEY_PREVIOUS`
from `PRINCIPAL_KEY_PREVIOUS` on every deploy. Because `--secrets-file` never removes a secret,
delete `ASSISTANT_PRINCIPAL_KEY_PREVIOUS` from the engine (`wrangler secret delete`, by hand, with
the user's approval) when you remove `PRINCIPAL_KEY_PREVIOUS`, as for any `*_PREVIOUS`.

### The assistant's principal key

The web gateway signs the assistant's paths (`/agents/*`) with a key derived from `PRINCIPAL_KEY`
(HKDF-SHA256, salt `commerceworker/principal-subkeys`, info `commerceworker/assistant-principal/v1`,
32 bytes as base64url: `deriveAssistantPrincipalKey` in `@commerceworker/security/assistant-key`)
and every other path with `PRINCIPAL_KEY` itself. The api's gate for `/agents/*` derives the key
from `PRINCIPAL_KEY` (and `_PREVIOUS`); its REST surface accepts only the main key. The engine holds
only the derived pair, so a principal it could sign is good for the assistant's socket and nothing
else. Nothing to set by hand: CI derives the pair at each deploy (`fleet.ts secrets`, with
`scripts/derive-assistant-key.ts`; it reads the key from stdin or `PRINCIPAL_KEY`, never an
argument), and `provision.sh` generates nothing new for it.

The api gate and the engine accept only the derived key on `/agents/*`; a principal signed with
`PRINCIPAL_KEY` is refused there, and one signed with the derived key is refused on every other
path. A change to how these paths are signed has to roll out in two steps (verifiers accept both,
then only the new).

### The deploy token

`CLOUDFLARE_API_TOKEN` is an account-owned API token for the deployment's account. It needs
exactly what `deploy.yml` does, and nothing `provision.sh` does (provisioning runs by hand
under `wrangler login`). One token can serve every deployment on the account: hold it, with
`CLOUDFLARE_ACCOUNT_ID`, as repository secrets, and every deployment's
environment uses them (a secret of the same name on an environment overrides them). Each
deployment's zone goes on the token:

| Scope                   | Permission                        | Used by                                                                      |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| Account                 | Workers Admin, on **all** Workers | `wrangler deploy`, `--secrets-file` and `wrangler rollback` for every Worker |
| Account                 | D1: Edit                          | `d1 time-travel info` (the bookmark) and `d1 migrations apply --remote`      |
| Account                 | Queues: Edit                      | registering the engine's and media worker's queue consumers on deploy        |
| Account                 | Account Settings: Read            | Wrangler's account lookup                                                    |
| Zone (the deployment's) | Workers Routes: Edit, Zone: Read  | the custom domains (`<domain>`, `api.`, `cdn.`, `media.`, the docs host)     |

Binding a key-value namespace, bucket, vector index, gateway or other resource needs no permission
on it, so the token carries none. The Workers permission must cover every Worker in the account,
not a list of specified ones: Admin, because a deploy that ships a new Worker has to create it, and
all Workers, because a Worker missing from the list fails its deploy with "No access to the
specified service". A token that lacks a permission fails at the step that needs it, and the log
names the request.

## The pipeline

CI and the deploy are described in [Deploy](../deploy.md#ci), and the content stack's own deploy
steps in [Deploy](../deploy.md#the-content-stack). In short: `.github/workflows/ci.yml` verifies
every pull request and push to `main`, and once the repository variable `DEPLOY_ENABLED` is `true`
it deploys every deployment in `deployments/`, ring by ring, through
`.github/workflows/deploy.yml`. That one job deploys a deployment's content Workers beside its
commerce Workers, smoke-tests them, and rolls back what it deployed if a step fails. A failed deploy
is re-run from GitHub Actions, never from a workstation.

Planned, once customers exist ([Patterns](../patterns.md), P8): the registry and each customer's
GitHub environment move to a private fleet repository, so a customer's entry and secrets never land
in this one. CI's `verify` then hands that repository each passing `main` commit to release, its
release refuses any commit that isn't on this repository's `main`, and a push to its registry ships
a new or changed deployment on its own, with the newest `main` commit whose CI passed.

## Releasing the SDK

One package ships to npm, apart from the deploys: `@commerceworker/sdk` (`packages/sdk/sdk`), which
bundles the private workspace SDKs (`packages/sdk/*`) and the CLI (`packages/cli`, its
`commerceworker` binary). Nothing else is published (`scripts/sdk-packages.test.ts`).

- CI's `sdk` job (`.github/workflows/ci.yml`, when a change touches `packages/sdk/`,
  `packages/cli/`, `scripts/sdk-packages*`, the REST operations or the tool schemas): `pnpm sdk:pack`
  builds it through turbo and packs it, then `pnpm sdk:check` installs the tarball into an empty
  project, loads every subpath (ESM and CJS), type-checks every subpath against the shipped `.d.ts`
  files and runs `commerceworker help`. That is what a user installs: `pnpm pack` applies
  `publishConfig` (exports and bin pointing at `dist/`) and rewrites `catalog:` versions.
- Release workflow (`.github/workflows/sdk-release.yml`): pushing a tag `sdk-v<version>` checks that
  the tag equals `packages/sdk/sdk/package.json`'s version, then lints, type-checks and tests the
  SDK and everything it bundles (`turbo --filter='@commerceworker/sdk...'`), runs `pnpm sdk:pack`
  and `pnpm sdk:check`, and runs `node scripts/sdk-packages.ts publish --provenance`, which
  publishes with `--access public` and skips a version npm already has (so a re-run is safe). It
  runs in the `npm` GitHub environment, only in `commerceworker/commerceworker`, one release at a
  time, with `contents: read` and `id-token: write`; there is no stored token, since npm trusts
  the job's OIDC identity and attaches a provenance attestation. Run it from the Actions tab
  (`workflow_dispatch`) to rehearse: `dry-run` defaults to true, which does everything but publish.

To release: bump `version` in `packages/sdk/sdk/package.json`, merge that to `main`, then tag the
merge commit and push the tag (`git tag sdk-v<version> && git push origin sdk-v<version>`). The
`npm` environment's reviewers approve the run, and the version appears on npm with its provenance.

One-time setup, by the npm org's owner, before the first release:

1. Create the `@commerceworker` organization on npmjs.com.
2. Publish the first version by hand (`pnpm sdk:pack`, then `npm publish` of the tarball with
   `--access public`), because npm can configure a trusted publisher only for a package that exists.
3. On the package's settings, add the trusted publisher: GitHub Actions, organization
   `commerceworker`, repository `commerceworker`, workflow `sdk-release.yml`, environment `npm`.
4. In the repository's Settings, Environments, create `npm` with required reviewers, and limit it
   to the tag the release runs from: under Deployment branches and tags choose "Selected branches
   and tags", add a tag rule `sdk-v*` and a branch rule `main` (a rehearsal run from the Actions
   tab runs from a branch). Without a rule, a workflow on any branch could use the environment's
   OIDC identity, which npm trusts. `provision.sh` doesn't create this environment, so this one
   is by hand.

Until then the workflow can run as a dry run but cannot publish.

## Migrations

CI applies the hand-written migrations in `packages/store/migrations/` to each deployment's database
with `wrangler d1 migrations apply DB --remote`, after recording the point-in-time recovery
bookmark and before the new code ships (see the deploy steps above). That ordering is why they
are expand-only; the rules for writing one, and applying it locally with `pnpm db:migrate:local`,
are in [Development](./development.md#changing-the-database-schema). Remote databases are
migrated only by CI.

## Recovering admin access

When no administrator can sign in, `./scripts/setup-code.sh <id>` issues a new one-time setup
code: it writes it to `.secrets/<id>/setup-code`, sets it on the GitHub environment (so the next
deploy keeps it) and on the web worker (so it works now). The code opens `/setup` once to create
one admin account; its use and every wrong guess go to the audit log.

## Rollback by hand

CI rolls back a failed deploy itself. A later rollback is a revert merged to `main`, which CI
ships like any change. Rolling code back never rolls the schema back; restoring data is a
point-in-time recovery restore (see [Backup & restore](./backup-and-restore.md)).

Mind what the older code doesn't know about. Code from before environment purging
(`0003_environment_purges.sql`) ignores the purge markers: while a deleted environment is still
being purged, it would serve the leftovers again, let the same id be created on top of them, and
treat `environment.purge_due` as an ordinary event (so a webhook subscribed to `*` would receive
it). Check `SELECT * FROM environment_purges` is empty before rolling back past that change;
purges normally finish within minutes.

Code from before `0004_version_bodies.sql` reads an archived version's emptied `fields` (`{}`)
as its body, so the archive sweep ships off (`VERSION_ARCHIVE=false`). Turn it on in a later change,
once the release that reads archived bodies runs on every worker of every ring. Once it's on, don't
roll back past that release: history views and restores of superseded versions would show empty
content. Current and published versions are never archived, so entries themselves read
correctly.

An engine from before snapshot import jobs (environment import and clone) doesn't know their job
kind: it fails their chunks and never starts their publishing job. Re-run such an import after
rolling forward.
