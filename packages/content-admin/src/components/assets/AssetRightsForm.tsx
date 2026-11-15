import { InlineConfirm } from '@commerceworker/content-admin/components/InlineConfirm';
import { StatusBadge } from '@commerceworker/content-admin/components/status';
import { When } from '@commerceworker/content-admin/components/when';
import {
  isoToLocalInput,
  localInputToIso,
  RIGHTS_BADGE,
  rightsState,
  timeUntil,
} from '@commerceworker/content-admin/lib/assets';
import { useClient } from '@commerceworker/content-admin/lib/client-context';
import {
  apiErrorMessage,
  apiFieldIssues,
  isForbidden,
  refusedSave,
  UNCONFIRMED_SAVE,
} from '@commerceworker/content-admin/lib/management';
import { useToast } from '@commerceworker/content-admin/lib/toast';
import { useNow } from '@commerceworker/content-admin/lib/use-now';
import type { Asset, AssetRights } from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { DialogError } from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { useEffect, useState } from 'react';

type Field = keyof AssetRights;

interface Values {
  readonly license: string;
  readonly credit: string;
  /** `datetime-local` values, on the reader's clock. */
  readonly expiresAt: string;
  readonly embargoUntil: string;
}

const valuesOf = (rights: AssetRights | undefined): Values => ({
  license: rights?.license ?? '',
  credit: rights?.credit ?? '',
  expiresAt: isoToLocalInput(rights?.expiresAt),
  embargoUntil: isoToLocalInput(rights?.embargoUntil),
});

/** Where the reader's clock is, so a date typed here is read as the instant they meant. */
const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
};

/**
 * An asset's usage rights: the license and credit Delivery shows with it, when it must stop being
 * delivered, and the earliest it may be. The saved rights are read out first as a status
 * ("Expires in 3 days", "Under embargo until …"). Dates are typed on the reader's clock and sent
 * as instants with a zone. Setting rights takes content:publish, because they decide whether the
 * asset is delivered; a role without it is told so in place. Mount it with a `key` per asset.
 */
