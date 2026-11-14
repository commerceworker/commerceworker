import {
  DiscardAsk,
  GuardCancel,
  useDiscardGuard,
} from '@commerceworker/content-admin/components/discard-guard';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
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
import { useState } from 'react';
import { WEBHOOK_TOPICS, type WebhookSummary, type WebhookTopic } from '../lib/management';

/** Edit a webhook's endpoint, topics, secret, active state and which environments it hears. */
export function WebhookDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  webhook: WebhookSummary;
  onSave: (changes: {
    url: string;
    topics: WebhookTopic[];
    active: boolean;
    secret?: string;
    allEnvironments?: boolean;
  }) => Promise<void>;
}) {
  const [url, setUrl] = useState(props.webhook.url);
  const [topics, setTopics] = useState<WebhookTopic[]>([...props.webhook.topics]);
  const [active, setActive] = useState(props.webhook.active);
  const wasEverywhere = props.webhook.environmentId === null;
  const [everywhere, setEverywhere] = useState(wasEverywhere);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const guard = useDiscardGuard({
    saving: busy,
    open: props.open,
    dirty:
      url !== props.webhook.url ||
      secret !== '' ||
      active !== props.webhook.active ||
      everywhere !== wasEverywhere ||
      topics.length !== props.webhook.topics.length ||
      topics.some((t) => !props.webhook.topics.includes(t)),
    onOpenChange: props.onOpenChange,
  });

  const toggleTopic = (t: WebhookTopic) =>
    setTopics((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || topics.length === 0) {
      setError('A URL and at least one topic are required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // secret is write-only and never returned — only send it when changed.
      await props.onSave({
        url: url.trim(),
        topics,
        active,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        // Only a change of scope is sent: unticking scopes it to the environment being viewed.
        ...(everywhere !== wasEverywhere ? { allEnvironments: everywhere } : {}),
      });
      props.onOpenChange(false);
    } catch (err) {
      setError(guard.saveFailed(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit webhook</DialogTitle>
          <DialogDescription>Change the endpoint, topics, or signing secret.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wh-url">Endpoint URL</Label>
            <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wh-secret">Signing secret</Label>
            <Input
              id="wh-secret"
              type="password"
              placeholder="leave blank to keep the current secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Topics</span>
            <div className="flex flex-wrap gap-4">
              {WEBHOOK_TOPICS.map((t) => (
                <Label key={t} className="flex items-center gap-2 font-normal">
                  {/* A wrapping label does not name a <button role="checkbox">;
                      see the note in Settings.tsx. */}
                  <Checkbox
                    aria-label={t}
                    checked={topics.includes(t)}
                    onCheckedChange={() => toggleTopic(t)}
                  />
                  <span>{t}</span>
                </Label>
              ))}
            </div>
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              aria-label="Active (deliver events)"
              checked={active}
              onCheckedChange={(c) => setActive(c === true)}
            />
            <span>Active (deliver events)</span>
          </Label>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              aria-label="Send events from every environment"
              checked={everywhere}
              onCheckedChange={(c) => setEverywhere(c === true)}
            />
            <span>Send events from every environment</span>
          </Label>

          {error && <DialogError>{error}</DialogError>}

          <DialogFooter>
            <DiscardAsk guard={guard} message="Discard your changes to this webhook?">
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save changes'}
              </Button>
            </DiscardAsk>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
