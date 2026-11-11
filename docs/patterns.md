# Pattern inventory

Every architectural pattern from the platform packages and the order engine that applies to CommerceWorker is merged and used. This page tracks each one. **Merged** means the whole platform follows it and a test or check holds it. **Content: merged · Commerce: Pn** means the content stack (`apps/studio`, `api`, `delivery`, `media`, `pipeline` and the platform packages) follows it and the commerce stack (`apps/web`, `engine`, `catalog*`, `packages/core`) adopts it in that ROADMAP phase. **To merge** names the phase that lands it. Update a row in the same change that moves it.

Each pattern is listed only once. Where both sources have a version, the stricter one wins.

## Repository and toolchain

| Pattern | Source | State | Where / phase |
|---|---|---|---|
| pnpm + Turborepo + Biome monorepo, shared tsconfig bases | both | Merged | root, `packages/typescript-config` |
| Strict dependency catalog (`catalogMode: strict`, every dependency `catalog:` or `workspace:`) | Platform | Merged | `pnpm-workspace.yaml`, `scripts/catalog.test.ts` |
| Strict TypeScript: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters` | Platform | Merged | `packages/typescript-config/base.json` |
| Build scripts allow-listed (`onlyBuiltDependencies`) | Platform | Merged | `pnpm-workspace.yaml` |
| Generated files regenerated, never hand-edited (docs theme from tokens) | both | Merged | `pnpm sync:theme`, `packages/design/tests` |
| Test files named for the capability, never a roadmap phase | Platform | Merged (rule) | AGENTS.md |
| Coding-agent toolkit: hooks that refuse hand deploys, remote migrations and edits to applied migrations; review agents; skills | both | Merged | `.claude/`, `pnpm test:toolkit` |
| Path-scoped agent rules | Platform | Merged | `.claude/rules/` |

## Delivery and operations

| Pattern | Source | State | Where / phase |
|---|---|---|---|
| One isolated stack per customer from a registry; rings staging → internal → canary → general | both | Merged | `deployments/`, `scripts/fleet.ts`, `fleet.test.ts` |
| Merging is releasing; CI migrates D1 (after a restore point) and deploys ring by ring with smoke-test rollback | both | Merged | `.github/workflows/ci.yml` |
| Idempotent provisioning that records ids back into the registry | both | Merged | `scripts/provision.sh` |
| Durable Object migration tags only append, held by a test | both | Merged | `scripts/do-migrations.test.ts` |
| Expand-only, hand-written, never-edited migrations | both | Merged | `packages/db/migrations` |
| One zone with fixed host roles; intake mail on each deployment's host, never the apex | CommerceWorker | Merged | `docs/operations.md` |
| Secrets escrow workflow | Platform | To merge | `scripts/escrow-secrets*`, `escrow-secrets.yml` (P8) |
| Private fleet registry repo handed the commit by CI | Platform | To merge, when customers exist | P8 |

## Architecture

| Pattern | Source | State | Where / phase |
|---|---|---|---|
| Cloudflare primitives first; D1 and Durable Object SQLite only | both | Merged (rule) | AGENTS.md, ADR 0001 |
| A pure core with no bindings or Cloudflare imports | Order engine | Merged | `packages/core` |
| Hexagonal layers: `domain` → `ports` → `application`; adapters bound only at the composition root | Platform | Content: merged · Commerce: partial (pricing, inventory, fulfillment, balances, marketplace, shipping, documents, payments, invoices, order and cart records, checkout sessions, retention, data subjects, order queries, flows, workspace, plugin installs, sealed secrets, tax certificates, companies, budgets, addresses, identity, confirmations, UCP, outbox, product index, logs, audit: ports, D1 and in-memory stores, contracts, the `priceOrder`, `routeFulfillment`, `splitBySeller`, `schedulePayouts`, `bookShipment`, label-void, payment and invoice use-cases, `apps/engine/src/wire.ts`, the only engine file that reaches D1, held by `scripts/composition-root.test.ts`; the web app's reads P1; the storefront has no root and no D1: it asks the engine's `StorefrontApi`, and the same test holds it to importing no `@commerceworker/db`) | `packages/{domain,ports,application,adapters,platform}`, `packages/ports/src/commerce`, `packages/application/src/commerce` (ADR 0003) |
| Deterministic use-cases: ids from an injected `IdGenerator`, time from `Clock`, every call carries a `Scope` | Platform | Content: merged · Commerce: partial (`priceOrder` takes `now`; the D1 pricing store takes a `Clock`) | `packages/application`, `packages/ports/src/support.ts` |
| Unit of work: read first, then one D1 batch, with the outbox row in the same batch | Platform | Content: merged · Commerce: P1 (the catalog shards already write their outbox in the same transaction) | `packages/store` |
| Transactional outbox → queue → consumers (webhooks, search, purges, agents) | both | Content: merged · Commerce: P1 (catalog and webhooks have it) | `apps/pipeline` |
| Apps are thin entries; shared code lives in packages | Platform | Content: merged · Commerce: P1–P3 | `apps/{studio,api,delivery,media,pipeline}` |
| Workers split by traffic profile (admin, api, storefront, delivery, media, engine) | Platform | Content: merged · Commerce: P2–P3 (storefront split) | AGENTS.md, Layout |
| Cached delivery entrypoint behind an uncached gateway; rationed purges | both | Merged | `apps/delivery` |
| D1 limits as design inputs (100 parameters, one writer, 10 GB) | Platform | Merged (rule) | AGENTS.md, ADR 0001 |
| Statement counts per request snapshotted; read paths may only go down | Platform | Merged | `packages/store/test/query-counts.json`, `packages/db/test/query-counts.json` (one counter and drift report, `@commerceworker/test-kit/d1`) |
| A state machine per lifecycle (`defineLifecycle`): every move one compare-and-set on the status read, two racing moves one winner; reads bound by a `scope` (one company's or all) so another company's rows are never reachable | Commerce v1 intake (P5) | Partial: companies and members (S1), approvals decided by votes (S5), budgets (S4) and purchase orders (S6); price books, credit and quotes follow | `packages/core/src/lifecycle.ts`, `packages/core/src/b2b/companies.ts`, `packages/core/src/b2b/approvals.ts`, `packages/core/src/b2b/budgets.ts`, `docs/b2b.md` |
| A store contract run against both the D1 and the in-memory store | Platform | Content: merged · Commerce: partial (pricing, inventory, fulfillment, balances, marketplace, shipping, documents, payments, invoices, order and cart records, checkout sessions, retention, data subjects, order queries, flows, workspace, plugin installs, sealed secrets, tax certificates, companies, budgets, addresses, identity, confirmations, UCP, outbox, product index, logs, audit) | `packages/test-kit/src/commerce/pricing-store-contract.ts`, `packages/db/test`, `packages/test-kit/test` |
| D1 read replicas with session bookmarks | Platform | Content: merged · Commerce: P1 | `packages/platform/src/wire.ts` |
| Sealed secrets at rest; refuse fake adapters in a persistent deployment | Platform | Content: merged · Commerce: partial (every stored secret sealed and resealed daily through the sealed secrets port; fake-adapter refusal P1) | `packages/platform/src/wire.ts` |
| Sharded catalog in Durable Objects with a frozen shard hash | Order engine | Merged | `apps/catalog`, golden tests |
| Workflows with step-keyed effects, saga rollback, continue-as-new | Order engine | Merged | `apps/engine/src/workflow.ts` |
| Optional assets service (R2 originals, Images variants, Stream, signed reads, share links) | Platform | Merged as an app; per-deployment switch and product media wiring P3 | `apps/media` |
| Sandboxed plugins on Worker Loader with declared capabilities | both | Merged | `apps/engine/src/plugin-host.ts` |

## Surfaces, auth and AI

| Pattern | Source | State | Where / phase |
|---|---|---|---|
| Every use-case exposed on both REST and MCP from one registration | Platform | Content: merged · Commerce: P2 (REST and MCP exist separately) | `packages/http` |
| OpenAPI generated from the same schemas the handler parses | both | Merged (web REST) | `apps/web/app/lib/openapi.ts` |
| MCP tool scopes held to each handler's own by a test | Platform | Content: merged · Commerce: P2 | `packages/http/src/mcp/tool-scopes.ts`, `test/mcp/tool-visibility.test.ts` |
| Maintainer docs embedded for MCP docs tools | Platform | Content: merged (`docs/content`) · Commerce: P2 | `packages/docs-index` |
| Signed principal header: HMAC, bound to method and path, under 60 s, trusted only on internal hops | both | Content: merged · Commerce: P2 (bound to the path only) | `packages/security/src/principal.ts`, `packages/core/src/roles.ts` |
| Human auth: passwords, passkeys, TOTP, OIDC, SCIM, setup code | both | Merged | `apps/web/app/lib/*.server.ts` |
| Host-only `__Host-` session cookies and `Origin` checks | both | Merged | `apps/web/app/lib/auth.server.ts`, `origin.ts` |
| AI through AI Gateway; schema-validated output; deterministic fallback | Order engine | Merged | `apps/engine/src/ai.ts` |
| Model tiers (`flagship` / `balanced` / `fast`) chosen by callers, mapped once | Platform | Content: merged · Commerce: P1 | `packages/ports` `ModelTier`, `packages/adapters/src/ai-workers` |
| Hybrid search: full-text shards in Durable Objects plus vectors | both | Merged (catalog search shards, product vectors) | `apps/catalog` |
| Public SDK (core, edge, management) and a CLI with device-flow login | Platform | Merged for content; commerce endpoints P7 | `packages/sdk/*`, `packages/cli` |
| Ledger design system: one token set held to both admins' CSS by a test, with WCAG contrast checks | both | Merged | `packages/design`, `packages/ui` |
| Device tests (WebKit as iPhone, iPad and desktop) | both | Merged | `apps/web/e2e` |
| Automated accessibility checks in the device tests (`@axe-core/playwright`) | Platform | Content: merged · Commerce: P9 | `apps/studio/e2e` |
