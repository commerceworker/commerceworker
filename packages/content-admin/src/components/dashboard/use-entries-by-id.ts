import { useMemo } from 'react';
import { useClient } from '../../lib/client-context';
import type { PreviewEntry } from '../../lib/management';
import { useContentTypesQuery, useScopedQuery } from '../../lib/queries';
import { type EntryRef, entryRef, fetchEntriesById } from './entry-titles';

/**
 * Names and links for entries known only by id (an agent run, a review, a scheduled action, a
 * workflow step): one batched lookup instead of a request per row, so a screen of proposals is
 * never left reading ids. Keyed under `entries`, so every entry mutation's invalidation refreshes
 * it. An id missing from `refs` once `resolving(id)` is false was deleted or isn't visible.
 */
export function useEntriesById(ids: readonly string[]) {
  const { client, conn } = useClient();
  const types = useContentTypesQuery().data;
  const key = useMemo(() => [...new Set(ids.filter(Boolean))].sort(), [ids]);
  const query = useScopedQuery(['entries', 'by-id', key], () => fetchEntriesById(client, key), {
    silent: true,
    enabled: key.length > 0,
    // When the set of ids changes (a proposal approved, a live event), rows already named keep
    // their names while the new set loads, instead of every row going back to a skeleton.
    keepPrevious: true,
  });
  const entries = useMemo(
    () => new Map((query.data ?? []).map((e) => [e.id, e] as const)),
    [query.data],
  );
  const refs = useMemo(
    () =>
      new Map(
        [...entries.values()].map((e) => [e.id, entryRef(e, types ?? [], conn.locale)] as const),
      ),
    [entries, types, conn.locale],
  );
  return {
    entries: entries as ReadonlyMap<string, PreviewEntry>,
    refs: refs as ReadonlyMap<string, EntryRef>,
    /** The first lookup hasn't answered yet (nothing to show for any row). */
    isLoading: key.length > 0 && query.isLoading,
    /** This id isn't named yet but a lookup that may name it is in flight. */
    resolving: (id: string) => !entries.has(id) && (query.isLoading || query.isFetching),
    isError: query.isError,
  };
}
