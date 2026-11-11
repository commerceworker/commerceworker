/**
 * Every status lifecycle in core (`defineLifecycle`), listed once so the docs' reference page and
 * the lifecycle tests read one list. A new `defineLifecycle` is added here: a test scans core's
 * sources and fails for one that isn't.
 */
import { BUDGET_LIFECYCLE, BUDGET_STATUS_LABELS, SPEND_LIFECYCLE } from './b2b/budgets';
import {
  COMPANY_LIFECYCLE,
  COMPANY_STATUS_LABELS,
  MEMBER_LIFECYCLE,
  MEMBER_STATUS_LABELS,
} from './b2b/companies';
import { PO_LIFECYCLE, PO_STATUS_LABELS } from './b2b/purchase-orders';
import { QUOTE_LIFECYCLE, QUOTE_STATUS_LABELS } from './b2b/quotes';
import { CREDIT_HOLD } from './credit';
import type { Lifecycle } from './lifecycle';
import { PRICE_BOOK_LIFECYCLE } from './price-books';

export interface LifecycleDoc {
  readonly id: string;
  readonly title: string;
  /** What the status belongs to and what its moves mean, in a sentence. */
  readonly about: string;
  /** Where a new one starts. */
  readonly start: string;
  readonly lifecycle: Lifecycle<string>;
  /** A state's display label, where the product shows one; the state's own name otherwise. */
  readonly labels?: Readonly<Record<string, string>>;
}

export const LIFECYCLES: readonly LifecycleDoc[] = [
  {
    id: 'company',
    title: 'Company',
    about:
      'A business customer’s company account: approved or rejected once, suspended and reinstated, closed for good.',
    start: 'pending',
    lifecycle: COMPANY_LIFECYCLE,
    labels: COMPANY_STATUS_LABELS,
  },
  {
    id: 'member',
    title: 'Company member',
    about:
      'A person who buys for a company. A removed member stays on record for the orders they placed.',
    start: 'invited',
    lifecycle: MEMBER_LIFECYCLE,
    labels: MEMBER_STATUS_LABELS,
  },
  {
    id: 'price-book',
    title: 'Price book',
    about:
      'A named list of prices assigned to companies or tiers. It prices nothing until it is active; archiving is final.',
    start: 'draft',
    lifecycle: PRICE_BOOK_LIFECYCLE,
  },
  {
    id: 'credit-hold',
    title: 'Credit hold',
    about:
      'What an open order claims of a customer’s credit limit: held until invoicing charges it, or it is given back.',
    start: 'held',
    lifecycle: CREDIT_HOLD,
  },
  {
    id: 'budget',
    title: 'Budget',
    about:
      'A company’s or team’s spending limit per period. Pause and resume freely; archiving is final and keeps the spend on record.',
    start: 'active',
    lifecycle: BUDGET_LIFECYCLE,
    labels: BUDGET_STATUS_LABELS,
  },
  {
    id: 'budget-spend',
    title: 'Budget spend',
    about:
      'One order’s commit against a budget’s window. The ledger never edits a row: a reversal is a row of its own, and the commit reads as reversed once it exists.',
    start: 'committed',
    lifecycle: SPEND_LIFECYCLE,
  },
  {
    id: 'purchase-order',
    title: 'Purchase order',
    about:
      'A buyer’s PO. A draft is submitted, which starts its order; from then on the order’s progress is the PO’s.',
    start: 'draft',
    lifecycle: PO_LIFECYCLE,
    labels: PO_STATUS_LABELS,
  },
  {
    id: 'quote',
    title: 'Quote',
    about:
      'A negotiated, versioned price offer. An accepted quote is a deal: it prices the company’s orders until it expires or is ended, and is never edited or revised.',
    start: 'draft',
    lifecycle: QUOTE_LIFECYCLE,
    labels: QUOTE_STATUS_LABELS,
  },
];
