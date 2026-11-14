import { Link, matchPath, useLocation } from '@commerceworker/content-admin/router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { cn } from '@commerceworker/ui/lib/utils';
import { Plus } from 'lucide-react';
import { useContentTypesQuery } from '../../lib/queries';

/**
 * "New entry", the header's primary create action. An entry needs a content type: on a
 * content type's pages it is a link straight to that type's new entry; anywhere else it opens a
 * menu of the space's content types (or says there are none yet, with the way to make one).
 *
 * `look`: `header` is the header's pill (ink, or an outline on Approvals and Workflows, where
 * deciding and building come first); `float` is a phone's floating pill above the tab bar.
 */
export function NewEntry({ look, quiet }: { look: 'header' | 'float'; quiet?: boolean }) {
  const { pathname } = useLocation();
  const typeId = matchPath('/content/:typeId/*', pathname)?.params.typeId;
  const types = useContentTypesQuery().data;
  // On a singleton's pages there is no second entry to make: the menu of every type instead.
  const onType =
    typeId && typeId !== 'new' && !types?.find((t) => t.apiId === typeId)?.singleton
      ? typeId
      : undefined;

  const className =
    look === 'header'
      ? cn(
          'hit-area inline-flex h-8 items-center justify-center gap-1.5 rounded-4xl px-3 font-medium text-ui transition-[color,background-color,border-color]',
          quiet
            ? 'border border-input bg-input/30 text-foreground hover:bg-input/50'
            : 'bg-primary text-primary-foreground hover:bg-primary/90',
        )
      : 'fixed right-[max(1rem,var(--safe-right))] bottom-[calc(var(--tabbar-h)+0.75rem)] z-30 inline-flex h-11 items-center gap-1.5 rounded-4xl bg-primary pr-4.5 pl-4 font-medium text-primary-foreground text-sm shadow-float md:hidden';
  const icon = <Plus className={look === 'header' ? 'size-3.5' : 'size-4'} aria-hidden="true" />;
  const float = look === 'float' ? { 'data-float-action': '' } : {};

  if (onType) {
    return (
      <Link to={`/content/${onType}/new`} className={className} title="New entry" {...float}>
        {icon}
        New entry
      </Link>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={className} title="New entry" {...float}>
        {icon}
        New entry
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={look === 'float' ? 'top' : 'bottom'}
        className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-60"
      >
        <DropdownMenuLabel className="caption">New entry in</DropdownMenuLabel>
        {types === undefined ? (
          <DropdownMenuItem disabled>Loading content types…</DropdownMenuItem>
        ) : types.length === 0 ? (
          <>
            <DropdownMenuItem disabled>No content types yet</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/content">Create a content type</Link>
            </DropdownMenuItem>
          </>
        ) : (
          types.map((t) => (
            <DropdownMenuItem key={t.apiId} asChild>
              {/* A singleton's one entry, made or opened: never a second. */}
              <Link to={t.singleton ? `/content/${t.apiId}/entry` : `/content/${t.apiId}/new`}>
                {t.name}
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
