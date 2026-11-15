import { BulkJobProgress } from '@commerceworker/content-admin/components/bulk-job-progress';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useClient } from '../lib/client-context';
import { plural } from '../lib/format';
import type { BulkJobSummary } from '../lib/management';
import { useScopedQuery } from '../lib/queries';

/** A content type's delete that removes its entries first, running as a job on the server. */
export interface ContentTypeDeleteJobState {
  readonly job: BulkJobSummary;
  readonly type: { readonly apiId: string; readonly name: string };
  /** The entries it could not delete, from the job's report, once the type was kept for them. */
  readonly failures?: readonly { readonly id: string; readonly error: string }[];
  /** Why the report could not be read, so they cannot be named. */
  readonly reportError?: string;
}

/** What the Content layout keeps for its overview, so the job outlives a visit elsewhere. */
export interface ContentTypeDeleteJob {
  readonly state: ContentTypeDeleteJobState | null;
  start(job: BulkJobSummary, type: { apiId: string; name: string }): void;
  dismiss(): void;
  cancel(): void;
  readonly cancelling: boolean;
}

/**
 * Follows a content type's delete job from the Content layout, so its card is still there after a
 * visit to an entry. It polls until the job records what became of the type (`typeDeletion`), not
 * only until it stops running: the type itself goes in a step after the last entry. Then
 * `onSettled` runs once (the layout reloads the types and entries), and when the type was kept
 * with entries that failed, the report is read to name them.
 */
export function useContentTypeDeleteJob(
  onSettled: (state: ContentTypeDeleteJobState) => void,
): ContentTypeDeleteJob {
  const { client } = useClient();
  const [state, setState] = useState<ContentTypeDeleteJobState | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const outcome = state?.job.config?.typeDeletion;
  const polled = useScopedQuery(
    ['bulk-jobs', state?.job.id],
    () => client.getBulkJob(state?.job.id ?? ''),
    { enabled: state !== null && outcome === undefined, refetchInterval: 2000, silent: true },
  );
  useEffect(() => {
    const next = polled.data;
    if (!next) return;
    setState((current) =>
      current && current.job.id === next.id && !current.job.config?.typeDeletion
        ? { ...current, job: next }
        : current,
    );
  }, [polled.data]);

  // Once per job, when its outcome arrives.
  const settled = useRef<string | null>(null);
  const settle = useRef(onSettled);
  settle.current = onSettled;
  useEffect(() => {
    if (!state || !outcome || settled.current === state.job.id) return;
    settled.current = state.job.id;
    settle.current(state);
    if (outcome.deleted || state.job.failed === 0) return;
    const id = state.job.id;
    client.getBulkJobReport(id).then(
      (report) =>
        setState((current) =>
          current?.job.id === id
            ? {
                ...current,
                failures: report.chunks.flatMap((c) =>
                  c.failures.map((f) => ({ id: f.id, error: f.error })),
                ),
              }
            : current,
        ),
      (err: unknown) =>
        setState((current) =>
          current?.job.id === id
            ? { ...current, reportError: err instanceof Error ? err.message : String(err) }
            : current,
        ),
    );
  }, [state, outcome, client]);

  const start = useCallback((job: BulkJobSummary, type: { apiId: string; name: string }) => {
    setState({ job, type: { apiId: type.apiId, name: type.name } });
  }, []);
  const dismiss = useCallback(() => setState(null), []);
  const cancel = useCallback(() => {
    const id = state?.job.id;
    if (!id) return;
    setCancelling(true);
    client
      .cancelBulkJob(id)
      .then((job) =>
        setState((current) => (current?.job.id === id ? { ...current, job } : current)),
      )
      .catch(() => {})
      .finally(() => setCancelling(false));
  }, [client, state?.job.id]);
  return { state, start, dismiss, cancel, cancelling };
}

/** Failed entries a kept type's notice names; the report has them all. */
const NAMED = 10;

/**
 * The delete job's card on the Content overview: its progress (Stop included), then what became
 * of the type. While the type's own delete is still to come it says so; a type that was kept gets
 * a warning naming why, and the entries that couldn't be deleted when that is the reason.
 */
export function ContentTypeDeleteJobCard(props: { job: ContentTypeDeleteJob }) {
  const { state, cancelling } = props.job;
  if (!state) return null;
  const { job, type } = state;
  const outcome = job.config?.typeDeletion;
  return (
    <div className="mb-4 space-y-3">
      <BulkJobProgress
        job={job}
        verbs={{ done: 'Deleted', doing: 'Deleting' }}
        nouns={[`entry of “${type.name}”`, `entries of “${type.name}”`]}
        where="the content types"
        takeFocus
        onDismiss={props.job.dismiss}
        onCancel={props.job.cancel}
        cancelling={cancelling}
      />
      {job.status !== 'running' && !outcome ? (
        <p role="status" className="text-muted-foreground text-ui">
          Deleting the content type “{type.name}”…
        </p>
      ) : null}
      {outcome?.deleted ? (
        <Alert variant="success">
          <AlertTitle>“{type.name}” was deleted, with its entries</AlertTitle>
        </Alert>
      ) : null}
      {outcome && !outcome.deleted ? (
        <Alert variant="warning">
          <AlertTitle>
            “{type.name}” was kept
            {job.failed > 0
              ? `: ${plural(job.failed, 'entry', 'entries')} couldn’t be deleted`
              : ''}
          </AlertTitle>
          <AlertDescription>
            {job.failed > 0 && state.failures?.length ? (
              <ul className="list-disc space-y-0.5 pl-4">
                {state.failures.slice(0, NAMED).map((f) => (
                  <li key={f.id}>
                    <span className="font-mono">{f.id}</span>: {f.error}
                  </li>
                ))}
                {state.failures.length > NAMED ? (
                  <li>and {state.failures.length - NAMED} more, in the job’s report</li>
                ) : null}
              </ul>
            ) : job.failed > 0 && state.reportError ? (
              <p>
                The job’s report couldn’t be read ({state.reportError}), so they can’t be named.
              </p>
            ) : job.failed > 0 ? null : job.status === 'cancelled' ? (
              <p>
                The job was stopped, so the content type and the entries it hadn’t reached stay.
              </p>
            ) : (
              <p>Its delete was refused: {outcome.reason}.</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
