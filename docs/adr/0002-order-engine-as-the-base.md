# 0002: The order engine is the base

**Status:** accepted, 2026-11-07

**Decision.** CommerceWorker starts as a renamed copy of an existing order engine codebase, whose
name is retired. Its generic Workflow is the `OrderWorkflow` class and the capability "Order
Flows": every order is a pinned flow graph that the Workflow interprets.

**Why.**
- That codebase already shipped a commerce engine: catalog, cart, checkout, pricing, promotions, payments, UCP, plugins and the order lifecycle.
- It also shipped the toolkit, fleet, CI and Ledger. Lifting it whole reuses the most code with the least rewriting.

**Consequences.**
- Its shape departs from strict hexagonal layering: there is no ports layer, logic lives in Durable Objects, and transport mixes into use-cases. ADR 0003 records the plan for that.
- Renamed signing labels changed one golden vector (plugin keys), which was updated in `packages/core/tests/plugins.test.ts` and `scripts/fleet.test.ts`. No CommerceWorker deployment or plugin existed yet.
