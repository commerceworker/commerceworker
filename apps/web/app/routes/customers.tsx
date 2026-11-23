import { COMPANY_STATUS_LABELS, COMPANY_STATUSES, CUSTOMER_KINDS } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { money } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableEmpty, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { useId } from 'react';
import { Form, Link, useLoaderData, useNavigate, useSearchParams } from 'react-router';
import { FindBar, Pager, Total } from '~/components/back-office';
import { NewCustomer } from '~/components/company';
import { ToneBadge } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { customersPage } from '~/lib/commerce.server';
import { CUSTOMER_KIND_KEY, CUSTOMER_STATUS_KEY } from '~/lib/commerce-pages';
import { humanize } from '~/lib/format';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/customers';

export const meta = () => [{ title: 'Customers · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return customersPage(new URL(request.url).searchParams);
}

export default function Customers() {
  const { customers, customerFilter, q } = useLoaderData<typeof loader>();
  const canOperate = useCan('operator');
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Consumers, businesses and internal buyers: their terms, balances and credit, and a business customer’s company, members and tax exemptions."
        actions={canOperate ? <NewCustomer navigate={navigate} /> : null}
      />
      <Body className="grid gap-4">
        <FindBar q={q} label="Find a customer by name or id" />
        <Section
          title="Directory"
          description="Each customer’s terms, balance and credit limit, and a business customer’s company status."
          actions={<Total list={customers} noun="customer" />}
          flush
        >
          <CustomerFilters filter={customerFilter} />
          {customers.total || q || customerFilter.kind || customerFilter.status ? (
            <Table stack="cards" scroll caption="Customers">
              <TableHead>
                <Tr>
                  <Th>Customer</Th>
                  <Th>Company</Th>
                  <Th>Terms</Th>
                  <Th numeric>Balance</Th>
                  <Th numeric>Credit limit</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {customers.rows.map((c) => {
                  const over = !!c.creditLimit && c.balance > c.creditLimit;
                  // Close enough that one more order could tip it over.
                  const near = !over && !!c.creditLimit && c.balance >= c.creditLimit * 0.9;
                  return (
                    <Tr key={c.id}>
                      <Td>
                        <Link to={`/customers/${c.id}`} className="hover:underline">
                          {c.name}
                        </Link>
                        <div className="text-muted-foreground text-xs">
                          {humanize(c.kind)}
                          {c.kind === 'business' ? ` · ${humanize(c.tier)}` : ''}
                        </div>
                      </Td>
                      <Td label="Company">
                        {c.companyStatus ? (
                          <ToneBadge
                            tone={COMPANY_TONE[c.companyStatus]}
                            label={COMPANY_STATUS_LABELS[c.companyStatus]}
                          />
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </Td>
                      <Td label="Terms">
                        {c.kind === 'business' ? humanize(c.terms) : 'Pays at checkout'}
                      </Td>
                      <Td
                        numeric
                        label="Balance"
                        className={cn(
                          over && 'font-medium text-bad',
                          near && 'font-medium text-wait',
                        )}
                      >
                        {money(c.balance)}
                        {over ? <span className="ml-1.5 text-xs">Over limit</span> : null}
                        {near ? <span className="ml-1.5 text-xs">Near limit</span> : null}
                      </Td>
                      <Td numeric label="Credit limit">
                        {c.creditLimit ? (
                          money(c.creditLimit)
                        ) : (
                          <span className="text-muted-foreground">No limit</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
                {!customers.total ? (
                  <TableEmpty colSpan={5}>
                    No customers match{q ? ` “${q}”` : ' those filters'}.
                  </TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          ) : (
            <Empty>No customers yet.</Empty>
          )}
          <Pager list={customers} listKey="customers" label="Customers" />
        </Section>
      </Body>
    </>
  );
}

/** A company's status as its badge shows it (the customer page's tones). */
const COMPANY_TONE: Record<(typeof COMPANY_STATUSES)[number], 'ok' | 'wait' | 'bad' | 'idle'> = {
  pending: 'wait',
  active: 'ok',
  suspended: 'bad',
  rejected: 'idle',
  closed: 'idle',
};

/**
 * The customers list's filters, kept in the URL beside the search and the other lists' pages:
 * a kind, and the status of a business customer's company. Choosing one reloads the list.
 */
function CustomerFilters({ filter }: { filter: { kind: string | null; status: string | null } }) {
  const [params] = useSearchParams();
  const kindId = useId();
  const statusId = useId();
  const kept = [...params].filter(
    ([k]) => k !== CUSTOMER_KIND_KEY && k !== CUSTOMER_STATUS_KEY && k !== 'customers',
  );
  return (
    <Form
      method="get"
      className="flex flex-wrap items-center gap-2 px-4 pb-3"
      role="search"
      aria-label="Filter customers"
    >
      {kept.map(([k, v]) => (
        <input key={`${k}=${v}`} type="hidden" name={k} value={v} />
      ))}
      <label htmlFor={kindId} className="sr-only">
        Kind
      </label>
      <NativeSelect
        id={kindId}
        name={CUSTOMER_KIND_KEY}
        size="sm"
        defaultValue={filter.kind ?? ''}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <NativeSelectOption value="">All kinds</NativeSelectOption>
        {CUSTOMER_KINDS.map((k) => (
          <NativeSelectOption key={k} value={k}>
            {humanize(k)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <label htmlFor={statusId} className="sr-only">
        Company status
      </label>
      <NativeSelect
        id={statusId}
        name={CUSTOMER_STATUS_KEY}
        size="sm"
        defaultValue={filter.status ?? ''}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <NativeSelectOption value="">Any company status</NativeSelectOption>
        {COMPANY_STATUSES.map((s) => (
          <NativeSelectOption key={s} value={s}>
            {COMPANY_STATUS_LABELS[s]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button type="submit" size="sm" variant="outline">
        Filter
      </Button>
      {filter.kind || filter.status ? (
        <Link
          to={`/customers${kept.length ? `?${new URLSearchParams(kept).toString()}` : ''}`}
          className="hit-area text-link text-sm hover:underline"
        >
          Clear filters
        </Link>
      ) : null}
    </Form>
  );
}
