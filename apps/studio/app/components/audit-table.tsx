import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Ago } from '~/components/ago';
import { ToneBadge } from '~/components/status';
import { type AuditEvent, describeEvent } from '~/lib/audit';
import { useDateTime } from '~/lib/use-date-time';

/** Actions that record something refused or failed, drawn as a failure. */
const REFUSED = /(_failed|_throttled|_refused|_expired|\.refused)$/;

export type AuditTableEvent = AuditEvent & {
  readonly id: string | number;
  readonly at: number;
  readonly ip: string | null;
};

/**
 * The deployment's audit events, newest first. Each row leads with what happened (on a phone it
 * heads the card), a refusal saying so in a ruled badge rather than in colour alone; then who,
 * when (the time itself, how long ago beside it) and from where.
 */
export function AuditTable({ events }: { events: readonly AuditTableEvent[] }) {
  const formatTime = useDateTime();
  return (
    <Table stack="cards" sticky caption="Events">
      <TableHead>
        <Tr>
          <Th>What</Th>
          <Th>Who</Th>
          <Th>When</Th>
          <Th>From</Th>
        </Tr>
      </TableHead>
      <TableBody>
        {events.map((e) => (
          <Tr key={e.id}>
            <Td>
              {/* Something refused or failed: a sign-in, a step-up, an API call. */}
              {REFUSED.test(e.action) ? (
                <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <ToneBadge tone="bad" label="Refused" />
                  {describeEvent(e)}
                </span>
              ) : (
                describeEvent(e)
              )}
            </Td>
            <Td label="Who">{e.actor ?? <span className="text-muted-foreground">—</span>}</Td>
            <Td label="When" className="whitespace-nowrap text-xs">
              <time dateTime={new Date(e.at).toISOString()} suppressHydrationWarning>
                {formatTime(e.at)}
              </time>
              <span className="text-muted-foreground">
                {' · '}
                <Ago ms={e.at} />
              </span>
            </Td>
            <Td label="From" className="font-mono text-muted-foreground text-xs">
              {e.ip}
            </Td>
          </Tr>
        ))}
      </TableBody>
    </Table>
  );
}
