import { Alert, AlertAction, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@commerceworker/ui/alert-dialog';
import { Button } from '@commerceworker/ui/button';
import { Catalog, CatalogRow, CatalogTile } from '@commerceworker/ui/catalog';
import { Checkbox } from '@commerceworker/ui/checkbox';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { KeyRound, Plug } from 'lucide-react';
import { useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { Section } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { When } from '~/cms/components/when';
import {
  type ConnectedApp,
  type CreatedPat,
  type ManagementClient,
  PERMISSION_SCOPES,
  type PersonalAccessToken,
} from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** Plain-language scope names; falls back to the raw scope for anything new. */
const SCOPE_LABEL = new Map<string, string>(
  PERMISSION_SCOPES.map((s) => [s.value, s.label] as const),
);
const scopeText = (scopes: readonly string[]) =>
  scopes.map((s) => SCOPE_LABEL.get(s) ?? s).join(', ');

/**
 * Who and what can reach this space through OAuth, plus the personal access
 * tokens issued in it. Two sibling sections rather than one nested surface —
 * connections are granted by a human clicking approve in another application,
 * tokens are minted here, and they are revoked differently.
 */
export function ConnectedApps(props: { client: ManagementClient }) {
  return (
    <div className="space-y-4">
      <Connections client={props.client} />
      <PersonalAccessTokens client={props.client} />
    </div>
  );
}

function Connections(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();

  const apps = useScopedQuery(['oauth-connections'], () => client.listConnectedApps()).data ?? [];

  const disconnect = async (app: ConnectedApp) => {
    try {
      const { revokedTokens } = await client.revokeConnectedApp(app.clientId, app.subject);
      await invalidate(['oauth-connections']);
      toast.success(
        `${app.clientName} disconnected (${revokedTokens} ${
          revokedTokens === 1 ? 'token' : 'tokens'
        } revoked)`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section
      title="Connected applications"
      description="Applications a person approved through OAuth — MCP clients, assistants, editors. Disconnecting revokes their tokens and the grants behind them, so they can’t refresh back in."
      flush
    >
      {apps.length === 0 ? (
        <p className="px-5 py-4 text-muted-foreground text-sm">No applications are connected.</p>
      ) : (
        <Catalog aria-label="Connected applications">
          {apps.map((app) => (
            <CatalogRow
              key={`${app.clientId}:${app.subject}`}
              media={
                <CatalogTile>
                  <Plug aria-hidden="true" />
                </CatalogTile>
              }
              title={app.clientName}
              meta={
                <span className="flex flex-wrap gap-x-2">
                  <span className="min-w-0 break-words">
                    Authorized by <span>{app.subject}</span>
                  </span>
                  <span title={app.scopes.join(', ')}>
                    Access: {scopeText(app.scopes) || 'None'}
                  </span>
                  {app.tokenCount > 1 && <span>{app.tokenCount} active tokens</span>}
                  <span>
                    {app.lastUsedAt ? (
                      <>
                        Last used <Ago at={app.lastUsedAt} />
                      </>
                    ) : (
                      'Never used'
                    )}
                  </span>
                </span>
              }
              actions={<DisconnectButton name={app.clientName} onConfirm={() => disconnect(app)} />}
            />
          ))}
        </Catalog>
      )}
    </Section>
  );
}

function DisconnectButton(props: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="xs" aria-label={`Disconnect “${props.name}”`}>
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect “{props.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It loses access immediately and can&rsquo;t refresh back in. Anyone using it will need
            to authorize again. This can&rsquo;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onConfirm}>
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const DEFAULT_PAT_SCOPES = ['delivery:read', 'search:read'];

function PersonalAccessTokens(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_PAT_SCOPES);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [busy, setBusy] = useState(false);
  // The raw token is shown exactly once, right after minting.
  const [minted, setMinted] = useState<CreatedPat>();

  const tokens =
    useScopedQuery(['personal-access-tokens'], () => client.listPersonalAccessTokens()).data ?? [];

  const toggle = (scope: string) =>
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    setBusy(true);
    try {
      const days = Number(expiresInDays);
      const created = await client.createPersonalAccessToken({
        name: name.trim(),
        scopes,
        expiresInDays: Number.isFinite(days) && days > 0 ? days : undefined,
      });
      setMinted(created);
      setName('');
      setExpiresInDays('');
      setScopes(DEFAULT_PAT_SCOPES);
      await invalidate(['personal-access-tokens']);
      toast.success('Personal access token created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await client.revokePersonalAccessToken(id);
      await invalidate(['personal-access-tokens']);
      toast.success('Token revoked');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section
      title="Personal access tokens"
      description="For CLI and CI clients that can’t run a browser sign-in. A token can only carry permissions you hold yourself."
      flush
    >
      <div className="space-y-4 p-5">
        {minted && (
          <Alert>
            <KeyRound />
            <AlertTitle>New token — copy it now, it won&rsquo;t be shown again.</AlertTitle>
            <AlertDescription>
              <code className="break-all text-sm text-foreground">{minted.token}</code>
            </AlertDescription>
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(minted.token)}
              >
                Copy
              </Button>
            </AlertAction>
          </Alert>
        )}

        <form className="space-y-3" onSubmit={create}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-56"
              placeholder="What is it for? e.g. release CI"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              className="w-44"
              type="number"
              min={1}
              max={365}
              placeholder="Expires in days"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
              {busy ? 'Creating…' : 'Create token'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-4">
            {PERMISSION_SCOPES.map((s) => (
              <Label key={s.value} className="flex items-center gap-2 font-normal">
                {/* Radix renders a <button role="checkbox">, which an *implicit*
                    (wrapping) label does not name — verified in Chrome's
                    accessibility tree. An explicit htmlFor/id pair does work;
                    aria-label is what the rest of the admin uses. Without it a
                    screen reader announces an unnamed checkbox, which on a
                    permission grant is unusable. */}
                <Checkbox
                  aria-label={s.label}
                  checked={scopes.includes(s.value)}
                  onCheckedChange={() => toggle(s.value)}
                />
                <span>{s.label}</span>
              </Label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Leave the expiry blank for a token that never expires. Scopes you don&rsquo;t hold are
            dropped.
          </p>
        </form>
      </div>

      <div className="border-t">
        {tokens.length === 0 ? (
          <p className="px-5 py-4 text-muted-foreground text-sm">No personal access tokens yet.</p>
        ) : (
          <Catalog aria-label="Personal access tokens">
            {tokens.map((t) => (
              <CatalogRow
                key={t.id}
                media={
                  <CatalogTile>
                    <KeyRound aria-hidden="true" />
                  </CatalogTile>
                }
                title={t.name ?? <span className="text-muted-foreground">Unnamed token</span>}
                meta={
                  <span className="flex flex-wrap gap-x-2">
                    {!t.name && <span>ID ending {idTail(t.id)}</span>}
                    {t.subject && <span className="min-w-0 break-words">Owned by {t.subject}</span>}
                    <span title={t.scopes.join(', ')}>Access: {scopeText(t.scopes) || 'None'}</span>
                    <span>
                      {t.expiresAt ? (
                        <>
                          Expires <When at={t.expiresAt} />
                        </>
                      ) : (
                        'Never expires'
                      )}
                    </span>
                  </span>
                }
                aside={<StatusBadge status={tokenStatus(t)} />}
                actions={
                  t.revoked ? undefined : (
                    <RevokeTokenButton
                      name={t.name ? `“${t.name}”` : `the unnamed token ending ${idTail(t.id)}`}
                      onConfirm={() => revoke(t.id)}
                    />
                  )
                }
              />
            ))}
          </Catalog>
        )}
      </div>
    </Section>
  );
}

/**
 * A token that lapsed on its own reads differently from one somebody revoked,
 * so the two are never collapsed into a single "inactive".
 */
function tokenStatus(token: PersonalAccessToken): string {
  if (token.revoked) return 'revoked';
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

/** The end of a token's id, which tells unnamed tokens apart (UUIDv7 ends in random bits). */
function idTail(id: string): string {
  return id.replace(/-/g, '').slice(-4);
}

/** `name` is ready to read: a quoted name, or how an unnamed token is told apart. */
function RevokeTokenButton(props: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="xs" aria-label={`Revoke ${props.name}`}>
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {props.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything using this token stops working immediately. This can&rsquo;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onConfirm}>
            Revoke token
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
