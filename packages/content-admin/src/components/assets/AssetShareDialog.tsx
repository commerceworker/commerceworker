import { ConfirmDialog } from '@commerceworker/content-admin/components/ConfirmDialog';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { ToneBadge } from '@commerceworker/content-admin/components/status';
import {
  isoToLocalInput,
  SHARE_EXPIRY_CHOICES,
  type ShareExpiryChoice,
  shareExpiresAt,
  timeUntil,
} from '@commerceworker/content-admin/lib/assets';
import { useClient } from '@commerceworker/content-admin/lib/client-context';
import { dateTime } from '@commerceworker/content-admin/lib/format';
import {
  apiErrorMessage,
  apiFieldIssues,
  isForbidden,
  refusedSave,
  saveFailureMessage,
  UNCONFIRMED_SAVE,
} from '@commerceworker/content-admin/lib/management';
import { useInvalidate, useScopedQuery } from '@commerceworker/content-admin/lib/queries';
import { useToast } from '@commerceworker/content-admin/lib/toast';
import { useNow } from '@commerceworker/content-admin/lib/use-now';
import {
  type Asset,
  type AssetShareLink,
  type AssetShareTargetType,
  MAX_SHARE_LINK_SECONDS,
  MAX_SHARE_PASSWORD,
  MIN_SHARE_LINK_SECONDS,
  MIN_SHARE_PASSWORD,
} from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import { SkeletonText } from '@commerceworker/ui/skeleton';
import { Switch } from '@commerceworker/ui/switch';
import { Copy, Link2 } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';

/** What is being shared: one asset or a collection, by the name an editor knows it by. */
export interface ShareTarget {
  readonly type: AssetShareTargetType;
  readonly id: string;
  readonly name: string;
}

const FORBIDDEN =
  'A share link opens files to anyone who holds it, so making, listing and revoking links take ' +
  'the content:publish permission, as publishing does. Ask a space administrator to share it, ' +
  'or for a role that has it.';

/**
 * Share links to an asset or a collection, in a dialog: make one (an expiry from presets or a
 * date of your own, whether files download, an optional password), then copy or revoke the links
 * that still open. A link only ever serves published files: an unpublished asset can't be shared
 * until it is published, and a collection's page leaves its drafts off. A role without
 * content:publish sees why it can't share, never a form that would be refused.
 */
