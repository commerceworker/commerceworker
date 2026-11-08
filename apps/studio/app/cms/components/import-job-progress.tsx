import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import type { BulkJobSummary } from '../lib/management';

/**
 * A running import job.
 *
 * Chunks, not records, because chunks are what actually complete — reporting
 * a record count that only moves 200 at a time would look stuck between jumps.
 * Failures are shown as they accumulate rather than saved for the end: an
 * import that is failing every record should be cancellable before it finishes.
 */
export function ImportJobProgress(props: {
  job: BulkJobSummary;
  onDone: () => void;
  /** Headings while it runs and once it is over; an import's by default. */
  labels?: { readonly running: string; readonly done: string };
}) {
  const { job } = props;
  const labels = props.labels ?? { running: 'Importing…', done: 'Import finished' };
  const done = job.status !== 'running';
  const percent = job.totalChunks === 0 ? 100 : (job.completedChunks / job.totalChunks) * 100;

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">
          {done ? labels.done : labels.running}
        </h2>
        <p className="text-sm text-muted-foreground">
          {done
            ? `${job.succeeded} imported, ${job.failed} failed.`
            : `${job.completedChunks} of ${job.totalChunks} batches — this keeps running if you close the tab.`}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* <progress>, not a div wearing role="progressbar": the element is
            already the thing, and browsers announce its value without being
            told how. */}
        <progress
          className="h-2 w-full overflow-hidden rounded-full"
          aria-label="Import progress"
          value={job.completedChunks}
          max={Math.max(1, job.totalChunks)}
        >
          {Math.round(percent)}%
        </progress>

        {job.failed > 0 && (
          <Alert variant="destructive">
            <AlertTitle>
              {job.failed} {job.failed === 1 ? 'record' : 'records'} failed
            </AlertTitle>
            <AlertDescription>
              The job report lists each one. The rest were imported.
            </AlertDescription>
          </Alert>
        )}

        {done && (
          <Button type="button" onClick={props.onDone}>
            Done
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
