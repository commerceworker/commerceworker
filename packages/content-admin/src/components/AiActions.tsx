import { ConfirmButton } from '@commerceworker/content-admin/components/InlineConfirm';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Textarea } from '@commerceworker/ui/textarea';
import { useCallback, useEffect, useState } from 'react';
import type { AIAction, ManagementClient, ModelTier } from '../lib/management';
import { useToast } from '../lib/toast';
import { useStoppable } from '../lib/use-stoppable';

const TIERS: ModelTier[] = ['fast', 'balanced', 'flagship'];

/** Manage reusable AI Actions: create templated prompts, run them, delete. */
export function AiActions(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [actions, setActions] = useState<AIAction[]>([]);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [targetField, setTargetField] = useState('');
  const [tier, setTier] = useState<ModelTier>('balanced');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setActions(await client.listAIActions());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await client.createAIAction({
        name: name.trim(),
        promptTemplate: template,
        targetField: targetField.trim() || undefined,
        tier,
      });
      setName('');
      setTemplate('');
      setTargetField('');
      await load();
      toast.success('AI Action created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Variables the user must fill before a run; field.* variables resolve from
  // a target entry server-side and are never prompted here.
  const promptable = (action: AIAction) => action.variables.filter((v) => !v.startsWith('field.'));

  const [runFor, setRunFor] = useState<{
    action: AIAction;
    values: Record<string, string>;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const runRequest = useStoppable();

  const execute = async (action: AIAction, variables: Record<string, string>) => {
    const signal = runRequest.start();
    setRunning(true);
    try {
      const r = await client.runAIAction(action.id, { variables }, signal);
      if (signal.aborted) return;
      setOutput({ id: action.id, text: r.output });
      setRunFor(null);
    } catch (e) {
      if (signal.aborted) return;
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal.aborted) setRunning(false);
    }
  };

  // A model can hang: closing walks away from a run under way, and its answer is dropped.
  const closeRun = () => {
    runRequest.stop();
    setRunning(false);
    setRunFor(null);
  };

  const run = (action: AIAction) => {
    const vars = promptable(action);
    if (vars.length === 0) {
      void execute(action, {});
      return;
    }
    setRunFor({ action, values: Object.fromEntries(vars.map((v) => [v, ''])) });
  };

  const remove = async (id: string) => {
    try {
      await client.deleteAIAction(id);
      await load();
      toast.success('Deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">New AI Action</h2>
          <p className="text-muted-foreground text-sm">
            A reusable prompt template. Reference values with{' '}
            <code className="text-xs">{'{{variable}}'}</code>; use{' '}
            <code className="text-xs">{'{{field.apiId}}'}</code> to pull from an entry. Set a target
            field to write the result back.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="action-name">Name</Label>
                <Input
                  id="action-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="SEO title"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="action-target">Target field (optional)</Label>
                <Input
                  id="action-target"
                  value={targetField}
                  onChange={(e) => setTargetField(e.target.value)}
                  placeholder="title"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Tier</Label>
                <Select value={tier} onValueChange={(v) => setTier(v as ModelTier)}>
                  <SelectTrigger aria-label="Model tier" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="action-template">Prompt template</Label>
              <Textarea
                id="action-template"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="Write a concise SEO title for: {{field.body}}"
                rows={3}
              />
            </div>
            <Button type="submit" disabled={!name.trim() || !template.trim() || busy}>
              {busy ? 'Creating…' : 'Create action'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {actions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No AI Actions yet.</p>
      ) : (
        <div className="space-y-3">
          {actions.map((a) => (
            <Card key={a.id} size="sm">
              <CardContent className="space-y-2 pt-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{a.name}</span>
                      <Badge variant="outline">{a.tier}</Badge>
                      {a.targetField && <Badge variant="secondary">→ {a.targetField}</Badge>}
                    </div>
                    <p className="mt-1 font-mono text-muted-foreground text-xs">
                      {a.promptTemplate}
                    </p>
                    {a.variables.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {a.variables.map((v) => (
                          <Badge key={v} variant="outline">
                            {v}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={running}
                      onClick={() => run(a)}
                    >
                      Run
                    </Button>
                    <ConfirmButton
                      message={`Delete “${a.name}”?`}
                      note="This can’t be undone."
                      confirmLabel="Delete action"
                      busy={running}
                      onConfirm={() => void remove(a.id)}
                    >
                      {(ask) => (
                        <Button type="button" variant="ghost" size="sm" onClick={ask}>
                          Delete
                        </Button>
                      )}
                    </ConfirmButton>
                  </div>
                </div>
                {output?.id === a.id && (
                  <pre className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">
                    {output.text}
                  </pre>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={runFor !== null} onOpenChange={(o) => !o && closeRun()}>
        <DialogContent className="sm:max-w-md">
          {runFor && (
            <>
              <DialogHeader>
                <DialogTitle>Run “{runFor.action.name}”</DialogTitle>
                <DialogDescription>
                  This action's template needs {Object.keys(runFor.values).length}{' '}
                  {Object.keys(runFor.values).length === 1 ? 'value' : 'values'} before it runs.
                </DialogDescription>
              </DialogHeader>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void execute(runFor.action, runFor.values);
                }}
              >
                {Object.keys(runFor.values).map((v) => (
                  <div key={v} className="space-y-1.5">
                    <Label htmlFor={`action-var-${v}`}>{v}</Label>
                    <Input
                      id={`action-var-${v}`}
                      value={runFor.values[v] ?? ''}
                      onChange={(e) =>
                        setRunFor((s) =>
                          s ? { ...s, values: { ...s.values, [v]: e.target.value } } : s,
                        )
                      }
                    />
                  </div>
                ))}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={closeRun}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={running}>
                    {running ? 'Running…' : 'Run action'}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
