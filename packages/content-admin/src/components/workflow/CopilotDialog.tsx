/**
 * "Draft with AI": describe a workflow (or a change to the one on screen), get the copilot's
 * proposal, and review it in the {@link ProposalBanner} before anything is applied. The route
 * (`POST …/workflows/copilot`) never saves; the caller decides what Apply means (a new draft on the
 * list page, one undoable edit in the editor).
 *
 * The copilot route is called directly; the assistant-driven path arrives with PR 11.
 */

import { useClient } from '@commerceworker/content-admin/lib/client-context';
import { useStoppable } from '@commerceworker/content-admin/lib/use-stoppable';
import type { WorkflowGraph } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { ComposeLoader, composeIcons } from '@commerceworker/ui/compose-loader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { Textarea } from '@commerceworker/ui/textarea';
import { useId, useState } from 'react';
import { ProposalBanner, type WorkflowProposal } from './ProposalBanner';

const EMPTY: WorkflowGraph = { nodes: [], edges: [] };

/** A name from what someone asked for: its first few words. */
export const nameFrom = (prompt: string) => {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 6);
  const s = words.join(' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
};

export function CopilotDialog({
  open,
  onOpenChange,
  graph,
  contentTypes,
  askName = false,
  applyLabel,
  onApply,
  onProposal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The graph being edited (unsaved edits included); omitted to draft a new workflow. */
  graph?: WorkflowGraph;
  contentTypes?: readonly string[];
  /** Ask for a name too (a new workflow). */
  askName?: boolean;
  applyLabel?: string;
  /** Applies the confirmed proposal; the dialog closes when it resolves. */
  onApply?: (proposal: WorkflowProposal, name: string) => Promise<void> | void;
  /**
   * Hands the proposal to the caller instead of reviewing it here (the editor previews it on the
   * canvas under its own {@link ProposalBanner}).
   */
  onProposal?: (proposal: WorkflowProposal) => void;
}) {
  const { client } = useClient();
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<WorkflowProposal | null>(null);
  const promptId = useId();
  const nameId = useId();
  const request = useStoppable();

  const reset = () => {
    setPrompt('');
    setName('');
    setError(null);
    setProposal(null);
  };

  const draft = async () => {
    const signal = request.start();
    setDrafting(true);
    setError(null);
    try {
      const r = await client.workflowCopilot(
        {
          prompt: prompt.trim(),
          ...(graph ? { graph } : {}),
          ...(contentTypes?.length ? { contentTypes } : {}),
        },
        signal,
      );
      if (signal.aborted) return;
      if (onProposal) {
        onProposal(r);
        reset();
        onOpenChange(false);
      } else setProposal(r);
    } catch (e) {
      if (signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal.aborted) setDrafting(false);
    }
  };

  // Closing walks away from a draft under way: the request aborts, so a late proposal can't land
  // after the dialog closed. What was typed and a proposal under review stay for when it opens
  // again; only applying clears them. An apply is a write, so it is waited for.
  const close = () => {
    if (applying) return;
    request.stop();
    setDrafting(false);
    setError(null);
    onOpenChange(false);
  };

  const apply = async () => {
    if (!proposal || !onApply) return;
    setApplying(true);
    setError(null);
    try {
      await onApply(proposal, name.trim() || nameFrom(prompt) || 'New workflow');
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{graph ? 'Change with AI' : 'Draft a workflow with AI'}</DialogTitle>
          <DialogDescription>
            {graph
              ? 'Describe the change. You review what it would do before anything is applied.'
              : 'Describe the steps. You review the draft before it is created, and again before publishing.'}
          </DialogDescription>
        </DialogHeader>
        {proposal ? (
          <ProposalBanner
            proposal={proposal}
            base={graph ?? EMPTY}
            title={graph ? 'Apply these changes?' : 'Create this workflow as a draft?'}
            note={
              graph
                ? 'One edit you can undo; nothing is saved until you save.'
                : 'It is saved as an unpublished draft for you to edit.'
            }
            applyLabel={applyLabel ?? (graph ? 'Apply changes' : 'Create draft')}
            busy={applying}
            onApply={() => void apply()}
            onDismiss={() => setProposal(null)}
            onEscape={close}
          />
        ) : (
          <div className="space-y-4">
            {askName ? (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor={nameId}>Name</Label>
                  <span className="text-muted-foreground text-xs">Optional</span>
                </div>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Legal review for press releases"
                />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={promptId}>What should happen</Label>
              <Textarea
                id={promptId}
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="text-base md:text-sm"
                placeholder="When someone asks to publish, check the entry is valid, ask an editor to approve, then publish it. If it is rejected, comment why."
              />
            </div>
          </div>
        )}
        {error ? <DialogError>{error}</DialogError> : null}
        <p className="sr-only" aria-live="polite">
          {drafting ? 'Drafting the workflow.' : ''}
        </p>
        {proposal ? null : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={drafting || !prompt.trim()}
              onClick={() => void draft()}
            >
              {drafting ? (
                <>
                  <ComposeLoader icon={composeIcons.workflow} />
                  Drafting…
                </>
              ) : (
                'Draft'
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
