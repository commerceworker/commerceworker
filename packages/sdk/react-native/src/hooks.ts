import type { Fields } from '@commerceworker/sdk-core';
import { useCallback, useEffect, useState } from 'react';
import type { OfflineDelivery } from './offline.js';

export interface SyncState<F extends Fields> {
  readonly entries: import('@commerceworker/sdk-core').DeliveredEntry<F>[];
  readonly syncing: boolean;
  readonly error?: Error;
  readonly sync: () => Promise<void>;
}

/**
 * Loads cached entries immediately (offline) and delta-syncs in the background.
 * Call `sync()` again on reconnect / foreground / pull-to-refresh.
 */
export function useOfflineEntries<F extends Fields = Fields>(
  store: OfflineDelivery<F>,
): SyncState<F> {
  const [entries, setEntries] = useState<import('@commerceworker/sdk-core').DeliveredEntry<F>[]>(
    [],
  );
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(undefined);
    try {
      await store.sync();
      setEntries(await store.list());
    } catch (e) {
      setError(e as Error);
    } finally {
      setSyncing(false);
    }
  }, [store]);

  useEffect(() => {
    let active = true;
    // Serve cache first, then sync.
    store.list().then((cached) => active && setEntries(cached));
    void sync();
    return () => {
      active = false;
    };
  }, [store, sync]);

  return { entries, syncing, error, sync };
}
