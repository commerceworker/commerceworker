# B2B core (ROADMAP P5): the plan

How P5 is built, slice by slice, and the product decisions it rests on. Unpublished maintainer
doc; the workspace-facing guides are in `apps/docs`. Each slice is one PR in dependency order.

## Starting point

What exists and is reused:

- **Business customers**: `customers.kind`, `tier`, `credit_limit`, `balance` and `terms`.
- **Receivables ledger**: the balances port (`balance_entries`). It charges once per order and
  step, then settles or reverses once. Its pattern is copied for the credit and budget ledgers.
- **Checks**: core `creditCheck` and `budgetCheck`, with their nodes.
- **Price chain**: `price_book`, `contract` and `volume`, read in one D1 batch (`priceInputs`).
- **Approvals**: `control.approval` waits, the approver role, separation of duties, the approvals
  inbox's keyset cursor.
- **Lifecycle reference**: the tax certificate slice, from port to REST.
- **Flow templates**: procurement and B2B order.

What is missing, or isn't what its name suggests:

- Companies, members, teams and company roles.
- Named price books and assignments.
- Any write path for customers, credit limits, contract prices or price rules. Today they exist
  only as seed SQL.
- Negotiated quotes. A cart's quote is only a pricing snapshot.
- Buyer purchase orders. `commerce.generate_po` is a supplier document.
- Credit holds. `commerce.credit_check` reads a balance that moves only at invoicing, so two orders
  checked at once can together exceed a limit.
- Budgets as data with periods and spend.
- Approval voting modes and company approvers.

## Rules every slice follows

- **Layering**: the pricing slice pattern.
  - Core holds the rules and lifecycle.
  - The port takes plain records.
  - The D1 store is a `@commerceworker/db` subpath.
  - The in-memory store and contract live in `packages/test-kit`, and the contract runs against
    both stores.
  - Use-cases take ports and `now`.
  - Adapters bind only in the composition roots.
- **Lifecycles**: one core helper (`defineLifecycle`). Every store transition is one
  compare-and-set (`UPDATE … WHERE id=? AND status=?`), and the contract proves two racing
  transitions from the same state produce exactly one winner.
- **Lists**: keyset cursors, a total, sort and filter. Every read takes a
  `scope: { companyId } | { all: true }`, so company filtering can't be forgotten. That closes
  v1's cross-company access class. Each new read is snapshotted in `query-counts.json`.
- **D1**: chunk bulk writes under 100 bound parameters, and no writes on read paths.
- **REST and MCP**: every operation is a twin (`ASSISTANT_TOOLS`, `REST_OPERATIONS`), held by the
  parity and coverage tests. Anything that changes what a buyer pays or owes is in
  `PERSON_CONFIRMS_TOOLS`.
- **Personal data**: company members are personal data, covered by subject export and erasure and
  by the retention sweep.

## Slices

**S1 is built**, on the defaults of D1 (the business customer is the company), D9 (fixed roles
`buyer`, `approver`, `company_admin`) and D11 (no company-bound tokens), none yet confirmed by the product
owner. What depends on a default stays in one place: D1 is `hasCompany` and `COMPANY_CUSTOMER_KIND`
(`packages/core/src/b2b/companies.ts`) and the 1:1 key of `companies`; D9 is `COMPANY_ROLES` and its
labels; D11 is that every read takes a `scope`, so a token bound to a company could be added later.
Beyond the plan: a member's order limit is data (`buyer.orderLimit`), not enforced by `validateOrder`, since
a limit that approves rather than declines is S5's; and the member email's uniqueness holds among members
not removed, so a removed member's row stays for the orders they placed and the same email can be added
again.

