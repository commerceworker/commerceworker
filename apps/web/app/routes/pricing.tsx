import { BASE_CURRENCY } from '@commerceworker/core';
import { count, money } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { Body, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Link, useLoaderData } from 'react-router';
import { FindBar, Off, Pager } from '~/components/back-office';
import { FxRates } from '~/components/fx-rates';
import { requireUser } from '~/lib/auth.server';
import { fxRatesPage, pricingPage } from '~/lib/commerce.server';
import { pricesKey } from '~/lib/commerce-pages';
import { humanize } from '~/lib/format';
import type { Route } from './+types/pricing';

export const meta = () => [{ title: 'Pricing · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const [page, fxRates] = await Promise.all([
    pricingPage(new URL(request.url).searchParams),
    fxRatesPage(),
  ]);
  return { ...page, fxRates };
}

type PricingData = Awaited<ReturnType<typeof loader>>;

export default function PricingPage() {
  const { pricing, fxRates, q } = useLoaderData<typeof loader>();
  return (
    <>
      <PageHeader
        title="Pricing"
        subtitle="How an order’s lines are priced: the sources a Price lines step runs, in order, and the exchange rates an order in another currency converts at."
      />
      <Body className="grid gap-4">
        <FindBar q={q} label="Find a SKU, product, customer or rule" />
        <Pricing pricing={pricing} fxRates={fxRates} />
      </Body>
    </>
  );
}

function Pricing({ pricing, fxRates }: Pick<PricingData, 'pricing' | 'fxRates'>) {
  const item = (sku: string | null, name: string | null) =>
    sku ? (name ? `${name} (${sku})` : sku) : null;
  const entries = (rows: PricingData['pricing']['sources'][number]['entries']['rows']) =>
    rows.map((r) => ({
      key: r.key,
      name: r.name,
      scope: [
        item(r.sku, r.productName),
        r.customerTier ? `${humanize(r.customerTier)} tier` : null,
        r.customerName,
        r.minQty ? `${count(r.minQty)}+` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      price: r.price != null ? money(r.price) : `${r.discountPct}% off list`,
    }));
  return (
    <Section
      id="chain"
      title="Price sources"
      description="In the order a Price lines step runs them, each with its entries."
      flush
    >
      <ol className="divide-y">
        {pricing.sources.map((s, i) => {
          const rows = entries(s.entries.rows);
          return (
            <li key={s.id}>
              <div className="flex flex-wrap items-baseline gap-x-3 px-4 pt-2.5 pb-1">
                <span className="text-muted-foreground text-xs tabular">{i + 1}</span>
                <span className={`font-medium text-sm ${s.active ? '' : 'text-muted-foreground'}`}>
                  {s.label}
                </span>
                {s.active ? null : <Off />}
                <span className="text-muted-foreground text-xs">
                  priority {s.priority}
                  {s.active
                    ? s.stopProcessing
                      ? ' · a match here is the price; later sources are skipped'
                      : ' · a match here can be adjusted by later sources'
                    : ''}
                </span>
              </div>
              {rows.length ? (
                <Table
                  edge="flush"
                  caption={s.label}
                  className={cn('mb-2 table-fixed', !s.active && 'text-muted-foreground')}
                >
                  <TableHead className="sr-only">
                    <Tr>
                      <Th>Applies as</Th>
                      <Th>To</Th>
                      <Th numeric>Price</Th>
                    </Tr>
                  </TableHead>
                  <TableBody className="divide-y-0">
                    {rows.map((r) => (
                      <Tr key={r.key}>
                        <Td className="w-2/5 break-words py-0.5 pl-4 sm:w-1/2 sm:pl-10">
                          {r.name}
                        </Td>
                        <Td className="break-words py-0.5 text-muted-foreground text-xs">
                          {r.scope}
                        </Td>
                        <Td numeric className="w-24 py-0.5 pr-4">
                          {r.price}
                        </Td>
                      </Tr>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="pb-2 pl-4 text-muted-foreground text-xs sm:pl-10">No entries.</p>
              )}
              <Pager
                list={s.entries}
                listKey={pricesKey(s.id)}
                hash="chain"
                label={s.label}
                inset
              />
            </li>
          );
        })}
        <li className="flex items-baseline gap-3 px-4 py-2.5">
          <span className="text-muted-foreground text-xs tabular">
            {pricing.sources.length + 1}
          </span>
          <span className="font-medium text-sm">List price</span>
          <span className="text-muted-foreground text-xs">when nothing above matches</span>
        </li>
      </ol>
      <p className="border-t px-4 py-2.5 text-muted-foreground text-xs">
        <span className="block max-w-measure">
          Prices are in {BASE_CURRENCY}. Orders in another currency convert at the rate below, fixed
          when the order is priced. Named price books and their assignments are under{' '}
          <Link to="/price-books" className="text-link hover:underline">
            Price books
          </Link>
          , and promotion codes under{' '}
          <Link to="/promotions" className="text-link hover:underline">
            Promotions
          </Link>
          .
        </span>
      </p>
      <FxRates rates={fxRates} />
    </Section>
  );
}
