/**
 * A pending agent proposal awaiting a human decision — the persisted half of
 * the human-in-the-loop gate. A workflow that ends `needs_review` creates one
 * of these carrying the proposed field values; a reviewer approves (the values
 * are applied as a new draft version) or rejects it. On durable runtimes a
 * detached review-watcher workflow waits for the decision as a signal/event;
 * everywhere else the decision use-case applies directly. `awaiting` records
 * whether a watcher is armed; `appliedAt` is the exactly-once apply marker
 * (whichever path wins the CAS applies, the other skips).
 */

import type { EntryFields } from '../types';

export type AgentReviewStatus = 'pending' | 'approved' | 'rejected';

export interface AgentReview {
  readonly id: string;
  /** Workflow that produced the proposal (enrich | curate | repurpose). */
  readonly workflow: string;
  readonly entryId: string;
  /** Proposed field values (locale-keyed), applied on approval. */
  readonly proposed: EntryFields;
  /** The agent's reasoning notes — context for the reviewer. */
  readonly notes: readonly string[];
  readonly status: AgentReviewStatus;
  /** True while a durable review-watcher workflow is armed for this review. */
  readonly awaiting: boolean;
  readonly createdAt: string;
  readonly decidedAt?: string;
  /** Reviewer identity (principal name/id) when known. */
  readonly decidedBy?: string;
  /** Set exactly once by whichever path applied the proposal. */
  readonly appliedAt?: string;
}
