import type { Menu, MenuItem, MenuItemInput, MenuLink } from '@commerceworker/domain';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import {
  Catalog,
  CatalogEmpty,
  CatalogFigure,
  CatalogRow,
  CatalogTile,
  ListSearch,
  ListToolbar,
} from '@commerceworker/ui/catalog';
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
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Switch } from '@commerceworker/ui/switch';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  IndentDecrease,
  IndentIncrease,
  ListTree,
  Plus,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '~/cms/components/ConfirmDialog';
import { DiscardAsk, GuardCancel, useDiscardGuard } from '~/cms/components/discard-guard';
import { EntityPicker } from '~/cms/components/EntityPicker';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { EmptyState, Section } from '~/cms/components/page';
import { ToneBadge } from '~/cms/components/status';
import type { Tone } from '~/cms/lib/format';
import {
  ApiError,
  apiErrorMessage,
  apiFieldIssues,
  type ManagementClient,
  type MenuItemPreview,
  type MenuItemStatus,
  type MenuSummary,
  refusedSave,
  SaveRefusedError,
} from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** Deepest a menu nests (the API's MAX_MENU_DEPTH): top-level items are depth 1. */
export const MENU_DEPTH = 3;

const STATUS: Record<MenuItemStatus, { tone: Tone; label: string; why?: string }> = {
  live: { tone: 'ok', label: 'Live' },
  unpublished: {
    tone: 'idle',
    label: 'Not published',
    why: 'Its entry isn’t published: Delivery leaves it out until it is.',
  },
  missing: { tone: 'bad', label: 'Missing', why: 'What it links to was deleted.' },
  no_url: {
    tone: 'wait',
    label: 'No URL',
    why: 'Its content type has no published URL pattern, or the entry has no slug here.',
  },
  hidden: {
    tone: 'idle',
    label: 'Hidden',
    why: 'It links to content your role can’t read, so you can’t see what Delivery serves for it.',
  },
};

/** Where a move sends an item, as the API's move takes it. */
interface Move {
  readonly itemId: string;
  readonly parentId: string | null;
  readonly index: number;
}

type Direction = 'up' | 'down' | 'indent' | 'outdent';

const height = (item: MenuItem): number => 1 + Math.max(0, ...item.children.map(height));

/**
 * The move each keyboard button makes for the item at `index` among `siblings` (under `parent`,
 * which sits at `parentIndex` among `parentSiblings` under `grandparent`), or null when it can't.
 */
function moveFor(
  dir: Direction,
  at: {
    item: MenuItem;
    index: number;
    siblings: readonly MenuItem[];
    depth: number;
    parent: MenuItem | null;
    grandparentId: string | null;
    parentIndex: number;
  },
): Move | null {
  const { item, index, siblings, depth, parent } = at;
  switch (dir) {
    case 'up':
      return index > 0 ? { itemId: item.id, parentId: parent?.id ?? null, index: index - 1 } : null;
    case 'down':
      return index < siblings.length - 1
        ? { itemId: item.id, parentId: parent?.id ?? null, index: index + 1 }
        : null;
    case 'indent': {
      // Under the item above it, last; the subtree comes along, so it must still fit.
      const above = siblings[index - 1];
      if (!above || depth + height(item) > MENU_DEPTH) return null;
      return { itemId: item.id, parentId: above.id, index: above.children.length };
    }
    case 'outdent':
      // Out of its parent, just after it.
      return parent
        ? { itemId: item.id, parentId: at.grandparentId, index: at.parentIndex + 1 }
        : null;
  }
}

const describeLink = (link: MenuLink): string =>
  link.type === 'url'
    ? link.url
    : link.type === 'entry'
      ? `Entry ${link.entryId}`
      : `${link.termKind === 'tag' ? 'Tag' : 'Concept'} ${link.termId}`;

/** A stored item back as the API takes it: the same tree, ids kept. */
const asInput = (items: readonly MenuItem[]): MenuItemInput[] =>
  items.map((i) => ({
    id: i.id,
    ...(i.label ? { label: i.label } : {}),
    link: i.link,
    ...(i.target ? { target: i.target } : {}),
    ...(i.attrs ? { attrs: i.attrs } : {}),
    children: asInput(i.children),
  }));

const isStale = (err: unknown) => err instanceof ApiError && err.status === 409;

/**
 * Settings → Menus: the environment's navigation menus, which front ends render (Delivery serves
 * each one resolved: published entries only). A list of menus, and an editor for one menu's tree.
 */
export function Menus(props: { client: ManagementClient }) {
  const [open, setOpen] = useState<string | null>(null);
  return open ? (
    <MenuEditor client={props.client} id={open} onClose={() => setOpen(null)} />
  ) : (
    <MenuList client={props.client} onOpen={setOpen} />
  );
}

function MenuList(props: { client: ManagementClient; onOpen: (id: string) => void }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const list = useScopedQuery(['menus'], () => client.listMenus());
  const menus = list.data ?? [];
  // The API answers every menu at once, so the filter can run here.
  const needle = q.trim().toLowerCase();
  const shown = menus.filter(
    (m) => !needle || `${m.name} ${m.handle} ${m.description ?? ''}`.toLowerCase().includes(needle),
  );

  const remove = async (m: MenuSummary) => {
    setBusy(true);
    try {
      await client.deleteMenu(m.id, m.revision);
      toast.success('Menu deleted');
    } catch (err) {
      throw isStale(err)
        ? new SaveRefusedError('Someone changed this menu since the list loaded.')
        : err;
    } finally {
      await invalidate(['menus']);
      setBusy(false);
    }
  };

  const newButton = (
    <Button size={menus.length ? 'sm' : 'default'} onClick={() => setCreating(true)}>
      <Plus />
      New menu
    </Button>
  );

  return (
    <div className="space-y-4">
      {list.data !== undefined && menus.length === 0 ? (
        <EmptyState
          icon={ListTree}
          title="No menus yet"
          description="Build your site's navigation here: a header, a footer, a sidebar. Link entries, tags and concepts, or any URL. Delivery serves each menu with published entries only."
        >
          {newButton}
        </EmptyState>
      ) : (
        <Section
          title="Menus"
          description="Your site renders these: Delivery serves each one by its handle, with links to published entries only."
          flush
          actions={newButton}
        >
          <ListToolbar summary={`${shown.length} shown`}>
            <ListSearch
              label="Search menus"
              placeholder="Search names and handles"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ('')}
            />
          </ListToolbar>
          {needle && shown.length === 0 ? (
            <CatalogEmpty onClear={() => setQ('')}>No menus match “{q}”.</CatalogEmpty>
          ) : (
            <Catalog
              aria-label="Menus"
              aria-busy={list.data === undefined || undefined}
              className="pt-0"
            >
              {shown.map((m) => (
                <CatalogRow
                  key={m.id}
                  media={
                    <CatalogTile>
                      <ListTree aria-hidden="true" />
                    </CatalogTile>
                  }
                  title={
                    <button
                      type="button"
                      className="hit-area break-words text-left font-medium hover:underline"
                      onClick={() => props.onOpen(m.id)}
                    >
                      {m.name}
                    </button>
                  }
                  meta={
                    <span className="flex flex-wrap gap-x-2">
                      <span className="break-all font-mono">{m.handle}</span>
                      {m.description && <span>{m.description}</span>}
                    </span>
                  }
                  aside={<CatalogFigure label="Items">{m.itemCount}</CatalogFigure>}
                  actions={
                    <ConfirmDialog
                      message={`Delete the menu “${m.name}”?`}
                      note={`Delivery stops serving “${m.handle}”: a site that renders it shows no navigation there.`}
                      confirmLabel="Delete menu"
                      busy={busy}
                      onConfirm={() => remove(m)}
                    >
                      {(ask) => (
                        <span className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`Edit the menu ${m.name}`}
                            onClick={() => props.onOpen(m.id)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`Delete the menu ${m.name}`}
                            onClick={ask}
                          >
                            Delete
                          </Button>
                        </span>
                      )}
                    </ConfirmDialog>
                  }
                />
              ))}
            </Catalog>
          )}
        </Section>
      )}
      {creating && (
        <MenuDialog
          menu={null}
          onOpenChange={setCreating}
          onSave={async (input) => {
            const made = await client.createMenu(input);
            await invalidate(['menus']);
            toast.success('Menu created');
            props.onOpen(made.id);
          }}
        />
      )}
    </div>
  );
}

