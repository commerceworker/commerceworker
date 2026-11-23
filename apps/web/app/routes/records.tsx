import { Ago } from '@commerceworker/ui/ago';
import { count, money } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { useEffect, useId, useState } from 'react';
import { Link, useLoaderData, useSearchParams } from 'react-router';
import { FindBar } from '~/components/back-office';
import { ToneBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { humanize, orderRef } from '~/lib/format';
import { RECORD_KINDS, type RecordKind, type RecordRow, recordTone } from '~/lib/records';
import { recentRecords } from '~/lib/records.server';
import type { Route } from './+types/records';

export const meta = () => [{ title: 'Records · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  return { records: await recentRecords(q), q };
}

export default function RecordsPage() {
  const { records, q } = useLoaderData<typeof loader>();
  return (
    <>
      <PageHeader
        title="Records"
        subtitle="What orders did to the outside world: payments, shipments, stock held, messages and seller payouts. Every write is keyed by its step, so a retry finds the same record."
      />
      <Body className="grid gap-4">
        <FindBar q={q} label="Find an order, customer, SKU or seller" />
        <Records records={records} q={q} />
      </Body>
    </>
  );
}

/**
 * What orders did to the outside world, by kind, newest first. Each row names its order and the
 * step that wrote it: every connector write is keyed by its step, so a retry finds the same row.
 */
function Records({ records, q }: { records: Record<RecordKind, RecordRow[]>; q: string }) {
  const [params] = useSearchParams();
  const asked = RECORD_KINDS.find((k) => k.id === params.get('records'))?.id;
  // With a search, open the first kind that has anything.
  const first = RECORD_KINDS.find((k) => records[k.id].length)?.id ?? 'money';
  const [kind, setKind] = useState<RecordKind>(asked ?? (q ? first : 'money'));
  useEffect(() => {
    setKind(asked ?? (q ? first : 'money'));
  }, [asked, q, first]);
  const rows = records[kind];
  const tablistId = useId();
  return (
    <Section
      title="By kind"
      description="Newest first. Each row names its order and the step that wrote it."
      flush
    >
      <div
        role="tablist"
        aria-label="Kinds of record"
        id={tablistId}
        className="mx-(--card-spacing) my-3 flex w-fit max-w-[calc(100%-2*var(--card-spacing))] flex-wrap gap-1 rounded-3xl bg-muted p-1"
      >
        {RECORD_KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            id={`${tablistId}-${k.id}`}
            aria-selected={kind === k.id}
            aria-controls={`${tablistId}-panel`}
            onClick={() => setKind(k.id)}
            className={cn(
              'hit-area min-h-7 rounded-full border border-transparent px-3 py-1 text-ui outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              kind === k.id
                ? 'bg-background font-medium text-foreground shadow-sm dark:bg-input/30'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {k.label}{' '}
            <span className={cn('tabular', kind === k.id ? 'opacity-80' : 'opacity-70')}>
              {count(records[k.id].length)}
            </span>
          </button>
        ))}
      </div>
      <div id={`${tablistId}-panel`} role="tabpanel" aria-labelledby={`${tablistId}-${kind}`}>
        {rows.length ? (
          <Table stack="cards" scroll caption={RECORD_KINDS.find((k) => k.id === kind)?.label}>
            <TableHead>
              <Tr>
                <Th>Record</Th>
                <Th>Order</Th>
                <Th>Status</Th>
                <Th numeric>Amount</Th>
                <Th numeric>When</Th>
              </Tr>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="max-w-80">
                    <div className="break-words">{r.what}</div>
                    {r.detail || r.step ? (
                      <div className="break-words text-muted-foreground text-xs">
                        {r.detail}
                        {r.detail && r.step ? ' · ' : ''}
                        {r.step ? (
                          <span title="The step that wrote it; a retry finds this same record">
                            step <span className="font-mono">{r.step}</span>
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </Td>
                  <Td label="Order" className="max-w-72">
                    <Link to={`/orders/${r.orderId}`} className="hover:underline">
                      {r.orderTitle || 'Order'}
                    </Link>{' '}
                    <span className="font-mono text-muted-foreground text-xs">
                      {orderRef(r.orderId)}
                    </span>
                    {r.customer ? (
                      <div className="break-words text-muted-foreground text-xs">{r.customer}</div>
                    ) : null}
                  </Td>
                  <Td label="Status">
                    {r.status ? (
                      <ToneBadge tone={recordTone(r.status)} label={humanize(r.status)} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td numeric label="Amount">
                    {r.amount !== null ? money(r.amount, r.currency ?? undefined) : ''}
                  </Td>
                  <Td numeric label="When" className="text-muted-foreground text-xs">
                    <Ago ms={r.at} />
                  </Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>
            {q
              ? `No ${RECORD_KINDS.find((k) => k.id === kind)?.label.toLowerCase()} match “${q}”.`
              : 'Nothing yet. Orders write these as their steps run.'}
          </Empty>
        )}
      </div>
    </Section>
  );
}
