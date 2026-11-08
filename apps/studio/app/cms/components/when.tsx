import { dateTime, toMs } from '~/cms/lib/format';

/**
 * A moment as a full local date and time ("Oct 30, 2026, 2:05 PM"), in a `<time>` whose
 * `dateTime` carries the exact instant. For when the moment itself is the fact (a schedule, a
 * delivery); `Ago` is for how recent something is. Takes ms or an ISO string, as the API returns,
 * and an em dash for nothing.
 */
export function When({ at }: { at: number | string | null | undefined }) {
  const ms = toMs(at);
  if (!ms) return <>—</>;
  return <time dateTime={new Date(ms).toISOString()}>{dateTime(ms)}</time>;
}