export function AssetShareDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ShareTarget;
  /** For an asset: whether it is published (only a published asset can be shared). */
  published?: boolean;
  /** For an asset: archived, it can't be published until it is restored. */
  archived?: boolean;
  /** The asset was published from here, so it could be shared. */
  onPublished?: (asset: Asset) => void;
  /** A publish from here got no answer, so the asset should be read again. */
  onPublishUnconfirmed?: () => void;
}) {
  const { target } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const now = useNow(60_000);
  const id = useId();
  const key = ['share-links', target.type, target.id];
  const links = useScopedQuery(
    key,
    () => client.listShareLinks({ targetType: target.type, targetId: target.id }),
    { enabled: props.open, silent: true },
  );
  const [choice, setChoice] = useState<ShareExpiryChoice>('7d');
  const [custom, setCustom] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  // A link that didn't answer may exist: the list below is where to check, so it is read again.
  const [unconfirmed, setUnconfirmed] = useState<string>();
  const [mayHaveLanded, setMayHaveLanded] = useState(false);
  // The link just made: it takes focus (its Copy button), so it can be copied at once.
  const [made, setMade] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishFailed, setPublishFailed] = useState<{ said: string; refused: boolean } | null>(
    null,
  );
  // As with a link: a publish that got no answer may have landed.
  const [publishMayHaveLanded, setPublishMayHaveLanded] = useState(false);
  // Published from here: the caller's `published` catches up when its read does.
  const [publishedHere, setPublishedHere] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const revoked = useRef(false);

  // A fresh form each time the dialog opens on a target.
  useEffect(() => {
    if (!props.open) return;
    setChoice('7d');
    setCustom('');
    setAllowDownload(true);
    setPassword('');
    setIssues({});
    setRefusal(null);
    setMade(null);
    setPublishedHere(false);
    setPublishFailed(null);
    setPublishMayHaveLanded(false);
  }, [props.open, target.type, target.id]);

  // Publish asset goes with the warning: the form that replaces it carries the keyboard on.
  useEffect(() => {
    if (publishedHere) {
      formRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    }
  }, [publishedHere]);

  useEffect(() => {
    if (!made) return;
    const copy = list.current?.querySelector<HTMLElement>(
      `[data-link-id="${CSS.escape(made)}"] [data-copy-link]`,
    );
    if (!copy) return;
    copy.focus();
    setMade(null);
  }, [made, links.data]);

  const forbidden = isForbidden(links.error);
  const unpublished = target.type === 'asset' && props.published === false && !publishedHere;
  const archived = unpublished && props.archived === true;
  const active = links.data ?? [];

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setIssues({});
    setRefusal(null);
    setUnconfirmed(undefined);
    const expiresAt = shareExpiresAt(choice, custom, Date.now());
    if (!expiresAt) {
      setIssues({ expiresAt: 'Choose the date and time the link stops opening.' });
      return;
    }
    setBusy(true);
    try {
      const link = await client.createShareLink({
        targetType: target.type,
        targetId: target.id,
        expiresAt,
        allowDownload,
        ...(password ? { password } : {}),
      });
      setPassword('');
      toast.success('Share link created');
      await invalidate(key);
      setMade(link.id);
    } catch (err) {
      const fields = apiFieldIssues(err);
      setIssues(fields);
      if (!refusedSave(err)) {
        setUnconfirmed(UNCONFIRMED_SAVE);
        setMayHaveLanded(true);
        void links.refetch();
      } else if (isForbidden(err)) setRefusal(FORBIDDEN);
      else if (!fields.expiresAt && !fields.password) setRefusal(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Goes live at once, as an asset's Publish does in the library. Refused under an embargo or past
  // an expiry, in the server's words.
  const publish = async () => {
    if (publishing) return;
    setPublishFailed(null);
    setPublishing(true);
    try {
      const asset = await client.publishAsset(target.id);
      toast.success(`Published “${target.name}”`);
      setPublishedHere(true);
      props.onPublished?.(asset);
    } catch (err) {
      const refused = refusedSave(err);
      setPublishFailed({ said: saveFailureMessage(err), refused });
      if (!refused) {
        setPublishMayHaveLanded(true);
        props.onPublishUnconfirmed?.();
      }
    } finally {
      setPublishing(false);
    }
  };

  const revoke = async (link: AssetShareLink) => {
    await client.revokeShareLink(link.id);
    revoked.current = true;
    toast.success('Link revoked; it stops opening within a minute');
    await invalidate(key);
  };
  // After the confirm has gone: it holds focus while it is up, and its row goes with the link.
  const toTheList = (event: Event) => {
    if (!revoked.current) return;
    revoked.current = false;
    event.preventDefault();
    listHeading.current?.focus();
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('The link couldn’t be copied: select it and copy it yourself');
    }
  };

  // A field's error is an alert: heard when it appears, wherever focus is (the submit button).
  const issue = (field: 'expiresAt' | 'password') =>
    issues[field] ? (
      <p id={`${id}-${field}-error`} role="alert" className="text-destructive text-xs">
        {issues[field]}
      </p>
    ) : null;

  const what = target.type === 'asset' ? 'this file' : 'the collection’s files';
  const form = (
    <form
      ref={formRef}
      className="space-y-4"
      onSubmit={create}
      noValidate
      aria-label="New share link"
    >
      {unconfirmed && <DialogError>{unconfirmed}</DialogError>}
      {refusal && (
        <Alert variant="destructive">
          {/* A refused retry doesn't speak for a try before it that may have landed. */}
          <AlertTitle>
            {mayHaveLanded ? 'This try was refused' : 'The link wasn’t created'}
          </AlertTitle>
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-1.5">
        <Label id={`${id}-expiry`}>Expires after</Label>
        <Segmented
          aria-labelledby={`${id}-expiry`}
          aria-describedby={issues.expiresAt ? `${id}-expiresAt-error` : undefined}
          aria-invalid={issues.expiresAt && choice !== 'custom' ? true : undefined}
          value={choice}
          onValueChange={(v) => setChoice(v as ShareExpiryChoice)}
          className="w-full"
        >
          {SHARE_EXPIRY_CHOICES.map((c) => (
            <SegmentedItem key={c.value} value={c.value}>
              {c.label}
            </SegmentedItem>
          ))}
        </Segmented>
        {choice === 'custom' && (
          <div className="space-y-1 pt-1">
            <Label htmlFor={`${id}-custom`} className="text-xs">
              Expires at
            </Label>
            <Input
              id={`${id}-custom`}
              type="datetime-local"
              value={custom}
              min={isoToLocalInput(new Date(now + MIN_SHARE_LINK_SECONDS * 1000).toISOString())}
              max={isoToLocalInput(new Date(now + MAX_SHARE_LINK_SECONDS * 1000).toISOString())}
              onChange={(e) => setCustom(e.target.value)}
              aria-invalid={issues.expiresAt ? true : undefined}
              aria-describedby={`${id}-custom-hint${issues.expiresAt ? ` ${id}-expiresAt-error` : ''}`}
            />
            <p id={`${id}-custom-hint`} className="text-muted-foreground text-xs">
              On your clock. From 5 minutes to 90 days from now.
            </p>
          </div>
        )}
        {issue('expiresAt')}
      </div>
      <div className="flex items-start gap-3">
        <Switch
          id={`${id}-download`}
          checked={allowDownload}
          onCheckedChange={setAllowDownload}
          aria-describedby={`${id}-download-hint`}
        />
        <div className="space-y-0.5">
          <Label htmlFor={`${id}-download`}>Allow downloads</Label>
          <p id={`${id}-download-hint`} className="text-muted-foreground text-xs">
            Otherwise the files open in the browser only.
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-password`}>
          Password <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          minLength={MIN_SHARE_PASSWORD}
          maxLength={MAX_SHARE_PASSWORD}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={issues.password ? true : undefined}
          aria-describedby={`${id}-password-hint${issues.password ? ` ${id}-password-error` : ''}`}
        />
        <p id={`${id}-password-hint`} className="text-muted-foreground text-xs">
          At least {MIN_SHARE_PASSWORD} characters. Asked for before the page opens; send it
          separately from the link.
        </p>
        {issue('password')}
      </div>
      <Button type="submit" disabled={busy}>
        <Link2 aria-hidden="true" />
        {busy ? 'Creating…' : 'Create link'}
      </Button>
    </form>
  );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{target.name}”</DialogTitle>
          <DialogDescription>
            Anyone with the link can view {what} until it expires or you revoke it. Only published
            files are shared
            {target.type === 'collection'
              ? ': drafts in the collection stay off the page until they are published.'
              : '.'}
          </DialogDescription>
        </DialogHeader>

        {links.isPending && props.open ? (
          <div className="space-y-1 text-xs">
            <LoadingStatus>Loading share links…</LoadingStatus>
            <SkeletonText width="80%" />
            <SkeletonText width="60%" />
          </div>
        ) : forbidden ? (
          <Alert variant="warning">
            <AlertTitle>Your role can’t share</AlertTitle>
            <AlertDescription>{FORBIDDEN}</AlertDescription>
          </Alert>
        ) : links.error ? (
          <Alert variant="destructive">
            <AlertTitle>The share links didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(links.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void links.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {archived ? (
              <Alert variant="warning">
                <AlertTitle>Restore it to share it</AlertTitle>
                <AlertDescription>
                  A share link only serves published files, and this asset is archived. Restored, it
                  comes back as a draft to publish.
                </AlertDescription>
              </Alert>
            ) : null}
            {unpublished && publishFailed && !publishFailed.refused ? (
              <DialogError>{publishFailed.said}</DialogError>
            ) : null}
            {unpublished && publishFailed?.refused ? (
              <Alert variant="destructive">
                <AlertTitle>
                  {publishMayHaveLanded ? 'This try was refused' : 'It wasn’t published'}
                </AlertTitle>
                <AlertDescription>{publishFailed.said}</AlertDescription>
              </Alert>
            ) : null}
            {archived ? null : unpublished ? (
              <Alert variant="warning">
                <AlertTitle>Publish it to share it</AlertTitle>
                <AlertDescription>
                  <p>A share link only serves published files, and this asset isn’t published.</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    // Not `disabled`: focus stays on it, for a refusal to find it there.
                    aria-disabled={publishing || undefined}
                    className="mt-2 aria-disabled:opacity-50"
                    onClick={() => void publish()}
                  >
                    {publishing ? 'Publishing…' : 'Publish asset'}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              form
            )}
            <div className="space-y-2">
              <h3
                ref={listHeading}
                tabIndex={-1}
                className="section-title outline-none"
                id={`${id}-active`}
              >
                Active links
              </h3>
              {active.length === 0 ? (
                <p className="text-muted-foreground text-sm">No link opens it now.</p>
              ) : (
                <ul ref={list} aria-labelledby={`${id}-active`} className="divide-y text-sm">
                  {active.map((link) => {
                    const at = Date.parse(link.expiresAt);
                    const when = `${timeUntil(at, now)} (${dateTime(at)})`;
                    return (
                      <li key={link.id} data-link-id={link.id} className="space-y-1.5 py-2">
                        {link.url ? (
                          <code className="block truncate font-mono text-xs" title={link.url}>
                            {link.url}
                          </code>
                        ) : (
                          <p className="text-muted-foreground text-xs">
                            No address: this deployment has no media origin configured.
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground text-xs">Expires {when}</span>
                          {link.hasPassword && <ToneBadge tone="idle" label="Password" />}
                          <ToneBadge
                            tone="idle"
                            label={link.allowDownload ? 'Downloads allowed' : 'View only'}
                          />
                          <div className="ml-auto flex items-center gap-1">
                            {link.url && (
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                data-copy-link=""
                                aria-label={`Copy the link that expires ${dateTime(at)}`}
                                onClick={() => void copy(link.url as string)}
                              >
                                <Copy aria-hidden="true" />
                                Copy
                              </Button>
                            )}
                            <ConfirmDialog
                              message="Revoke this link?"
                              note="It stops opening within a minute. This can’t be undone."
                              confirmLabel="Revoke link"
                              onConfirm={() => revoke(link)}
                              onCloseAutoFocus={toTheList}
                            >
                              {(ask) => (
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  aria-label={`Revoke the link that expires ${dateTime(at)}`}
                                  onClick={ask}
                                >
                                  Revoke
                                </Button>
                              )}
                            </ConfirmDialog>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
