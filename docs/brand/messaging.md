# Messaging and voice

## Hierarchy

**Tagline:** Commerce that runs as code.

- Secondary line, for Order Flows pages: *Every order, a workflow you can see.*
- Use in docs only: *Commerce infrastructure for people and agents.*

**Value proposition:** API-first commerce infrastructure on Cloudflare. Each customer gets an isolated deployment, and people and agents reach every capability through the same interface.

| Pillar | Headline | Support |
|---|---|---|
| One contract, two interfaces | REST and MCP. Same capabilities, same rules. | Same parameters, permissions and errors on both. Agentic checkout (UCP, ACP) and A2A run on the same pricing, inventory and approvals. |
| Orders you can read | Each order is an Order Flow. | Each step shows its live state, pending approvals and history. A failed step rolls back to a known state. |
| Isolated by design | Your deployment. No shared tenancy. | Data and execution are separated at the infrastructure level. B2B uses the same model as direct checkout. |

Before launch, attach proof to each pillar: an architecture diagram, the REST/MCP parity table, and an Order Flow screenshot.

**Boilerplate, 25 words:** CommerceWorker is API-first commerce infrastructure on Cloudflare. Catalog, checkout, B2B and payments run in an isolated deployment, with the same capabilities over REST and MCP.

**Boilerplate, 75 words:** CommerceWorker is API-first, agent-first commerce infrastructure that runs entirely on Cloudflare. Each customer gets an isolated deployment covering catalog, pricing, promotions, cart, checkout, inventory and payments, plus B2B companies, quotes, purchase orders, approvals and credit. Every order runs as an Order Flow: a durable workflow with live state, approvals and rollback. Every capability is identical over REST and MCP, with agentic checkout over UCP and ACP and coordination over A2A.

## Naming

- Write **CommerceWorker**: one word, capital C and W. Use `commerceworker` in code and URLs. Never "Commerce Worker", "Commerceworker" or "CW" in public copy.
- Capabilities are plain Title Case nouns with no prefix: Order Flows, Storefront API, Admin API, Agent Surfaces. As a common noun, write "an Order Flow", and never "Flows" alone. Never name the retired order engine brand; the Workflow under an Order Flow is the `OrderWorkflow` class.
- Features keep plain names: Quotes stays Quotes.
- Write protocols the way their specs do (REST, MCP, UCP, ACP, A2A), and spell them out on first use.

| Term | Meaning |
|---|---|
| Deployment | One customer's isolated CommerceWorker instance |
| Order Flow | The durable workflow graph for one order |
| Step | One node in an Order Flow |
| Approval | A step that waits for a person or a policy |
| Rollback | Returning an Order Flow to its last consistent step |
| Company | A B2B buyer organization with members and credit |
| Quote | A priced proposal that can become an order |
| Purchase order | A buyer-issued commitment attached to an order |
| Credit line | Approved payment terms for a Company |
| Agent Surface | The MCP, UCP, ACP and A2A entry points |

**Avoid:**
- "AI-powered", "magic", "seamless", "revolutionary", "supercharge", "unleash", "copilot".
- "Headless" as the lead descriptor.
- "Tenant" in marketing; say "deployment".
- Third-party commerce vocabulary.
- Naming any competing platform; say "the surveyed platform".

## Voice

A well-written runbook: calm, exact, each sentence finished.

| Surface | Do | Don't |
|---|---|---|
| Button | Approve purchase order | Looks good! |
| Status | 3 steps pending approval | Almost there! |
| Empty state | No quotes yet. Create quote | Nothing here yet... let's get started! |
| Error | Credit line exceeded: order total 12,400.00 exceeds available credit 10,000.00. Request a credit increase or split the order. | Oops! Something went wrong. |
| Error | Step `reserve_inventory` failed: SKU-0042 has 0 available. Rolled back to `price_confirmed`. | Sorry, we couldn't process that. |
| Docs | `POST /orders` starts an Order Flow and returns its ID. | Easily kick off powerful order workflows. |
| Agents | An agent can create a cart and request checkout. Orders above the approval threshold wait for a person. | Autonomous AI that handles everything. |

Rules:
- One idea per sentence, active voice, present tense.
- Use numbers and identifiers, not adjectives.
- Buttons are a verb plus its object.
- No exclamation marks, rhetorical questions or emoji.
- Describe what an agent can do, what limits it, and where a person steps in.

## Visual accent

Ledger with one CommerceWorker accent: Arizona turquoise, about hue 195, a nod to Arizona, the Copper State. Blue is every infrastructure tool's colour; turquoise is ours. It avoids the status hues: ok 152, wait 62, bad 28, undo 42. The tokens are `brand` (`oklch(0.5 0.09 195)` light, a deep turquoise that holds text contrast on white; `oklch(0.78 0.12 195)` dark, the stone itself), `brand-foreground` and `brand-subtle`. The link stays sky blue (hue 235 light, 238 dark), 40 degrees from the accent; sRGB can't give turquoise more chroma than the link at text contrast, so hue keeps the two apart. The AI tone stays violet (310). The accent colours the mark and the wordmark on every surface (the admin shell, the marketing header and footer, the favicons and the social image) and the focus ring; buttons stay ink. `packages/design/tests/accent.test.ts` holds AA in both themes (text on the accent, the accent as text, the accent on its tint, the focus ring) and the hue distances; the figures are in `apps/studio/DESIGN.md`.
