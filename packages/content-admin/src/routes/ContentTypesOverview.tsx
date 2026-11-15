import {
  CloneContentTypeDialog,
  DeleteContentTypeDialog,
} from '@commerceworker/content-admin/components/ContentTypeActions';
import { ContentTypeDeleteJobCard } from '@commerceworker/content-admin/components/ContentTypeDeleteJob';
import { ContentTypeDialog } from '@commerceworker/content-admin/components/ContentTypeDialog';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { Empty, PageHeader } from '@commerceworker/content-admin/components/page';
import { StatusBadge } from '@commerceworker/content-admin/components/status';
import { contentTypeIcon } from '@commerceworker/content-admin/lib/content-type-icons';
import { count, plural } from '@commerceworker/content-admin/lib/format';
import { Link } from '@commerceworker/content-admin/router';
import { typeMark } from '@commerceworker/content-admin/shared/initials';
import type { ContentType, ContentTypeDraft } from '@commerceworker/domain';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Skeleton, SkeletonText } from '@commerceworker/ui/skeleton';
import { MoreHorizontalIcon, Plus, Shapes } from 'lucide-react';
import { useRef, useState } from 'react';
import { useClient } from '../lib/client-context';
import { apiErrorMessage, type ContentTypeEntryCounts } from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';

/**
 * Content-types overview: one row per type with what an editor needs before opening it (how many
 * entries it holds, and how many of them wait to be published), and create / edit / publish for
 * the schema. A type reads as published unless it says otherwise: only a draft schema carries a
 * badge, since a badge every row shares tells nobody anything.
 */
