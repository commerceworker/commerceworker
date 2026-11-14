import {
  DiscardAsk,
  GuardCancel,
  useDiscardGuard,
} from '@commerceworker/content-admin/components/discard-guard';
import { ConfirmButton } from '@commerceworker/content-admin/components/InlineConfirm';
import { EmptyState, Section } from '@commerceworker/content-admin/components/page';
import { ToneBadge } from '@commerceworker/content-admin/components/status';
import type { Redirect, RedirectChain } from '@commerceworker/domain';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Switch } from '@commerceworker/ui/switch';
import { Textarea } from '@commerceworker/ui/textarea';
import { ArrowRight, ArrowRightLeft, Plus, Upload } from 'lucide-react';
import { useId, useState } from 'react';
import {
  apiErrorMessage,
  apiFieldIssues,
  type ManagementClient,
  type RedirectImportReport,
} from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';
import { useStoppable } from '../lib/use-stoppable';

const STATUSES = [
  { value: 301, label: '301 Moved permanently' },
  { value: 308, label: '308 Permanent, keeps the method' },
  { value: 302, label: '302 Found (temporary)' },
  { value: 307, label: '307 Temporary, keeps the method' },
] as const;

/** Every locale: the Select's value for "no locale" (a Select item can't be empty). */
const ALL = '__all__';

const chainNote = (chains: readonly RedirectChain[]) =>
  chains.length === 1
    ? 'It chains through another redirect: readers take an extra hop. Collapse chains to fix it.'
    : `It is part of ${chains.length} chains: readers take extra hops. Collapse chains to fix them.`;

/**
 * Settings → Redirects: the environment's redirects, which front ends apply (Delivery serves the
 * enabled set). A list with search, an add/edit dialog, an enable switch per row and an import.
 * The set's checks (no source twice, no loop) are the API's; this screen shows what it says.
 */
