import { Button } from '@commerceworker/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { cn } from '@commerceworker/ui/lib/utils';
import { Check, GitBranch, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient } from '../../lib/client-context';
import type { Environment } from '../../lib/management';

/** Branch switcher: lists the space's environments, switches on select, and
 * creates new ones. Switching re-memoizes the client → the app loads that branch. */
export function EnvironmentSwitcher() {
  const { conn, updateConn, client } = useClient();
  const [envs, setEnvs] = useState<Environment[]>([
    { id: conn.environment, name: conn.environment },
  ]);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let live = true;
    client
      .listEnvironments()
      .then((e) => {
        if (!live) return;
        setEnvs(e.length ? e : [{ id: conn.environment, name: conn.environment }]);
      })
      .catch(() => live && setEnvs([{ id: conn.environment, name: conn.environment }]));
    return () => {
      live = false;
    };
  }, [client, conn.environment]);

  const switchEnv = (id: string) => {
    if (id !== conn.environment) updateConn({ environment: id });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" title="Switch environment">
            <GitBranch className="size-4 text-muted-foreground" />
            <span className="font-medium">{conn.environment}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Environments</DropdownMenuLabel>
          {envs.map((e) => (
            <DropdownMenuItem
              key={e.id}
              onClick={() => switchEnv(e.id)}
              className="justify-between"
            >
              <span className="flex flex-col">
                <span>{e.id}</span>
                {e.name !== e.id && <span className="text-xs text-muted-foreground">{e.name}</span>}
              </span>
              <Check
                className={cn('size-4', e.id === conn.environment ? 'opacity-100' : 'opacity-0')}
              />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New environment…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateEnvironmentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => updateConn({ environment: id })}
      />
    </>
  );
}

function CreateEnvironmentDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { client } = useClient();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const envId = id.trim();
    if (!envId) {
      setError('An environment ID is required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await client.createEnvironment({ id: envId, name: name.trim() || undefined });
      props.onCreated(envId);
      props.onOpenChange(false);
      setId('');
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New environment</DialogTitle>
          <DialogDescription>
            Create a branch of this space. New environments start empty; switching to one scopes the
            whole admin to it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="env-id">ID</Label>
            <Input
              id="env-id"
              value={id}
              placeholder="staging"
              className="font-mono"
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="env-name">Name (optional)</Label>
            <Input
              id="env-name"
              value={name}
              placeholder="Staging"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create & switch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
