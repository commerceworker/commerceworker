import type { ContentType } from '@commerceworker/domain';
import { Dialog, DialogContent, DialogTitle } from '@commerceworker/ui/dialog';
import { cn } from '@commerceworker/ui/lib/utils';
import {
  FileText,
  FileUp,
  Keyboard,
  LogOut,
  type LucideIcon,
  Moon,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { useTheme } from '~/lib/theme';
import { useClient } from '../../lib/client-context';
import { useFeatures } from '../../lib/features';
import type { PreviewEntry } from '../../lib/management';
import { entryTitle } from './Breadcrumbs';
import { openKeyboardShortcuts } from './KeyboardShortcuts';
import { type NavItem, SETTINGS_SECTIONS, visibleNav } from './nav';

type Group = 'Go to' | 'Actions' | 'Settings' | 'Content types' | 'Entries';
const GROUPS: readonly Group[] = ['Go to', 'Actions', 'Settings', 'Content types', 'Entries'];

/** A row in the palette: a destination (`to`) or an action (`run`). */
interface Item {
  readonly id: string;
  readonly group: Group;
  readonly label: string;
  readonly to?: string;
  readonly run?: () => void;
  readonly icon?: LucideIcon;
  /** Shown right-aligned for sighted keyboard users, e.g. "G D". */
  readonly hint?: string;
  readonly search: string;
}

const navItems = (nav: readonly NavItem[]): readonly Item[] =>
  nav.map((n) => ({
    id: `nav:${n.to}`,
    group: 'Go to',
    label: n.label,
    to: n.to,
    icon: n.icon,
    hint: `G ${n.shortcutKey.toUpperCase()}`,
    search: n.label.toLowerCase(),
  }));

const SETTINGS_ITEMS: readonly Item[] = SETTINGS_SECTIONS.map((s) => ({
  id: `settings:${s.id}`,
  group: 'Settings',
  label: s.label,
  to: `/settings/${s.id}`,
  icon: SettingsIcon,
  search: `settings ${s.label}`.toLowerCase(),
}));

const OPEN_EVENT = 'commerceworker:command-open';

/** Open the global command palette from anywhere (e.g. a topbar button). */
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_EVENT));

