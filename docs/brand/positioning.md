# Positioning

**Category:** durable commerce infrastructure.

> For engineering-led B2B and hybrid sellers whose orders run on quotes, approvals, purchase orders and several channels, CommerceWorker runs every order as a workflow you can see, replay and roll back. Every capability is reachable by people and agents through the same API, on an isolated Cloudflare deployment the customer owns.

The throughline: an order is a long-running process, not a database row.

## Primary ICP: hybrid and B2B sellers with complex orders

Manufacturers, distributors and wholesale-plus-DTC brands. They have negotiated pricing, company accounts with buyers and approvers, credit terms or budgets, and orders that arrive by storefront, Shopify, EDI 850 and email. They have in-house or retained engineering.

| Role | Who |
|---|---|
| Economic buyer | CTO, VP Engineering, VP Digital Commerce |
| Champion | A platform or commerce engineering lead who has absorbed order-failure pain |
| Users | Engineers on the API and MCP; order-ops and sales-ops in the live order view; approvers at the seller's customers |
| Influencer | A security or architecture reviewer, persuaded by per-customer isolation |

**Trigger events:**
- Replatforming a legacy suite whose B2B order logic nobody wants to migrate.
- Modernizing EDI or email intake.
- A mandate to open catalog and checkout to AI agents.
- Adding DTC beside B2B.
- An incident nobody could explain or cleanly reverse.
- A review that rejects shared multi-tenant infrastructure.

## Secondary ICP: developers and agencies

- Studios already building on Cloudflare.
- Agencies that want one repeatable isolated deployment per client.
- Builders of agentic products who need a commerce back end their agents can call over MCP or A2A.

## Pillars

1. **Every order is a workflow you can see.** Order Flows are durable flow graphs with saga rollback, approvals and a live view, for every order model and channel.
2. **Built for how B2B buys.** Companies, price books, quotes, purchase orders, approvals, credit and budgets are core model. (Quotes, companies and credit are on the roadmap at P5; say "planned" until they ship.)
3. **Agent-ready by construction.** Use-cases are reachable over REST and MCP (full parity is P2), and UCP checkout ships. ACP is planned. A2A and the assistant are included.
4. **Your commerce, your deployment.** One isolated stack per customer, with no multi-tenant pool.

## Competitive frame (by category, never by vendor)

| Category | Where we win | Where we don't | Don't claim |
|---|---|---|---|
| Legacy suites | Visible, reversible order logic; native agent surfaces; complex B2B flows survive the move | Merchandising breadth, integrator ecosystem, certified back-office connectors | Parity; replacing the ERP |
| SaaS monoliths | Complex B2B and multi-channel orders, isolation, ownership | No-code storefronts, themes, app marketplaces. Don't chase this segment | Easier, faster to launch, cheaper |
| Composable / MACH | One durable order lifecycle instead of glue code; native B2B and agents | Best-of-breed per component; teams committed to another cloud | "More composable": our argument is coherence |
| Agentic point tools | The whole system available to agents, not only checkout | Adding agent checkout to an existing platform this quarter | Broad protocol coverage: UCP is live, ACP is planned |

## Risks

- **Breadth reads as immaturity.** Lead with Order Flows and B2B as the wedge, and earn design-partner proof before marketing breadth.
- **Platform dependence.** Frame Cloudflare as substrate the customer owns, and be explicit about data portability and the API contract.
- **The agent story outruns demand.** Present agent-readiness as a consequence of REST/MCP parity, not as the headline.

Never claim scale, latency, customers, uptime or compliance until it is measured.
