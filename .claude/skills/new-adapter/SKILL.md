---
name: new-adapter
description: Add a Cloudflare adapter to CommerceWorker. A new subpath of @commerceworker/adapters implementing a port, its tests, the test-kit fake, the binding and env wiring in packages/platform, every wrangler.jsonc and the fleet, and the docs. Use when adding a new backing service for an existing port (vector store, queue, blob store, AI or embeddings provider, email, images, video), or a new port with its first adapter.
argument-hint: "<port> <adapter-name>"
---

# Add an adapter: $ARGUMENTS

Adapters live in one package, `packages/adapters`, one subpath each:

!`ls packages/adapters/src`

1. **Mirror the closest sibling** implementing the same port (e.g. `vector-vectorize` for a
   `VectorStore`, `queue-cf` for a queue). Create `packages/adapters/src/<name>/index.ts` and add
   `"./<name>": "./src/<name>/index.ts"` to `exports` in `packages/adapters/package.json`. External
   dependencies come from the pnpm catalog (`"catalog:"`); add the version to `pnpm-workspace.yaml`
   first.

2. **Port.** The interface lives in `packages/ports/src/` (`content-store.ts`, `infra.ts`, …). If
   the port is new: interfaces only, domain types only (no binding, SDK or driver type in any
   signature), plus an in-memory fake in `packages/test-kit/src/` exported from its index.

3. **Implementation.** Export a `create<Name>(options)` factory taking the binding and explicit
   options (never reading env itself). It runs on workerd (`nodejs_compat`): `fetch` and bindings,
   no filesystem, no long-lived sockets. Every operation honours `Scope` where the port carries one,
   so isolation holds inside the backing service. Describe a binding with a narrow `…Like` type
   (see `R2BucketLike`, `ImagesBindingLike`) so tests can stub it.

4. **Tests:** `packages/adapters/test/<name>/*.test.ts`, in node with the binding stubbed. Cover the
   mapping to and from domain types, errors, and a two-scope case.

5. **Wire it** in `packages/platform/src/wire.ts` (`wireEdge`), selected by binding presence or a
   `<PORT>_PROVIDER` style var matching the existing selectors (`AI_PROVIDER`,
   `EMBEDDINGS_PROVIDER`, `VECTOR_STORE`). If the port has a fake key in
   `packages/application/src/adapter-guard.ts`, make sure binding the real adapter satisfies
   `assertNoFakeAdapters`.

6. **Parity** (`infra-change` skill): the binding or var goes in `EdgeEnv`
   (`packages/platform/src/env.ts`), every `apps/*/wrangler.jsonc` whose Worker uses it, the local
   stack's `LOCAL_STACK_VARS` in `apps/web/vite.config.ts` when local dev needs a value or a fake,
   `scripts/fleet.ts` (per-deployment names or ids) and `scripts/provision.sh` (a resource that must
   exist before deploy), then `pnpm test:fleet`.

7. **Docs:** `docs/configuration.md`, `docs/architecture.md` and the topic page (e.g.
   `docs/ai-agents-and-search.md`), then `pnpm --filter @commerceworker/docs generate`.

8. **Verify:** `pnpm install`, `pnpm --filter @commerceworker/adapters test`,
   `pnpm --filter @commerceworker/adapters check-types`, a dry-run bundle of each Worker that binds
   it (`infra-change`, step 7), then `/preflight` and `/review-change`.