/** A flattened row of the tree: the item and where it sits. */
interface Row {
  readonly item: MenuItem;
  readonly depth: number;
  readonly index: number;
  readonly siblings: readonly MenuItem[];
  readonly parent: MenuItem | null;
  readonly grandparentId: string | null;
  readonly parentIndex: number;
}

function rowsOf(items: readonly MenuItem[]): Row[] {
  const out: Row[] = [];
  const walk = (
    list: readonly MenuItem[],
    depth: number,
    parent: MenuItem | null,
    grandparentId: string | null,
    parentIndex: number,
  ) =>
    list.forEach((item, index) => {
      out.push({ item, depth, index, siblings: list, parent, grandparentId, parentIndex });
      walk(item.children, depth + 1, item, parent?.id ?? null, index);
    });
  walk(items, 1, null, null, -1);
  return out;
}

const DIRECTIONS: readonly {
  dir: Direction;
  label: string;
  key: string;
  icon: typeof ArrowUp;
}[] = [
  { dir: 'up', label: 'up', key: 'ArrowUp', icon: ArrowUp },
  { dir: 'down', label: 'down', key: 'ArrowDown', icon: ArrowDown },
  { dir: 'outdent', label: 'out a level', key: 'ArrowLeft', icon: IndentDecrease },
  { dir: 'indent', label: 'in a level', key: 'ArrowRight', icon: IndentIncrease },
];

