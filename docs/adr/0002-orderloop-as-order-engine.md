# 0002: OrderLoop is the base and the order engine

**Status:** accepted, 2026-11-07

**Decision.** CommerceWorker starts as a renamed copy of the OrderLoop codebase. OrderLoop retires as a brand. Its generic Workflow keeps the class name `OrderLoop` and is the capability "Order Loops": every order is a pinned flow graph that the Workflow interprets.

**Why.**
- OrderLoop already ships a commerce engine: catalog, cart, checkout, pricing, promotions, payments, UCP, plugins and the order lifecycle.
- It also ships the toolkit, fleet, CI and Ledger. Lifting it whole reuses the most code with the least rewriting.

**Consequences.**
- OrderLoop's shape departs from strict hexagonal layering: there is no ports layer, logic lives in Durable Objects, and transport mixes into use-cases. ADR 0003 records the plan for that.
- Renamed signing labels changed one golden vector (plugin keys), which was updated in `packages/core/tests/plugins.test.ts` and `scripts/fleet.test.ts`. No CommerceWorker deployment or plugin existed yet.
