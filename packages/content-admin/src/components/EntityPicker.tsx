import { cn } from '@commerceworker/ui/lib/utils';
import { ChevronsUpDown, X } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PickOption } from './EntryForm';

/**
 * Searchable reference picker for Link fields: a combobox over the space's
 * entries/assets, replacing a plain Select that offered no search across a
 * potentially large corpus. Follows the WAI-ARIA combobox pattern (focus stays
 * in the input; the active option is conveyed via aria-activedescendant), same
 * as the command palette. The list renders in a Popover portal so the form
 * card's overflow clipping can't cut it off.
 */
export function EntityPicker(props: {
  id: string;
  options: readonly PickOption[];
  /** Selected option id, or empty for none. */
  value: string;
  placeholder?: string;
  /** Accessible name for the input when no <Label> points at it. */
  ariaLabel?: string;
  invalid?: boolean;
  errorId?: string;
  /**
   * Resolves matches on the server instead of filtering `options`.
   *
   * When present, `options` is only the seed shown before anyone types — the
   * corpus is not assumed to be in memory, because it is not: the list endpoint
   * is capped, so filtering a fetched page cannot reach an entry past it.
   */
  onSearch?: (query: string) => Promise<readonly PickOption[]>;
  onChange: (id: string | undefined) => void;
}) {
  const { options, value, onChange, onSearch } = props;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  /**
   * Results, paired with the query they answer.
   *
   * Kept together so a pending search can be told from a finished one: showing
   * the previous query's matches while someone types a new one presents stale
   * answers as current.
   */
  const [remote, setRemote] = useState<{ query: string; items: readonly PickOption[] }>();

  /**
   * The selected option, remembered across searches.
   *
   * Once matching happens server-side, the selected entry is usually absent
   * from the current results — so reading the label out of them would blank the
   * field the moment someone typed. Held separately, and kept until the
   * selection itself changes.
   */
  const [picked, setPicked] = useState<PickOption>();
  const selected =
    options.find((o) => o.id === value) ?? (picked?.id === value ? picked : undefined);

  // Debounced, because a keystroke is not a query. The trailing edge only: the
  // useful answer is for what someone finished typing, not what they passed
  // through on the way.
  useEffect(() => {
    if (!onSearch || !open) return;
    const q = query.trim();
    let live = true;
    const timer = setTimeout(() => {
      onSearch(q)
        .then((items) => {
          if (live) setRemote({ query: q, items });
        })
        .catch(() => {
          // A failed lookup keeps the previous results rather than emptying the
          // list, which would read as "nothing matches" — a different and wrong
          // answer. It is marked as answering this query so the picker stops
          // saying it is still searching.
          if (live) setRemote((prev) => ({ query: q, items: prev?.items ?? [] }));
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [onSearch, open, query]);

  // True while what is on screen does not yet answer what has been typed.
  const searching = Boolean(onSearch) && remote?.query !== query.trim();

  const filtered = useMemo(() => {
    if (onSearch) return (searching ? [] : (remote?.items ?? [])).slice(0, 50);
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : [...options];
    return list.slice(0, 50);
  }, [onSearch, searching, remote, options, query]);

  const optionId = (idx: number) => `${listId}-opt-${idx}`;

  // Keep the keyboard-highlighted option visible while arrowing through.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  });

  const openList = () => {
    setQuery('');
    setActive(0);
    setOpen(true);
  };

  const pick = (option: PickOption | undefined) => {
    if (!option) return;
    // Remembered here rather than looked up later: this is the only moment the
    // label is known for certain, and the next search will not return it.
    setPicked(option);
    onChange(option.id);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault();
      openList();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(filtered[active]);
    } else if (e.key === 'Escape') {
      if (open) {
        // Close only the picker, not a Dialog it may be sitting inside.
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="relative">
          <input
            ref={inputRef}
            id={props.id}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && filtered.length > 0 ? optionId(active) : undefined}
            aria-label={props.ariaLabel}
            aria-invalid={props.invalid || undefined}
            aria-describedby={props.errorId}
            className={cn(
              'h-8 w-full min-w-0 rounded-2xl border border-transparent bg-input/50 py-1 pr-14 pl-2.5 text-sm transition-[color,box-shadow] duration-200 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring',
              props.invalid && 'border-destructive focus-visible:ring-destructive/30',
            )}
            placeholder={props.placeholder ?? 'Search…'}
            // Fallback to the raw id when the target isn't in the options
            // (deleted entry, pickers still loading) — never a blank that
            // reads as "no link".
            value={open ? query : (selected?.label ?? value)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              if (!open) setOpen(true);
            }}
            onClick={() => {
              if (!open) openList();
            }}
            onKeyDown={onKeyDown}
          />
          <span className="absolute inset-y-0 right-2 flex items-center gap-1">
            {selected && !open && (
              <button
                type="button"
                aria-label="Clear selection"
                className="rounded-2xl p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => onChange(undefined)}
              >
                <X className="size-3.5" />
              </button>
            )}
            <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          // Combobox: focus stays in the input.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 max-h-64 w-[--radix-popover-trigger-width] min-w-64 overflow-y-auto rounded-2xl border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {/* WAI-ARIA combobox popup, managed via aria-activedescendant.
              (biome.json turns off useSemanticElements/useFocusableInteractive here.) */}
          <div id={listId} role="listbox" aria-label="Matches">
            {filtered.length === 0 && (
              // "Searching" and "nothing matched" are different answers, and
              // showing the second while the first is true tells people to stop
              // typing a query that would have worked.
              <p className="px-2 py-2 text-muted-foreground text-sm">
                {searching ? 'Searching…' : 'No matches.'}
              </p>
            )}
            {filtered.map((o, idx) => (
              <button
                key={o.id}
                type="button"
                id={optionId(idx)}
                role="option"
                aria-selected={o.id === value}
                tabIndex={-1}
                onMouseEnter={() => setActive(idx)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                className={cn(
                  'flex w-full items-center rounded-xl px-2 py-1.5 text-left text-sm',
                  idx === active ? 'bg-accent text-accent-foreground' : 'text-popover-foreground',
                )}
              >
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
