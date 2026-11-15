import type { ContentType, SavedView } from '@commerceworker/domain';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@commerceworker/ui/alert-dialog';
import { Button } from '@commerceworker/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { Switch } from '@commerceworker/ui/switch';
import { Bookmark, ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { useClient, useLocalRun } from '../../lib/client-context';
import {
  type EntryListState,
  listQueryToViewQuery,
  matchesView,
  viewToListState,
} from '../../lib/entry-url';
import { ApiError, apiErrorMessage, apiFieldIssues } from '../../lib/management';
import { useInvalidate, useScopedQuery } from '../../lib/queries';
import { useToast } from '../../lib/toast';

/** The name dialog's two jobs: naming a new view, or renaming the open one. */
type NameDialog = { readonly mode: 'new' } | { readonly mode: 'rename'; readonly view: SavedView };

/** A view over every type shows `sys.*` columns only: a type's field isn't its to keep. */
const columnsFit = (view: SavedView, columns: EntryListState['columns']) =>
  view.contentTypeApiId !== null || (columns ?? []).every((c) => c.startsWith('sys.'));

/** Whether the list's columns are the view's own, the default for both or the same list. */
const sameColumns = (view: SavedView, columns: EntryListState['columns']) =>
  JSON.stringify(view.columns) === JSON.stringify(columns);

/**
 * The entries list's views menu: pick a saved view (yours, then the space's shared ones), save
 * what the list shows now as a new view, or save it over the open one, rename it, share it with
 * the space or take it back, and delete it.
 *
 * A view only fills in the list's URL (its filters, sort, search and columns), so a view and a
 * link always agree, and the list runs as the reader's own query: a shared view never shows
 * anyone more than their role lets them see. Sharing, and changing a shared view, take
 * content:manage (`canShare`); without it the shared views are there to pick, not to change.
 * Stopping sharing is the view's creator's alone (`subject`): anyone else saves a copy instead.
 */
export function SavedViewsMenu(props: {
  type: ContentType;
  state: EntryListState;
  onApply(state: EntryListState): void;
  canShare: boolean;
  /** Who is reading, as a view's `createdBy` names them. */
  subject?: string;
}) {
  const { type, state, canShare } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const { busy, run } = useLocalRun();
  const [naming, setNaming] = useState<NameDialog | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const viewsQuery = useScopedQuery(['saved-views', type.apiId], () =>
    client.listSavedViews(type.apiId),
  );
  const views = viewsQuery.data ?? [];
  const current = state.viewId ? views.find((v) => v.id === state.viewId) : undefined;
  const changed = current ? !matchesView(state, current) : false;
  const editable = (v: SavedView) => v.visibility === 'personal' || canShare;
  const canChangeSharing = (v: SavedView) =>
    canShare && (v.visibility === 'personal' || v.createdBy === props.subject);
  // Field columns can't be saved over a view of every type: only the query is, if it changed.
  const saveable =
    current !== undefined &&
    changed &&
    (columnsFit(current, state.columns) ||
      !matchesView({ ...state, columns: current.columns }, current));
  // A personal view here is always the reader's own: the api lists no one else's.
  const mine = views.filter((v) => v.visibility === 'personal');
  const shared = views.filter((v) => v.visibility === 'shared');
  const refresh = () => invalidate(['saved-views']);

  const pick = (id: string) => {
    const view = views.find((v) => v.id === id);
    // "All entries" clears the view and everything it filled in; the trash stays the trash.
    props.onApply(view ? viewToListState(view) : { query: {} });
  };

  const saveChanges = (view: SavedView) =>
    run(async () => {
      const fit = columnsFit(view, state.columns);
      let saved: SavedView;
      try {
        saved = await client.updateSavedView(view.id, {
          query: listQueryToViewQuery(state.query, view.query),
          // Only when they changed: columns are checked against this environment's type, and a
          // query-only edit shouldn't be refused over a column it never touched.
          ...(fit && !sameColumns(view, state.columns) ? { columns: state.columns ?? null } : {}),
          revision: view.revision,
        });
      } catch (err) {
        // Saved by someone else meanwhile: the menu reads the view again, so this list's changes
        // can be saved over that, on purpose, the next time.
        if (err instanceof ApiError && err.status === 409) await refresh();
        throw err;
      }
      await refresh();
      const next = viewToListState(saved);
      props.onApply(fit ? next : { ...next, columns: state.columns });
      toast.success(`Saved “${saved.name}”`);
    });

  const toggleShare = (view: SavedView) =>
    run(async () => {
      const visibility = view.visibility === 'shared' ? 'personal' : 'shared';
      const saved = await client.updateSavedView(view.id, { visibility, revision: view.revision });
      await refresh();
      toast.success(
        visibility === 'shared'
          ? `“${saved.name}” is shared with everyone in the space`
          : `“${saved.name}” is yours alone now`,
      );
    });

  const remove = (view: SavedView) =>
    run(async () => {
      await client.deleteSavedView(view.id);
      await refresh();
      if (state.viewId === view.id) props.onApply({ ...state, viewId: undefined });
      toast.success(`Deleted “${view.name}”`);
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Stays enabled while a change saves: a disabled button can't take focus back from a
              dialog. The menu's changes wait instead. */}
          <Button type="button" variant="outline" size="sm">
            <Bookmark aria-hidden="true" className="size-4" />
            {current && <span className="sr-only">View: </span>}
            <span className="max-w-48 truncate">{current ? current.name : 'Views'}</span>
            {changed && (
              <span className="text-muted-foreground">
                <span aria-hidden="true">·</span> edited
              </span>
            )}
            <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
          <DropdownMenuRadioGroup value={current?.id ?? ''} onValueChange={pick}>
            <DropdownMenuRadioItem value="">All {type.name} entries</DropdownMenuRadioItem>
            {mine.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Your views</DropdownMenuLabel>
                {mine.map((v) => (
                  <DropdownMenuRadioItem key={v.id} value={v.id}>
                    <span className="truncate">{v.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </>
            )}
            {shared.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Shared with the space</DropdownMenuLabel>
                {shared.map((v) => (
                  <DropdownMenuRadioItem key={v.id} value={v.id}>
                    <span className="truncate">{v.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </>
            )}
          </DropdownMenuRadioGroup>
          {viewsQuery.isError && (
            <p className="px-2 py-1.5 text-muted-foreground text-ui">
              Saved views couldn’t be loaded.
            </p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setNaming({ mode: 'new' })}>
            Save as new view…
          </DropdownMenuItem>
          {current && editable(current) && (
            <>
              {saveable && (
                <DropdownMenuItem disabled={busy} onSelect={() => void saveChanges(current)}>
                  Save changes to “{current.name}”
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => setNaming({ mode: 'rename', view: current })}
              >
                Rename…
              </DropdownMenuItem>
              {canChangeSharing(current) && (
                <DropdownMenuItem disabled={busy} onSelect={() => void toggleShare(current)}>
                  {current.visibility === 'shared' ? 'Stop sharing' : 'Share with the space'}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onSelect={() => setDeleting(current)}
              >
                Delete view…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {naming && (
        <ViewNameDialog
          dialog={naming}
          canShare={canShare}
          onOpenChange={(open) => !open && setNaming(null)}
          onSave={async ({ name, shared: share }) => {
            if (naming.mode === 'rename') {
              const saved = await client.updateSavedView(naming.view.id, {
                name,
                revision: naming.view.revision,
              });
              await refresh();
              toast.success(`Renamed to “${saved.name}”`);
              return;
            }
            const created = await client.createSavedView({
              name,
              contentTypeApiId: type.apiId,
              visibility: share ? 'shared' : 'personal',
              query: listQueryToViewQuery(state.query, current?.query),
              ...(state.columns ? { columns: state.columns } : {}),
            });
            await refresh();
            props.onApply(viewToListState(created));
            toast.success(
              share ? `Saved “${created.name}” for everyone` : `Saved “${created.name}”`,
            );
          }}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.visibility === 'shared'
                ? 'Everyone in the space loses this view. Entries aren’t touched.'
                : 'The view goes; the entries it lists aren’t touched.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep view</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const view = deleting;
                setDeleting(null);
                if (view) void remove(view);
              }}
            >
              Delete view
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Names a new view (and, with content:manage, shares it), or renames the open one. */
function ViewNameDialog(props: {
  dialog: NameDialog;
  canShare: boolean;
  onOpenChange(open: boolean): void;
  onSave(input: { name: string; shared: boolean }): Promise<void>;
}) {
  const { dialog } = props;
  const id = useId();
  const [name, setName] = useState(dialog.mode === 'rename' ? dialog.view.name : '');
  const [shared, setShared] = useState(false);
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssue(undefined);
    try {
      await props.onSave({ name: name.trim(), shared });
      props.onOpenChange(false);
    } catch (err) {
      const fields = apiFieldIssues(err);
      setIssue(fields.name ?? Object.values(fields)[0] ?? apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialog.mode === 'rename' ? 'Rename view' : 'Save view'}</DialogTitle>
          <DialogDescription>
            {dialog.mode === 'rename'
              ? 'The view keeps its filters, sort and columns.'
              : 'Keeps the filters, search, sort and columns shown now, to open again in one step.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              placeholder="Drafts to review"
              maxLength={80}
              aria-invalid={Boolean(issue)}
              aria-describedby={issue ? `${id}-issue` : undefined}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {issue && (
              <p id={`${id}-issue`} className="text-destructive text-ui">
                {issue}
              </p>
            )}
          </div>
          {dialog.mode === 'new' && props.canShare && (
            <div className="flex items-start gap-3">
              <Switch
                id={`${id}-shared`}
                checked={shared}
                onCheckedChange={setShared}
                aria-describedby={`${id}-shared-hint`}
              />
              <div className="space-y-0.5">
                <Label htmlFor={`${id}-shared`}>Share with the space</Label>
                <p id={`${id}-shared-hint`} className="text-muted-foreground text-ui">
                  Everyone who can read this content type can open it. Each person sees only the
                  entries and fields their role allows.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : dialog.mode === 'rename' ? 'Rename' : 'Save view'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