| Slice | Scope | Depends on |
|---|---|---|
| S1 Companies (built) | `companies` (1:1 with a business customer), teams (a tree), members (fixed company roles, an optional per-member order limit), the buyer on an order, creating and editing customers. Lifecycles: company `pending → active ⇄ suspended → closed` (or `rejected`), member `invited → active ⇄ inactive → removed`. `validateOrder` declines orders from inactive companies or buyers. JSON Logic gains `company.*` and `buyer.*` | none |
| S2 Price books | Named books (priority, dates, status) assigned to a company or a tier, entries as price rules, a write path for contract prices. Within the price-book source, the highest-priority assigned book wins, then the lowest price in it. Read in the same single batch | S1 for company assignments |
| S3 Credit ledger (built) | Holds taken by the credit check, guarded so the check and the hold are one batch and no interleaving exceeds a limit. Converted to the charge at invoicing, released on rollback, cancel and order end. Limit editing and adjustments (person-confirmed) | S1 |
| S4 Budgets | Per company and team, per calendar period, `strict` or `advisory`. Spend is a ledger keyed by order and step and summed per window, never a mutable counter. Reversed on rollback | S1 |
| S5 Approvals | `control.approval` gains approvers (`staff:<role>`, `company:<role>`, team, members) and a mode (`any`, `all`, `majority`, `quorum`). Votes are recorded once, and the OrderAgent resumes the wait only once the vote is decided, so the Workflow and its step names are unchanged. Thresholds are flow logic over `company.*`. No route approves outside the flow | S1 |
| S6 Purchase orders | Buyer PO records with editable drafts. Submitting starts an order on a B2B PO flow, and the PO's status follows the order. Inbound EDI, email and punchout POs create records too | S1, S3, S4, S5 |
| S7 Quotes | Negotiated, versioned quotes. A `quote` price source with the highest priority, valid only while accepted, unexpired, for its company and within its quantities. Quote to PO draft, or straight to an order | S1, S2, S6 |
| S8 Close | A B2B scenario and docs run, `patterns.md` and `port-map.md` updated, a `hexagonal-guardian` pass, a generated lifecycle reference | all |

### S3 notes

- **Ledger.** Holds are a sibling `credit_holds` table, not `balance_entries` kinds: a hold's status moves, the
  ledger's rows never do. `balance_entries` gained `kind` (`charge`, `settle`, `reverse`, `adjust`), `reference`
  and `note`. Migration `0069`.
- **Company status.** `holdCredit` takes no credit for a company that isn't active, and `set_credit_limit`
  refuses a suspended, closed or rejected one. Reads and adjustments (a payment received) still work.
- **Zero limit.** A new business customer's limit is zero; `set_credit_limit` is how it gets one.
- **Left for later.** Credit routes are customer-scoped; company-member access to a credit account waits for company-scoped
  API tokens (D11). An over-limit order that a person approves proceeds with no hold.

After S1 there are three parallel streams: S2; S3; and S4 followed by S5. S6 follows S3, S4 and
S5, and S7 follows S2 and S6.

## Decisions

Recommended defaults, built on where a slice needs them. The product owner confirms or changes
each.

| # | Decision | Default | Blocks |
|---|---|---|---|
| D1 | Is a company a new entity above customers, or is the business customer the company? | The business customer is the company (1:1 `companies` plus members), so nothing keyed by `customer_id` moves | S1 |
| D2 | When several price books apply, does priority or price win? | The highest-priority assigned book wins, then the lowest price within it | S2 |
| D3 | Who decides company approvals before buyers can sign in? | Staff record a member's vote (`onBehalfOf`, audited) | S5 |
| D4 | Are approval rules data tables or flow logic? | Flow logic | S5 |
| D5 | Is enforcement blocking or advisory? | Credit blocks, with a hold. Budgets are per budget, advisory by default | S3, S4 |
| D6 | What counts as a purchase order? | Buyer POs and inbound EDI, email and punchout POs. `generate_po` stays the supplier document | S6 |
| D7 | Does a quote go to an order directly? | Through a PO draft when the company uses POs | S7 |
| D8 | What currency are books, quotes and budgets in? | The base currency | S2, S4, S7 |
| D9 | Are company roles fixed or custom? | Fixed: `buyer`, `approver`, `company_admin` | S1 |
| D10 | What is cut from P5? | Projects and jobs, requisition lists, approval groups | none |
| D11 | Do company-bound API tokens come in P5? | Not in P5; ports take `scope`, so they can be added later | none |

## Lifted from v1, and fixed

- **Statuses**: v1's company, PO and quote statuses.
- **Price-book resolver**: v1 ignored tiers and currency, ranked inconsistently and ran one query
  per product.
- **Credit enforcement**: v1 checked and charged separately, so two orders could race past a limit,
  and never used its idempotency key.
- **Budget enforcement**: v1 kept a mutable spend counter that never reset per period, and had no
  reversal.
- **Approval evaluation**: ported as a pure core function, with v1's identity and majority bugs
  fixed. v1's direct-approve route bypassed the rules; there is no such route here.
- **Purchase orders and quotes**: v1's status changes were unguarded.
- **Audit gaps closed**: paged, company-filtered lists, and editable draft POs.
