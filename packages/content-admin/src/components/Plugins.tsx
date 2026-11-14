import { Confirmation } from '@commerceworker/content-admin/components/ai/Confirmation';
import {
  DiscardAsk,
  GuardCancel,
  useDiscardGuard,
} from '@commerceworker/content-admin/components/discard-guard';
import { PluginSettingsSheet } from '@commerceworker/content-admin/components/PluginSettingsSheet';
import { EmptyState, Section } from '@commerceworker/content-admin/components/page';
import { ToneBadge } from '@commerceworker/content-admin/components/status';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
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
import { Catalog, CatalogRow, CatalogTile } from '@commerceworker/ui/catalog';
import { Checkbox } from '@commerceworker/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { MoreHorizontalIcon, Puzzle } from 'lucide-react';
import { Fragment, useState } from 'react';
import {
  type InspectedPluginPackage,
  type InstalledPluginSummary,
  type ManagementClient,
  PLUGIN_CAPABILITIES,
  type PluginManifestInput,
  UNENFORCEABLE_PLUGIN_CAPABILITIES,
  UNPROVIDED_PLUGIN_CAPABILITIES,
} from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useStoppable } from '../lib/use-stoppable';

const QUERY_KEY = ['plugins'];

const CAPABILITY = new Map(PLUGIN_CAPABILITIES.map((c) => [c.value, c] as const));
/** Falls back to the raw string: an unknown capability is the one to show verbatim. */
const capabilityLabel = (value: string) => CAPABILITY.get(value)?.label ?? value;

/** When each hook fires, in the words of someone deciding whether to allow it. */
const HOOK_LABEL: Record<string, string> = {
  'entry:beforeSave': 'every entry save',
  'entry:beforePublish': 'every publish',
  'entry:beforeTrash': 'every move to trash',
  'entry:beforePurge': 'every permanent delete',
  'asset:beforeCreate': 'every upload',
};
const hookText = (hooks: readonly string[]) =>
  hooks.map((h) => HOOK_LABEL[h] ?? h).join(', ') || '—';

/** What a plugin actually runs with — requested ∩ approved. */
const grantOf = (p: InstalledPluginSummary) =>
  p.grantedCapabilities ??
  p.approvedCapabilities.filter((c) => p.requestedCapabilities.includes(c));

/**
 * Plugins run third-party code inside a write, before it lands — so this screen
 * is a consent surface first and a list second. Everything here exists to make
 * the grant legible before it is made: what the code will run on, what it will
 * be able to do, and what it asked for that it did not get.
 */
