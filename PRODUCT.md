# Product

## Register

product

## Users

**Order and sales operations first.** These are the people who work approvals, quotes, purchase orders and exceptions in the live order view for hours at a stretch. They are not necessarily technical. The Order Flow state (waiting, approved, rolled back, failed) must read clearly without the docs.

**Engineers second.** They model flows, wire channels (storefront, Shopify, EDI 850, email intake), connect API tokens, MCP clients and A2A agents, and install plugins. They visit the same admin in shorter, tool-shaped sessions, and they judge the product by its API reference.

**Buyers' approvers third.** People at a seller's B2B customers who approve a requisition or a purchase order, occasionally and under time pressure. Their screens explain themselves.

Context: a browser tab that stays open all day, beside the storefront or ERP. The admin also runs on iPad and iPhone, in a tab or from the Home Screen. A phone is for keeping up and deciding (overview, approvals, orders, quick actions); the flow editor is review-only below `lg`.

## Product Purpose

The admin for CommerceWorker: API-first, agent-first commerce infrastructure on Cloudflare. It is the human surface over the same engine the REST API, MCP, UCP and A2A call: catalog, pricing, promotions, carts, checkout, inventory, payments, B2B, and the Order Flows that run every order. Success is an operator resolving an order exception, or approving a purchase order, quickly and with confidence, and trusting what an agent did on their behalf.

## Brand Personality

Infrastructure-grade, calm, precise: a well-written runbook. Dense but legible, keyboard-friendly, nothing decorative. Say what a thing does and what will happen on click. Errors name the violated constraint, give the values, and name the next action. No enthusiasm, no reassurance, no apology. Positioning and voice are in `docs/brand/`.

## Anti-references

- **Legacy commerce admin:** nested tab hierarchies, twelve-field filter bars, settings four levels deep.
- **Generic SaaS landing energy:** gradient heroes, hero-metric rows, three identical feature cards.
- **Consumer playfulness:** mascots, celebratory motion, emoji.
- **AI-everything clutter:** sparkle icons and "AI" buttons on every surface. Agent output arrives as reviewable proposals with provenance.
- **Unthemed shadcn grey,** which reads as a template. The look is Ledger, with CommerceWorker's own accent.

## Design Principles

1. **The order is the interface.** Chrome recedes. The Order Flow, its waits and its money carry the visual weight.
2. **State is always legible.** Waiting, approved, rolled back, failed, paid, refunded: nobody should wonder what will happen next.
3. **Confirmation proportional to blast radius.** Editing a draft flow is instant. Cancelling a paid order, refunding, or publishing a flow every new order pins asks first.
4. **Agents earn trust through review.** Assistant actions show a confirm card; flow changes come back as proposals.
5. **One system, no snowflakes.** New surfaces compose Ledger tokens and `packages/ui`.

## Accessibility & Inclusion

WCAG 2.2 AA: body text at least 4.5:1 in both themes (placeholder and muted text included), full keyboard paths through tables, dialogs and the flow editor, visible focus, `prefers-reduced-motion` alternatives, and touch targets of at least 44px. Status is never conveyed by color alone. Layouts survive translation and multiple currencies.
