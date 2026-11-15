import { ToneBadge } from '@commerceworker/content-admin/components/status';
import { Link } from '@commerceworker/content-admin/router';
import { Badge } from '@commerceworker/ui/badge';
import { Card, CardContent, CardHeader } from '@commerceworker/ui/card';
import { Radio } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClient } from '../../lib/client-context';
import { humanize } from '../../lib/format';
import { type EntryRef, entryPath } from './entry-titles';
import { useEntriesById } from './use-entries-by-id';

/** "entry.published" → "Published": the event's verb, in the editor's words. */
const eventLabel = (type: string) => humanize(type.split('.').pop() ?? type);

/** `seq` keys the row: two events can arrive in one millisecond, for no entry (an asset's). */
type LiveItem = { seq: number; type: string; entryId?: string; at: number };

/**
 * Live Content API feed: streams published-content changes over SSE (via fetch
 * streaming, so the bearer token is sent). Shows the most recent events; the
 * connection closes when the card unmounts.
 */
export function LiveActivityCard(props: { entryById?: (id: string) => EntryRef | undefined }) {
  const { client } = useClient();
  const [items, setItems] = useState<LiveItem[]>([]);
  // Live events name entries by id; the ones the Overview hasn't loaded are looked up in one batch.
  const unseen = useMemo(
    () => items.flatMap((it) => (it.entryId && !props.entryById?.(it.entryId) ? [it.entryId] : [])),
    [items, props.entryById],
  );
  const looked = useEntriesById(unseen);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const ac = new AbortController();
    // The server ends each stream after a while (so access is re-checked) and a stream can drop:
    // reconnect until the card unmounts, backing off while it keeps failing.
    void (async () => {
      let failures = 0;
      while (!ac.signal.aborted) {
        setConnected(true);
        const opened = Date.now();
        try {
          await client.subscribeLive((e) => {
            const data = e.data as { entryId?: string } | undefined;
            setItems((prev) =>
              [
                { seq: ++seq.current, type: e.type, entryId: data?.entryId, at: Date.now() },
                ...prev,
              ].slice(0, 20),
            );
          }, ac.signal);
        } catch {
          // Reconnect below.
        }
        setConnected(false);
        if (ac.signal.aborted) return;
        // A stream that stayed up a while ended normally; one that failed fast backs off.
        failures = Date.now() - opened > 30_000 ? 0 : failures + 1;
        const wait = Math.min(30_000, 1_000 * 2 ** failures);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, wait);
          ac.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    })();
    return () => ac.abort();
  }, [client]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 font-heading font-medium text-base">
          <Radio className="size-4 text-muted-foreground" />
          Live activity
        </h2>
        <ToneBadge tone={connected ? 'run' : 'idle'} label={connected ? 'Live' : 'Idle'} />
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Published changes stream in here as they happen.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((it) => {
              const ref = it.entryId
                ? (props.entryById?.(it.entryId) ?? looked.refs.get(it.entryId))
                : undefined;
              return (
                <li key={it.seq} className="flex min-w-0 items-center gap-2 text-sm">
                  <Badge variant="outline">{eventLabel(it.type)}</Badge>
                  {ref ? (
                    <Link
                      to={entryPath(ref)}
                      className="min-w-0 truncate underline-offset-2 hover:underline"
                    >
                      {ref.title}
                    </Link>
                  ) : (
                    it.entryId && (
                      <span className="truncate text-muted-foreground">
                        {looked.resolving(it.entryId) ? '…' : 'Entry no longer available'}
                      </span>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
