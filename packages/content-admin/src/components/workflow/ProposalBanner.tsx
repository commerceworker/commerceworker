/**
 * A proposed workflow graph awaiting the person's decision: what the proposer says it did, what
 * changed (`describeDiff`, layout ignored), and whether it still has problems. Nothing is applied
 * until Apply.
 *
 * Today the copilot ("Draft with AI") feeds it; it is also the seam for the assistant's
 * `propose_workflow_change` proposals (PR 11), which arrive as the same shape. Built on
 * `components/ai/Confirmation.tsx`, so it is the admin's one confirm pattern: focus lands on
 * Dismiss, Escape backs out.
 */

import { Confirmation } from '@commerceworker/content-admin/components/ai/Confirmation';
import { plural } from '@commerceworker/content-admin/lib/format';
import {
  describeDiff,
  type GraphIssue,
  graphDiff,
  type WorkflowGraph,
  type WorkflowGraphChanges,
} from '@commerceworker/domain';

export interface WorkflowProposal {
  graph: WorkflowGraph;
  explanation: string;
  errors: readonly GraphIssue[];
  warnings: readonly GraphIssue[];
  /** Counted against `base` when the proposer didn't say. */
  changes?: WorkflowGraphChanges;
  /** "model" or "heuristic", with why the heuristic answered. */
  provenance?: { source?: string; fallback?: string };
}

export function ProposalBanner({
  proposal,
  base,
  title = 'Apply these changes?',
  note = 'Applying is one edit you can undo; nothing is saved until you save.',
  applyLabel = 'Apply changes',
  busy,
  onApply,
  onDismiss,
  onEscape,
  className,
}: {
  proposal: WorkflowProposal;
  /** The graph the proposal started from (empty for a new workflow). */
  base: WorkflowGraph;
  title?: React.ReactNode;
  note?: React.ReactNode;
  applyLabel?: string;
  busy?: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onEscape?: () => void;
  className?: string;
}) {
  const changes = proposal.changes ?? graphDiff(base, proposal.graph);
  const summary = describeDiff(changes) ?? 'Layout changes only';
  const heuristic = proposal.provenance?.source === 'heuristic';
  return (
    <Confirmation
      title={title}
      note={note}
      applyLabel={applyLabel}
      busy={busy}
      onApply={onApply}
      onDismiss={onDismiss}
      onEscape={onEscape}
      className={className}
      provenance={
        <p className="text-muted-foreground text-xs">
          <span className={heuristic ? 'font-medium text-foreground' : 'font-medium text-ai'}>
            {heuristic ? 'Drafted without the model' : 'Drafted by AI'}
          </span>
          {heuristic && proposal.provenance?.fallback ? ` · ${proposal.provenance.fallback}` : ''}
        </p>
      }
    >
      <div className="space-y-1.5 text-sm">
        {proposal.explanation ? <p className="text-pretty">{proposal.explanation}</p> : null}
        <p className="text-muted-foreground text-xs tabular">
          {summary}
          {proposal.errors.length
            ? ` · ${plural(proposal.errors.length, 'problem')} to fix before publishing`
            : ''}
          {proposal.warnings.length ? ` · ${plural(proposal.warnings.length, 'warning')}` : ''}
        </p>
      </div>
    </Confirmation>
  );
}
