import { ImportJobProgress } from '@commerceworker/content-admin/components/import-job-progress';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import { Checkbox } from '@commerceworker/ui/checkbox';
import { Label } from '@commerceworker/ui/label';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@commerceworker/ui/table';
import { useEffect, useState } from 'react';
import { useClient } from '../lib/client-context';
import type { BulkJobSummary, SpaceExportReport, SpaceExportRequest } from '../lib/management';

/**
 * Importing a whole space export (content model, locales, tags, entries and assets) into this
 * environment.
 *
 * As with every import here, the screen is the server's analysis: nothing is read in the browser
 * but the file's text, and the report is the run without the commit. The run itself is two jobs
 * (create, then publish what the export had published), followed one after the other.
 */
export function SpaceExportImport(props: {
  /** The export's text, when the file was chosen on the import screen already. */
  payload?: string;
  fileName?: string;
  onDone: () => void;
}) {
  const { client } = useClient();
  const [payload, setPayload] = useState(props.payload);
  const [fileName, setFileName] = useState(props.fileName);
  const [publish, setPublish] = useState(true);
  const [addLocales, setAddLocales] = useState(false);
  const [report, setReport] = useState<SpaceExportReport>();
  const [busy, setBusy] = useState<'analyzing' | 'running'>();
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<BulkJobSummary>();
  const [publishJobId, setPublishJobId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<BulkJobSummary>();

  // A different file, or different options, is a different import: the old report no longer
  // describes it.
  useEffect(() => {
    setPayload(props.payload);
    setFileName(props.fileName);
    setReport(undefined);
  }, [props.payload, props.fileName]);

  const request = (): SpaceExportRequest => ({
    payload: payload ?? '',
    publish,
    ...(addLocales ? { addLocales: true } : {}),
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

  const analyze = async () => {
    const result = await run('analyzing', () => client.analyzeSpaceExport(request()));
    if (result) setReport(result);
  };

  const start = async () => {
    const started = await run('running', () => client.startSpaceExportImport(request()));
    if (!started) return;
    setReport(started.report);
    setPublishJobId(started.publishJobId);
    if (started.job) setJob(started.job);
    else props.onDone();
  };

  // Follows the create job, then the publishing job it starts after a clean run. Each poll stops
  // on its own when its job finishes.
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
  useEffect(() => {
    if (!publishJobId || job?.status !== 'completed' || job.failed > 0) return;
    if (publishing && publishing.status !== 'running') return;
    const timer = setInterval(() => {
      client
        .getBulkJob(publishJobId)
        .then(setPublishing)
        .catch(() => {
          /* not started yet, or transient */
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [job, publishJobId, publishing, client]);

  return (
    <div className="space-y-4">
      {props.payload === undefined && (
        <Card>
          <CardHeader>
            <h2 className="font-heading text-base font-medium">1. Choose the export</h2>
            <p className="text-sm text-muted-foreground">
              The JSON file a space export writes: its content types, entries, assets, locales and
              tags. It imports into an environment with no content types yet.
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <Label htmlFor="space-export-file">File</Label>
              <input
                id="space-export-file"
                type="file"
                accept=".json,application/json"
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-foreground"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void file.text().then((text) => {
                    setPayload(text);
                    setFileName(file.name);
                    setReport(undefined);
                  });
                }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {payload !== undefined && !job && (
        <Card>
          <CardHeader>
            <h2 className="font-heading text-base font-medium">
              {props.payload === undefined ? '2. Check it' : '2. Check the export'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {fileName ? `${fileName}. ` : ''}Every entry and asset gets a new id here, and every
              link and rich-text embed is pointed at it.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Label className="flex items-center gap-2 font-normal">
              {/* A wrapping label does not name a <button role="checkbox">; see Settings.tsx. */}
              <Checkbox
                aria-label="Publish what the export had published"
                checked={publish}
                onCheckedChange={(c) => {
                  setPublish(c === true);
                  setReport(undefined);
                }}
              />
              <span>Publish what the export had published</span>
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                aria-label="Add the export's locales this space lacks"
                checked={addLocales}
                onCheckedChange={(c) => {
                  setAddLocales(c === true);
                  setReport(undefined);
                }}
              />
              <span>Add the export’s locales this space lacks (space admins)</span>
            </Label>
            <Button type="button" onClick={() => void analyze()} disabled={!!busy}>
              {busy === 'analyzing' ? 'Checking…' : 'Check this import'}
            </Button>
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
        <ImportJobProgress
          job={job}
          labels={{ running: 'Importing…', done: 'Entries and assets imported' }}
          onDone={props.onDone}
        />
      )}
      {publishing && (
        <ImportJobProgress
          job={publishing}
          labels={{ running: 'Publishing…', done: 'Published' }}
          onDone={props.onDone}
        />
      )}

      {report && !job && (
        <SpaceExportReportCard report={report} busy={busy} onRun={() => void start()} />
      )}
    </div>
  );
}

function SpaceExportReportCard(props: {
  report: SpaceExportReport;
  busy?: string;
  onRun: () => void;
}) {
  const { report } = props;
  const { entries, assets } = report;
  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">3. What this would do</h2>
        <p className="text-sm text-muted-foreground">
          {entries.read.toLocaleString()} {entries.read === 1 ? 'entry' : 'entries'} and{' '}
          {assets.read.toLocaleString()} {assets.read === 1 ? 'asset' : 'assets'} read. Nothing has
          been written.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Content types', report.contentTypes],
            ['Entries', entries.imported],
            ['Assets', assets.imported],
            ['Published', entries.published + assets.published],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl bg-secondary/40 p-3">
              <div className="text-2xl font-medium">{Number(value).toLocaleString()}</div>
              <div className="text-muted-foreground text-xs">{label}</div>
            </div>
          ))}
        </div>

        {report.problems.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>This import can’t run yet</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {report.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <p className="text-sm text-muted-foreground">
          Locales:{' '}
          {report.locales.declared
            .map((l) => (l.fallback ? `${l.code} (falls back to ${l.fallback})` : l.code))
            .join(', ')}
          {report.locales.toAdd.length > 0 &&
            `. Not in this space yet: ${report.locales.toAdd.join(', ')}.`}
        </p>

        {report.unmappedFields.length > 0 && (
          <Alert>
            <AlertTitle>
              {report.unmappedFields.length}{' '}
              {report.unmappedFields.length === 1 ? 'field has' : 'fields have'} no equivalent and
              would not be imported
            </AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {report.unmappedFields.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {report.unmappedValidations.length > 0 && (
          <Alert>
            <AlertTitle>Validations editors here would not be held to</AlertTitle>
            <AlertDescription>{report.unmappedValidations.join('; ')}</AlertDescription>
          </Alert>
        )}

        {report.warnings.length > 0 && (
          <Alert>
            <AlertTitle>Worth knowing</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {report.warnings.slice(0, 12).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {report.invalidEntries.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {entries.invalid} {entries.invalid === 1 ? 'entry' : 'entries'} would not be imported
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Entry</TableHead>
                  <TableHead>Problem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.invalidEntries.map((issue) => (
                  <TableRow key={issue.entry}>
                    <TableCell className="font-mono text-xs">{issue.entry}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {issue.messages.join('; ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {report.missingLinkCount > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {report.missingLinkCount}{' '}
              {report.missingLinkCount === 1 ? 'link points' : 'links point'} at something not
              imported, and would be dropped
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">Entry</TableHead>
                  <TableHead>Field</TableHead>
                  <TableHead>Links to</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.missingLinks.map((l) => (
                  <TableRow key={`${l.entry}/${l.field}/${l.target}`}>
                    <TableCell className="font-mono text-xs">{l.entry}</TableCell>
                    <TableCell>{l.field}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {l.linkType.toLowerCase()} {l.target}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={props.onRun}
            disabled={!report.executable || props.busy === 'running'}
          >
            {props.busy === 'running' ? 'Starting…' : 'Import this space'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Files are copied and entries created in the background; this keeps running if you close
            the tab.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