/**
 * One menu's tree. Every change saves at once, naming the revision it was made against, so a
 * menu someone else saved meanwhile is refused (409) and the editor offers to reload rather than
 * overwrite it. Reorder by keyboard: each row's Move buttons, or Alt+arrows on a focused row.
 */
function MenuEditor(props: { client: ManagementClient; id: string; onClose: () => void }) {
  const { client, id } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const fetched = useScopedQuery(['menus', id], () => client.getMenu(id)).data;
  const preview = useScopedQuery(['menus', id, 'preview'], () => client.previewMenu(id)).data;
  const [menu, setMenu] = useState<Menu>();
  const [stale, setStale] = useState(false);
  // A write here may have landed, so the revision that moved may be this person's own.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [said, setSaid] = useState('');
  const [focusAfter, setFocusAfter] = useState<{ id: string; dir: Direction } | null>(null);
  const busy = useRef(false);
  const list = useRef<HTMLOListElement>(null);
  // The focus target inside the section's own <h2> (Section renders the heading).
  const heading = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (fetched) setMenu(fetched);
  }, [fetched]);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  // Focus stays with the moved item: on the button just used, or another that still works.
  useEffect(() => {
    if (!focusAfter) return;
    const row = list.current?.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(focusAfter.id)}"]`,
    );
    const buttons = [
      ...(row?.querySelectorAll<HTMLButtonElement>(':scope > div [data-move]') ?? []),
    ];
    const wanted = buttons.find((b) => b.dataset.move === focusAfter.dir);
    (wanted && !wanted.disabled ? wanted : buttons.find((b) => !b.disabled))?.focus();
    setFocusAfter(null);
  }, [focusAfter, menu]);

  const previews = useMemo(() => {
    const byId = new Map<string, MenuItemPreview>();
    const walk = (items: readonly MenuItemPreview[]) =>
      items.forEach((p) => {
        byId.set(p.id, p);
        walk(p.children);
      });
    walk(preview?.items ?? []);
    return byId;
  }, [preview]);
  const nameOf = (item: MenuItem) =>
    item.label ?? (previews.get(item.id)?.label || describeLink(item.link));

  /** Runs one write against the current revision; a write already running wins. */
  const write = async (work: (m: Menu) => Promise<Menu>, done?: string) => {
    if (!menu || busy.current || stale) return null;
    busy.current = true;
    try {
      const next = await work(menu);
      setMenu(next);
      await invalidate(['menus']);
      if (done) toast.success(done);
      return next;
    } catch (err) {
      if (!refusedSave(err)) setUnconfirmed(true);
      if (isStale(err)) setStale(true);
      else toast.error(apiErrorMessage(err));
      throw err;
    } finally {
      busy.current = false;
    }
  };

  const move = async (row: Row, dir: Direction) => {
    const to = moveFor(dir, row);
    if (!to) return;
    const name = nameOf(row.item);
    try {
      await write((m) => client.moveMenuItem(m.id, { ...to, revision: m.revision }));
      setSaid(`“${name}” moved ${DIRECTIONS.find((d) => d.dir === dir)?.label}`);
      setFocusAfter({ id: row.item.id, dir });
    } catch {
      // Said by `write`: a toast, or the reload alert.
    }
  };

  const saveItems = (items: readonly MenuItemInput[], done: string) =>
    write((m) => client.updateMenu(m.id, { items, revision: m.revision }), done);

  if (!menu) {
    return <p className="text-muted-foreground text-sm">Loading menu…</p>;
  }
  const rows = rowsOf(menu.items);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={props.onClose}>
        <ArrowLeft />
        All menus
      </Button>
      {stale && (
        <Alert variant="warning">
          <AlertTitle>This menu changed since you opened it</AlertTitle>
          <AlertDescription>
            {unconfirmed
              ? 'That may be your own save that didn’t confirm, or someone else’s. Reload to see what’s there; your last change wasn’t saved.'
              : 'Someone else saved it. Reload to see their version; your last change wasn’t saved.'}
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                setMenu(await client.getMenu(id));
                await invalidate(['menus']);
                setStale(false);
                setUnconfirmed(false);
              }}
            >
              Reload
            </Button>
          </AlertAction>
        </Alert>
      )}
      <Section
        title={
          <span ref={heading} tabIndex={-1} className="outline-none">
            {menu.name}
          </span>
        }
        description={
          <>
            Delivery serves it as <span className="font-mono">{menu.handle}</span>. An item whose
            link doesn’t resolve is left out, and the items under it take its place.
          </>
        }
        flush
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button size="sm" disabled={stale} onClick={() => setEditing('new')}>
              <Plus />
              Add item
            </Button>
          </div>
        }
      >
        <p className="sr-only" aria-live="polite">
          {said}
        </p>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-muted-foreground text-sm">
            No items yet. Add one to start the menu.
          </p>
        ) : (
          <ol ref={list} aria-label={`Items of ${menu.name}`} className="divide-y">
            {rows.map((row) => {
              const { item } = row;
              const name = nameOf(item);
              const status = previews.get(item.id)?.status;
              return (
                <li
                  key={item.id}
                  data-item-id={item.id}
                  className="flex items-center gap-2 py-2 pr-3 max-md:flex-wrap"
                  style={{ paddingInlineStart: `${row.depth * 1.25}rem` }}
                  onKeyDown={(e) => {
                    if (!e.altKey) return;
                    const d = DIRECTIONS.find((x) => x.key === e.key);
                    if (!d) return;
                    e.preventDefault();
                    void move(row, d.dir);
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sm">
                      {name}
                      {row.depth > 1 && <span className="sr-only">, level {row.depth}</span>}
                    </span>
                    <span className="block truncate font-mono text-2xs text-muted-foreground">
                      {previews.get(item.id)?.url ?? describeLink(item.link)}
                      {item.target === '_blank' ? ' · new tab' : ''}
                    </span>
                  </div>
                  {status && (
                    <span title={STATUS[status].why}>
                      <ToneBadge tone={STATUS[status].tone} label={STATUS[status].label} />
                    </span>
                  )}
                  <div className="flex shrink-0 items-center gap-0.5 max-md:ml-auto pointer-coarse:gap-5">
                    {DIRECTIONS.map(({ dir, label, icon: Icon }) => (
                      <Button
                        key={dir}
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        data-move={dir}
                        aria-label={`Move “${name}” ${label}`}
                        aria-keyshortcuts={`Alt+${DIRECTIONS.find((d) => d.dir === dir)?.key}`}
                        disabled={stale || moveFor(dir, row) === null}
                        onClick={() => void move(row, dir)}
                      >
                        <Icon aria-hidden="true" />
                      </Button>
                    ))}
                    <ConfirmButton
                      message={`Remove “${name}”${item.children.length ? ' and the items under it' : ''}?`}
                      confirmLabel="Remove item"
                      onConfirm={() =>
                        void saveItems(
                          asInput(removeItem(menu.items, item.id)),
                          'Item removed',
                        ).catch(() => {})
                      }
                    >
                      {(ask) => (
                        <span className="flex gap-0.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label={`Edit “${name}”`}
                            disabled={stale}
                            onClick={() => setEditing(item)}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-label={`Remove “${name}”`}
                            disabled={stale}
                            onClick={ask}
                          >
                            Remove
                          </Button>
                        </span>
                      )}
                    </ConfirmButton>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      {editing && (
        <MenuItemDialog
          client={client}
          item={editing === 'new' ? null : editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onSave={async (input) => {
            const items =
              editing === 'new'
                ? [...asInput(menu.items), input]
                : asInput(replaceItem(menu.items, editing.id, input));
            await saveItems(items, editing === 'new' ? 'Item added' : 'Item saved');
          }}
        />
      )}
      {renaming && (
        <MenuDialog
          menu={menu}
          onOpenChange={setRenaming}
          onSave={async (input) => {
            await write(
              (m) =>
                client.updateMenu(m.id, {
                  name: input.name,
                  handle: input.handle,
                  description: input.description ?? null,
                  revision: m.revision,
                }),
              'Menu saved',
            );
          }}
        />
      )}
    </div>
  );
}

function removeItem(items: readonly MenuItem[], id: string): MenuItem[] {
  return items
    .filter((i) => i.id !== id)
    .map((i) => ({ ...i, children: removeItem(i.children, id) }));
}

/** The tree with item `id`'s own fields replaced by `input`'s; its children stay. */
function replaceItem(items: readonly MenuItem[], id: string, input: MenuItemInput): MenuItem[] {
  return items.map((i) =>
    i.id === id
      ? ({ ...input, id, children: i.children } as MenuItem)
      : { ...i, children: replaceItem(i.children, id, input) },
  );
}

/** Name, handle and description: a new menu, or a rename. */
function MenuDialog(props: {
  menu: Pick<Menu, 'name' | 'handle' | 'description'> | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: { name: string; handle: string; description?: string | null }) => Promise<void>;
}) {
  const m = props.menu;
  const id = useId();
  const [name, setName] = useState(m?.name ?? '');
  const [handle, setHandle] = useState(m?.handle ?? '');
  const [touched, setTouched] = useState(Boolean(m));
  const [description, setDescription] = useState(m?.description ?? '');
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const guard = useDiscardGuard({
    saving: busy,
    dirty:
      name !== (m?.name ?? '') ||
      handle !== (m?.handle ?? '') ||
      description !== (m?.description ?? ''),
    onOpenChange: props.onOpenChange,
  });

  const suggest = (n: string) =>
    n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssues({});
    setError(undefined);
    try {
      await props.onSave({
        name: name.trim(),
        handle: handle.trim(),
        description: description.trim() || null,
      });
      props.onOpenChange(false);
    } catch (err) {
      const said = guard.saveFailed(err);
      const fields = apiFieldIssues(err);
      setIssues(fields);
      if (Object.keys(fields).length === 0) setError(said);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m ? 'Rename menu' : 'New menu'}</DialogTitle>
          <DialogDescription>
            A front end asks Delivery for a menu by its handle, so changing it means changing the
            site too.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              placeholder="Main navigation"
              aria-invalid={Boolean(issues.name)}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!touched) setHandle(suggest(e.target.value));
              }}
            />
            {issues.name && <p className="text-destructive text-ui">{issues.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-handle`}>Handle</Label>
            <Input
              id={`${id}-handle`}
              className="font-mono"
              placeholder="main"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(issues.handle)}
              aria-describedby={`${id}-handle-hint`}
              value={handle}
              onChange={(e) => {
                setTouched(true);
                setHandle(e.target.value);
              }}
            />
            <p id={`${id}-handle-hint`} className="text-ui text-muted-foreground">
              {issues.handle ??
                'Lowercase letters and digits joined by - or _: main, footer-legal.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-description`}>Description</Label>
            <Input
              id={`${id}-description`}
              placeholder="Where it shows (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <DiscardAsk guard={guard} message="Discard this menu?">
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy || !name.trim() || !handle.trim()}>
                {busy ? 'Saving…' : m ? 'Save' : 'Create menu'}
              </Button>
            </DiscardAsk>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const KINDS = [
  { value: 'url', label: 'URL' },
  { value: 'entry', label: 'Entry' },
  { value: 'term', label: 'Tag or concept' },
] as const;

/** Add or edit one item: its link, its label and whether it opens a new tab. */
export function MenuItemDialog(props: {
  client: ManagementClient;
  item: MenuItem | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: MenuItemInput) => Promise<void>;
}) {
  const { client, item } = props;
  const id = useId();
  const link = item?.link;
  const [kind, setKind] = useState<MenuLink['type']>(link?.type ?? 'url');
  const [url, setUrl] = useState(link?.type === 'url' ? link.url : '');
  const [entryId, setEntryId] = useState(link?.type === 'entry' ? link.entryId : '');
  const [term, setTerm] = useState(link?.type === 'term' ? `${link.termKind}:${link.termId}` : '');
  const [label, setLabel] = useState(item?.label ?? '');
  const [newTab, setNewTab] = useState(item?.target === '_blank');
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const tags = useScopedQuery(['taxonomy', 'tags'], () => client.listTags(), {
    enabled: kind === 'term',
  }).data;
  const concepts = useScopedQuery(['taxonomy', 'concepts'], () => client.listConcepts(), {
    enabled: kind === 'term',
  }).data;
  const searchEntries = async (q: string) =>
    (await client.suggestEntries({ q, limit: 20 })).map((s) => ({
      id: s.id,
      label: s.title || s.id,
      contentType: s.contentType,
    }));

  const linkOf = (): MenuLink | null => {
    if (kind === 'url') return url.trim() ? { type: 'url', url: url.trim() } : null;
    if (kind === 'entry') return entryId ? { type: 'entry', entryId } : null;
    const [termKind, termId] = term.split(':');
    return termId && (termKind === 'tag' || termKind === 'concept')
      ? { type: 'term', termKind, termId }
      : null;
  };
  const chosen = linkOf();
  const guard = useDiscardGuard({
    saving: busy,
    dirty:
      JSON.stringify(chosen) !== JSON.stringify(link ?? null) ||
      label !== (item?.label ?? '') ||
      newTab !== (item?.target === '_blank'),
    onOpenChange: props.onOpenChange,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setIssues({});
    setError(undefined);
    try {
      await props.onSave({
        ...(item ? { id: item.id } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
        link: chosen,
        ...(newTab ? { target: '_blank' as const } : {}),
        ...(item?.attrs ? { attrs: item.attrs } : {}),
      });
      props.onOpenChange(false);
    } catch (err) {
      const said = guard.saveFailed(err);
      // The API names the item by its path (items[3].link.url): the last part is the field.
      const fields = Object.fromEntries(
        Object.entries(apiFieldIssues(err)).map(([f, m]) => [f.split('.').at(-1) ?? f, m]),
      );
      setIssues(fields);
      if (Object.keys(fields).length === 0 && !isStale(err)) setError(said);
      if (isStale(err)) props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const linkIssue = issues.url ?? issues.link;

  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? 'Edit item' : 'New item'}</DialogTitle>
          <DialogDescription>
            Link an entry (it shows while published, at its URL), a tag or concept, or any URL.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Segmented
            aria-label="Link to"
            value={kind}
            onValueChange={(v) => setKind(v as MenuLink['type'])}
          >
            {KINDS.map((k) => (
              <SegmentedItem key={k.value} value={k.value}>
                {k.label}
              </SegmentedItem>
            ))}
          </Segmented>
          <div className="space-y-1.5">
            {kind === 'url' && (
              <>
                <Label htmlFor={`${id}-url`}>URL</Label>
                <Input
                  id={`${id}-url`}
                  className="font-mono"
                  placeholder="/about or https://example.com"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={Boolean(linkIssue)}
                  aria-describedby={`${id}-link-hint`}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </>
            )}
            {kind === 'entry' && (
              <>
                <Label htmlFor={`${id}-entry`}>Entry</Label>
                <EntityPicker
                  id={`${id}-entry`}
                  options={[]}
                  value={entryId}
                  placeholder="Search entries…"
                  invalid={Boolean(linkIssue)}
                  errorId={`${id}-link-hint`}
                  onSearch={searchEntries}
                  onChange={(v) => setEntryId(v ?? '')}
                />
              </>
            )}
            {kind === 'term' && (
              <>
                <Label htmlFor={`${id}-term`}>Tag or concept</Label>
                <Select value={term} onValueChange={setTerm}>
                  <SelectTrigger
                    id={`${id}-term`}
                    className="w-full"
                    aria-invalid={Boolean(linkIssue)}
                    aria-describedby={`${id}-link-hint`}
                  >
                    <SelectValue placeholder="Choose one" />
                  </SelectTrigger>
                  <SelectContent>
                    {(tags ?? []).map((t) => (
                      <SelectItem key={`tag:${t.id}`} value={`tag:${t.id}`}>
                        {t.name} (tag)
                      </SelectItem>
                    ))}
                    {(concepts ?? []).map((c) => (
                      <SelectItem key={`concept:${c.id}`} value={`concept:${c.id}`}>
                        {c.prefLabel} (concept)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            <p
              id={`${id}-link-hint`}
              className={linkIssue ? 'text-destructive text-ui' : 'text-muted-foreground text-ui'}
            >
              {linkIssue ??
                (kind === 'url'
                  ? 'A path, an http(s) address, mailto: or tel:.'
                  : kind === 'entry'
                    ? 'Its content type needs a URL pattern: the item links to the entry’s URL.'
                    : 'Your site routes it by its slug.')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-label`}>Label</Label>
            <Input
              id={`${id}-label`}
              placeholder={kind === 'url' ? 'About us' : 'Leave empty to use its title'}
              aria-invalid={Boolean(issues.label)}
              aria-describedby={issues.label ? `${id}-label-error` : undefined}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            {issues.label && (
              <p id={`${id}-label-error`} className="text-destructive text-ui">
                {issues.label}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Switch id={`${id}-tab`} checked={newTab} onCheckedChange={setNewTab} />
            <Label htmlFor={`${id}-tab`}>Open in a new tab</Label>
          </div>
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <DiscardAsk guard={guard} message="Discard this menu item?">
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy || !chosen || (kind === 'url' && !label.trim())}>
                {busy ? 'Saving…' : item ? 'Save item' : 'Add item'}
              </Button>
            </DiscardAsk>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