export function Redirects(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Redirect | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const page = useScopedQuery(['redirects', q], () => client.listRedirects({ q, limit: 100 }));
  const analysis = useScopedQuery(['redirects', 'analysis'], () => client.analyzeRedirects()).data;
  const config = useScopedQuery(['space-config'], () => client.getSpaceConfig()).data;
  const items = page.data?.items ?? [];
  const reload = () => invalidate(['redirects']);

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      await reload();
      toast.success(done);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const chains = analysis?.chains ?? [];
  const loops = analysis?.loops ?? [];
  const empty = page.data !== undefined && items.length === 0 && !q;

  return (
    <div className="space-y-4">
      {loops.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Redirects loop</AlertTitle>
          <AlertDescription>
            {loops.length === 1 ? 'One set of redirects sends' : `${loops.length} sets send`}{' '}
            readers round in a circle. Disable or change one of them.
          </AlertDescription>
        </Alert>
      )}
      {chains.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>
            {chains.length === 1 ? '1 redirect chains' : `${chains.length} redirects chain`} through
            another
          </AlertTitle>
          <AlertDescription>
            Readers take an extra hop for each. Collapsing points each one straight at where its
            chain ends.
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const { updated } = await client.collapseRedirectChains();
                  return updated;
                }, 'Chains collapsed')
              }
            >
              Collapse chains
            </Button>
          </AlertAction>
        </Alert>
      )}

      {empty ? (
        <EmptyState
          icon={ArrowRightLeft}
          title="No redirects yet"
          description="Send readers from an old path to a new one. Your site applies them: Delivery serves the enabled set. A content type with a URL pattern adds one when a published entry's slug changes."
        >
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setEditing('new')}>
              <Plus />
              New redirect
            </Button>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <Upload />
              Import
            </Button>
          </div>
        </EmptyState>
      ) : (
        <Section
          title="Redirects"
          description="Your site applies these: Delivery serves the enabled set. An exact path wins over a pattern, and the most specific pattern over the rest."
          flush
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                <Upload />
                Import
              </Button>
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus />
                New redirect
              </Button>
            </div>
          }
        >
          <ListToolbar summary={`${items.length} shown`}>
            <ListSearch
              label="Search redirects"
              placeholder="Search paths and notes"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ('')}
            />
          </ListToolbar>
          {items.length === 0 && page.data !== undefined ? (
            <CatalogEmpty onClear={() => setQ('')}>No redirects match “{q}”.</CatalogEmpty>
          ) : (
            <Catalog aria-label="Redirects" aria-busy={page.isFetching} className="pt-0">
              {items.map((r) => (
                <CatalogRow
                  key={r.id}
                  media={<CatalogTile title={`Status ${r.status}`}>{r.status}</CatalogTile>}
                  title={<span className="break-all font-mono text-xs">{r.source}</span>}
                  meta={
                    <span className="flex flex-wrap gap-x-2">
                      <span className="break-all font-mono">
                        <ArrowRight aria-hidden="true" className="mr-1 inline size-3" />
                        <span className="sr-only">To </span>
                        {r.destination}
                      </span>
                      <span>{[301, 308].includes(r.status) ? 'Permanent' : 'Temporary'}</span>
                      <span>{r.locale ? `Locale ${r.locale}` : 'All locales'}</span>
                      {r.origin === 'slug' && <span>From a slug change</span>}
                      {r.note && <span>{r.note}</span>}
                    </span>
                  }
                  aside={
                    <>
                      {r.enabled ? null : <ToneBadge tone="idle" label="Off" />}
                      <CatalogFigure label="Enabled">
                        <Switch
                          aria-label={`Enabled: ${r.source}`}
                          checked={r.enabled}
                          disabled={busy}
                          onCheckedChange={(enabled) =>
                            void act(
                              () => client.updateRedirect(r.id, { enabled }),
                              enabled ? 'Redirect on' : 'Redirect off',
                            )
                          }
                        />
                      </CatalogFigure>
                    </>
                  }
                  actions={
                    <ConfirmButton
                      message={`Delete the redirect from ${r.source}?`}
                      note="Readers on the old path get your site's not-found page."
                      confirmLabel="Delete redirect"
                      busy={busy}
                      onConfirm={() =>
                        void act(() => client.deleteRedirect(r.id), 'Redirect deleted')
                      }
                    >
                      {(ask) => (
                        <span className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`Edit the redirect from ${r.source}`}
                            onClick={() => setEditing(r)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`Delete the redirect from ${r.source}`}
                            onClick={ask}
                          >
                            Delete
                          </Button>
                        </span>
                      )}
                    </ConfirmButton>
                  }
                />
              ))}
            </Catalog>
          )}
          {page.data?.nextCursor && (
            <p className="px-4 py-3 text-muted-foreground text-ui">
              Showing the first {items.length}. Search to narrow the list.
            </p>
          )}
        </Section>
      )}

      {editing && (
        <RedirectDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          redirect={editing === 'new' ? null : editing}
          locales={config?.locales ?? []}
          onSave={async (input) => {
            const { chains: made } =
              editing === 'new'
                ? await client.createRedirect(input)
                : await client.updateRedirect(editing.id, input);
            await reload();
            if (made.length > 0) toast.success(`Redirect saved. ${chainNote(made)}`);
            else toast.success(editing === 'new' ? 'Redirect added' : 'Redirect saved');
          }}
        />
      )}
      {importing && (
        <ImportRedirectsDialog
          open
          onOpenChange={setImporting}
          client={client}
          onImported={async (report) => {
            await reload();
            toast.success(
              `Imported: ${report.created} added, ${report.updated} updated, ${report.unchanged} unchanged`,
            );
          }}
        />
      )}
    </div>
  );
}

interface RedirectForm {
  source: string;
  destination: string;
  status: 301 | 302 | 307 | 308;
  locale: string | null;
  enabled: boolean;
  note: string | null;
}

