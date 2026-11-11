/**
 * Purchase orders: every company's buyer POs, newest first, filtered by status, company, the days
 * they were created and a PO number search. Viewers read; an operator starts a draft, which goes
 * through the assistant (`create_po_draft`) and opens on its own page.
 */
import { PO_STATUS_LABELS, PO_STATUSES } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { Field, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { plural } from '@commerceworker/ui/lib/format';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Form, Link, useLoaderData } from 'react-router';
import { NewPurchaseOrder, PoTable } from '~/components/purchase-orders';
import { requireUser } from '~/lib/auth.server';
import { filterQuery, filtersFrom } from '~/lib/purchase-orders';
import { activeCompanies, purchaseOrderPage } from '~/lib/purchase-orders.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/purchase-orders';

export const meta = () => [{ title: 'Purchase orders · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  const filters = filtersFrom(params);
  const [page, companies] = await Promise.all([
    purchaseOrderPage(filters, params.get('after') ?? undefined),
    activeCompanies(),
  ]);
  return { ...page, filters, companyChoices: companies, after: params.get('after') };
}

export default function PurchaseOrders() {
  const { purchaseOrders, total, cursor, companies, filters, companyChoices, error } =
    useLoaderData<typeof loader>();
  const canOperate = useCan('operator');
  return (
    <>
      <PageHeader
        title="Purchase orders"
        subtitle="Buyers’ POs, from the app, the API and inbound EDI and email. Submitting a draft starts an order; from then on the order’s progress is the PO’s."
        actions={
          canOperate ? (
            <NewPurchaseOrder companies={companyChoices} initialCompany={filters.company} />
          ) : null
        }
      />
      <Body className="grid gap-4">
        {/* A GET form, so a filtered list is a link that can be shared. */}
        <Form
          method="get"
          aria-label="Filter purchase orders"
          className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3 lg:grid-cols-6"
        >
          <Field className="gap-1">
            <FieldLabel htmlFor="po-filter-status">Status</FieldLabel>
            <NativeSelect
              id="po-filter-status"
              name="status"
              defaultValue={filters.status ?? ''}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="">Any</NativeSelectOption>
              {PO_STATUSES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {PO_STATUS_LABELS[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="po-filter-company">Company</FieldLabel>
            <NativeSelect
              id="po-filter-company"
              name="company"
              defaultValue={filters.company ?? ''}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="">Any</NativeSelectOption>
              {companyChoices.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="po-filter-from">Created from</FieldLabel>
            <Input id="po-filter-from" name="from" type="date" defaultValue={filters.from ?? ''} />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="po-filter-to">Created to</FieldLabel>
            <Input id="po-filter-to" name="to" type="date" defaultValue={filters.to ?? ''} />
          </Field>
          <Field className="col-span-2 gap-1 sm:col-span-1">
            <FieldLabel htmlFor="po-filter-q">PO number</FieldLabel>
            <Input id="po-filter-q" name="q" defaultValue={filters.q ?? ''} maxLength={100} />
          </Field>
          <div className="col-span-2 flex gap-2 sm:col-span-1">
            <Button type="submit" size="sm">
              Filter
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/purchase-orders">Clear</Link>
            </Button>
          </div>
        </Form>
        <Section
          title="Purchase orders"
          description={`${plural(total, 'purchase order')}${Object.keys(filters).length ? ' match' : ''}, newest first.`}
          flush
        >
          {error ? (
            <Empty>{error}</Empty>
          ) : purchaseOrders.length ? (
            <PoTable rows={purchaseOrders} companies={companies} />
          ) : (
            <Empty>No purchase orders match.</Empty>
          )}
          <nav
            aria-label="Purchase order pages"
            className="flex items-center gap-4 border-t px-5 py-2 text-xs"
          >
            <span className="text-muted-foreground">
              {cursor ? 'More after this page' : 'End of the list'}
            </span>
            {cursor ? (
              <Link
                to={filterQuery(filters, { after: cursor })}
                className="hit-area ml-auto text-link hover:underline"
              >
                Next page
              </Link>
            ) : null}
          </nav>
        </Section>
      </Body>
    </>
  );
}
