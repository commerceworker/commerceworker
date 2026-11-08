import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Progress } from '@commerceworker/ui/progress';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { StatusBadge } from '~/cms/components/status';
import { useClient } from '../../lib/client-context';
import type { StarterInstall } from '../../lib/management';

/** How often a running install is read again. */
export const STARTER_INSTALL_POLL_MS = 3000;

/** Failures a stopped install names; the phase's job report has them all. */
const NAMED = 5;

/**
 * A background starter install, followed from the dialog that started it: the phase under way
 * (its title, step N of M) in the bulk job card's shape (a polite live summary, its stamp, a
 * `Progress` of phases done), polled until it completes or stops. A stopped install says where,
 * names what failed and how to finish it; an unreadable progress says the install keeps running
 * on the server. `onSettled` runs once, when it ends either way.
 */
export function StarterInstallProgress(props: {
  spaceId: string;
  environmentId: string;
  install: string;
  steps: number;
  /** The starter's name, for the summary ("Installed Enterprise demo (Aldermoor)"). */
  title: string;
  onSettled?: (install: StarterInstall) => void;
}) {
  const { client } = useClient();
  const query = useQuery({
    queryKey: ['starter-install', props.spaceId, props.environmentId, props.install],
    queryFn: () => client.getStarterInstall(props.spaceId, props.environmentId, props.install),
    refetchInterval: (q) =>
      q.state.data && q.state.data.status !== 'running' ? false : STARTER_INSTALL_POLL_MS,
    retry: false,
  });
  const install = query.data;
  const status = install?.status ?? 'running';
  const steps = install?.steps ?? props.steps;
  // Phases done: the one under way isn't, until the install moves past it.
  const done = !install ? 0 : status === 'completed' ? steps : Math.max(0, install.step - 1);

  const settled = useRef(false);
  const settle = useRef(props.onSettled);
  settle.current = props.onSettled;
  useEffect(() => {
    if (!install || install.status === 'running' || settled.current) return;
    settled.current = true;
    settle.current?.(install);
  }, [install]);

  const summary =
    status === 'completed'
      ? `Installed ${props.title}`
      : status === 'failed'
        ? `The install stopped at ${install?.title ?? 'a step'}`
        : install
          ? `Installing ${install.title}: step ${install.step} of ${steps}…`
          : `Starting the install…`;

  return (
    <section aria-label="Starter install" className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="section-title" role="status">
          {summary}
        </p>
        <StatusBadge status={status} />
      </div>
      <Progress
        value={Math.round((done / Math.max(1, steps)) * 100)}
        aria-label="Starter install progress"
        className="h-1.5"
      />
      <p className="text-muted-foreground text-xs">
        {status === 'completed'
          ? 'Every step is done. The space is ready to explore.'
          : status === 'failed'
            ? `${done} of ${steps} steps done. What they installed is kept.`
            : `${done} of ${steps} steps done; this keeps running if you close this dialog or the tab.`}
      </p>
      {status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>The rest of the content wasn’t installed</AlertTitle>
          <AlertDescription>
            {(install?.failures ?? []).length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4">
                {(install?.failures ?? []).slice(0, NAMED).map((f) => (
                  <li key={f.id}>{f.error}</li>
                ))}
              </ul>
            )}
            <p>
              Create the space again with the same id and starter to finish: what was installed is
              kept, and nothing is added twice.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {query.isError && status === 'running' && (
        <p className="text-muted-foreground text-xs" role="status">
          Couldn’t read the install’s progress just now. It keeps running on the server; this tries
          again in a few seconds.
        </p>
      )}
    </section>
  );
}