/**
 * Global palette (⌘K / Ctrl+K): every NAV destination and Settings section,
 * a few actions that exist elsewhere in the app (new entry and import for the
 * content type you're on, theme, shortcuts, sign out), then content types and
 * entries, loaded lazily on first open. A Dialog with a filtered, grouped list
 * and arrow-key navigation.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { client, conn, signOut } = useClient();
  const { resolved: theme, setChoice } = useTheme();
  const toggle = useCallback(
    () => setChoice(theme === 'dark' ? 'light' : 'dark'),
    [setChoice, theme],
  );
  const features = useFeatures();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [types, setTypes] = useState<ContentType[]>([]);
  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd-K / Ctrl-K toggles the palette; a custom event opens it (topbar button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // Reset the query/selection and focus the input each time it opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the keyboard-highlighted option visible while arrowing through.
  useEffect(() => {
    document
      .getElementById(`commerceworker-cmdk-item-${active}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  // Lazy-load the searchable index the first time the palette opens.
  useEffect(() => {
    if (!open || loaded) return;
    let live = true;
    (async () => {
      try {
        const [ts, es] = await Promise.all([
          client.listContentTypes(),
          client.listEntries().catch(() => []),
        ]);
        if (!live) return;
        setTypes(ts);
        setEntries(es);
        setLoaded(true);
      } catch {
        /* palette still offers navigation and actions if the index fails to load */
      }
    })();
    return () => {
      live = false;
    };
  }, [open, loaded, client]);

  // The content type in the URL, if any: new entry / import act on it.
  const typeId = matchPath('/content/:typeId/*', pathname)?.params.typeId;

  const items = useMemo<Item[]>(() => {
    const currentType = typeId ? types.find((t) => t.apiId === typeId) : undefined;
    const typeName = currentType?.name ?? typeId;
    const actions: Item[] = [];
    if (currentType?.singleton) {
      // A singleton holds one entry: it is opened, never added to or imported into.
      actions.push({
        id: 'action:open-singleton',
        group: 'Actions',
        label: `Open ${currentType.name}`,
        to: `/content/${currentType.apiId}/entry`,
        icon: FileText,
        search: `open singleton ${currentType.name}`.toLowerCase(),
      });
    } else if (typeId && typeName) {
      actions.push(
        {
          id: 'action:new-entry',
          group: 'Actions',
          label: `New ${typeName} entry`,
          to: `/content/${typeId}/new`,
          icon: Plus,
          search: `new entry create ${typeName}`.toLowerCase(),
        },
        {
          id: 'action:import',
          group: 'Actions',
          label: `Import ${typeName} entries`,
          to: `/content/${typeId}/import`,
          icon: FileUp,
          search: `import entries csv ${typeName}`.toLowerCase(),
        },
      );
    }
    actions.push(
      {
        id: 'action:theme',
        group: 'Actions',
        label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        run: toggle,
        icon: theme === 'dark' ? Sun : Moon,
        search: 'theme light dark mode appearance',
      },
      {
        id: 'action:shortcuts',
        group: 'Actions',
        label: 'Keyboard shortcuts',
        run: openKeyboardShortcuts,
        icon: Keyboard,
        hint: '?',
        search: 'keyboard shortcuts keys help',
      },
      {
        id: 'action:sign-out',
        group: 'Actions',
        label: 'Sign out',
        run: signOut,
        icon: LogOut,
        search: 'sign out log out disconnect',
      },
    );

    const displayFieldOf = new Map(types.map((t) => [t.apiId, t.displayField]));
    const typeItems: Item[] = types.map((t) => ({
      id: `type:${t.apiId}`,
      group: 'Content types',
      label: t.name,
      to: `/content/${t.apiId}`,
      icon: FileText,
      search: `${t.name} ${t.apiId}`.toLowerCase(),
    }));
    const entryItems: Item[] = entries.slice(0, 100).map((e) => {
      const label =
        entryTitle(e.fields, displayFieldOf.get(e.contentType), conn.locale) ?? 'Untitled entry';
      return {
        id: `entry:${e.id}`,
        group: 'Entries',
        label,
        to: `/content/${e.contentType}/${e.id}`,
        search: `${label} ${e.contentType} ${e.id}`.toLowerCase(),
      };
    });
    return [
      ...navItems(visibleNav(features)),
      ...actions,
      ...SETTINGS_ITEMS,
      ...typeItems,
      ...entryItems,
    ];
  }, [types, entries, conn.locale, typeId, theme, toggle, signOut, features]);

  // Settings sections are long-tail destinations: listed only once you type.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter((i) => i.search.includes(q))
      : items.filter((i) => i.group !== 'Settings');
    // Keep the flat order identical to the rendered (grouped) order.
    return GROUPS.flatMap((g) => list.filter((i) => i.group === g)).slice(0, 50);
  }, [items, query]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    if (item.to) navigate(item.to);
    // Let the palette close (and hand focus back) before an action opens a dialog.
    else if (item.run) requestAnimationFrame(() => item.run?.());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(filtered[active]);
    }
  };

  let flat = -1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Anchored to the top: centred, the search box would jump as the results shrink. */}
      <DialogContent
        showCloseButton={false}
        placement="top"
        className="sm:max-w-lg"
        bodyClassName="flex flex-col gap-0 overflow-hidden p-0 pb-0!"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex shrink-0 items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Go to a page, run an action, or find an entry…"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Command palette search"
            role="combobox"
            aria-expanded="true"
            aria-controls="commerceworker-cmdk-list"
            aria-autocomplete="list"
            aria-activedescendant={
              filtered.length > 0 ? `commerceworker-cmdk-item-${active}` : undefined
            }
          />
        </div>
        {/* WAI-ARIA combobox pattern: focus stays in the input and the active
            option is conveyed via aria-activedescendant, so the listbox and its
            options are intentionally not focusable and can't be <select>/<option>.
            (biome.json turns off useSemanticElements/useFocusableInteractive here.) */}
        <div
          id="commerceworker-cmdk-list"
          role="listbox"
          aria-label="Results"
          className="max-h-80 min-h-0 flex-1 overflow-y-auto p-1"
        >
          {filtered.length === 0 && (
            <div aria-hidden="true" className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </div>
          )}
          {GROUPS.map((g) => {
            const inGroup = filtered.filter((i) => i.group === g);
            if (inGroup.length === 0) return null;
            const groupId = `commerceworker-cmdk-group-${g.replace(/\s+/g, '-').toLowerCase()}`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an option group inside the listbox, not a form fieldset.
              <div key={g} role="group" aria-labelledby={groupId} className="mb-1">
                <div id={groupId} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  {g}
                </div>
                {inGroup.map((item) => {
                  flat += 1;
                  const idx = flat;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      id={`commerceworker-cmdk-item-${idx}`}
                      role="option"
                      aria-selected={idx === active}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => choose(item)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
                        idx === active ? 'bg-accent text-accent-foreground' : 'text-foreground',
                      )}
                    >
                      {item.icon && <item.icon className="size-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.hint && (
                        <span
                          aria-hidden="true"
                          className="hidden shrink-0 font-sans text-xs text-muted-foreground pointer-fine:inline"
                        >
                          {item.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        {/* Always mounted, so filling it is announced; the words on screen sit in the listbox. */}
        <p role="status" className="sr-only">
          {filtered.length === 0 ? 'No results found.' : ''}
        </p>
      </DialogContent>
    </Dialog>
  );
}
