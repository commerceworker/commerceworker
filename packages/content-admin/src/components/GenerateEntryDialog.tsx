import {
  Confirmation,
  ProposedValue,
} from '@commerceworker/content-admin/components/ai/Confirmation';
import { Suggestion, Suggestions } from '@commerceworker/content-admin/components/ai/Suggestion';
import { Task, TaskItem } from '@commerceworker/content-admin/components/ai/Task';
import type { ContentType, EntryFields } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { ComposeLoader, composeSequences } from '@commerceworker/ui/compose-loader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Label } from '@commerceworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Textarea } from '@commerceworker/ui/textarea';
import { useRef, useState } from 'react';
import type { GeneratedDraft, ModelTier } from '../lib/management';
import { useStoppable } from '../lib/use-stoppable';

// Tiers, not models: the provider adapter maps tier → model, and the provider
// is swappable (AI_PROVIDER), so naming a model here would be wrong elsewhere.
const TIERS: { value: ModelTier; label: string }[] = [
  { value: 'fast', label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'flagship', label: 'Most capable' },
];

/** Prompt starters: they fill the prompt for editing, never submit on their own. */
const STARTERS = [
  'A short announcement of ',
  'A beginner-friendly explainer on ',
  'A concise summary of ',
];

function previewOf(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

/**
 * Prompts the model to draft this content type's fields, then shows the draft
 * as a reviewable proposal: which fields it filled, with what, from which
 * prompt and model. Nothing touches the editor form until the editor applies
 * it — "AI earns trust through review" — and applied values still pass the
 * same validators a human write does.
 */
export function GenerateEntryDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentType: ContentType;
  /** Runs the generation and returns the draft; must not touch the form. */
  onGenerate: (prompt: string, tier: ModelTier, signal: AbortSignal) => Promise<GeneratedDraft>;
  /** Merges the reviewed draft into the editor form (unsaved). */
  onApply: (fields: EntryFields) => void;
}) {
  const { contentType } = props;
  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState<ModelTier>('balanced');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<{ result: GeneratedDraft; prompt: string; tier: ModelTier }>();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const generation = useStoppable();

  const fieldName = (apiId: string) =>
    contentType.fields.find((f) => f.apiId === apiId)?.name ?? apiId;

  // A closed dialog has nowhere to review a result, so closing walks away from a generation under
  // way: the request aborts and a late answer is dropped. The prompt and a draft under review stay
  // for when it opens again, so no way out loses work; only Discard and Apply clear a draft.
  const close = () => {
    generation.stop();
    setBusy(false);
    setError(undefined);
    props.onOpenChange(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    const signal = generation.start();
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.onGenerate(prompt.trim(), tier, signal);
      if (signal.aborted) return;
      setDraft({ result, prompt: prompt.trim(), tier });
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  const apply = () => {
    if (!draft) return;
    props.onApply(draft.result.fields);
    setDraft(undefined);
    setPrompt('');
    close();
  };

  // Discard keeps the prompt so it can be refined and re-run.
  const discard = () => {
    setDraft(undefined);
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const applyStarter = (text: string) => {
    setPrompt(text);
    requestAnimationFrame(() => {
      const el = promptRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const values = draft
    ? Object.entries(draft.result.fields).flatMap(([apiId, byLocale]) =>
        Object.entries(byLocale ?? {}).map(([locale, value]) => ({
          key: `${apiId}:${locale}`,
          label: `${fieldName(apiId)} (${locale})`,
          preview: previewOf(value),
        })),
      )
    : [];
  const fieldCount = draft ? Object.keys(draft.result.fields).length : 0;
  const tokens = draft ? draft.result.usage.inputTokens + draft.result.usage.outputTokens : 0;

  return (
    <Dialog open={props.open} onOpenChange={(o) => (o ? props.onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate {contentType.name} draft</DialogTitle>
          <DialogDescription>
            {draft
              ? 'Review the drafted fields. Nothing changes in the form until you apply them.'
              : 'Describe what to write. You review the draft before anything fills the form.'}
          </DialogDescription>
        </DialogHeader>

        {draft ? (
          <Confirmation
            title={`Apply ${fieldCount} drafted ${fieldCount === 1 ? 'field' : 'fields'}?`}
            note="Fills the form; nothing is saved until you save the draft."
            applyLabel="Apply to form"
            dismissLabel="Discard"
            onApply={apply}
            onDismiss={discard}
            onEscape={close}
            provenance={
              <Task
                title={`Generated by ${TIERS.find((t) => t.value === draft.tier)?.label ?? draft.tier}`}
                meta={`${tokens.toLocaleString()} tokens`}
              >
                <TaskItem>Prompt: “{draft.prompt}”</TaskItem>
                <TaskItem>Read the {contentType.name} field definitions</TaskItem>
                <TaskItem>
                  Drafted {fieldCount} {fieldCount === 1 ? 'field' : 'fields'}; validation runs when
                  you save
                </TaskItem>
              </Task>
            }
          >
            {values.length === 0 ? (
              <p className="text-muted-foreground text-sm">The model returned no field values.</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {values.map((v) => (
                  <ProposedValue key={v.key} label={v.label}>
                    {v.preview}
                  </ProposedValue>
                ))}
              </div>
            )}
          </Confirmation>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="gen-prompt">Prompt</Label>
              <Textarea
                ref={promptRef}
                id="gen-prompt"
                rows={5}
                placeholder="e.g. A launch announcement for our new realtime sync feature, upbeat and concise."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              {!prompt.trim() && (
                <Suggestions label="Prompt starters" className="pt-1">
                  {STARTERS.map((s) => (
                    <Suggestion key={s} suggestion={s} onClick={applyStarter} />
                  ))}
                </Suggestions>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gen-tier">Model</Label>
              <Select value={tier} onValueChange={(v) => setTier(v as ModelTier)}>
                <SelectTrigger id="gen-tier" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIERS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {error && <DialogError>{error}</DialogError>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !prompt.trim()}>
                {busy ? (
                  <>
                    <ComposeLoader icon={composeSequences.drafting} />
                    Generating…
                  </>
                ) : (
                  'Generate draft'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
