import { Search, X } from 'lucide-react';
import * as React from 'react';

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './input-group';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from './item';
import { cn } from './lib/utils';

/** What focus lands on in a row that has taken another's place. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled])';

/**
 * What sits over a list: its search at the start, its filters at the end. One bar for every list,
 * catalog or table, so finding things works the same on every screen. Below `sm` it wraps, the
 * search taking the whole line.
 */
function ListToolbar({
  summary,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  /** What the filters left ("3 shown"), said to screen readers as it changes. */
  summary?: string;
}) {
  return (
    <div
      data-slot="list-toolbar"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 px-4 py-3 max-sm:[&>[data-slot=segmented]]:w-full',
        className,
      )}
      {...props}
    >
      {children}
      <p role="status" className="sr-only">
        {summary}
      </p>
    </div>
  );
}

/**
 * A list's search field. `label` names it for screen readers; the placeholder is only a hint. With
 * `onClear`, a filled field offers a Clear button and Escape clears it.
 */
function ListSearch({
  label,
  onClear,
  onKeyDown,
  className,
  ...props
}: Omit<React.ComponentProps<typeof InputGroupInput>, 'type' | 'aria-label'> & {
  label: string;
  onClear?: () => void;
}) {
  return (
    <InputGroup className={cn('max-w-sm max-sm:max-w-none', className)}>
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        aria-label={label}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        className="[&::-webkit-search-cancel-button]:appearance-none"
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.key === 'Escape' && props.value && onClear) {
            e.preventDefault();
            onClear();
          }
        }}
        {...props}
      />
      {onClear && props.value ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear search"
            onClick={(e) => {
              // Clearing removes this button: focus stays in the field, not on the page.
              e.currentTarget
                .closest('[data-slot=input-group]')
                ?.querySelector<HTMLElement>('input')
                ?.focus();
              onClear();
            }}
          >
            <X aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

/**
 * A short list of things, each a raised row: what it is first, what state it's in beside it. For
 * lists read one row at a time. A list worked across its columns (sorted, ticked, moved through
 * with the keyboard) stays a `Table`.
 */
function Catalog({ className, onFocus, onBlur, ...props }: React.ComponentProps<'ul'>) {
  const list = React.useRef<HTMLUListElement>(null);
  // Which row holds focus. An action can take its own row away (Pause under an Active filter): focus
  // then goes to the row that took its place, or to the list's search when none is left.
  const place = React.useRef<number | null>(null);
  React.useEffect(() => {
    const el = list.current;
    if (!el) return;
    const card = el.closest('[data-slot=card], .card');
    const search = () =>
      card?.querySelector<HTMLElement>('[data-slot=list-toolbar] input[type=search]');
    const adrift = () => place.current !== null && document.activeElement === document.body;
    const watcher = new MutationObserver(() => {
      if (!adrift()) return;
      const row = el.children[Math.min(place.current ?? 0, el.children.length - 1)];
      place.current = null;
      (row?.querySelector<HTMLElement>(FOCUSABLE) ?? search())?.focus();
    });
    watcher.observe(el, { childList: true });
    return () => {
      watcher.disconnect();
      if (adrift() && card?.isConnected) search()?.focus();
    };
  }, []);
  return (
    <ul
      ref={list}
      data-slot="catalog"
      className={cn('flex flex-col gap-2 p-3', className)}
      onFocus={(e) => {
        onFocus?.(e);
        // React bubbles focus out of a portal too: a row's dialog holds focus outside the list, and
        // sees to its own way back.
        const at = Array.from(e.currentTarget.children).findIndex((row) => row.contains(e.target));
        place.current = at < 0 ? null : at;
      }}
      onBlur={(e) => {
        onBlur?.(e);
        // Moved on to something else. A row taken away blurs with nowhere to go, and keeps its place.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) place.current = null;
      }}
      {...props}
    />
  );
}

/**
 * One row of a `Catalog`. `media` identifies it at a glance (`CatalogTile`), `title` and `meta` say
 * what it is, `aside` holds its state (a badge, a `CatalogFigure`), `actions` what can be done to
 * it. Below `sm` what it is fills the first line, and its state and actions share the second.
 */
function CatalogRow({
  media,
  title,
  meta,
  aside,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<'li'>, 'title'> & {
  media?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  aside?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Item asChild variant="muted" size="sm" className={cn('rounded-xl', className)}>
      <li data-slot="catalog-row" {...props}>
        {media ? <ItemMedia>{media}</ItemMedia> : null}
        <ItemContent className="min-w-0 basis-48 max-sm:basis-[calc(100%-3.5rem)]">
          <ItemTitle className="line-clamp-none w-full min-w-0 wrap-anywhere">{title}</ItemTitle>
          {meta ? (
            <ItemDescription className="line-clamp-none wrap-anywhere text-xs">
              {meta}
            </ItemDescription>
          ) : null}
        </ItemContent>
        {aside ? (
          <div className="flex max-w-full shrink-0 items-center gap-6 max-sm:flex-1 max-sm:flex-wrap max-sm:gap-x-4 max-sm:gap-y-1">
            {aside}
          </div>
        ) : null}
        {actions ? (
          <ItemActions className="max-w-full shrink-0 touch:gap-5 max-sm:ml-auto">
            {actions}
          </ItemActions>
        ) : null}
      </li>
    </Item>
  );
}

/** The square at a row's start: an icon, or a short code such as a redirect's status. */
function CatalogTile({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="catalog-tile"
      className={cn(
        'flex size-10 items-center justify-center rounded-lg border bg-card font-medium text-muted-foreground text-xs tabular [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

/** A named figure in a row's aside: its caption over its value, right-aligned and tabular. */
function CatalogFigure({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & { label: string }) {
  return (
    <div
      data-slot="catalog-figure"
      className={cn(
        'flex flex-col items-end gap-0.5 max-sm:flex-row max-sm:items-baseline max-sm:gap-1.5',
        className,
      )}
      {...props}
    >
      <span className="caption">{label}</span>
      <span className="font-medium tabular">{children}</span>
    </div>
  );
}

/**
 * Why a filtered list shows nothing, with the way out in it. Clearing removes the button that was
 * pressed, so focus goes to the list's search rather than falling to the page.
 */
function CatalogEmpty({
  onClear,
  className,
  children,
  ...props
}: React.ComponentProps<'p'> & { onClear?: () => void }) {
  return (
    <p
      data-slot="catalog-empty"
      className={cn('px-4 pt-1 pb-4 text-muted-foreground text-xs', className)}
      {...props}
    >
      {children}
      {onClear ? (
        <>
          {' '}
          <button
            type="button"
            className="hit-area underline underline-offset-4"
            onClick={(e) => {
              e.currentTarget
                .closest('[data-slot=card], .card')
                ?.querySelector<HTMLElement>('[data-slot=list-toolbar] input[type=search]')
                ?.focus();
              onClear();
            }}
          >
            Clear filters
          </button>
        </>
      ) : null}
    </p>
  );
}

export { Catalog, CatalogEmpty, CatalogFigure, CatalogRow, CatalogTile, ListSearch, ListToolbar };
