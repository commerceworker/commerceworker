# 0001: One stack per customer, on D1

**Status:** accepted, 2026-11-07

**Decision.** Each customer runs an isolated CommerceWorker deployment (`deployments/<id>.jsonc`, rendered by `scripts/fleet.ts` and deployed ring by ring). D1 and Durable Object SQLite are the only databases. Neon, Postgres and Hyperdrive are not used.

**Why.**
- Commerce Worker v1 ran a multi-tenant pool on six Neon Postgres databases with a control plane. It reached 19 Workers, and its last work went into decoupling from Neon.
- OrderLoop ran one stack per customer on Cloudflare primitives, and that model is proven in CI.

**Consequences.**
- D1's limits are design inputs: 100 bound parameters, one writer, 10 GB.
- Append-heavy data goes to R2, and derived indexes go to Durable Objects (the sharded catalog).
- There is no tenant id in the data model. A sandbox is its own staging-ring deployment.
- v1 logic is re-implemented against D1, never ported with its driver.
