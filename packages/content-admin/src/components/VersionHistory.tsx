import { Ago } from '@commerceworker/content-admin/components/ago';
import { CollapsibleCard } from '@commerceworker/content-admin/components/CollapsibleCard';
import { InlineConfirm } from '@commerceworker/content-admin/components/InlineConfirm';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { RevisionDiff } from '@commerceworker/content-admin/components/RevisionDiff';
import { ToneBadge } from '@commerceworker/content-admin/components/status';
import type { ContentType } from '@commerceworker/domain';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
import { History, RotateCcw } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAssistantEdit } from '../lib/assistant';
import { useClient, useLocalRun } from '../lib/client-context';
import type { VersionDiff } from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** What a version is compared with: the current draft, or what delivery serves. */
type Against = 'draft' | 'published';

/**
 * Timeline of an entry's saved versions with a readable diff against the current draft (or, for an
 * entry that is live, against the published version) and restore.
 * Restore appends a NEW version carrying the old fields, so history is never
 * rewritten — after it runs, the parent reloads the form via `onRestored`. It goes through the
 * assistant, as a confirm card in its panel; when the assistant can't be reached, it asks in place
 * under the version and restores through the API. Asking in place because it can be undone: the
 * version it replaces is still in the list, to restore in turn.
 */
export function VersionHistory(props: {
  entryId: string;
  /** What the assistant's card calls the entry: its title. */
  about?: string;
  /** Current draft version, to flag "current" and pick a diff baseline. */
  currentVersion: number;
  /** Published version (if any), to flag "live". */
  publishedVersion?: number | null;
  /** Whether a version is live, so a version can be compared with it (the server resolves which). */
  isLive?: boolean;
  /** The entry's content type, to name block variants in a diff. */
  contentType?: ContentType;
  /** Whether the editor form holds unsaved edits — restoring discards them,
   * so the confirmation warns before that happens. */
  hasUnsavedChanges?: () => boolean;
  onRestored: () => void;
}) {
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const toast = useToast();
  const invalidate = useInvalidate();
  const edit = useAssistantEdit();
  const versionsQuery = useScopedQuery(['versions', props.entryId], () =>
    client.listVersions(props.entryId),
  );
  const versions = versionsQuery.data ?? [];
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffWith, setDiffWith] = useState<number | null>(null);
  const [against, setAgainst] = useState<Against>('draft');
  // Version awaiting restore confirmation (restore reseeds the form, so it is
  // never a single-click action).
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  // The Restore that asked: it is disabled while the assistant answers, so it has lost focus by
  // the time the question opens.
  const restoreAsked = useRef<HTMLButtonElement | null>(null);

  const compare = (version: number, side: Against) =>
    run(async () => {
      setDiff(await client.diffVersions(props.entryId, version, side));
      setDiffWith(version);
      setAgainst(side);
    });

  const toggleDiff = (version: number) => {
    if (diffWith === version) {
      setDiff(null);
      setDiffWith(null);
      return;
    }
    void compare(version, 'draft');
  };

  // Asks through the assistant's card; without it, in place under the version.
  const requestRestore = (version: number) =>
    run(async () => {
      // The card says what asking in place warns of: restoring discards the form's unsaved edits.
      const what = props.about ? `Version ${version} of ${props.about}` : `Version ${version}`;
      const unsaved = props.hasUnsavedChanges?.()
        ? ' · unsaved edits in the form are discarded'
        : '';
      const r = await edit(
        'entries_restore_version',
        // Held to the draft on screen: one saved since makes the card refuse.
        { id: props.entryId, version, expectedVersion: props.currentVersion },
        what + unsaved,
      );
      if (r === null) setConfirmRestore(version);
      else if ('output' in r) await restored(version);
    });

  const restore = async (version: number) => {
    let done = false;
    await run(async () => {
      await client.restoreVersion(props.entryId, version);
      await restored(version);
      done = true;
    });
    // After `run`: until then the Restore that asked is disabled and can't take focus back.
    if (done) setConfirmRestore(null);
  };

  const restored = async (version: number) => {
    toast.success(`Restored version ${version} as a new draft`);
    setDiff(null);
    setDiffWith(null);
    await invalidate(['versions', props.entryId]);
    props.onRestored();
  };

  return (
    <CollapsibleCard
      title={
        <>
          <History className="size-4" />
          Version history
        </>
      }
      contentClassName="space-y-3"
    >
      {versionsQuery.isLoading ? (
        <>
          <LoadingStatus>Loading versions…</LoadingStatus>
          <ul className="space-y-1">
            {[0, 1, 2].map((i) => (
              <li key={i} aria-hidden="true" className="rounded-md border px-3 py-2">
                <div className="flex min-h-8 items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      <SkeletonText width="1.5rem" />
                    </span>
                    {i === 0 ? <SkeletonPill className="w-14" /> : null}
                    <span className="text-xs">
                      <SkeletonText width="4rem" />
                    </span>
                  </div>
                  {i === 0 ? null : <SkeletonPill className="h-8 w-[5.5rem]" />}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : versions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No versions yet.</p>
      ) : (
        <ul className="space-y-1">
          {versions.map((v) => {
            const isCurrent = v.version === props.currentVersion;
            const isPublished = v.version === props.publishedVersion;
            return (
              <li key={v.version} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">v{v.version}</span>
                    {isCurrent && <Badge variant="secondary">current</Badge>}
                    {isPublished && <ToneBadge tone="ok" label="Live" />}
                    <span className="text-muted-foreground text-xs">
                      {v.createdAt ? <Ago at={v.createdAt} /> : null}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {!isCurrent && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={diffWith === v.version}
                        aria-label={
                          diffWith === v.version
                            ? `Hide changes since version ${v.version}`
                            : `Compare version ${v.version}`
                        }
                        onClick={() => toggleDiff(v.version)}
                        disabled={busy}
                      >
                        {diffWith === v.version ? 'Hide changes' : 'Compare'}
                      </Button>
                    )}
                    {!isCurrent && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          restoreAsked.current = e.currentTarget;
                          void requestRestore(v.version);
                        }}
                        disabled={busy}
                      >
                        <RotateCcw className="size-3.5" />
                        Restore
                      </Button>
                    )}
                  </div>
                </div>

                {confirmRestore === v.version && (
                  <InlineConfirm
                    className="mt-2"
                    message={`Restore version ${v.version}?`}
                    note={`Its fields become a new draft version; history is kept.${
                      props.hasUnsavedChanges?.()
                        ? ' Unsaved edits in the form will be discarded.'
                        : ''
                    }`}
                    cancelLabel="Keep current draft"
                    onCancel={() => setConfirmRestore(null)}
                    returnFocus={() => restoreAsked.current}
                  >
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void restore(v.version)}
                    >
                      Restore version
                    </Button>
                  </InlineConfirm>
                )}

                {diffWith === v.version && diff && (
                  <div className="mt-2 space-y-3 border-t pt-2">
                    {props.isLive ? (
                      <fieldset className="flex flex-wrap items-center gap-1">
                        <legend className="sr-only">Compare version {v.version} with</legend>
                        <span aria-hidden="true" className="text-muted-foreground text-xs">
                          Compare with
                        </span>
                        {(['draft', 'published'] as const).map((side) => (
                          <Button
                            key={side}
                            type="button"
                            variant={against === side ? 'secondary' : 'ghost'}
                            size="xs"
                            aria-pressed={against === side}
                            disabled={busy}
                            onClick={() => void compare(v.version, side)}
                          >
                            {side === 'draft' ? 'Current draft' : 'Live version'}
                          </Button>
                        ))}
                      </fieldset>
                    ) : null}
                    <RevisionDiff
                      diff={diff}
                      contentType={props.contentType}
                      fromLabel={`v${diff.from}`}
                      toLabel={`v${diff.to} (${against === 'draft' ? 'current draft' : 'live'})`}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleCard>
  );
}