export function AssetRightsForm(props: {
  asset: Asset;
  onAssetChange?: (asset: Asset) => void;
  /** Says whether the form holds rights not yet saved, so the sheet can ask before it closes. */
  onDirty?: (dirty: boolean) => void;
  /** Says when a save is under way, so the sheet holds rather than offer to discard it. */
  onSaving?: (saving: boolean) => void;
  /** Says a save failed, so the sheet can tell a refusal from a save that may have landed. */
  onSaveFailed?: (err: unknown) => void;
}) {
  const { asset } = props;
  const { client } = useClient();
  const toast = useToast();
  const now = useNow(60_000);
  const [values, setValues] = useState<Values>(() => valuesOf(asset.rights));
  const dirty = JSON.stringify(values) !== JSON.stringify(valuesOf(asset.rights));
  const { onDirty } = props;
  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<{ forbidden: boolean; message: string } | null>(null);
  // A save with no answer to go on: it may have gone through, so it can't say it wasn't saved.
  const [unconfirmed, setUnconfirmed] = useState<string>();
  // A refused retry doesn't speak for a save before it that may have landed.
  const [mayHaveLanded, setMayHaveLanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const { onSaving } = props;
  useEffect(() => {
    onSaving?.(busy);
    return () => onSaving?.(false);
  }, [busy, onSaving]);
  // An expiry already past on a published asset takes it out of Delivery at once: asked first.
  const [confirmExpire, setConfirmExpire] = useState(false);
  const published = asset.status === 'published';

  const set = (field: Field, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setIssues(({ [`rights.${field}`]: _, [field]: __, ...rest }) => rest);
  };
  // A 422 names `rights.expiresAt`; a malformed body would name the bare field.
  const issueOf = (field: Field) => issues[`rights.${field}`] ?? issues[field];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const expiresAt = localInputToIso(values.expiresAt);
    const unchanged = expiresAt !== null && expiresAt === asset.rights?.expiresAt;
    if (published && expiresAt && Date.parse(expiresAt) <= Date.now() && !unchanged) {
      setConfirmExpire(true);
      return;
    }
    void save();
  };

  const save = async () => {
    setConfirmExpire(false);
    setUnconfirmed(undefined);
    setBusy(true);
    setRefusal(null);
    try {
      const next = await client.setAssetRights(asset.id, {
        license: values.license.trim() || null,
        credit: values.credit.trim() || null,
        expiresAt: localInputToIso(values.expiresAt),
        embargoUntil: localInputToIso(values.embargoUntil),
      });
      setIssues({});
      setValues(valuesOf(next.rights));
      toast.success('Rights saved');
      props.onAssetChange?.(next);
    } catch (err) {
      props.onSaveFailed?.(err);
      const fields = apiFieldIssues(err);
      setIssues(fields);
      const named = (['license', 'credit', 'expiresAt', 'embargoUntil'] as const).some(
        (f) => fields[`rights.${f}`] ?? fields[f],
      );
      if (!refusedSave(err)) {
        setUnconfirmed(UNCONFIRMED_SAVE);
        setMayHaveLanded(true);
      } else if (isForbidden(err)) {
        setRefusal({
          forbidden: true,
          message:
            'Rights decide whether the asset is delivered, so setting them takes the content:publish permission. Ask a space administrator to set them, or for a role that has it.',
        });
      } else if (!named) {
        // Refused for the asset as a whole (an embargo on a published asset), not one field.
        setRefusal({ forbidden: false, message: apiErrorMessage(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  const field = (
    name: Field,
    label: string,
    input: Omit<React.ComponentProps<typeof Input>, 'id' | 'value' | 'onChange'>,
    hint?: string,
  ) => {
    const id = `asset-rights-${name}`;
    const issue = issueOf(name);
    const describedBy = [issue ? `${id}-error` : '', hint ? `${id}-hint` : '']
      .filter(Boolean)
      .join(' ');
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          value={values[name]}
          onChange={(e) => set(name, e.target.value)}
          aria-invalid={issue ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...input}
        />
        {hint && (
          <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
            {hint}
          </p>
        )}
        {issue && (
          <p id={`${id}-error`} className="text-destructive text-xs">
            {issue}
          </p>
        )}
      </div>
    );
  };

  const tz = zone();
  const clock = tz ? `On your clock (${tz}). Empty for none.` : 'On your clock. Empty for none.';

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <RightsStatus rights={asset.rights} now={now} />
      {refusal && (
        <Alert variant={refusal.forbidden ? 'warning' : 'destructive'}>
          <AlertTitle>
            {refusal.forbidden
              ? 'Your role can’t set rights'
              : mayHaveLanded
                ? 'This try was refused'
                : 'The rights weren’t saved'}
          </AlertTitle>
          <AlertDescription>{refusal.message}</AlertDescription>
        </Alert>
      )}
      {unconfirmed && <DialogError>{unconfirmed}</DialogError>}
      {field('license', 'License', { maxLength: 500, placeholder: 'CC BY 4.0, Getty editorial…' })}
      {field('credit', 'Credit', { maxLength: 500, placeholder: 'Photo: Ada Lovelace' })}
      {field(
        'expiresAt',
        'Expires at',
        { type: 'datetime-local' },
        `${clock} The asset is unpublished then.`,
      )}
      {field(
        'embargoUntil',
        'Embargo until',
        { type: 'datetime-local' },
        published
          ? `${clock} It is published, so an embargo can’t be set now: unpublish it first.`
          : `${clock} Publishing is refused before then.`,
      )}
      {confirmExpire ? (
        <InlineConfirm
          message="Expire it now?"
          note="That expiry has passed, so it stops being delivered at once."
          onCancel={() => setConfirmExpire(false)}
        >
          <Button type="button" variant="destructive" size="sm" onClick={() => void save()}>
            Expire now
          </Button>
        </InlineConfirm>
      ) : (
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save rights'}
        </Button>
      )}
    </form>
  );
}

/** The saved rights as a status: expired, expiring (and when), under embargo, or what is set. */
function RightsStatus({ rights, now }: { rights: AssetRights | undefined; now: number }) {
  const state = rightsState(rights, now);
  const expires = rights?.expiresAt ? Date.parse(rights.expiresAt) : Number.NaN;
  const sentence = !state ? (
    Number.isFinite(expires) ? (
      <>
        Expires <When at={rights?.expiresAt} />.
      </>
    ) : (
      'No expiry or embargo.'
    )
  ) : state.state === 'expired' ? (
    <>
      Expired <When at={state.at} />. It isn’t delivered; extend or clear the expiry to publish it
      again.
    </>
  ) : state.state === 'expiring' ? (
    <>
      Expires {timeUntil(Date.parse(state.at), now)} (<When at={state.at} />
      ). It is unpublished then.
    </>
  ) : (
    <>
      Under embargo until <When at={state.at} />. It can be published from then on.
    </>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="rights-status">
      {state && (
        <StatusBadge
          status={RIGHTS_BADGE[state.state].status}
          label={RIGHTS_BADGE[state.state].label}
        />
      )}
      <p className="min-w-0 flex-1">{sentence}</p>
    </div>
  );
}
