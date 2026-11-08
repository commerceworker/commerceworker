---
paths:
  - apps/api/**
  - apps/delivery/**
  - apps/pipeline/**
  - apps/media/**
  - packages/platform/**
  - packages/adapters/**
  - examples/fleet/**
  - scripts/fixtures/fleet/**
  - scripts/fleet.ts
  - scripts/provision.sh
---

# The Workers (api, delivery, engine) and their platform

- Apps are thin composition entries; shared code lives in packages. `packages/platform/src/wire.ts`
  (`wireEdge`) binds adapters to ports; `EdgeEnv` (`src/env.ts`) is the typed binding and var
  surface for every Worker.
- Split by traffic profile: `apps/api` is HTTP only (Management, Preview, MCP, OAuth, media, live)
  with Smart Placement; `apps/delivery` is the public Delivery API (gateway authenticates every
  request, then the cached, unroutable `Delivery` entrypoint reads D1 replicas); `apps/pipeline` has
  no route and owns every queue consumer, the cron, and every Durable Object and Workflow class,
  which api and delivery bind by `script_name: "commerceworker-pipeline"`.
- Each `wrangler.jsonc` is the template `scripts/fleet.ts` renders per deployment
  (one registry entry each, in the private `commerceworker/fleet` repo); never deploy it by hand. A new resource must be provisioned
  (`scripts/provision.sh`) in every deployment before the merge that binds it (`infra-change`).
- CI deploys engine → api → delivery → web and rolls back engine first; the engine can't roll back
  past a Durable Object migration. DO migration tags only append (`apps/pipeline/wrangler.jsonc` and
  `scripts/do-migrations.test.ts`, same change).
- A new var or binding: `EdgeEnv`, config, every Worker that reads it, the local stack's vars in
  `apps/studio/vite.config.ts`, `fleet.ts` if it varies per deployment, `docs/configuration.md`.
  Secrets only through the deployment's GitHub environment (`fleet.ts` `SECRETS`), never `vars`.
- Workers rules: no floating promises (`ctx.waitUntil` for background work), no request state in
  module globals, no Node servers or filesystem (`nodejs_compat` only), Workflow effects only inside
  `step.do`. Check a bundle with `pnpm --filter @commerceworker/<app> exec wrangler deploy --dry-run --outdir /tmp/<app>`.
- The Cloudflare account holds other projects: filter by the `commerceworker` name prefix before any
  read of Workers, KV, queues, R2 or Vectorize, and never create or delete them from a session.
- Review with the `workers-reviewer` agent.