export function ContentTypesOverview() {
  const { client, run } = useClient();
  const { types, typesPending, reload, deleteJob } = useContentOutlet();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; initial?: ContentType }>({ open: false });
  // A type's menu: Clone and Delete, each in its own dialog.
  const [cloning, setCloning] = useState<ContentType | null>(null);
  const [deleting, setDeleting] = useState<ContentType | null>(null);
  const [query, setQuery] = useState('');
  // The API returns every type, so the filter is safe to run here.
  const needle = query.trim().toLowerCase();
  const shown = types.filter(
    (ct) =>
      !needle || `${ct.name} ${ct.apiId} ${ct.description ?? ''}`.toLowerCase().includes(needle),
  );
  const invalidate = useInvalidate();
  // Each row's ⋯ button: after a delete, focus goes on to the next row's.
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  // Set when a delete removed the type at once: its row (and button) go with it.
  const deletedNow = useRef(false);
  /** After a delete: the next row's button, or the page's heading when it was the last row. */
  const focusAfterDelete = (apiId: string) => (event: Event) => {
    if (!deletedNow.current) return;
    event.preventDefault();
    deletedNow.current = false;
    const next = shown[shown.findIndex((t) => t.apiId === apiId) + 1];
    const to = next ? triggers.current.get(next.apiId) : undefined;
    if (to) return to.focus();
    const heading = document.querySelector<HTMLElement>('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  };
  // Under the entries prefix, so every entry mutation's invalidation refreshes them too. Silent:
  // the counts are a summary beside the list, which works without them.
  const countsQuery = useScopedQuery(['entries', 'counts'], () => client.contentTypeEntryCounts(), {
    silent: true,
  });
  const countsFor = (apiId: string): ContentTypeEntryCounts | undefined =>
    countsQuery.data?.find((c) => c.contentType === apiId);

  // A failure goes back to the dialog, which keeps the form and says what happened.
  const save = async (draft: ContentTypeDraft) => {
    let failed: unknown;
    await run(async () => {
      try {
        await client.saveContentType(draft);
        // The draft has landed by now, so a refused publish doesn't mean nothing was saved.
        await client.publishContentType(draft.apiId).catch((err) => {
          throw new Error(`The draft saved but wasn’t published: ${apiErrorMessage(err)}`);
        });
        reload();
        toast.success(`Content type “${draft.name}” saved`);
      } catch (err) {
        failed = err;
      }
    });
    if (failed !== undefined) throw failed;
  };

  const publish = (ct: ContentType) =>
    run(async () => {
      await client.publishContentType(ct.apiId);
      reload();
      toast.success(`Published “${ct.name}”`);
    });

  /** A count figure: a skeleton while loading, a dash when the counts couldn't be read. */
  const figure = (n: number | undefined) =>
    countsQuery.isPending ? (
      <Skeleton className="inline-block h-4 w-8 align-middle" />
    ) : n === undefined ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className={n === 0 ? 'text-muted-foreground' : undefined}>{count(n)}</span>
    );

  return (
    <div>
      <PageHeader
        title="Content"
        subtitle="Each content type is a schema; its entries are the content. Open one to browse and edit its entries."
        actions={
          <Button size="sm" onClick={() => setDialog({ open: true })}>
            <Plus aria-hidden="true" /> New content type
          </Button>
        }
      />
      {/* Kept by the Content layout, so it is still here after a visit to an entry. */}
      <ContentTypeDeleteJobCard job={deleteJob} />
      {typesPending ? (
        // Never "No content types yet" before the types have arrived.
        <div className="card overflow-clip" aria-busy="true">
          <LoadingStatus>Loading content types…</LoadingStatus>
          <div className="divide-y text-sm">
            {['38%', '52%', '44%', '60%'].map((w) => (
              <div key={w} className="flex items-center gap-3 px-4 py-3">
                <SkeletonText width={w} className="flex-1" />
                <Skeleton className="h-4 w-8" />
              </div>
            ))}
          </div>
        </div>
      ) : types.length === 0 ? (
        <Empty icon={<Shapes />} title="No content types yet" className="card">
          A content type defines the fields its entries have. Make one to start writing content, or{' '}
          <Link to="/content/space-import" className="underline underline-offset-4">
            import a space export
          </Link>{' '}
          with its model, entries and assets.
        </Empty>
      ) : (
        <div className="card overflow-clip">
          <ListToolbar summary={`${shown.length} shown`}>
            <ListSearch
              label="Search content types"
              placeholder="Search content types"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
            />
          </ListToolbar>
          {shown.length === 0 ? (
            <CatalogEmpty onClear={() => setQuery('')}>
              No content types match “{query.trim()}”.
            </CatalogEmpty>
          ) : (
            <Catalog aria-label="Content types" className="pt-0">
              {shown.map((ct) => {
                const n = countsFor(ct.apiId);
                // A type without an icon shows its initials, so such rows still look apart.
                const Icon = contentTypeIcon(ct.icon);
                return (
                  <CatalogRow
                    key={ct.apiId}
                    media={
                      <CatalogTile aria-hidden="true">
                        {Icon ? <Icon /> : typeMark(ct.name || ct.apiId)}
                      </CatalogTile>
                    }
                    title={
                      <Link
                        // A singleton opens its one entry, as the sidebar does.
                        to={ct.singleton ? `/content/${ct.apiId}/entry` : `/content/${ct.apiId}`}
                        className="hit-area font-medium text-foreground hover:underline"
                      >
                        {ct.name}
                      </Link>
                    }
                    meta={
                      <span className="flex flex-wrap gap-x-2">
                        <span className="break-all font-mono">{ct.apiId}</span>
                        {ct.singleton ? <span>One entry only</span> : null}
                        {/* The schema's size, not the editor's work: the aside keeps to that. */}
                        <span>{plural(ct.fields.length, 'field')}</span>
                        {ct.description ? (
                          <span className="line-clamp-2 w-full max-w-measure">
                            {ct.description}
                          </span>
                        ) : null}
                      </span>
                    }
                    aside={
                      <>
                        {ct.status === 'draft' ? <StatusBadge status="draft" /> : null}
                        <CatalogFigure label="Entries">{figure(n?.total)}</CatalogFigure>
                        <CatalogFigure label="Drafts">{figure(n?.draft)}</CatalogFigure>
                        <CatalogFigure label="Changed">{figure(n?.changed)}</CatalogFigure>
                      </>
                    }
                    actions={
                      <div className="flex justify-end gap-1">
                        {ct.status === 'draft' ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label={`Publish “${ct.name}”`}
                            onClick={() => publish(ct)}
                          >
                            Publish
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="xs"
                          aria-label={`Edit “${ct.name}”`}
                          onClick={() => setDialog({ open: true, initial: ct })}
                        >
                          Edit
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              ref={(el) => {
                                if (el) triggers.current.set(ct.apiId, el);
                                else triggers.current.delete(ct.apiId);
                              }}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`More actions for “${ct.name}”`}
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-auto min-w-40">
                            <DropdownMenuItem onSelect={() => setCloning(ct)}>
                              Clone…
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setDeleting(ct)}
                            >
                              Delete…
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    }
                  />
                );
              })}
            </Catalog>
          )}
        </div>
      )}

      {cloning && (
        <CloneContentTypeDialog
          key={cloning.apiId}
          source={cloning}
          open
          onOpenChange={(open) => !open && setCloning(null)}
          onCloned={(clone) => {
            reload();
            toast.success(`Cloned as “${clone.name}”, a draft`);
          }}
        />
      )}
      {deleting && (
        <DeleteContentTypeDialog
          key={deleting.apiId}
          type={deleting}
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          onCloseAutoFocus={focusAfterDelete(deleting.apiId)}
          onDeleted={(job) => {
            if (job) deleteJob.start(job, deleting);
            else {
              deletedNow.current = true;
              reload();
              void invalidate(['entries']);
              toast.success(`Deleted “${deleting.name}”`);
            }
          }}
        />
      )}

      {/* Key on the target so the form seeds fresh each time it opens. */}
      <ContentTypeDialog
        key={`${dialog.open}:${dialog.initial?.apiId ?? 'new'}`}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initial={dialog.initial}
        onSave={save}
      />
    </div>
  );
}
