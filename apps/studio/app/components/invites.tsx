import { Button } from '@commerceworker/ui/button';
import { Catalog, CatalogFigure, CatalogRow, CatalogTile } from '@commerceworker/ui/catalog';
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
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Mail } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { Confirm } from '~/components/confirm';
import { CopyButton } from '~/components/copy-button';
import { Field } from '~/components/field';
import { Empty, Section } from '~/components/page';
import { ToneBadge } from '~/components/status';
import { StepUpField } from '~/components/step-up-field';
import type { StepUpMethod } from '~/lib/auth.server';
import { INVITE_LABEL, INVITE_TONE, type Invite } from '~/lib/invites';
import { ROLE_LABELS, ROLES, type Role } from '~/lib/roles';

/** The space role presets, in order (the api resolves a name to the space's seeded role). */
export const SPACE_PRESETS = [
  ['viewer', 'Viewer'],
  ['approver', 'Approver'],
  ['editor', 'Editor'],
  ['manager', 'Manager'],
  ['admin', 'Administrator'],
] as const;

/** What an invite action answers: a link to show once, a refusal, or what was done. */
export type InviteResult = { link?: { email: string; url: string; expiresAt: string } } & {
  error?: string;
  done?: string;
};

const until = (iso: string) =>
  new Date(iso).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' });

/** A new link, shown once, with the one way to take it away: Copy. */
export function InviteLink({
  email,
  url,
  expiresAt,
}: {
  email: string;
  url: string;
  expiresAt: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      className="rounded-md border border-wait/40 bg-wait/10 p-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <p className="font-medium">Invitation link for {email}</p>
      <p className="mt-0.5 max-w-measure text-muted-foreground text-xs">
        Send it to them privately. It works once, until {until(expiresAt)}, and is shown only now.
        If this deployment sends email, they get a link of their own by email too.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-sm bg-card px-2 py-1.5 font-mono text-sm">
          {url}
        </code>
        <CopyButton text={url} />
      </div>
    </div>
  );
}

