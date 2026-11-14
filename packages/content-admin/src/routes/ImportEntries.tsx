import { ImportJobProgress } from '@commerceworker/content-admin/components/import-job-progress';
import { PageHeader } from '@commerceworker/content-admin/components/page';
import { RequiredMark } from '@commerceworker/content-admin/components/required-mark';
import { useNavigate, useParams } from '@commerceworker/content-admin/router';
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@commerceworker/ui/table';
import { useEffect, useRef, useState } from 'react';
import { useClient } from '../lib/client-context';
import {
  type BulkJobSummary,
  IMPORT_SYNC_MAX_RECORDS,
  type ImportAnalysis,
  type ImportRequest,
} from '../lib/management';
import { useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';
import { SpaceExportImport } from './SpaceExportImport';

/** A whole space (model, entries, assets), not records for one content type: its own flow. */
const SPACE_EXPORT = 'space-export';

/** Source ids by file extension; the picker still lets you override. */
const SOURCE_BY_EXTENSION: Record<string, string> = {
  csv: 'csv',
  json: 'json',
  tsv: 'csv',
  xml: 'wxr',
};

/**
 * What the server's reader is told besides the file: which column is each
 * record's identity, and — for a WordPress export — which post type to read.
 */
function sourceOptionsFor(
  source: string,
  postType: string,
  identityColumn: string | undefined,
): { sourceOptions?: Record<string, unknown> } {
  const options: Record<string, unknown> = {
    ...(identityColumn ? { identityField: identityColumn } : {}),
    ...(source === 'wxr' ? { postType } : {}),
  };
  return Object.keys(options).length ? { sourceOptions: options } : {};
}

/** "Leave empty" — a select cannot hold the empty string as a value. */
const UNMAPPED = '\u0000unmapped';

/**
 * Importing a file into a content type.
 *
 * The screen is the analysis: every step shows what the server would do rather
 * than what this page believes it would do, because the two disagreeing is the
 * failure mode that matters. Nothing is parsed here — even the column list
 * comes from the server, so the names offered for mapping are the names the
 * import will actually see.
 */
export function ImportEntries() {
  const { typeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client } = useClient();
  const { types, defaultLocale, locales } = useContentOutlet();
  const contentType = types.find((t) => t.apiId === typeId);

  const [source, setSource] = useState('csv');
  // A WordPress export holds every post type in one file; a mapping targets one.
  const [postType, setPostType] = useState('post');
  /** What the Post type box shows while being typed in; committed on blur or Enter. */
  const [postTypeDraft, setPostTypeDraft] = useState('post');
  /** Numbers each read, so a slower earlier one cannot overwrite a later one's columns. */
  const latestRead = useRef(0);
  const [payload, setPayload] = useState<string>();
  const [fileName, setFileName] = useState<string>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [identityField, setIdentityField] = useState<string>();
  const [locale, setLocale] = useState(defaultLocale);
  const [conflicts, setConflicts] = useState<'skip' | 'update' | 'fail'>('skip');
  const [columns, setColumns] = useState<string[]>();
  const [analysis, setAnalysis] = useState<ImportAnalysis>();
  const [busy, setBusy] = useState<'reading' | 'analyzing' | 'running'>();
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<BulkJobSummary>();

  const request = (fields: Record<string, string>): ImportRequest => ({
    source,
    payload: payload ?? '',
    mapping: {
      contentTypeApiId: contentType?.apiId ?? '',
      fields,
      ...(identityField ? { identityField } : {}),
      locale,
    },
    ...sourceOptionsFor(source, postType, identityField ? mapping[identityField] : undefined),
    conflicts,
  });

  const run = async <T,>(phase: NonNullable<typeof busy>, fn: () => Promise<T>) => {
    setBusy(phase);
    setError(undefined);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  /**
   * Reads the file by asking the server what is in it.
   *
   * An empty mapping is a legitimate analysis: it reports every source field as
   * unmapped, which is exactly the column list. Parsing here instead would mean
   * two readers that can disagree about what a file contains.
   */
  const chooseFile = async (file: File) => {
    const text = await file.text();
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    // A space export is JSON too: once chosen, a .json file stays one.
    const detected =
      source === SPACE_EXPORT && extension === 'json'
        ? SPACE_EXPORT
        : (SOURCE_BY_EXTENSION[extension] ?? source);
    setSource(detected);
    setPayload(text);
    setFileName(file.name);
    if (detected !== SPACE_EXPORT) await readColumns(text, detected, postType);
  };

  /**
   * Re-reads the file when what is being read from it changes. A different
   * post type can bring different custom fields, so the old column list and
   * any mapping built on it no longer describe this import.
   */
  const choosePostType = async (next: string) => {
    const trimmed = next.trim() || 'post';
    setPostTypeDraft(trimmed);
    if (trimmed === postType) return;
    setPostType(trimmed);
    if (payload) await readColumns(payload, source, trimmed);
  };

  /** A different format reads the same bytes differently, so the columns are asked for again. */
  const chooseSource = async (next: string) => {
    setSource(next);
    if (next === SPACE_EXPORT) {
      // Nothing to map: the export carries its own model.
      setColumns(undefined);
      setMapping({});
      setAnalysis(undefined);
      return;
    }
    if (payload) await readColumns(payload, next, postType);
  };

  const readColumns = async (text: string, from: string, type: string) => {
    const readNumber = latestRead.current + 1;
    latestRead.current = readNumber;
    setMapping({});
    setIdentityField(undefined);
    setAnalysis(undefined);
    // Cleared up front: if this read fails, the old list describes a file
    // reading that is no longer the one on screen.
    setColumns(undefined);
    const read = await run('reading', () =>
      client.analyzeImport({
        source: from,
        payload: text,
        mapping: { contentTypeApiId: contentType?.apiId ?? '', fields: {}, locale },
        ...sourceOptionsFor(from, type, undefined),
      }),
    );
    if (read && readNumber === latestRead.current) setColumns([...read.unmappedSourceFields]);
  };

  const analyze = async () => {
    const result = await run('analyzing', () => client.analyzeImport(request(mapping)));
    if (result) setAnalysis(result);
  };

  /**
   * Runs it, synchronously or as a job depending on size.
   *
   * The cutoff is not a preference: past it the synchronous route refuses,
   * because a request that writes ten thousand entries is a request that times
   * out. Below it the synchronous route is better — an immediate answer, and
   * no dependency on a consumer being alive, which in a local stack it may not
   * be.
   */
  const execute = async () => {
    if ((analysis?.records ?? 0) > IMPORT_SYNC_MAX_RECORDS) {
      const started = await run('running', () => client.startImportJob(request(mapping)));
      if (started) setJob(started.job);
      return;
    }
    const result = await run('running', () => client.runImport(request(mapping)));
    if (!result) return;
    toast.success(
      `Imported ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`,
    );
    navigate(`/content/${contentType?.apiId ?? ''}`);
  };

  // Polls a running job. Stops on its own when the job finishes, so a finished
  // import does not keep a tab talking to the server forever.
  useEffect(() => {
    if (job?.status !== 'running') return;
    const timer = setInterval(() => {
      client
        .getBulkJob(job.id)
        .then(setJob)
        .catch(() => {
          /* transient; the next tick tries again */
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [job, client]);

  // Below every hook, deliberately. The content types arrive asynchronously, so
  // this guard is true on the first render and false on the next — returning
  // above the hooks would change how many run between renders, which React
  // treats as a crash rather than a re-render.
  // `/content/space-import`: no content type yet, which is the point of importing a whole space.
  if (!typeId) {
    return (
      <div className="max-w-3xl space-y-4">
        <PageHeader
          title="Import a space export"
          description="Nothing is written until you say so — the report is the run, without the commit."
        >
          <Button type="button" variant="outline" onClick={() => navigate('/content')}>
            Cancel
          </Button>
        </PageHeader>
        <SpaceExportImport onDone={() => navigate('/content')} />
      </div>
    );
  }
  if (!contentType) return <p className="text-muted-foreground text-sm">Unknown content type.</p>;

  const mappable = mappableFields(contentType);
  const mapped = Object.keys(mapping).length > 0;

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader
        title={`Import into ${contentType.name}`}
        description="Nothing is written until you say so — the report below is the run, without the commit."
      >
        <Button type="button" variant="outline" onClick={() => navigate(`/content/${typeId}`)}>
          Cancel
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <h2 className="font-heading text-base font-medium">1. Choose a file</h2>
          <p className="text-sm text-muted-foreground">
            A spreadsheet exported as CSV, a JSON array, a WordPress export, or a whole space
            export. The server reads it and tells you what it found.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="import-file">File</Label>
              <input
                id="import-file"
                type="file"
                accept=".csv,.tsv,.json,.xml,text/csv,application/json,application/xml,text/xml"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void chooseFile(file);
                }}
              />
            </div>
            <div className="w-36 space-y-1">
              <Label htmlFor="import-source">Format</Label>
              <Select value={source} onValueChange={(next) => void chooseSource(next)}>
                <SelectTrigger id="import-source" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="wxr">WordPress</SelectItem>
                  <SelectItem value={SPACE_EXPORT}>Space export</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {source === 'wxr' && (
              <div className="w-36 space-y-1">
                <Label htmlFor="import-post-type">Post type</Label>
                <Input
                  id="import-post-type"
                  value={postTypeDraft}
                  className="h-8"
                  onChange={(e) => setPostTypeDraft(e.target.value)}
                  onBlur={(e) => void choosePostType(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void choosePostType(e.currentTarget.value);
                  }}
                />
              </div>
            )}
            {locales.length > 1 && (
              <div className="w-36 space-y-1">
                <Label htmlFor="import-locale">Locale</Label>
                <Select value={locale} onValueChange={setLocale}>
                  <SelectTrigger id="import-locale" size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {locales.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {fileName && columns && (
            <p className="text-sm text-muted-foreground">
              {fileName} — {columns.length} {columns.length === 1 ? 'column' : 'columns'}
            </p>
          )}
        </CardContent>
      </Card>

      {source === SPACE_EXPORT && payload !== undefined && (
        <SpaceExportImport
          payload={payload}
          fileName={fileName}
          onDone={() => navigate('/content')}
        />
      )}

      {columns && source !== SPACE_EXPORT && (
        <Card>
          <CardHeader>
            <h2 className="font-heading text-base font-medium">2. Match the columns</h2>
            <p className="text-sm text-muted-foreground">
              A field left empty is not imported. A column nothing points at is data this import
              throws away — the report says which.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead>Column</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappable.map((field) => (
                  <TableRow key={field.apiId}>
                    <TableCell>
                      <Label htmlFor={`map-${field.apiId}`} className="gap-1">
                        {field.name}
                        {field.required && <RequiredMark />}
                      </Label>
                      <div className="text-muted-foreground text-xs">{field.type}</div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={mapping[field.apiId] ?? UNMAPPED}
                        onValueChange={(value) => {
                          setAnalysis(undefined);
                          setMapping((prev) => {
                            const next = { ...prev };
                            if (value === UNMAPPED) delete next[field.apiId];
                            else next[field.apiId] = value;
                            return next;
                          });
                        }}
                      >
                        <SelectTrigger
                          id={`map-${field.apiId}`}
                          size="sm"
                          className="w-full max-w-64"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={UNMAPPED}>— not imported —</SelectItem>
                          {columns.map((column) => (
                            <SelectItem key={column} value={column}>
                              {column}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-end gap-3">
              <div className="w-56 space-y-1">
                <Label htmlFor="import-identity">Identifies a record</Label>
                <Select
                  value={identityField ?? UNMAPPED}
                  onValueChange={(value) => {
                    setAnalysis(undefined);
                    setIdentityField(value === UNMAPPED ? undefined : value);
                  }}
                >
                  <SelectTrigger id="import-identity" size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNMAPPED}>— nothing —</SelectItem>
                    {Object.keys(mapping).map((apiId) => (
                      <SelectItem key={apiId} value={apiId}>
                        {mappable.find((f) => f.apiId === apiId)?.name ?? apiId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-48 space-y-1">
                <Label htmlFor="import-conflicts">When it already exists</Label>
                <Select
                  value={conflicts}
                  onValueChange={(v) => {
                    setAnalysis(undefined);
                    setConflicts(v as typeof conflicts);
                  }}
                >
                  <SelectTrigger id="import-conflicts" size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Leave it alone</SelectItem>
                    <SelectItem value="update">Update it</SelectItem>
                    <SelectItem value="fail">Report it as a problem</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" onClick={() => void analyze()} disabled={!mapped || !!busy}>
                {busy === 'analyzing' ? 'Checking…' : 'Check this import'}
              </Button>
            </div>

            {!identityField && (
              <p className="text-xs text-muted-foreground">
                Without something that identifies a record, running this twice creates everything
                twice.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>That didn’t work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {job && (
        <ImportJobProgress job={job} onDone={() => navigate(`/content/${contentType.apiId}`)} />
      )}

      {analysis && !job && (
        <AnalysisReport analysis={analysis} busy={busy} onRun={() => void execute()} />
      )}
    </div>
  );
}

function AnalysisReport(props: { analysis: ImportAnalysis; busy?: string; onRun: () => void }) {
  const { analysis } = props;
  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">3. What this would do</h2>
        <p className="text-sm text-muted-foreground">
          {/* Grouped: "10001" is a number to decode, "10,001" is one to read. */}
          {analysis.records.toLocaleString()} {analysis.records === 1 ? 'record' : 'records'} read.
          Nothing has been written.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {[
            ['Create', analysis.willCreate],
            ['Update', analysis.willUpdate],
            ['Skip', analysis.willSkip],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl bg-secondary/40 p-3">
              <div className="text-2xl font-medium">{value}</div>
              <div className="text-muted-foreground text-xs">{label}</div>
            </div>
          ))}
        </div>

        {analysis.missingRequiredFields.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Required fields with no column behind them</AlertTitle>
            <AlertDescription>{analysis.missingRequiredFields.join(', ')}</AlertDescription>
          </Alert>
        )}

        {analysis.unmappedSourceFields.length > 0 && (
          <Alert>
            <AlertTitle>
              {analysis.unmappedSourceFields.length}{' '}
              {analysis.unmappedSourceFields.length === 1 ? 'column' : 'columns'} would be discarded
            </AlertTitle>
            <AlertDescription>
              {/* Only findable before the run: afterwards there is nothing to
                  compare against. */}
              {analysis.unmappedSourceFields.join(', ')}
            </AlertDescription>
          </Alert>
        )}

        {analysis.warnings.length > 0 && (
          <Alert>
            <AlertTitle>The file was not entirely readable</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {analysis.warnings.slice(0, 10).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {analysis.issues.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {analysis.invalid} {analysis.invalid === 1 ? 'record' : 'records'} would be skipped
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Record</TableHead>
                  <TableHead>Problem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analysis.issues.map((issue) => (
                  <TableRow key={issue.externalId}>
                    <TableCell className="font-mono text-xs">{issue.externalId}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {issue.messages.join('; ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {analysis.invalid > analysis.issues.length && (
              <p className="text-xs text-muted-foreground">
                Showing {analysis.issues.length} of {analysis.invalid}.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={props.onRun}
            disabled={!analysis.executable || props.busy === 'running'}
          >
            {props.busy === 'running'
              ? 'Importing…'
              : `Import ${(analysis.willCreate + analysis.willUpdate).toLocaleString()} ${
                  analysis.willCreate + analysis.willUpdate === 1 ? 'record' : 'records'
                }`}
          </Button>
          <p className="text-xs text-muted-foreground">
            They arrive as drafts. Publishing is a separate step.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Fields a flat file can fill.
 *
 * Rich text is one: the server reads a text value as HTML, which is what a
 * blog export holds and what plain prose already is. Links, components and the
 * rest need structure a cell does not have; offering them would produce a
 * mapping that only fails at validation.
 */
function mappableFields(contentType: ContentType): FieldDefinition[] {
  const flat = new Set([
    'Symbol',
    'Slug',
    'Text',
    'RichText',
    'Integer',
    'Number',
    'Boolean',
    'Date',
    'Array',
  ]);
  return contentType.fields.filter((f) => flat.has(f.type));
}
