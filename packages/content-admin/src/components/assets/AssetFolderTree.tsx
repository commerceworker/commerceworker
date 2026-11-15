import { ConfirmButton } from '@commerceworker/content-admin/components/InlineConfirm';
import {
  type FolderSelection,
  folderLabel,
  folderRows,
} from '@commerceworker/content-admin/lib/assets';
import type { AssetFolder } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@commerceworker/ui/sheet';
import { Folder, FolderCog, FolderOpen, FolderPlus, Inbox, Layers, Pencil } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';

const same = (a: FolderSelection, b: FolderSelection) =>
  a.kind === b.kind && (a.kind !== 'folder' || (b.kind === 'folder' && a.id === b.id));

const ALL = '__all__';
const ROOT = '__root__';
const toOption = (v: FolderSelection) => (v.kind === 'all' ? ALL : v.kind === 'root' ? ROOT : v.id);
const fromOption = (v: string): FolderSelection =>
  v === ALL ? { kind: 'all' } : v === ROOT ? { kind: 'root' } : { kind: 'folder', id: v };

/** One row of the sidebar's lists (folders, collections): the open one is `aria-current`. */
export function TreeButton(props: {
  current: boolean;
  folderId?: string;
  icon: ReactNode;
  children: ReactNode;
  /** An accessible name that says more than the visible text (and starts with it). */
  label?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-current={props.current ? 'true' : undefined}
      data-folder-id={props.folderId}
      onClick={props.onClick}
      className={cn(
        'hit-area relative flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm focus-visible:outline-none transition-[background-color] focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        props.current
          ? 'current-item bg-muted font-medium [&_svg]:text-brand'
          : 'hover:bg-muted/60',
      )}
    >
      {props.icon}
      <span className="truncate">{props.children}</span>
    </button>
  );
}

/** A one-line form for a folder's name: creating one, or renaming it. */
function NameForm(props: {
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.initial ?? '');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const onCancel = useRef(props.onCancel);
  onCancel.current = props.onCancel;
  // Escape closes the form only: caught before an enclosing sheet sees it (as InlineConfirm does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !form.current?.contains(e.target as Node | null)) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.onSubmit(name.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form ref={form} onSubmit={submit} className="flex flex-col gap-2 px-1 py-1">
      <Input
        aria-label={props.label}
        value={name}
        autoFocus
        maxLength={128}
        onChange={(e) => setName(e.target.value)}
        className="h-8"
      />
      <div className="flex gap-1">
        <Button type="submit" size="xs" disabled={busy || !name.trim()}>
          {props.submitLabel}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * New folder, rename and delete for the open folder. When the name form closes, focus goes back to
 * the button that opened it; a created folder takes focus itself (`onCreated`).
 */
function FolderActions(props: {
  open: AssetFolder | undefined;
  onCreate: (name: string, parentId?: string) => Promise<AssetFolder | undefined>;
  onCreated: (folder: AssetFolder) => void;
  onRename: (folder: AssetFolder, name: string) => Promise<void>;
  onDelete: (folder: AssetFolder) => Promise<void>;
}) {
  const { open } = props;
  const [mode, setMode] = useState<'idle' | 'create' | 'rename'>('idle');
  const [returnTo, setReturnTo] = useState<'create' | 'rename' | null>(null);
  const createBtn = useRef<HTMLButtonElement>(null);
  const renameBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode !== 'idle' || !returnTo) return;
    (returnTo === 'rename' ? renameBtn : createBtn).current?.focus();
    setReturnTo(null);
  }, [mode, returnTo]);
  const close = (from: 'create' | 'rename') => {
    setMode('idle');
    setReturnTo(from);
  };

  if (mode === 'create') {
    return (
      <NameForm
        label={open ? `New folder in “${open.name}”` : 'New folder name'}
        submitLabel="Create folder"
        onCancel={() => close('create')}
        onSubmit={async (name) => {
          const created = await props.onCreate(name, open?.id);
          if (created) {
            setMode('idle');
            props.onCreated(created);
          } else close('create');
        }}
      />
    );
  }
  if (mode === 'rename' && open) {
    return (
      <NameForm
        label={`Rename “${open.name}”`}
        initial={open.name}
        submitLabel="Rename"
        onCancel={() => close('rename')}
        onSubmit={async (name) => {
          await props.onRename(open, name);
          close('rename');
        }}
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      <Button
        ref={createBtn}
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => setMode('create')}
      >
        <FolderPlus aria-hidden="true" />
        {open ? 'New subfolder' : 'New folder'}
      </Button>
      {open && (
        <>
          <Button
            ref={renameBtn}
            type="button"
            size="xs"
            variant="ghost"
            aria-label={`Rename “${open.name}”`}
            onClick={() => setMode('rename')}
          >
            <Pencil aria-hidden="true" />
            Rename
          </Button>
          <ConfirmButton
            message={`Delete “${open.name}”?`}
            note="Only an empty folder can be deleted."
            confirmLabel="Delete folder"
            onConfirm={() => void props.onDelete(open)}
          >
            {(ask) => (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`Delete “${open.name}”`}
                onClick={ask}
              >
                Delete
              </Button>
            )}
          </ConfirmButton>
        </>
      )}
    </div>
  );
}

