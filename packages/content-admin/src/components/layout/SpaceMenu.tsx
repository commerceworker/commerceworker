import { Link } from '@commerceworker/content-admin/router';
import { Button } from '@commerceworker/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { cn } from '@commerceworker/ui/lib/utils';
import { Check, Layers, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { useClient } from '../../lib/client-context';
import type { SpaceRef } from '../../lib/management';
import { CreateSpaceDialog } from './CreateSpaceDialog';

/**
 * Space switcher: lists the spaces this person can reach (a deployment admin → all, a
 * member → their own), switches on select, and provisions new ones (admin only).
 * Switching resets the environment to "main" since branches are per-space.
 */
export function SpaceMenu() {
  const { conn, updateConn, spaces: reachable } = useClient();
  const spaces: readonly SpaceRef[] = reachable?.length
    ? reachable
    : [{ id: conn.space, name: conn.space }];
  const [createOpen, setCreateOpen] = useState(false);

  const switchSpace = (id: string) => {
    if (id !== conn.space) updateConn({ space: id, environment: 'main' });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" title="Switch space">
            <Layers className="size-4 text-muted-foreground" />
            <span className="font-medium">{conn.space || 'no space'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Spaces</DropdownMenuLabel>
          {spaces.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onClick={() => switchSpace(s.id)}
              className="justify-between"
            >
              <span className="flex flex-col">
                <span>{s.name}</span>
                {s.name !== s.id && <span className="text-xs text-muted-foreground">{s.id}</span>}
              </span>
              <Check className={cn('size-4', s.id === conn.space ? 'opacity-100' : 'opacity-0')} />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New space…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings/team">
              <Settings className="size-4" /> Space access
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateSpaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => updateConn({ space: id, environment: 'main' })}
      />
    </>
  );
}
