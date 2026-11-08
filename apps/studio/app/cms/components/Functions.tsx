import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import { Catalog, CatalogRow, CatalogTile } from '@commerceworker/ui/catalog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import type { FunctionDefinition, ManagementClient } from '../lib/management';
import { useToast } from '../lib/toast';

/** Manage user-defined functions: HTTP endpoints invoked on matching events. */
export function Functions(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [fns, setFns] = useState<FunctionDefinition[]>([]);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('entry.*');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setFns(await client.listFunctions());
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
      await client.createFunction({
        name: name.trim(),
        eventPattern: pattern.trim(),
        url: url.trim(),
      });
      setName('');
      setUrl('');
      await load();
      toast.success('Function registered');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await client.deleteFunction(id);
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
          <h2 className="font-heading font-medium text-base">New function</h2>
          <p className="text-muted-foreground text-sm">
            An HTTP endpoint invoked with the event payload whenever an event matches the pattern (
            <code className="text-xs">*</code>, <code className="text-xs">entry.*</code>, or an
            exact type like <code className="text-xs">entry.published</code>).
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="fn-name">Name</Label>
              <Input
                id="fn-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="reindex-search"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fn-pattern">Event pattern</Label>
              <Input
                id="fn-pattern"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="fn-url">URL</Label>
              <Input
                id="fn-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/on-event"
              />
            </div>
            <Button type="submit" disabled={!name.trim() || !url.trim() || busy}>
              {busy ? 'Saving…' : 'Register'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {fns.length === 0 ? (
        <p className="text-muted-foreground text-sm">No functions registered.</p>
      ) : (
        <div className="card overflow-clip">
          <Catalog aria-label="Functions">
            {fns.map((f) => (
              <CatalogRow
                key={f.id}
                media={
                  <CatalogTile>
                    <Zap aria-hidden="true" />
                  </CatalogTile>
                }
                title={f.name}
                meta={
                  <span className="flex flex-wrap gap-x-2">
                    <span>
                      On <span className="font-mono">{f.eventPattern}</span>
                    </span>
                    <span className="break-all font-mono">{f.url}</span>
                  </span>
                }
                actions={
                  <ConfirmButton
                    message={`Delete “${f.name}”?`}
                    note="It stops receiving events. This can’t be undone."
                    confirmLabel="Delete function"
                    onConfirm={() => void remove(f.id)}
                  >
                    {(ask) => (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        aria-label={`Delete “${f.name}”`}
                        onClick={ask}
                      >
                        Delete
                      </Button>
                    )}
                  </ConfirmButton>
                }
              />
            ))}
          </Catalog>
        </div>
      )}
    </div>
  );
}