/** Add or edit one redirect. The API checks it against the whole set and names what's wrong. */
export function RedirectDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  redirect: Redirect | null;
  locales: readonly string[];
  onSave: (input: RedirectForm) => Promise<void>;
}) {
  const r = props.redirect;
  const id = useId();
  const [source, setSource] = useState(r?.source ?? '');
  const [destination, setDestination] = useState(r?.destination ?? '');
  const [status, setStatus] = useState<RedirectForm['status']>(r?.status ?? 301);
  const [locale, setLocale] = useState(r?.locale ?? ALL);
  const [enabled, setEnabled] = useState(r?.enabled ?? true);
  const [note, setNote] = useState(r?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const guard = useDiscardGuard({
    saving: busy,
    open: props.open,
    dirty:
      source !== (r?.source ?? '') ||
      destination !== (r?.destination ?? '') ||
      status !== (r?.status ?? 301) ||
      locale !== (r?.locale ?? ALL) ||
      enabled !== (r?.enabled ?? true) ||
      note !== (r?.note ?? ''),
    onOpenChange: props.onOpenChange,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setIssues({});
    setError(undefined);
    try {
      await props.onSave({
        source: source.trim(),
        destination: destination.trim(),
        status,
        locale: locale === ALL ? null : locale,
        enabled,
        note: note.trim() || null,
      });
      props.onOpenChange(false);
    } catch (err) {
      const said = guard.saveFailed(err);
      const fields = apiFieldIssues(err);
      setIssues(fields);
      // A refusal about the set (a loop, a source taken) names a field too; anything else is
      // said under the form.
      if (Object.keys(fields).length === 0) setError(said);
    } finally {
      setBusy(false);
    }
  };

  const field = (name: string, label: string, input: React.ReactNode, hint?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      {input}
      {issues[name] ? (
        <p id={`${id}-${name}-error`} className="text-destructive text-ui">
          {issues[name]}
        </p>
      ) : hint ? (
        <p id={`${id}-${name}-hint`} className="text-muted-foreground text-ui">
          {hint}
        </p>
      ) : null}
    </div>
  );
  const describedBy = (name: string, hint: boolean) =>
    issues[name] ? `${id}-${name}-error` : hint ? `${id}-${name}-hint` : undefined;

  return (
    <Dialog open={props.open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{r ? 'Edit redirect' : 'New redirect'}</DialogTitle>
          <DialogDescription>
            Where readers asking for one path should go instead.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {field(
            'source',
            'From',
            <Input
              id={`${id}-source`}
              className="font-mono"
              placeholder="/old-page"
              required
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(issues.source)}
              aria-describedby={describedBy('source', true)}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />,
            'A path. [slug] matches one segment and a final [...rest] the rest: /blog/[slug].',
          )}
          {field(
            'destination',
            'To',
            <Input
              id={`${id}-destination`}
              className="font-mono"
              placeholder="/new-page or https://example.com/page"
              required
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(issues.destination)}
              aria-describedby={describedBy('destination', true)}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />,
            'A path or an https:// address. Use the same [slug] to carry it across: /posts/[slug].',
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {field(
              'status',
              'Status',
              <Select
                value={String(status)}
                onValueChange={(v) => setStatus(Number(v) as RedirectForm['status'])}
              >
                <SelectTrigger id={`${id}-status`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s.value} value={String(s.value)}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
            )}
            {field(
              'locale',
              'Locale',
              <Select value={locale} onValueChange={setLocale}>
                <SelectTrigger id={`${id}-locale`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All locales</SelectItem>
                  {props.locales.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
            )}
          </div>
          {field(
            'note',
            'Note',
            <Input
              id={`${id}-note`}
              placeholder="Why it's here (optional)"
              aria-invalid={Boolean(issues.note)}
              aria-describedby={describedBy('note', false)}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />,
          )}
          <div className="flex items-center gap-3">
            <Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor={`${id}-enabled`}>Enabled</Label>
          </div>
          {error && <DialogError>{error}</DialogError>}
          <DialogFooter>
            <DiscardAsk guard={guard} message="Discard this redirect?">
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy || !source.trim() || !destination.trim()}>
                {busy ? 'Saving…' : r ? 'Save changes' : 'Add redirect'}
              </Button>
            </DiscardAsk>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const FORMATS = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
] as const;

/**
 * Import redirects from CSV (header: source, destination, status, locale, enabled, note) or a
 * JSON array. Check runs it as a dry run first; nothing is written until Import, and then all or
 * nothing.
 */
export function ImportRedirectsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ManagementClient;
  onImported: (report: RedirectImportReport) => Promise<void>;
}) {
  const id = useId();
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [data, setData] = useState('');
  const [checked, setChecked] = useState<RedirectImportReport | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Check is a dry run, a read: it stays closable, where the import itself holds the dialog.
  const [checking, setChecking] = useState(false);
  const check = useStoppable();
  const guard = useDiscardGuard({
    saving: busy,
    open: props.open,
    dirty: data.trim() !== '',
    onOpenChange: props.onOpenChange,
  });

  const refused = (err: unknown, said: string) => {
    setChecked(null);
    const issues = apiFieldIssues(err);
    const listed = Object.entries(issues).map(([f, m]) => {
      const row = /^rows\[(\d+)\]/.exec(f)?.[1];
      return row !== undefined ? `Row ${Number(row) + 1}: ${m}` : m;
    });
    setProblems(listed.length > 0 ? listed : [said]);
  };

  const dryRun = async () => {
    const signal = check.start();
    setChecking(true);
    setProblems([]);
    try {
      const report = await props.client.importRedirects({ format, data, dryRun: true }, signal);
      if (!signal.aborted) setChecked(report);
    } catch (err) {
      if (!signal.aborted) refused(err, apiErrorMessage(err));
    } finally {
      if (!signal.aborted) setChecking(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setProblems([]);
    try {
      const report = await props.client.importRedirects({ format, data, dryRun: false });
      await props.onImported(report);
      props.onOpenChange(false);
    } catch (err) {
      refused(err, guard.saveFailed(err));
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setData(await file.text());
    setFormat(file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv');
    setChecked(null);
  };

  return (
    <Dialog open={props.open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import redirects</DialogTitle>
          <DialogDescription>
            CSV with a header row (source, destination, status, locale, enabled, note), or a JSON
            array. A path already redirected is updated. Up to 1,000 rows, all or nothing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              aria-label="Format"
              value={format}
              onValueChange={(v) => {
                setFormat(v as 'csv' | 'json');
                setChecked(null);
              }}
            >
              {FORMATS.map((f) => (
                <SegmentedItem key={f.value} value={f.value}>
                  {f.label}
                </SegmentedItem>
              ))}
            </Segmented>
            <Input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              aria-label="Choose a file"
              className="max-w-64"
              onChange={(e) => void loadFile(e.target.files?.[0])}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-data`}>{format === 'csv' ? 'CSV' : 'JSON'}</Label>
            <Textarea
              id={`${id}-data`}
              rows={8}
              className="font-mono text-xs"
              placeholder={
                format === 'csv'
                  ? 'source,destination,status\n/old,/new,301'
                  : '[{ "source": "/old", "destination": "/new" }]'
              }
              spellCheck={false}
              value={data}
              onChange={(e) => {
                setData(e.target.value);
                setChecked(null);
              }}
            />
          </div>
          {problems.length > 0 && (
            // An import that may have gone through can't say this, whatever fails after it.
            <DialogError {...(guard.unconfirmed ? {} : { title: 'Nothing was imported' })}>
              <ul className="list-disc ps-4">
                {problems.slice(0, 10).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {problems.length > 10 && <li>and {problems.length - 10} more</li>}
              </ul>
            </DialogError>
          )}
          {checked && (
            <p role="status" className="text-sm">
              Ready: {checked.created} to add, {checked.updated} to update, {checked.unchanged}{' '}
              unchanged.
              {checked.chains.length > 0 &&
                ` ${checked.chains.length} will chain through another redirect.`}
            </p>
          )}
        </div>
        <DialogFooter>
          <DiscardAsk guard={guard} message="Discard this import?">
            <GuardCancel guard={guard} />
            {checked ? (
              <Button disabled={busy} onClick={() => void run()}>
                {busy ? 'Importing…' : 'Import'}
              </Button>
            ) : (
              <Button disabled={checking || !data.trim()} onClick={() => void dryRun()}>
                {checking ? 'Checking…' : 'Check'}
              </Button>
            )}
          </DiscardAsk>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
