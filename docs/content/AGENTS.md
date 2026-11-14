# AGENTS.md

The rules every change to CommerceWorker keeps, for people and for every coding agent.
`CLAUDE.md` imports this file for Claude Code; change the rules here, not there.

## What this is

CommerceWorker is an API-first, AI-agentic-first headless CMS that runs **entirely on
Cloudflare**: D1 is the system of record, with Workers, Queues, KV, R2, Durable Objects,
Workflows, Vectorize, Workers AI (through AI Gateway), Images, Stream, Email Sending and Worker
Loader. Content is **structured, not serialized HTML**: rich text is a typed document tree
(`RichTextDocument`), and every channel renders it for itself. It is a pnpm + Turborepo monorepo with a **ports & adapters (hexagonal)** core, deployed
as one isolated stack per customer (a registry entry each in `deployments/`, rendered by `scripts/fleet.ts`; a
deployment turns the content stack on with `"content": true`, and it gets its own content database); spaces
and environments live inside a deployment's D1. Shipped and planned work is in `ROADMAP.md`.

## Workers (split by traffic profile)

| App             | Role                                                                                      | Notes                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio`      | Admin UI (React Router 8 SSR) + human auth (passwords, passkeys, TOTP, OIDC, SCIM, setup) | Fronts `apps/api` over the `API` service binding, signing the signed-in person into `x-cw-principal`; sends bearer `/delivery/*` calls to `apps/delivery` over `DELIVERY`                             |
| `apps/api`      | Management + Preview REST, MCP, OAuth, media, live                                        | HTTP only. Smart Placement (near the D1 primary)                                                                                                                                                      |
| `apps/delivery` | Public Content Delivery API                                                               | Uncached gateway (auth on every request, KV-cached principal) → cached `Delivery` entrypoint (Workers Caching, keyed by visibility profile). Reads D1 replicas. Drains the purge queue                |
| `apps/media`    | Published asset files at `media.<domain>`                                                 | Uncached gateway (canonical URL, format from `Accept`, signed draft reads) → cached `Media` entrypoint (Workers Caching, immutable). KV gate written only by the engine. Drains the media purge queue |
| `apps/pipeline`   | Queue consumers, cron, every Durable Object and Workflow                                  | No route. api/delivery bind its classes by `script_name`                                                                                                                                              |
| `apps/docs`     | Public docs (Astro Starlight, static assets)                                              |                                                                                                                                                                                                       |

Apps are thin composition entries. Shared code lives in packages, never in another app:
`@commerceworker/platform` (env, config, `wireEdge`, ids, metrics, queue messages, DO classes and
clients, Workflow clients), `@commerceworker/http` (the Hono surface: routes, auth, OpenAPI, MCP),
`@commerceworker/store` (D1 schema, migrations, the D1 `ContentStore`), `@commerceworker/adapters`
(Cloudflare implementations of the ports, one subpath each), and the pure core:
`domain` → `ports` → `application`.

## Rules

- **Branch in a worktree; merging is releasing.** Never push `main`; open a PR. CI migrates D1
  and deploys every Worker ring by ring (`.github/workflows/ci.yml` and `deploy.yml` in this repo, from the
  registry in `deployments/`; the content Workers deploy only for a deployment with `content`, see
  `docs/operations.md`). Nobody deploys from an agent session (`wrangler deploy`
  without `--dry-run`, `versions deploy`, `rollback`, `pnpm … deploy`); `wrangler deploy
  --dry-run` checks a bundle.
- **Never migrate a remote database by hand.** `wrangler d1 migrations apply DB --local` only.
- **Migrations are hand-written SQL, expand-only, and never edited once applied**
  (`packages/store/migrations/NNNN_*.sql`, mirrored in `packages/store/src/schema.ts`). Add a column
  or table now; drop or rename only in a later change once no deployed code reads it.
- **The dependency rule.** `domain` depends on nothing; `ports` holds interfaces; `application`
  orchestrates domain + ports; only `@commerceworker/platform`'s `wire.ts` and the app entries bind
  adapters to ports. No SQL, ORM or driver type crosses a port.
- **Studio's composition root** is `apps/studio/app/lib/wire.server.ts`: only it imports stores,
  Cloudflare adapters or ORM code and reaches D1 (including the health probe). Auth handlers take
  ports; `env.server.ts` has no database helper. `scripts/composition-root.test.ts` holds the boundary.
- **`withTransaction` is a unit of work, not an interactive transaction** (D1 commits a batch).
  Read everything first, then write; a read inside the unit does not see its own writes. A
  compare-and-set inside a unit reports its outcome only at commit, as `TransactionConflictError`;
  callers retry or treat the lost race as a no-op. The outbox row always rides in the same unit.
- **D1 limits are design inputs:** at most 100 bound parameters per statement (use `chunked` /
  `selectChunked` / a JSON parameter with `json_each`), one writer per database (no per-request
  writes on read paths: e.g. `lastUsedAt` is throttled), 10 GB per database (append-heavy data
  goes to R2, derived indexes to Durable Objects). Statements per request are snapshotted in
  `packages/store/test/query-counts.json`: Delivery read counts may only go down, and a PR that
  raises one states why (`pnpm --filter @commerceworker/store test:query-counts:update` rewrites it).
- **Structured content, not serialized HTML.** Content is stored, validated, versioned and
  delivered as typed fields and `RichTextDocument` trees (`packages/domain/src/rich-text`), never
  as an HTML (or Markdown) string. HTML is converted at the edge on the way in
  (`richTextFromHtml`, for imports) and rendered by the consumer on the way out; no store column,
  API response, MCP tool, webhook payload or model output carries content as markup.
- **Both surfaces.** Every capability is a use-case in `@commerceworker/application`, exposed
  through both the HTTP API (`packages/http/src/api/routes`) and MCP
  (`packages/http/src/mcp`), so an agent can never do what a human client can't, or
  the reverse. Tools go in `mcp/tools/<area>.ts`, routes in `api/routes/management/<area>.ts`,
  response schemas in `api/docs/schemas/<area>.ts`; a new area adds its own file.
- **Deterministic use-cases.** IDs from `ctx.ids.newId()` (UUIDv7), time from `ctx.clock.now()`,
  and every store/use-case operation carries a `Scope` (`{ spaceId, environmentId }`).
- **Every dependency version lives in the pnpm catalog** (`pnpm-workspace.yaml`,
  [pnpm catalogs](https://pnpm.io/catalogs), `catalogMode: strict`). A `package.json` names an
  external dependency `"catalog:"` and our own `"workspace:*"`, never a version; only
  `peerDependencies` keep their own broad ranges. A new dependency adds its latest stable version
  to the catalog first; a bump is one line there. `scripts/catalog.test.ts` fails CI on a stray
  version or an unused entry.
- **Generated files are regenerated, not edited, and never committed:** the docs and diagram
  themes (`apps/docs/src/styles/theme.css`, `docs/diagrams/themes/ledger-{light,dark}.json`, from
  `packages/design/src/tokens.ts` by `pnpm sync:theme`), the docs embed
  (`packages/docs-index/src/generated.ts`, from `docs/*.md`) and the MCP skills embed
  (`packages/http/src/mcp/skills.generated.ts`, from `packages/http/skills/**`). All are
  gitignored: `pnpm install` writes them, and turbo's `generate` task rewrites them before every
  `check-types`, `test`, `build` and `dev` (`pnpm generate` by hand).
- **Durable Object migration tags only ever append** (`apps/pipeline/wrangler.jsonc` and
  `scripts/do-migrations.test.ts`, in the same change). Never `deleted_classes` without a plan
  for the data. Classes stay on the `migrations` array, not the `exports` block newer Cloudflare
  docs show: that switch is one-way, blocks version uploads and can't be rolled back across.
- **Trust boundaries:** the api believes `x-cw-principal` only when signed with `PRINCIPAL_KEY`,
  bound to the request method and path and under 60 s old; the delivery `Delivery` entrypoint trusts its
  principal header only because nothing outside the Worker can reach it. Never add a trusted
  header to a publicly routed handler.
- Never use a trailing "z" in endpoint names (`/health`, `/ready`, not `/healthz`).
- Never name a competing CMS in code, comments, docs or plans; say "the surveyed CMS".
- Test files are named for the capability under test, never for a roadmap phase.
- Report vulnerabilities privately (SECURITY.md).

## Commands

```sh
pnpm install
pnpm check-types && pnpm test && pnpm lint      # what CI's verify job runs (turbo, cached)
pnpm --filter @commerceworker/store test            # the D1 store, in workerd against Miniflare D1
pnpm --filter @commerceworker/pipeline test        # Durable Objects + Workflows, in workerd
pnpm --filter @commerceworker/http test          # HTTP API + MCP against in-memory fakes (node)
pnpm --filter @commerceworker/application test   # use-cases against test-kit fakes
node --test scripts/*.test.ts                   # fleet + DO-migration golden tests
pnpm --filter @commerceworker/api exec wrangler deploy --dry-run --outdir /tmp/api   # bundle check
pnpm dev                                        # migrates the local D1, then the stack in one Vite session
pnpm dev:reset                                  # wipe and re-migrate the local D1
pnpm --filter @commerceworker/studio e2e            # Playwright device tests (browsers: docs/development.md)
pnpm docs:build
```

## Cloudflare docs

Versions, defaults and config shapes change monthly: look them up, don't recall them. Search the
docs MCP (`cloudflare-docs`) or fetch `https://developers.cloudflare.com/<product>/llms.txt`. The
Cloudflare plugin's skills show hand deploys and remote migrations; here CI does both, the hooks
refuse them, and the rules in this file win. Path-specific rules live in
`.claude/rules/{web,workers,sdk,docs}.md`; other agents read the one for the area they edit.

## Conventions for new code

- TypeScript is strict (`packages/typescript-config/base.json`: `noUncheckedIndexedAccess`,
  `noUnusedLocals`, `verbatimModuleSyntax`). Use `import type` for types. TypeScript 7 (native)
  ships no compiler JS API: never `import ts from 'typescript'`; run its `tsc` binary instead (the
  SDKs emit `.d.ts` with `tsc`, tsup bundles JS only). ESM; internal packages and apps import
  relative paths without an extension (Bundler resolution), the published SDKs (`packages/sdk/*`)
  keep `.js` specifiers for npm consumers, and `scripts/*.ts` use `.ts` (Node type stripping).
- Biome formats: single quotes, semicolons, trailing commas, 2-space indent, width 100.
- New use-case: take `AppContext`, thread `Scope`, add a test in `packages/application/test/`
  with `@commerceworker/test-kit` fakes. New store behavior: a contract test in
  `packages/store/test/` that runs against D1.
- Code runs on workerd (`nodejs_compat`): no filesystem, no long-lived sockets, no Node servers.
- AI callers pick a `ModelTier` (`flagship` | `balanced` | `fast`); the Workers AI adapter maps
  tier → model and routes through AI Gateway when `AI_GATEWAY_ID` is set.

## Design context

The admin's design context is `PRODUCT.md` and `DESIGN.md` ("Ledger", shared through
`packages/design` and `packages/ui`). Read both before designing any `apps/studio` surface; compose
the existing tokens and components, never stock shadcn defaults.
