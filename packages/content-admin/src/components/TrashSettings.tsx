import { ConfirmDialog } from '@commerceworker/content-admin/components/ConfirmDialog';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { Section } from '@commerceworker/content-admin/components/page';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import { SkeletonText } from '@commerceworker/ui/skeleton';
import { useEffect, useId, useState } from 'react';
import { plural } from '../lib/format';
import { apiErrorMessage, type ManagementClient } from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** The longest retention the API accepts, about ten years. */
export const MAX_RETENTION_DAYS = 3650;
/** What the days field starts at when retention is turned on from off. */
const SUGGESTED_DAYS = 30;

/** The days typed, as the API takes them, or null when they aren't a whole number in range. */
export function retentionDaysOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return days >= 1 && days <= MAX_RETENTION_DAYS ? days : null;
}

/**
 * Settings → Trash: how long trashed entries are kept. Off (the default) keeps them until someone
 * restores them or deletes them for good; on, an hourly sweep deletes for good every entry that
 * has been in the trash longer than the days set, except one published entries still link to.
 * Turning it on, or shortening it, deletes what is already old enough at the next sweep, so that
 * save asks first, in place. Changing it needs space:admin; the API's refusal says so.
 */
export function TrashSettings(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const id = useId();
  // Silent: a failed load is said here, in place, with Retry, not as a toast.
  const settings = useScopedQuery(['trash-settings'], () => client.getTrashSettings(), {
    silent: true,
  });
  const saved = settings.data?.retentionDays;

  const [on, setOn] = useState(false);
  const [days, setDays] = useState(String(SUGGESTED_DAYS));
  const [busy, setBusy] = useState(false);
  // The form follows what is saved whenever that changes (it loaded, or a save came back).
  useEffect(() => {
    if (saved === undefined) return;
    setOn(saved !== null);
    setDays(String(saved ?? SUGGESTED_DAYS));
  }, [saved]);

  const typed = retentionDaysOf(days);
  const next = on ? typed : null;
  const invalid = on && typed === null;
  const changed = saved !== undefined && !invalid && next !== saved;
  // Deleting sooner than before (or at all, from off) removes trash that is there today.
  const deletesSooner = next !== null && (saved === null || (saved !== undefined && next < saved));

  const write = async () => {
    await client.setTrashSettings({ retentionDays: next });
    await invalidate(['trash-settings']);
    toast.success(
      next === null
        ? 'Trashed entries are kept until someone deletes them'
        : `Trashed entries are deleted after ${plural(next, 'day')}`,
    );
  };
  const save = async () => {
    setBusy(true);
    try {
      await write();
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Trash" description="How long entries stay in the trash.">
      {saved === undefined && settings.isError ? (
        // A failed load is said as one, never as a setting that looks off.
        <Alert variant="destructive">
          <AlertTitle>The trash setting didn’t load</AlertTitle>
          <AlertDescription>
            <p>{apiErrorMessage(settings.error)}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void settings.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : saved === undefined ? (
        <div aria-busy="true">
          <LoadingStatus>Loading the trash setting…</LoadingStatus>
          <SkeletonText width="16rem" />
        </div>
      ) : (
        <div className="space-y-4">
          <Segmented
            aria-label="Trash retention"
            value={on ? 'on' : 'off'}
            onValueChange={(v) => setOn(v === 'on')}
          >
            <SegmentedItem value="off">Keep until deleted</SegmentedItem>
            <SegmentedItem value="on">Delete after a while</SegmentedItem>
          </Segmented>
          {on ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-days`}>Days in the trash</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-days`}
                  inputMode="numeric"
                  className="w-28"
                  value={days}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? `${id}-error ${id}-note` : `${id}-note`}
                  onChange={(e) => setDays(e.target.value)}
                />
                <span className="text-muted-foreground text-sm">days</span>
              </div>
              {invalid ? (
                <p id={`${id}-error`} className="text-destructive text-xs">
                  A whole number of days, from 1 to {MAX_RETENTION_DAYS}.
                </p>
              ) : null}
            </div>
          ) : null}
          <p id={`${id}-note`} className="max-w-measure text-muted-foreground text-sm">
            {on
              ? `An hourly sweep permanently deletes entries that have been in the trash longer than ${typed ? plural(typed, 'day') : 'that'}, with their version history. An entry other published entries link to is kept, so their links don’t break.`
              : 'Entries stay in the trash until someone restores them or deletes them permanently.'}
          </p>
          {deletesSooner ? (
            <ConfirmDialog
              message={`Delete trashed entries after ${plural(next ?? 0, 'day')}?`}
              note="Entries already in the trash longer than that are deleted permanently at the next hourly sweep. That can’t be undone."
              cancelLabel="Keep as is"
              confirmLabel="Save and delete"
              onConfirm={write}
            >
              {(ask) => (
                <Button type="button" size="sm" disabled={busy || !changed} onClick={ask}>
                  Save
                </Button>
              )}
            </ConfirmDialog>
          ) : (
            <Button type="button" size="sm" disabled={busy || !changed} onClick={() => void save()}>
              Save
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}