export function Plugins(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [installing, setInstalling] = useState(false);
  const [upgrading, setUpgrading] = useState<InstalledPluginSummary>();
  const [configuring, setConfiguring] = useState<InstalledPluginSummary>();

  const plugins = useScopedQuery(QUERY_KEY, () => client.listPlugins()).data ?? [];

  const act = async (message: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await invalidate(QUERY_KEY);
      toast.success(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <Section
        title="Plugins"
        description="Code that runs inside a write, before it lands — it can change an entry, add validation errors, or refuse the operation. Each plugin runs in its own sandbox with no network access, and can only do what someone approved here."
        flush={plugins.length > 0}
        actions={
          <Button type="button" onClick={() => setInstalling(true)}>
            Install plugin
          </Button>
        }
      >
        {plugins.length === 0 ? (
          <EmptyState
            icon={Puzzle}
            title="No plugins installed"
            description="A plugin is a manifest and a bundle. Installing one shows you exactly what it is asking to do before anything runs."
          />
        ) : (
          <Catalog aria-label="Plugins">
            {plugins.map((p) => (
              <PluginRow
                key={p.id}
                plugin={p}
                onToggle={(enabled) =>
                  act(enabled ? `${p.name} enabled` : `${p.name} disabled`, () =>
                    client.setPluginEnabled(p.id, enabled),
                  )
                }
                onUninstall={() => act(`${p.name} uninstalled`, () => client.uninstallPlugin(p.id))}
                onApprove={(approved) =>
                  act(`${p.name}: capabilities approved`, () =>
                    client.approvePluginCapabilities(p.id, approved),
                  )
                }
                onUpgrade={() => setUpgrading(p)}
                onSettings={() => setConfiguring(p)}
              />
            ))}
          </Catalog>
        )}
      </Section>

      <InstallPluginDialog
        open={installing}
        onOpenChange={setInstalling}
        onInstall={async (input) => {
          await client.installPlugin(input);
          await invalidate(QUERY_KEY);
          toast.success(`${input.manifest.name} installed — enable it when you are ready`);
        }}
        onInspect={(packageUrl, signal) => client.inspectPluginPackage({ packageUrl }, signal)}
        onInstallFromUrl={async ({ name, ...input }) => {
          await client.installPluginFromUrl(input);
          await invalidate(QUERY_KEY);
          toast.success(`${name} installed — enable it when you are ready`);
        }}
      />

      {configuring && (
        <PluginSettingsSheet
          client={client}
          plugin={configuring}
          onOpenChange={(open) => {
            if (!open) setConfiguring(undefined);
          }}
        />
      )}

      {upgrading && (
        <UpgradePluginDialog
          plugin={upgrading}
          onOpenChange={(open) => {
            if (!open) setUpgrading(undefined);
          }}
          onUpgrade={async (input) => {
            const next = await client.upgradePlugin(upgrading.id, input);
            await invalidate(QUERY_KEY);
            toast.success(
              next.enabled || !upgrading.enabled
                ? `${next.name} upgraded to v${next.version}`
                : `${next.name} upgraded to v${next.version} — disabled until you enable it`,
            );
          }}
        />
      )}
    </>
  );
}

function PluginRow(props: {
  plugin: InstalledPluginSummary;
  onToggle: (enabled: boolean) => void;
  onUninstall: () => void;
  onApprove: (approved: string[]) => Promise<void>;
  onUpgrade: () => void;
  onSettings: () => void;
}) {
  const { plugin } = props;
  const granted = grantOf(plugin);
  const [reviewing, setReviewing] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [approved, setApproved] = useState<string[]>([]);
  // What it asked for and did not get. Shown because a plugin behaving oddly is
  // usually a plugin doing without something, and that is invisible otherwise.
  const declined = plugin.requestedCapabilities.filter((c) => !granted.includes(c));
  // Starting a plugin whose manifest predates capabilities is a fresh decision.
  const blocked = Boolean(plugin.needsReapproval) && !plugin.enabled;

  const review = () => {
    setApproved([...granted]);
    setReviewing(true);
  };
  const widens = approved.some((c) => !granted.includes(c));

  return (
    <Fragment>
      <CatalogRow
        media={
          <CatalogTile>
            <Puzzle aria-hidden="true" />
          </CatalogTile>
        }
        title={plugin.name}
        meta={
          <span className="flex flex-wrap gap-x-2">
            <span className="break-all font-mono">{plugin.id}</span>
            <span>v{plugin.version}</span>
            <span>
              {plugin.hooks.length === 0 ? 'Runs on nothing' : `Runs on ${hookText(plugin.hooks)}`}
            </span>
            <span title={granted.join(', ')}>
              {granted.length === 0
                ? 'Can only inspect what it is given'
                : `Can: ${granted.map(capabilityLabel).join(', ')}`}
            </span>
            {declined.length > 0 && (
              <span>Asked for, not granted: {declined.map(capabilityLabel).join(', ')}</span>
            )}
          </span>
        }
        aside={
          // Text, not color alone. A disabled plugin is a normal resting state, not a fault, so it
          // reads as neutral; one waiting on a capability review is the one that needs attention.
          plugin.needsReapproval ? (
            <ToneBadge tone="wait" label="Needs review" />
          ) : (
            <ToneBadge
              tone={plugin.enabled ? 'ok' : 'idle'}
              label={plugin.enabled ? 'Running' : 'Disabled'}
            />
          )
        }
        actions={
          <span className="flex justify-end gap-1">
            {/* Access stays out of the ⋯: this screen is a consent surface first. */}
            {blocked ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Review access for “${plugin.name}”`}
                onClick={review}
              >
                Review access
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} “${plugin.name}”`}
                  onClick={() => props.onToggle(!plugin.enabled)}
                >
                  {plugin.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`Access for “${plugin.name}”`}
                  onClick={review}
                >
                  Access
                </Button>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`More actions for “${plugin.name}”`}
                >
                  <MoreHorizontalIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-40">
                {/* Named per plugin: a list of identical "Settings" says nothing to a screen reader
                    going through the page's controls. */}
                <DropdownMenuItem
                  aria-label={`${plugin.name} settings`}
                  onSelect={props.onSettings}
                >
                  Settings…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onUpgrade}>Upgrade…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setUninstalling(true)}>
                  Uninstall…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        }
      />
      <UninstallDialog
        name={plugin.name}
        open={uninstalling}
        onOpenChange={setUninstalling}
        onConfirm={props.onUninstall}
      />
      {reviewing && (
        <li>
          <Confirmation
            title={`Approve what “${plugin.name}” can do?`}
            note={
              plugin.needsReapproval
                ? 'It was installed before plugins declared capabilities, so it is shown asking for exactly what it already has. Keep it or narrow it.'
                : widens
                  ? 'Granting more stops the plugin until you enable it again.'
                  : 'It keeps its current state; the change applies from its next run.'
            }
            applyLabel={widens ? 'Approve and disable' : 'Approve'}
            dismissLabel="Cancel"
            onDismiss={() => setReviewing(false)}
            onApply={() => {
              setReviewing(false);
              void props.onApprove(approved);
            }}
          >
            <CapabilityChoices
              requested={plugin.requestedCapabilities}
              approved={approved}
              onChange={setApproved}
              idPrefix={`review-${plugin.id}`}
            />
          </Confirmation>
        </li>
      )}
    </Fragment>
  );
}

