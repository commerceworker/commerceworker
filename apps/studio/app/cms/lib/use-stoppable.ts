import { useEffect, useRef } from 'react';

/**
 * A request someone can walk away from: a model can hang, and a dialog that waits on it must still
 * have a way out. `start` hands out the signal for a new run; `stop` aborts it. After its await a
 * run checks `signal.aborted` and touches nothing, so a late answer can't land in a closed dialog.
 * Unmounting stops the run too.
 */
export function useStoppable() {
  const run = useRef<AbortController | null>(null);
  const stop = () => {
    run.current?.abort();
    run.current = null;
  };
  useEffect(() => () => run.current?.abort(), []);
  return {
    start: () => {
      run.current?.abort();
      run.current = new AbortController();
      return run.current.signal;
    },
    stop,
  };
}