/** Invite someone: their email, their deployment role, and optionally a role in one space. */
export function InviteDialog({
  open,
  onOpenChange,
  spaces,
  stepUp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaces: { id: string; name: string }[];
  stepUp: StepUpMethod | null;
}) {
  const fetcher = useFetcher<InviteResult>();
  const [role, setRole] = useState<Role>('member');
  const [space, setSpace] = useState('');
  const result = fetcher.data;
  const busy = fetcher.state !== 'idle';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setRole('member');
          setSpace('');
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite a person</DialogTitle>
          <DialogDescription>
            They get a link that works once and choose their own password, or use single sign-on.
          </DialogDescription>
        </DialogHeader>
        {result?.link ? (
          <>
            <InviteLink {...result.link} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <fetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="invite" />
            <Field label="Email">
              <Input
                name="email"
                type="email"
                required
                autoComplete="off"
                placeholder="name@company.com"
              />
            </Field>
            <Field label="Role">
              <NativeSelect
                name="role"
                value={role}
                className="h-9 w-full"
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {ROLES.map((r) => (
                  <NativeSelectOption key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            {spaces.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Space" hint="Optional">
                  <NativeSelect
                    name="space"
                    value={space}
                    className="h-9 w-full"
                    onChange={(e) => setSpace(e.target.value)}
                  >
                    <NativeSelectOption value="">No space yet</NativeSelectOption>
                    {spaces.map((s) => (
                      <NativeSelectOption key={s.id} value={s.id}>
                        {s.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Role in the space">
                  <NativeSelect
                    name="spaceRole"
                    defaultValue="editor"
                    disabled={!space}
                    className="h-9 w-full"
                  >
                    {SPACE_PRESETS.map(([value, label]) => (
                      <NativeSelectOption key={value} value={value}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
            ) : null}
            {role === 'admin' ? <StepUpField method={stepUp} next="/team" /> : null}
            {result?.error ? <DialogError>{result.error}</DialogError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Inviting…' : 'Create invitation'}
              </Button>
            </DialogFooter>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The invitations that can still be resent or revoked, with the dialog that makes one. */
export function InvitesSection({
  invites,
  spaces,
  stepUp,
}: {
  /** Null when the api couldn't be asked. */
  invites: Invite[] | null;
  spaces: { id: string; name: string }[];
  stepUp: StepUpMethod | null;
}) {
  const [inviting, setInviting] = useState(false);
  const [asking, setAsking] = useState<{ id: string; intent: 'resend' | 'revoke' } | null>(null);
  const fetcher = useFetcher<InviteResult>();
  const busy = fetcher.state !== 'idle';
  const shown = fetcher.data;
  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;
  return (
    <Section
      title="Invitations"
      flush
      actions={
        <Button size="sm" type="button" onClick={() => setInviting(true)}>
          Invite a person
        </Button>
      }
    >
      <InviteDialog open={inviting} onOpenChange={setInviting} spaces={spaces} stepUp={stepUp} />
      {shown?.link ? (
        <div className="p-4">
          <InviteLink {...shown.link} />
        </div>
      ) : null}
      {shown?.error ? (
        <p role="alert" className="px-4 pt-3 text-destructive text-sm">
          {shown.error}
        </p>
      ) : null}
      {shown?.done ? (
        <p role="status" className="px-4 pt-3 text-sm">
          {shown.done}
        </p>
      ) : null}
      {invites === null ? (
        <p role="alert" className="p-4 text-destructive text-sm">
          Invitations couldn’t be loaded. Reload the page to try again.
        </p>
      ) : invites.length ? (
        <Catalog aria-label="Invitations">
          {invites.map((i) => (
            <Fragment key={i.id}>
              <CatalogRow
                media={
                  <CatalogTile>
                    <Mail aria-hidden="true" />
                  </CatalogTile>
                }
                title={i.email}
                meta={
                  <span className="flex flex-wrap gap-x-2">
                    <span>{ROLE_LABELS[i.role]}</span>
                    {i.grants.map((g) => (
                      <span key={g.spaceId}>{spaceName(g.spaceId)}</span>
                    ))}
                    {i.emailedAt ? <span>Emailed</span> : null}
                  </span>
                }
                aside={
                  <>
                    <ToneBadge tone={INVITE_TONE[i.status]} label={INVITE_LABEL[i.status]} />
                    <CatalogFigure label="Expires">{until(i.expiresAt)}</CatalogFigure>
                  </>
                }
                actions={
                  <span className="flex flex-wrap items-center justify-end gap-1">
                    {(['resend', 'revoke'] as const).map((intent) => (
                      <Button
                        key={intent}
                        size="xs"
                        variant="ghost"
                        type="button"
                        data-ask={`${i.id}:${intent}`}
                        aria-label={`${
                          intent === 'revoke'
                            ? 'Revoke'
                            : i.status === 'expired'
                              ? 'Send a new link'
                              : 'Resend'
                        } for ${i.email}`}
                        aria-expanded={asking?.id === i.id && asking.intent === intent}
                        onClick={() => setAsking({ id: i.id, intent })}
                      >
                        {intent === 'revoke'
                          ? 'Revoke…'
                          : i.status === 'expired'
                            ? 'Send a new link…'
                            : 'Resend…'}
                      </Button>
                    ))}
                  </span>
                }
              />
              {asking?.id === i.id ? (
                <li>
                  <fetcher.Form
                    method="post"
                    className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2"
                    onSubmit={() => setAsking(null)}
                  >
                    <input type="hidden" name="intent" value={`invite-${asking.intent}`} />
                    <input type="hidden" name="id" value={i.id} />
                    <Confirm
                      message={
                        asking.intent === 'revoke'
                          ? `Revoke the invitation for ${i.email}? Its links stop working.`
                          : `Send ${i.email} a new link? The old one stops working.`
                      }
                      cancelLabel="Keep"
                      onCancel={() => setAsking(null)}
                      className="flex-1"
                    >
                      {/* A new link to an admin's seat asks who you are first, as inviting one does. */}
                      {asking.intent === 'resend' && i.role === 'admin' ? (
                        <StepUpField method={stepUp} next="/team" />
                      ) : null}
                      <Button
                        size="sm"
                        variant={asking.intent === 'revoke' ? 'destructive' : 'default'}
                        type="submit"
                        disabled={busy}
                      >
                        {asking.intent === 'revoke' ? 'Revoke' : 'Send new link'}
                      </Button>
                    </Confirm>
                  </fetcher.Form>
                </li>
              ) : null}
            </Fragment>
          ))}
        </Catalog>
      ) : (
        <Empty>No open invitations. Invite someone to send them a link that works once.</Empty>
      )}
    </Section>
  );
}