/**
 * The library's folders. From md, a tree: everything, the assets in no folder, then each folder in
 * a list nested inside its parent's. On a phone, a select of folder paths, with the folder actions
 * in a sheet. A new folder goes inside the one that is open (at the root otherwise); the open
 * folder can be renamed, or deleted once it is empty.
 */
export function AssetFolderTree(props: {
  folders: readonly AssetFolder[];
  value: FolderSelection;
  onChange: (next: FolderSelection) => void;
  /** Resolves to the new folder, or undefined when it wasn't created (the caller said why). */
  onCreate: (name: string, parentId?: string) => Promise<AssetFolder | undefined>;
  onRename: (folder: AssetFolder, name: string) => Promise<void>;
  onDelete: (folder: AssetFolder) => Promise<void>;
  /** A collection is open instead: no folder is current, and the folder actions wait. */
  inactive?: boolean;
}) {
  const { folders, onChange } = props;
  // While a collection is open nothing here is current (a selection matching no row).
  const value: FolderSelection = props.inactive ? { kind: 'folder', id: '' } : props.value;
  const open = value.kind === 'folder' ? folders.find((f) => f.id === value.id) : undefined;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const tree = useRef<HTMLUListElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const createdInSheet = useRef(false);

  // A created folder takes focus once the tree draws it (hidden on a phone: the sheet's close
  // hands focus to the select instead).
  useEffect(() => {
    if (!focusId) return;
    const button = tree.current?.querySelector<HTMLElement>(
      `[data-folder-id="${CSS.escape(focusId)}"]`,
    );
    if (!button) return;
    button.focus();
    setFocusId(null);
  }, [focusId, folders]);

  const children = new Map<string, AssetFolder[]>();
  for (const f of folders) {
    const key = f.parentId ?? '';
    children.set(key, [...(children.get(key) ?? []), f]);
  }
  // Each folder is a list item; its subfolders are a list inside it, so the nesting is read out.
  const items = (parentId: string): ReactNode[] =>
    [...(children.get(parentId) ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => {
        const current = value.kind === 'folder' && value.id === folder.id;
        const below = items(folder.id);
        return (
          <li key={folder.id}>
            <TreeButton
              current={current}
              folderId={folder.id}
              icon={current ? <FolderOpen /> : <Folder />}
              onClick={() => onChange({ kind: 'folder', id: folder.id })}
            >
              {folder.name}
            </TreeButton>
            {below.length > 0 && <ul className="flex flex-col gap-0.5 pl-4">{below}</ul>}
          </li>
        );
      });

  const actions = (inSheet: boolean) => (
    <FolderActions
      open={open}
      onCreate={props.onCreate}
      onRename={props.onRename}
      onDelete={async (f) => {
        if (inSheet) setSheetOpen(false);
        await props.onDelete(f);
      }}
      onCreated={(f) => {
        if (inSheet) {
          createdInSheet.current = true;
          setSheetOpen(false);
        } else setFocusId(f.id);
      }}
    />
  );

  return (
    <nav aria-label="Folders" className="min-w-0">
      {/* Phones: the folder is a select of paths; what can be done to folders is in a sheet. */}
      <div className="flex items-center gap-2 md:hidden">
        <NativeSelect
          ref={select}
          aria-label="Folder"
          value={props.inactive ? '' : toOption(value)}
          onChange={(e) => onChange(fromOption(e.target.value))}
          wrapperClassName="min-w-0 flex-1"
        >
          {props.inactive && (
            <NativeSelectOption value="" disabled>
              Choose a folder
            </NativeSelectOption>
          )}
          <NativeSelectOption value={ALL}>All assets</NativeSelectOption>
          <NativeSelectOption value={ROOT}>Not in a folder</NativeSelectOption>
          {folderRows(folders).map(({ folder }) => (
            <NativeSelectOption key={folder.id} value={folder.id}>
              {folderLabel(folder, folders)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Folder actions"
          onClick={() => setSheetOpen(true)}
        >
          <FolderCog aria-hidden="true" />
        </Button>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            bodyClassName="px-4 pb-6"
            onCloseAutoFocus={(e) => {
              if (!createdInSheet.current) return;
              // The new folder is open: the select showing it is where the person is.
              createdInSheet.current = false;
              e.preventDefault();
              select.current?.focus();
            }}
          >
            <SheetHeader className="pr-10 pl-0">
              <SheetTitle>{open ? open.name : 'Folders'}</SheetTitle>
              <SheetDescription>
                {open ? folderLabel(open, folders) : 'Add a folder at the top of the library.'}
              </SheetDescription>
            </SheetHeader>
            {sheetOpen && actions(true)}
          </SheetContent>
        </Sheet>
      </div>

      {/* From md: the tree, its nesting as nested lists. */}
      <div className="hidden flex-col gap-0.5 md:flex">
        <ul ref={tree} className="flex flex-col gap-0.5">
          <li>
            <TreeButton
              current={same(value, { kind: 'all' })}
              icon={<Layers />}
              onClick={() => onChange({ kind: 'all' })}
            >
              All assets
            </TreeButton>
          </li>
          <li>
            <TreeButton
              current={same(value, { kind: 'root' })}
              icon={<Inbox />}
              onClick={() => onChange({ kind: 'root' })}
            >
              Not in a folder
            </TreeButton>
          </li>
          {items('')}
        </ul>
        <div className="mt-2 border-t pt-2">{actions(false)}</div>
      </div>
    </nav>
  );
}