/**
 * One checkbox per requested capability, in plain language.
 *
 * Shared by install, upgrade and review, so the words a person consents to are
 * the same wherever they consent. `isNew` marks what an upgrade asks for that
 * the installed version never did — the part of an upgrade worth reading.
 */
function CapabilityChoices(props: {
  requested: readonly string[];
  approved: readonly string[];
  onChange: (approved: string[]) => void;
  idPrefix: string;
  isNew?: (capability: string) => boolean;
}) {
  const toggle = (capability: string) =>
    props.onChange(
      props.approved.includes(capability)
        ? props.approved.filter((c) => c !== capability)
        : [...props.approved, capability],
    );
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">It is asking to:</legend>
      {props.requested.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing — it can only inspect what it is given.
        </p>
      )}
      {props.requested.map((capability) => {
        const meta = CAPABILITY.get(capability);
        const blocked = UNENFORCEABLE_PLUGIN_CAPABILITIES.includes(capability);
        const unprovided = UNPROVIDED_PLUGIN_CAPABILITIES.includes(capability);
        const id = `${props.idPrefix}-cap-${capability}`;
        return (
          <div key={capability} className="flex items-start gap-2">
            {/* Radix renders a <button role="checkbox">, which a wrapping
                label does not name. aria-label is what the rest of the admin
                uses; without it a screen reader announces an unnamed
                checkbox, which on a permission grant is unusable. */}
            <Checkbox
              id={id}
              aria-label={meta?.label ?? capability}
              disabled={blocked}
              checked={props.approved.includes(capability)}
              onCheckedChange={() => toggle(capability)}
            />
            <Label htmlFor={id} className="font-normal leading-tight block">
              <span className={blocked ? 'text-muted-foreground line-through' : ''}>
                {meta?.label ?? capability}
              </span>
              {props.isNew?.(capability) && (
                <span className="ml-2 inline-flex align-middle">
                  <ToneBadge tone="wait" label="New" />
                </span>
              )}
              <span className="block text-xs text-muted-foreground">
                {meta?.detail ?? capability}
                {unprovided &&
                  ' Not available on this deployment yet, so approving it grants nothing for now.'}
              </span>
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Asks before uninstalling. Opened from the row's ⋯, and closing goes back to it. */
function UninstallDialog(props: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Uninstall “{props.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its code, settings, stored data and capability grant are all removed, and can’t be
            brought back. Content it already changed stays as it is. Installing it again means
            approving its capabilities again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onConfirm}>
            Uninstall
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Two steps on purpose: choose the files, then read what they say and decide.
 *
 * Collapsing them would put the consent checkboxes on screen before there is
 * anything to consent to, which trains people to click through the step that
 * matters most.
 */
function InstallPluginDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (input: {
    manifest: PluginManifestInput;
    bundle: string;
    approvedCapabilities: string[];
  }) => Promise<void>;
  onInspect: (packageUrl: string, signal: AbortSignal) => Promise<InspectedPluginPackage>;
  onInstallFromUrl: (input: {
    packageUrl: string;
    expectedChecksum: string;
    approvedCapabilities: string[];
    name: string;
  }) => Promise<void>;
}) {
  const [mode, setMode] = useState<'files' | 'url'>('files');
  const [manifest, setManifest] = useState<PluginManifestInput>();
  const [bundle, setBundle] = useState<string>();
  const [approved, setApproved] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [packageUrl, setPackageUrl] = useState('');
  // Fetching a package only reads: it stays closable, where installing holds the dialog.
  const [inspecting, setInspecting] = useState(false);
  const inspection = useStoppable();
  // What the server verified. Pinned on install, so a release swapped in
  // between the two calls is refused rather than installed under this approval.
  const [inspected, setInspected] = useState<InspectedPluginPackage>();

  const reset = () => {
    setManifest(undefined);
    setBundle(undefined);
    setApproved([]);
    setError(undefined);
    setPackageUrl('');
    setInspected(undefined);
  };

  const acceptManifest = (parsed: PluginManifestInput) => {
    setManifest(parsed);
    // Pre-approve what it asked for, minus anything nothing here can enforce.
    setApproved(parsed.capabilities.filter((c) => !UNENFORCEABLE_PLUGIN_CAPABILITIES.includes(c)));
  };

  const inspect = async () => {
    const signal = inspection.start();
    setInspecting(true);
    setError(undefined);
    try {
      const found = await props.onInspect(packageUrl.trim(), signal);
      if (signal.aborted) return;
      setInspected(found);
      acceptManifest(found.manifest);
    } catch (err) {
      if (signal.aborted) return;
      setInspected(undefined);
      setManifest(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setInspecting(false);
    }
  };

  const close = (open: boolean) => {
    if (!open) {
      inspection.stop();
      setInspecting(false);
      reset();
    }
    props.onOpenChange(open);
  };
  const guard = useDiscardGuard({
    saving: busy,
    open: props.open,
    dirty: Boolean(manifest || bundle || packageUrl.trim()),
    onOpenChange: close,
  });

  const readManifest = async (file: File) => {
    setError(undefined);
    try {
      const parsed = JSON.parse(await file.text()) as PluginManifestInput;
      if (!parsed?.id || !parsed.name || !Array.isArray(parsed.capabilities)) {
        throw new Error('That file is not a plugin manifest.');
      }
      // Approving is then a decision to *narrow*, which is the only direction
      // consent can move without a second look at the manifest.
      acceptManifest(parsed);
    } catch (err) {
      setManifest(undefined);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const readBundle = async (file: File) => {
    setBundle(await file.text());
  };

  const ready = mode === 'files' ? Boolean(manifest && bundle) : Boolean(inspected);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'url' && inspected) {
        await props.onInstallFromUrl({
          packageUrl: packageUrl.trim(),
          expectedChecksum: inspected.checksum,
          approvedCapabilities: approved,
          name: inspected.manifest.name,
        });
      } else if (manifest && bundle) {
        await props.onInstall({ manifest, bundle, approvedCapabilities: approved });
      }
      close(false);
    } catch (err) {
      setError(guard.saveFailed(err));
    } finally {
      setBusy(false);
    }
  };

  const unenforceable = (manifest?.capabilities ?? []).filter((c) =>
    UNENFORCEABLE_PLUGIN_CAPABILITIES.includes(c),
  );

  return (
    <Dialog open={props.open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Install a plugin</DialogTitle>
          <DialogDescription>
            It will not run until you enable it, and it can only do what you approve here.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="inline-flex gap-1 rounded-lg bg-muted/40 p-1">
            {(['files', 'url'] as const).map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={mode === option ? 'default' : 'ghost'}
                onClick={() => {
                  setMode(option);
                  reset();
                }}
              >
                {option === 'files' ? 'From files' : 'From a URL'}
              </Button>
            ))}
          </div>

          {mode === 'url' && (
            <div className="space-y-1">
              <Label htmlFor="plugin-package-url">Package URL (https)</Label>
              <div className="flex gap-2">
                <Input
                  id="plugin-package-url"
                  type="url"
                  placeholder="https://plugins.example.com/seo/1.2.0.json"
                  value={packageUrl}
                  onChange={(e) => {
                    setPackageUrl(e.target.value);
                    // A URL that changed invalidates what was fetched for the
                    // previous one; leaving the old manifest on screen would
                    // mean approving one thing and installing another.
                    setInspected(undefined);
                    setManifest(undefined);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={inspecting || !packageUrl.trim()}
                  onClick={() => void inspect()}
                >
                  {inspecting ? 'Fetching…' : 'Fetch'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The server downloads it, checks the bundle against the checksum the package
                declares, and shows you what it found before anything is installed.
              </p>
            </div>
          )}

          <div className={mode === 'files' ? 'grid gap-3 sm:grid-cols-2' : 'hidden'}>
            <div className="space-y-1">
              <Label htmlFor="plugin-manifest">Manifest (.json)</Label>
              <input
                id="plugin-manifest"
                type="file"
                accept="application/json,.json"
                className="w-full text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readManifest(file);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="plugin-bundle">Bundle (.js)</Label>
              <input
                id="plugin-bundle"
                type="file"
                accept="text/javascript,.js,.mjs"
                className="w-full text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readBundle(file);
                }}
              />
            </div>
          </div>

          {manifest && (
            <div className="space-y-3 rounded-xl bg-secondary/40 p-4">
              <div>
                <div className="font-medium">
                  {manifest.name} <span className="text-muted-foreground">v{manifest.version}</span>
                </div>
                <div className="text-xs text-muted-foreground">{manifest.id}</div>
                {manifest.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{manifest.description}</p>
                )}
              </div>

              <p className="text-sm">
                This code will run on <strong>{hookText(manifest.hooks ?? [])}</strong> before the
                change is saved, and can refuse it.
              </p>

              {inspected && (
                <p className="text-xs text-muted-foreground">
                  Verified {inspected.bundleBytes.toLocaleString()} bytes ·{' '}
                  <code className="break-all">{inspected.checksum}</code>
                  {inspected.publishedAt
                    ? ` · published ${new Date(inspected.publishedAt).toLocaleDateString()}`
                    : ' · no publish date declared'}
                </p>
              )}

              <CapabilityChoices
                requested={manifest.capabilities}
                approved={approved}
                onChange={setApproved}
                idPrefix="install"
              />

              {manifest.allowedHosts && manifest.allowedHosts.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Hosts it listed: {manifest.allowedHosts.join(', ')}
                </p>
              )}

              {unenforceable.length > 0 && (
                <Alert>
                  <AlertTitle>
                    {unenforceable.map(capabilityLabel).join(', ')} cannot be granted here
                  </AlertTitle>
                  <AlertDescription>
                    Nothing on this deployment can enforce the host allowlist yet, so approving it
                    would grant something unchecked. The plugin still installs and runs — without
                    network access. If it needs the network to work at all, do not enable it.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {error && <DialogError>{error}</DialogError>}

          <DialogFooter>
            <DiscardAsk guard={guard} message="Discard this plugin install?">
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy || !ready}>
                {busy ? 'Installing…' : 'Install disabled'}
              </Button>
            </DiscardAsk>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Upgrading is consent again, scoped to what changed.
 *
 * Capabilities the installed version already asked for keep the decision made
 * then (granted stays checked, declined stays unchecked). Ones it never asked
 * for are marked New and pre-checked, the same narrow-only default as install.
 * Approving anything beyond the current grant lands the plugin disabled, and
 * the button says so before it is pressed.
 */
function UpgradePluginDialog(props: {
  plugin: InstalledPluginSummary;
  onOpenChange: (open: boolean) => void;
  onUpgrade: (input: {
    manifest: PluginManifestInput;
    bundle: string;
    approvedCapabilities: string[];
  }) => Promise<void>;
}) {
  const { plugin } = props;
  const granted = grantOf(plugin);
  const [manifest, setManifest] = useState<PluginManifestInput>();
  const [bundle, setBundle] = useState<string>();
  const [approved, setApproved] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const guard = useDiscardGuard({
    saving: busy,
    dirty: Boolean(manifest || bundle),
    onOpenChange: props.onOpenChange,
  });

  const isNew = (c: string) => !plugin.requestedCapabilities.includes(c);

  const readManifest = async (file: File) => {
    setError(undefined);
    try {
      const parsed = JSON.parse(await file.text()) as PluginManifestInput;
      if (!parsed?.id || !parsed.name || !Array.isArray(parsed.capabilities)) {
        throw new Error('That file is not a plugin manifest, or it declares no capabilities.');
      }
      if (parsed.id !== plugin.id) {
        throw new Error(`That manifest is for “${parsed.id}”, not “${plugin.id}”.`);
      }
      setManifest(parsed);
      setApproved(
        parsed.capabilities.filter(
          (c) =>
            (granted.includes(c) || isNew(c)) && !UNENFORCEABLE_PLUGIN_CAPABILITIES.includes(c),
        ),
      );
    } catch (err) {
      setManifest(undefined);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const added = (manifest?.capabilities ?? []).filter(isNew);
  const widens = approved.some((c) => !granted.includes(c));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manifest || !bundle) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onUpgrade({ manifest, bundle, approvedCapabilities: approved });
      props.onOpenChange(false);
    } catch (err) {
      setError(guard.saveFailed(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Upgrade {plugin.name}</DialogTitle>
          <DialogDescription>
            Installed: v{plugin.version}. Until you approve anything new it asks for, the installed
            version keeps running.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="upgrade-manifest">New manifest (.json)</Label>
              <input
                id="upgrade-manifest"
                type="file"
                accept="application/json,.json"
                className="w-full text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void readManifest(file);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="upgrade-bundle">New bundle (.js)</Label>
              <input
                id="upgrade-bundle"
                type="file"
                accept="text/javascript,.js,.mjs"
                className="w-full text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void file.text().then(setBundle);
                }}
              />
            </div>
          </div>

          {manifest && (
            <div className="space-y-3 rounded-xl bg-secondary/40 p-4">
              <div className="font-medium">
                v{plugin.version} → v{manifest.version}
              </div>
              <p className="text-sm">
                {added.length === 0
                  ? 'It asks for nothing the installed version did not.'
                  : `It asks for ${added.length === 1 ? 'one capability' : `${added.length} capabilities`} the installed version never did.`}
              </p>
              <CapabilityChoices
                requested={manifest.capabilities}
                approved={approved}
                onChange={setApproved}
                idPrefix="upgrade"
                isNew={isNew}
              />
            </div>
          )}

          {error && <DialogError>{error}</DialogError>}

          <DialogFooter>
            <DiscardAsk guard={guard} message="Discard this upgrade?">
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy || !manifest || !bundle}>
                {busy ? 'Upgrading…' : widens ? 'Upgrade disabled' : 'Upgrade'}
              </Button>
            </DiscardAsk>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
