/**
 * One price book: its state and dates, who it is assigned to, and its entries (a SKU at a
 * quantity and up, at a price or a percentage off list, in USD). Every change goes through the
 * assistant's tools, whose cards say what changes for buyers and ask a person to confirm.
 */

import { PRICE_BOOK_LIFECYCLE, priceBookState } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { count, dateTime, money } from '@commerceworker/ui/lib/format';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { data, Link, useLoaderData } from 'react-router';
import {
  AddEntries,
  AssignBook,
  RemoveEntryButton,
  StatusButtons,
  UnassignButton,
} from '~/components/price-book-actions';
import { ToneBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { customerNames } from '~/lib/orders.server';
import { BOOK_STATES, entryLabel } from '~/lib/price-books';
import { bookDetail } from '~/lib/price-books.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/price-book';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.book.name ?? 'Price book'} · Price books · CommerceWorker` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const after = new URL(request.url).searchParams.get('after') ?? undefined;
  const found = await bookDetail(params.bookId, after);
  if (!found) throw data('Price book not found', { status: 404 });
  return {
    book: found.book,
    assignments: found.assignments,
    entries: found.entries,
    entryTotal: found.entryTotal,
    next: found.next,
    after: after ?? null,
    customers: await customerNames(found.assignments.map((a) => a.customerId)),
    // One clock for the page, so the server and the hydrating browser agree on what has ended.
    now: Date.now(),
  };
}

const MOVES = ['active', 'inactive', 'archived'] as const;

export default function PriceBookPage() {
  const { book, assignments, entries, entryTotal, next, after, customers, now } =
    useLoaderData<typeof loader>();
  const canOperate = useCan('operator');
  const state = priceBookState(book, now);
  const shown = BOOK_STATES[state];
  const allowed = MOVES.filter((to) => PRICE_BOOK_LIFECYCLE.can(book.status, to));
  const editable = book.status !== 'archived';
  const page = (cursor: string) => `/price-books/${book.id}?after=${encodeURIComponent(cursor)}`;
  return (
    <>
      <PageHeader
        title={book.name}
        crumbs={
          <Link to="/price-books" className="hover:underline">
            Price books
          </Link>
        }
        subtitle={[
          book.code,
          `priority ${book.priority}`,
          book.startsAt === null && book.endsAt === null
            ? 'in force whenever active'
            : [
                book.startsAt === null ? null : `from ${dateTime(book.startsAt, 'UTC')}`,
                book.endsAt === null ? null : `until ${dateTime(book.endsAt, 'UTC')}`,
              ]
                .filter(Boolean)
                .join(' '),
        ].join(' · ')}
        actions={
          <span className="inline-flex flex-wrap items-center gap-2">
            <ToneBadge tone={shown.tone} label={shown.label} />
            {canOperate ? (
              <StatusButtons bookId={book.id} name={book.name} allowed={allowed} />
            ) : null}
          </span>
        }
      />
      <Body className="grid gap-4 lg:gap-6">
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
          <Section
            title="Entries"
            description={`${count(entryTotal)} ${entryTotal === 1 ? 'entry' : 'entries'}, by SKU and quantity. Prices are in USD.`}
            flush
          >
            {entries.length ? (
              <Table stack="cards" caption="Price book entries">
                <TableHead>
                  <Tr>
                    <Th>SKU</Th>
                    <Th numeric>From quantity</Th>
                    <Th numeric>Price</Th>
                    <Th className="w-0">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </Tr>
                </TableHead>
                <TableBody>
                  {entries.map((e) => (
                    <Tr key={`${e.sku}~${e.minQty}`}>
                      <Td className="font-mono">{e.sku}</Td>
                      <Td numeric label="From quantity">
                        {e.minQty}
                      </Td>
                      <Td numeric label="Price">
                        {entryLabel(e, (n) => money(n))}
                      </Td>
                      <Td className="max-md:-ml-3 max-md:basis-full">
                        {canOperate && editable ? (
                          <RemoveEntryButton bookId={book.id} entry={e} />
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>No entries yet. The book prices nothing until it has some.</Empty>
            )}
            {after || next ? (
              <div className="flex gap-2 px-4 py-3">
                {after ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/price-books/${book.id}`}>First page</Link>
                  </Button>
                ) : null}
                {next ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to={page(next)}>Next page</Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
            {canOperate && editable ? (
              <div className="border-t px-4 py-4">
                <AddEntries bookId={book.id} />
              </div>
            ) : null}
          </Section>
          <Section
            title="Assigned to"
            description="Customers and tiers that pay this book's prices while it is in force."
          >
            {assignments.length ? (
              <ul className="-mx-2 flex flex-col gap-0.5">
                {assignments.map((a) => {
                  const to = a.customerId ? { customerId: a.customerId } : { tier: a.tier ?? '' };
                  const label = a.customerId
                    ? (customers[a.customerId] ?? a.customerId)
                    : `${a.tier} tier`;
                  return (
                    <li
                      key={a.customerId ?? `tier:${a.tier}`}
                      className="flex items-center gap-2 px-2 py-1"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {a.customerId ? (
                          <Link
                            to={`/customers/${a.customerId}`}
                            className="text-link hover:underline"
                          >
                            {label}
                          </Link>
                        ) : (
                          label
                        )}
                      </span>
                      {canOperate ? (
                        <UnassignButton bookId={book.id} to={to} label={label} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>Not assigned, so it prices nothing.</Empty>
            )}
            {canOperate && editable ? (
              <div className="mt-4 border-t pt-4">
                <AssignBook bookId={book.id} />
              </div>
            ) : null}
          </Section>
        </div>
      </Body>
    </>
  );
}
