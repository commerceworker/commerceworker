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
import { PenLine } from 'lucide-react';
import { useState } from 'react';
import type { ModelTier } from '../lib/management';
import { useStoppable } from '../lib/use-stoppable';

const TIERS: { value: ModelTier; label: string }[] = [
  { value: 'fast', label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'flagship', label: 'Most capable' },
];

/**
 * Canvas authoring: write or paste free-form prose and let the model map it into
 * this content type's structured fields. The mapped values fill the editor form
 * and still pass the same validators a human write does.
 */
export function CanvasDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentTypeName: string;
  /** Maps the prose into the form; once `signal` aborts, it must leave the form alone. */
  onMap: (prose: string, tier: ModelTier, signal: AbortSignal) => Promise<void>;
}) {
  const [prose, setProse] = useState('');
  const [tier, setTier] = useState<ModelTier>('balanced');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mapping = useStoppable();

  // A late result landing after the dialog closed would silently mutate the form, so closing walks
  // away from a mapping under way: the request aborts and its result is dropped. The prose stays.
  const close = () => {
    mapping.stop();
    setBusy(false);
    props.onOpenChange(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prose.trim()) return;
    const signal = mapping.start();
    setBusy(true);
    setError(undefined);
    try {
      await props.onMap(prose.trim(), tier, signal);
      if (signal.aborted) return;
      props.onOpenChange(false);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => (o ? props.onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="size-4 text-primary" />
            Draft {props.contentTypeName} from prose
          </DialogTitle>
          <DialogDescription>
            Write freely. The model maps your prose into the structured fields, and you can edit
            anything before saving.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="canvas-prose">Prose</Label>
            <Textarea
              id="canvas-prose"
              rows={12}
              placeholder="Paste a draft, notes, or a free-form write-up. Everything that maps to a field will be extracted into it."
              value={prose}
              onChange={(e) => setProse(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="canvas-tier">Model</Label>
            <Select value={tier} onValueChange={(v) => setTier(v as ModelTier)}>
              <SelectTrigger id="canvas-tier" className="w-56">
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
          <p className="sr-only" aria-live="polite">
            {busy ? 'Mapping the text to fields.' : ''}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !prose.trim()}>
              {busy ? (
                <>
                  <ComposeLoader icon={composeSequences.drafting} />
                  Mapping…
                </>
              ) : (
                'Map to fields'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
