import { cn } from '@commerceworker/ui/lib/utils';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableEmpty, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Link, useLoaderData } from 'react-router';
import { FindBar, Off, Pager, Total } from '~/components/back-office';
import { requireUser } from '~/lib/auth.server';
import { sellersPage } from '~/lib/commerce.server';
import type { Route } from './+types/sellers';

export const meta = () => [{ title: 'Marketplace sellers · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return sellersPage(new URL(request.url).searchParams);
}

export default function Sellers() {
  const { sellers, q } = useLoaderData<typeof loader>();
  return (
    <>
      <PageHeader
        title="Marketplace sellers"
        subtitle="Who sells through the marketplace. A marketplace order splits by seller, asks each one to accept their part and schedules their payout."
      />
      <Body className="grid gap-4">
        <FindBar q={q} label="Find a seller by name or email" />
        <Section
          title="Sellers"
          description="Each seller’s contact, how they accept orders and the commission kept. A seller’s name opens their orders and payouts in Records."
          actions={<Total list={sellers} noun="seller" />}
          flush
        >
          {sellers.total || q ? (
            <Table stack="cards" scroll caption="Marketplace sellers">
              <TableHead>
                <Tr>
                  <Th>Seller</Th>
                  <Th>Accepts orders</Th>
                  <Th numeric>Commission</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {sellers.rows.map((s) => (
                  <Tr key={s.id}>
                    <Td>
                      <Link
                        to={`/records?q=${encodeURIComponent(s.name)}`}
                        className={cn('hover:underline', !s.active && 'text-muted-foreground')}
                        title={`Seller orders and payouts for ${s.name}`}
                      >
                        {s.name}
                      </Link>
                      {s.active ? null : <Off />}
                      <div className="break-all text-muted-foreground text-xs">{s.email}</div>
                    </Td>
                    <Td label="Accepts orders">
                      {s.autoAccept ? 'Automatically' : 'Asked per order'}
                    </Td>
                    <Td numeric label="Commission">
                      {Math.round(s.commissionPct * 1000) / 10}%
                    </Td>
                  </Tr>
                ))}
                {q && !sellers.total ? (
                  <TableEmpty colSpan={3}>No sellers match “{q}”.</TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          ) : (
            <Empty>No marketplace sellers yet.</Empty>
          )}
          <Pager list={sellers} listKey="sellers" label="Sellers" />
        </Section>
      </Body>
    </>
  );
}
