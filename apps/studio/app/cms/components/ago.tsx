import { ago, dateTime, toMs } from '~/cms/lib/format';
import { useNow } from '~/cms/lib/use-now';

/**
 * "3m ago" that stays true: refreshed every second while fresh,
 * then twice a minute. The full local time is in the tooltip and the `<time>` element's
 * `dateTime`. Takes ms or an ISO string, as the API returns.
 */
export function Ago({ at }: { at: number | string | null | undefined }) {
  const ms = toMs(at);
  const now = useNow(ms && Date.now() - ms < 60_000 ? 1000 : 30_000);
  if (!ms) return <>{ago(ms)}</>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={dateTime(ms)}>
      {ago(ms, now)}
    </time>
  );
}
