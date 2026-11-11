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

**S5 is built**, on the defaults of D3 (staff record a company member's vote, `onBehalfOf`, audited,
until buyers can sign in) and D4 (thresholds are flow logic over `order.baseTotal` and `company.*` or
`buyer.*`, not rule tables), neither yet confirmed by the product owner. What depends on a default
stays in one place: D3 is `onBehalfOf` (the `decide` RPC, `decide_approval`, `decide_approvals` and
the order page's member picker) and `voter_kind`/`on_behalf_by` on `approval_votes`, so a member who
signs in later votes as themselves with the same rows; D4 is that the node's `approvers`, `mode`,
`quorum` and `majorityPercent` are the whole rule (`packages/core/src/b2b/approvals.ts`). Beyond the
plan:

- The Workflow and every step name are unchanged. The Approval wait's `:open` step resolves who may
  vote (the order's company's active members, or the team's people) and the OrderAgent
  (`castVote`) records each vote and sends the one decision event only when
  `evaluateApprovalStatus` says approved or rejected. So every decision, from the order page,
  the inbox, REST, MCP and A2A, is a vote, and there is no route that approves outside the flow.
- `staff:<role>` keeps what every approval was: any one person with the role, first decision
  ends it, `waiting_for` stays `person:<assignee>` and the `assignee` field is still the label.
  Modes other than `any` count the team's non-disabled people with the role (API tokens can vote
  only where nobody is counted).
- Company roles aren't ordered: `company:approver` means members whose role is `approver`, not
  `company_admin`. `team:<id>` includes the teams under it.
- An approval with nobody who can vote (no company, a company that isn't active, an empty team)
  waits for the timeout and takes `escalated`.
- The separation setting also stops a member voting on an order they placed (`meta.buyerId`);
  with it off, they may.
- A vote sent again with the same decision counts once and re-evaluates; a second, different vote
  from the same voter is refused.
- Inbox: company, mode and tally on each row, `companyId` and `approver` filters on the board
  port and as `?company=` and `?approver=` on the page. There is no REST or MCP list of approvals
  (`needs_attention` and the inbox are the reads), so the filters aren't an API yet. Company approvals aren't
  decided inline from the inbox or its batch.

**S6 is built**, on the defaults of D6 (a buyer's PO and the inbound EDI, email and punchout POs are all records; `commerce.generate_po` stays the supplier document) and D7 (a quote reaches an order through a PO draft: `quote_id` is nullable on the PO and left for S7), neither yet confirmed by the product owner. What depends on a default stays in one place: D6 is `PO_SOURCES` (`packages/core/src/b2b/purchase-orders.ts`), `recordInboundPo` and `PurchaseOrderStart`. Beyond the plan:

- A PO's number is unique within its company among POs not cancelled (any case), so a cancelled PO gives its number back. Migration `0073`.
- The engine ties an order to its PO, never the caller's meta: `StartOrderInput.purchaseOrder` is `{ link }` (submitting a PO) or `{ record }` (EDI and email), `fromOutside` drops a `link` from a caller, and `start` strips `meta.purchaseOrderId` from every caller and sets it itself, so the PO an order's progress is mirrored into is never one a caller named. The order is linked before its flow launches.
- Submitting is idempotent by PO id (the start key is `po:<id>`, reserved from REST callers like the other core namespaces); a submit whose order never started finishes on the next try (the card seeds the flow first), a start that races a copy of itself replays instead of being refused, and a link the PO refuses stops the start. A cancel that lands between the submit and the link cancels the order that started after it: `cancelPo` re-reads the PO once it is cancelled and cancels an order the plan didn't know. The submit card lists the lines, what the buyer expects, the ship-to and the buyer.
- The OrderAgent's mirror never throws past its report, wait or cancel: a failure is logged and retried from an alarm (`syncPo`), so `forgetEvents` and the `checkInstance` schedule still run.
- An emailed PO is recorded only when the sender was authenticated (`INTAKE_REQUIRE_AUTH` on); otherwise anyone could write a company's POs.
- Erasing a person blanks the ship-to name and street lines, the notes and the buyer on their companies' POs and those their member rows placed (number, status, lines, city, postcode and country stay); export lists them.
- The PO's status mirror runs in the OrderAgent (`syncPurchaseOrder`, from `report`, `openWait`, `checkInstance` and the cancel), through `poProgressOf` and `syncPoFromOrder`, one lifecycle move at a time. `approved` is passed through when no approval is needed. A declined order is a rejection while the PO waits and a cancellation after. An approval gate that was rejected or timed out doesn't count as cleared (`poProgressOf` reads the node's `approved` branch), so its PO is rejected, never ordered first. A flow with no approval node is `proceeding` from the first report, so its PO is `ordered` while the order validates; a decline at validation then reads as a cancellation.
- An inbound PO follows whatever flow its order routes to: EDI 850s and emailed POs run on the default B2B order flow unless `ORDER_ROUTES` sends `b2b:edi` or the mailbox to `tpl-b2b-purchase-order`. The order carries the record's number as `meta.poNumber` (unless the caller named one), so its invoice shows it, except an emailed PO's provisional one.
- The template's approval threshold is the number in the flow's condition over `order.baseTotal` (D4), `5000` in the base currency; a deployment edits its copy.
- This closes v1's audit gaps for editable draft POs and company-filtered PO lists: only a draft is editable, and every read takes a `scope`.

Left for later:

- Punchout POs aren't recorded: the plugin starts its orders through the plugin host API, and recording would need a manifest capability and a story for a changed PO version that replaces an order.
- An email PO's record keeps its provisional number (`EML-…`) and no lines until a later change amends it from the extract node.
- A PO has no total: the flow prices the order, and the order page has it.
- Company-member access to POs waits for company-bound tokens (D11).
- POs are in subject export and erasure but not the retention sweep (an erased order's PO keeps its words until the person is erased).
- `quote_id` is S7's.

| Slice | Scope | Depends on |
|---|---|---|
| S1 Companies (built) | `companies` (1:1 with a business customer), teams (a tree), members (fixed company roles, an optional per-member order limit), the buyer on an order, creating and editing customers. Lifecycles: company `pending → active ⇄ suspended → closed` (or `rejected`), member `invited → active ⇄ inactive → removed`. `validateOrder` declines orders from inactive companies or buyers. JSON Logic gains `company.*` and `buyer.*` | none |
| S2 Price books (built) | Named books (priority, dates, status) assigned to a company or a tier, entries as price rules, a write path for contract prices. Within the price-book source, the highest-priority assigned book wins, then the lowest price in it. Read in the same single batch | S1 for company assignments |
| S3 Credit ledger (built) | Holds taken by the credit check, guarded so the check and the hold are one batch and no interleaving exceeds a limit. Converted to the charge at invoicing, released on rollback, cancel and order end. Limit editing and adjustments (person-confirmed) | S1 |
| S4 Budgets (built) | Per company and team, per calendar period, `strict` or `advisory`. Spend is a ledger keyed by order and step and summed per window, never a mutable counter. Reversed on rollback | S1 |
| S5 Approvals (built) | `control.approval` gains approvers (`staff:<role>`, `company:<role>`, team, members) and a mode (`any`, `all`, `majority`, `quorum`). Votes are recorded once, and the OrderAgent resumes the wait only once the vote is decided, so the Workflow and its step names are unchanged. Thresholds are flow logic over `company.*`. No route approves outside the flow | S1 |
| S6 Purchase orders (built) | Buyer PO records with editable drafts. Submitting starts an order on a B2B PO flow, and the PO's status follows the order. Inbound EDI and email POs create records too (punchout's is a follow-up) | S1, S3, S4, S5 |
| S7 Quotes | Negotiated, versioned quotes. A `quote` price source with the highest priority, valid only while accepted, unexpired, for its company and within its quantities. Quote to PO draft, or straight to an order | S1, S2, S6 |
| S8 Close | A B2B scenario and docs run, `patterns.md` and `port-map.md` updated, a `hexagonal-guardian` pass, a generated lifecycle reference | all |

### S2 notes

S2 follows D2 and D8: books are in the base currency, and a book is assigned to a `customer_id` (under D1, the
company) or to a `tier`. Beyond the plan: entries in no book (the older `price_book` rules) stay valid and rank
below every book; equal priority and price break by book id, then entry id; the book's dates are checked
against the order's `now`, so a replayed step prices as it did; an agentic checkout's buyer has no customer, so no
assigned book applies to it. `PriceBookStore.forCustomer` takes S1's `scope`. A suspended or closed company's
assigned books still price (pricing isn't access control; `validateOrder` declines the order), but
`assign_price_book` refuses a company that isn't active (taking an assignment away is always allowed).

### S3 notes

- **Ledger.** Holds are a sibling `credit_holds` table, not `balance_entries` kinds: a hold's status moves, the
  ledger's rows never do. `balance_entries` gained `kind` (`charge`, `settle`, `reverse`, `adjust`), `reference`
  and `note`. Migration `0069`.
- **Company status.** `holdCredit` takes no credit for a company that isn't active, and `set_credit_limit`
  refuses a suspended, closed or rejected one. Reads and adjustments (a payment received) still work.
- **Zero limit.** A new business customer's limit is zero; `set_credit_limit` is how it gets one.
- **Left for later.** Credit routes are customer-scoped; company-member access to a credit account waits for company-scoped
  API tokens (D11). An over-limit order that a person approves proceeds with no hold.

### S4 notes

Built on D5 (each budget is `strict` or `advisory`, advisory unless chosen) and D8 (amounts in the base
currency), neither yet confirmed by the product owner.

- **Ledger.** `budget_spend` rows are keyed `bsp_<order>_<step>_<budget>` (a retried step commits once); a
  reversal is a row of its own, `rev_` and the commit's id, of the negated amount in the same window, so a
  window's spend is `sum(amount)` over its rows and a reversed order nets to nothing. Never a counter: a window
  that has passed just stops being asked about (v1's counter never reset). Migration `0071`.
- **Windows.** UTC calendar periods (`budgetWindow`, reusing `advancePeriod`): a week from Monday, a month, a
  quarter from January, April, July or October, a year; `one_time` is one window from its anchor with no end. A
  budget isn't in force before its anchor. The window is read at the step's own clock (`Date.now()` inside the
  step), not the run's start, so an order that waited for an approval counts when it is checked.
- **Which budgets.** The order's customer is the company; a budget with no team is the company's, and a team's
  covers the teams under it, so an order is held to the company's budgets plus its buyer's team's and every team
  above it (`budgetsFor`, `budgetTeamIds`). At most 50 apply to one order, 100 a company.
- **One check, one commit.** `checkBudgets` reads the budgets in force (one statement) and their windows' spend
  (one statement, the pairs in one JSON parameter); `commitBudgetSpend` is one `INSERT … SELECT` that writes every
  line or none, refusing when a strict budget's window has less left than its line, so two orders racing for a
  strict budget take only what fits and an advisory budget is never left recorded for an order a strict one
  refused. The commit is the authority: a strict budget that filled after the read sends the order `over`. A
  retried step asks without its own rows (`spentIn`'s `except`) so a budget its own spend filled doesn't refuse it.
- **Node.** `commerce.budget_check` gains `source` (`node`, the default, which is today's behaviour exactly, or
  `company`) and `commit`. The node is `rollback: true` with a `ROLLBACKS` entry that reverses the order's
  commits; `compensateOrder` reverses them for a cancel; a Workflow that ends declined or cancelled reverses them in
  its own `<end key>:budgets` step, only when the flow has a committing budget check, so no published flow's step
  names change.
- **Immutable.** A budget's company, team, period and start can't change once it exists (the ledger counts in
  them); name, amount and enforcement can. Archiving is final.
- **Left for later.** The ledger lists commits with whether each was reversed; it has no manual adjustment (no
  one gives spend back by hand). Budgets are per company and team only; a member's own limit is S5's.
  Approving an over-budget order by a person (`over` into an approval) is flow logic: S5 adds the approvers.

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
