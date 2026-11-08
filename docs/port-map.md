# Port map

Where each part of CommerceWorker comes from. Everything below is code the owner already wrote. The rule is to lift before writing new code, and to rename rather than rewrite.

The sources:
- **The order engine**: the running base, an earlier codebase of the owner's whose name is retired. It was copied whole from its tracked files and renamed; its Workflow is now the `OrderWorkflow` class, the capability Order Flows.
- **The platform packages**: the hexagonal core, HTTP and MCP surfaces, Cloudflare adapters, assets service, tooling, SDK and CLI. They are taken whole and renamed.
- **Commerce Worker v1** (`~/Sites/cloudflare/commerceworker`): domain logic only. Its Neon/Postgres data plane, multi-tenancy and control plane are not ported (see `docs/adr/0001-stack-per-customer-on-d1.md`).

## Done in P0

| Part | From | How |
|---|---|---|
| Everything under `apps/`, `packages/`, `plugins/`, `scripts/`, `deployments/`, `docs/`, `.github/`, `.claude/` | Order engine | Copied whole and renamed: the package scope, the env var prefix, the `X-CommerceWorker-*` headers, the `cmw_live_` token prefix, the `.cwplugin` bundle extension and the domain |
| `deployments/commerceworker.jsonc`, `apps/*/wrangler.jsonc` | Order engine | Resource ids zeroed: they pointed at its production D1 and KV. `scripts/provision.sh` fills them for a new account |
| Agents `hexagonal-guardian`, `workers-reviewer`, `completeness-auditor`, `data-integrity-auditor`, `launch-reviewer`, `toolchain-auditor`, `admin-ui-reviewer` | Platform `.claude/agents` | Copied and renamed; the hexagonal ones carry a "converging" banner |
| Skills `new-use-case`, `new-adapter` | Platform `.claude/skills` | Copied and renamed, with a banner (they apply from P1) |
| Path rules `docs`, `sdk`, `web`, `workers` | Platform `.claude/rules` | Active in `.claude/rules/`, path-scoped to the content stack (`apps/studio`, `apps/pipeline`, `apps/api`, `apps/delivery`, `apps/media`, `apps/docs`, `packages/sdk`) |
| `onlyBuiltDependencies` (esbuild, workerd) | Platform `pnpm-workspace.yaml` | Copied |

Not taken, and why:
- The skills `run-stack` and `regen`: they boot a different stack (spaces, dev tokens), and `docs/local-development.md` covers ours.
- v1's `packages/rules` condition tree: the core already evaluates conditions with JSON Logic, and a second rules engine is the duplication v1's own `docs/architecture/rules-engines.md` warned against.

## The order engine: final import

CommerceWorker carries the order engine's `main` up to **b8e9f93**, its final state (7 November 2026). The original copy was taken from **a047657** (27 October); the 135 commits between them were ported on 7 November by renaming both snapshots exactly as the copy was renamed and merging each changed file three-way (the renamed old snapshot as base, ours, the renamed new snapshot). Where both sides changed a shared UI component, ours won (the Ledger contrast and transition tests hold it); upstream's sidebar tokens matched ours. This was a one-time import: its code now lives and changes here, and its repository is a read-only reference. One golden value moved with the rename: the deploy smoke test's write-check key and signature (`commerceworker-health-check`), in `packages/core/tests/roles.test.ts` and `scripts/fleet.test.ts`; no deployment had derived it.

## Done: the platform merge

