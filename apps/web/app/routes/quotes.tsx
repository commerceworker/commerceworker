/**
 * Quotes: every company's negotiated quotes, newest first, filtered by status, company and a name
 * search. Viewers read; an operator starts a draft, which goes through the assistant
 * (`create_quote`) and opens on its own page. A negotiation shows once, at its latest version.
 */
import { QUOTE_STATUS_LABELS, QUOTE_STATUSES } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { Field, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { plural } from '@commerceworker/ui/lib/format';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Form, Link, useLoaderData } from 'react-router';
import { NewQuote, QuoteTable } from '~/components/quotes';
import { requireUser } from '~/lib/auth.server';
import { activeCompanies } from '~/lib/purchase-orders.server';
import { filterQuery, filtersFrom } from '~/lib/quotes';
import { quotePage } from '~/lib/quotes.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/quotes';

export const meta = () => [{ title: 'Quotes · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  const filters = filtersFrom(params);
  const [page, companies] = await Promise.all([
    quotePage(filters, params.get('after') ?? undefined),
    activeCompanies(),
  ]);
  return { ...page, filters, companyChoices: companies };
}

export default function Quotes() {
  const { quotes, total, cursor, companies, filters, companyChoices, error } =
    useLoaderData<typeof loader>();
  const canOperate = useCan('operator');
  return (
    <>
      <PageHeader
        title="Quotes"
        subtitle="Negotiated prices for a company, versioned as they are agreed. Once accepted, a quote prices the company’s orders until it expires; it can become a purchase order draft or an order."
        actions={
          canOperate ? (
            <NewQuote companies={companyChoices} initialCompany={filters.company} />
          ) : null
        }
      />
      <Body className="grid gap-4">
        {/* A GET form, so a filtered list is a link that can be shared. */}
        <Form
          method="get"
          aria-label="Filter quotes"
          className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4"
        >
          <Field className="gap-1">
            <FieldLabel htmlFor="qt-filter-status">Status</FieldLabel>
            <NativeSelect
              id="qt-filter-status"
              name="status"
              defaultValue={filters.status ?? ''}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="">Latest versions</NativeSelectOption>
              {QUOTE_STATUSES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {QUOTE_STATUS_LABELS[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor="qt-filter-company">Company</FieldLabel>
            <NativeSelect
              id="qt-filter-company"
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
          <Field className="col-span-2 gap-1 sm:col-span-1">
            <FieldLabel htmlFor="qt-filter-q">Name</FieldLabel>
            <Input id="qt-filter-q" name="q" defaultValue={filters.q ?? ''} maxLength={100} />
          </Field>
          <div className="col-span-2 flex gap-2 sm:col-span-1">
            <Button type="submit" size="sm">
              Filter
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/quotes">Clear</Link>
            </Button>
          </div>
        </Form>
        <Section
          title="Quotes"
          description={`${plural(total, 'quote')}${Object.keys(filters).length ? ' match' : ''}, newest first.`}
          flush
        >
          {error ? (
            <Empty>{error}</Empty>
          ) : quotes.length ? (
            <QuoteTable rows={quotes} companies={companies} />
          ) : (
            <Empty>No quotes match.</Empty>
          )}
          <nav
            aria-label="Quote pages"
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