| Part | Where it went |
|---|---|
| Content admin, Management API, delivery, assets service, content engine, content docs | `apps/studio`, `apps/api`, `apps/delivery`, `apps/media`, `apps/pipeline`; the content docs merged into `apps/docs` under `/content/` (pages in `src/content/content/`, components in `src/components/content/`, the content API's explorer at `/content/api/`) |
| Hexagonal core and surfaces | `packages/domain`, `ports`, `application`, `store` (the D1 store), `adapters`, `platform`, `http`, `security`, `agent-runtime`, `graphql-gen`, `seed`, `test-kit` |
| SDK and CLI | `packages/sdk/*`, `packages/cli` |
| Docs embed for MCP | `packages/docs-index`, embedding `docs/content/*.md` |
| Design | Merged into `packages/design`: one Ledger token set held to both admins' `app.css`, with WCAG contrast tests; the evolved `packages/ui` components |
| Agent rules and skills | `.claude/rules/` (path-scoped), `skills/` (developer skills), `docs/content/AGENTS.md` |

Renamed on the way in: no app or package takes a product-area prefix. Where a name was taken, the incoming one took its role (`studio`, `pipeline`, `store`). Two golden vectors changed with the rename, both for keys no deployment had derived: the assistant principal key and the dev assistant key in `packages/security`.

## Done: the v1 intake

From Commerce Worker v1, everything that runs without Postgres and has no better counterpart here.

| Part | Where it went | How |
|---|---|---|
| i18n, AI guardrails, upload limits | `packages/i18n`, `packages/guardrails`, `packages/media-upload-limits` | Copied with their tests; the one happy-dom test runs on jsdom, the DOM the repo already uses |
| Subscription lifecycle and billing periods | `packages/core/src/subscriptions.ts` | The state machine (as `canSubscriptionTransition`) and calendar-correct `advancePeriod`, with tests; v1's Postgres service and provider stay behind |
| 56 UI components and 7 hooks | `packages/ui` | Ported to its dialect (`radix-ui`, flat paths, Ledger tokens); the data table on the Ledger table; `sonner` follows the admins' `data-theme` instead of `next-themes` |
| Marketing site | `apps/marketing` | Its structure, sections and English/Spanish copy, rebuilt as static Astro (no third framework, no server code); copy rewritten to what ships today; security headers in `public/_headers` |
| Legal page outlines | `docs/brand/legal-outline.md` | Kept for counsel, not published |

Not taken, and why:
- `stripe-amount`: `packages/core/src/money.ts` `toMinor` already converts, zero-decimal currencies included.
- v1's brand mark, copilot dock, plan-gating banners and usage charts, auth page shells, `theme-toggle` (`next-themes`) and `otp-auth-qr` (`react-qr-code`): the brand, the admins' own auth, `uqr` and the admins' theme rule cover them; plan gating is not planned.
- The marketing pricing page and plan matrix: v1's plans don't apply to a per-customer deployment.
- The example storefront, merchant, control and admin UIs, and the v1 docs pages: they speak v1's Postgres API and multi-tenant control plane.

## Planned

| Target | From | Mode | Phase |
|---|---|---|---|
| `packages/domain`, `ports`, `application`, `test-kit`; the composition root | Platform `packages/{domain,ports,application,test-kit}`, `platform/wire.ts` | Copy the skeleton (`AppContext`, `Scope`, `withTransaction` + outbox, `Clock`/`IdGenerator`, in-memory fakes); drop the CMS repositories | P1 |
| UUIDv7 ids, structured logs, log redaction | Platform `platform/src/ids.ts`, `packages/telemetry`, `packages/redaction` | Copy; reconcile redaction with `core/credentials.ts` `scrubCredentials` (keep one) | P1 |
| REST + MCP from one registration, OpenAPI `doc()`, `parseBody`, `requireScope`, tool-scope test | Platform `packages/http` | Copy the pattern; replace `apps/web/app/lib/api.server.ts` and `apps/engine/src/mcp.ts` area by area | P2 |
| `apps/storefront`, `apps/delivery` | `apps/engine/src/ucp`, `cart/`, `apps/catalog-edge` | Split and rename | P3 |
| Optional assets service: `apps/media` at `media.<host>`, asset ingest, R2 / Images / Stream / KV-gate adapters | Platform `apps/media`, `packages/adapters/src/{blob-r2,images-cf,video-stream,asset-gate-kv}`, `platform/src/asset-ingest.ts` | Copy; a registry field turns it on per deployment. Without it, product media is external `https` URLs (the merchant's DAM or CDN, or Platform-hosted assets) | P3 |
| ACP | `packages/core/src/checkout.ts` | New adapter on the existing CheckoutSession | P4 |
| B2B: companies, price books, quotes, POs, approvals, credit, budgets | v1 `packages/db/src/customer/schema-b2b.ts`, `price-book-resolver.ts`, `credit-enforcement.ts`, `budget-enforcement.ts`, `approval-evaluation.ts` | Re-implement on D1 as pure core logic plus engine adapters; approvals become Order Flow approval nodes | P5 |
| Promotions redesign | v1 `docs/promotions/capability-matrix.md`, `cart-coupon-discount.ts`; `packages/core/src/promotions.ts` | Extend the core, using JSON Logic conditions | P6 |
| Value objects (Address, PersonName), typed payment metadata, lifecycle state machines | v1 `packages/types`, `subscriptions/state-machine.ts`, `order-state-machine.ts` | Port where the core lacks one; the core's `money.ts` stays | P5–P6 |
| `@commerceworker/sdk`, `commerceworker` CLI, SDK packaging and release | Platform `packages/sdk/*`, `packages/cli`, `scripts/sdk-packages.ts`, `.github/workflows/sdk-release.yml` | Copy the framework (device-flow login, profiles, command model, packaging); replace the CMS endpoints | P7 |
| Strict dependency catalog, secrets escrow | Platform `scripts/catalog.test.ts`, `scripts/escrow-secrets*`, `escrow-secrets.yml` | Copy | P8 |
| Ledger brand accent, `DESIGN.md` | Platform `DESIGN.md`, `packages/design` | Copy the format; set the cobalt accent | P9 |
