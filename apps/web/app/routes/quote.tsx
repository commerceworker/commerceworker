/**
 * A quote. A draft is a form (name, buyer, expiry, notes and lines) saved through the assistant
 * (`update_quote`); anything else is read-only, because it has been sent. Sending, accepting,
 * declining, ending and converting stop for a confirm card; revising starts the next version as a
 * draft. The page names every version of the negotiation and what an accepted quote became.
 */
import { dayOfExpiry, QUOTE_STATUS_LABELS } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { dateTime, money } from '@commerceworker/ui/lib/format';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { type FormEvent, useState } from 'react';
import { data, Link, useLoaderData, useNavigate } from 'react-router';
import { QuoteLinesEditor, QuoteStatusBadge } from '~/components/quotes';
import { requireUser } from '~/lib/auth.server';
import { lineDiscount, linesFrom, quoteMoves } from '~/lib/quotes';
import { quoteDetail } from '~/lib/quotes.server';
import { useChange } from '~/lib/use-change';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/quote';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.quote.name ?? 'Quote'} · CommerceWorker` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const found = await quoteDetail(params.quoteId);
  if (!found) throw data('Quote not found', { status: 404 });
  return found;
}

export default function Quote() {
  const { quote, settled, state, company, members } = useLoaderData<typeof loader>();
  const canOperate = useCan('operator');
  const change = useChange();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [poNumber, setPoNumber] = useState('');
  const moves = quoteMoves(state === 'expired' ? 'expired' : quote.status, settled);
  const editing = canOperate && moves.edit;
  const id = { quoteId: quote.id };

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const lines = linesFrom(f);
    if (typeof lines === 'string') return setProblem(lines);
    setProblem(null);
    await change.run('update_quote', {
      ...id,
      name: String(f.get('name') ?? ''),
      buyerId: String(f.get('buyerId') ?? '') || null,
      expiresOn: String(f.get('expiresOn') ?? '') || null,
      notes: String(f.get('notes') ?? '').trim() || null,
      lines,
    });
  };
  const revise = async () => {
    const r = (await change.run('revise_quote', id)) as { quote?: { id: string } } | null;
    if (r?.quote) navigate(`/quotes/${r.quote.id}`);
  };
  const error = problem ?? change.error;
  const act = (tool: Parameters<typeof change.run>[0], label: string, variant?: 'outline') => (
    <Button
      size="sm"
      variant={variant}
      disabled={change.busy}
      onClick={() => void change.run(tool, id)}
    >
      {label}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={`Quote ${quote.name}`}
        crumbs={
          <Link to="/quotes" className="hover:underline">
            Quotes
          </Link>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <QuoteStatusBadge status={state} />
            <span>
              {company ? (
                <Link to={`/customers/${company.id}`} className="hit-area hover:underline">
                  {company.name}
                </Link>
              ) : (
                quote.companyId
              )}{' '}
              · version {quote.version} · created {dateTime(quote.createdAt, 'UTC')}
            </span>
          </span>
        }
        actions={
          canOperate ? (
            <span className="flex flex-wrap gap-2">
              {moves.send ? act('send_quote', 'Send') : null}
              {moves.accept ? act('accept_quote', 'Record acceptance') : null}
              {moves.decline
                ? act('decline_quote', quote.status === 'draft' ? 'Withdraw' : 'Decline', 'outline')
                : null}
              {moves.convert ? (
                <Button
                  size="sm"
                  disabled={change.busy}
                  onClick={() =>
                    void change.run('convert_quote', {
                      ...id,
                      ...(poNumber.trim() ? { poNumber: poNumber.trim() } : {}),
                    })
                  }
                >
                  {quote.convertedId ? 'Finish conversion' : 'Convert'}
                </Button>
              ) : null}
              {moves.revise ? (
                <Button size="sm" disabled={change.busy} onClick={() => void revise()}>
                  Revise
                </Button>
              ) : null}
              {moves.end ? act('expire_quote', 'End quote', 'outline') : null}
            </span>
          ) : null
        }
      />
      <Body className="grid gap-4">
        {change.error && !editing ? (
          <p role="alert" className="text-bad text-sm">
            {change.error}
          </p>
        ) : null}
        {quote.status === 'accepted' ? (
          <Section
            title="In force"
            description={
              state === 'expired'
                ? 'This quote has expired: nothing is priced from it.'
                : `Orders from this company are priced at these prices, ahead of every other price, up to each line’s quantity, through ${dayOfExpiry(quote.expiresAt ?? 0)} (UTC).`
            }
          >
            {quote.convertedId && !settled ? (
              <div className="grid gap-2">
                <p className="text-muted-foreground text-xs">
                  {quote.convertedTo === 'po'
                    ? 'It was converted to a purchase order draft that was never made. Convert again to make it, with another PO number if the number was taken.'
                    : 'Its order is starting. Convert again to finish it if this stays.'}
                </p>
                {canOperate && quote.convertedTo === 'po' ? (
                  <Field className="gap-1">
                    <FieldLabel htmlFor="qt-po-number">PO number</FieldLabel>
                    <Input
                      id="qt-po-number"
                      value={poNumber}
                      onChange={(e) => setPoNumber(e.target.value)}
                      maxLength={64}
                      placeholder="Made from the quote if left empty"
                    />
                  </Field>
                ) : null}
              </div>
            ) : quote.convertedId ? (
              <p className="text-sm">
                Converted to{' '}
                <Link
                  to={
                    quote.convertedTo === 'po'
                      ? `/purchase-orders/${quote.convertedId}`
                      : `/orders/${quote.convertedId}`
                  }
                  className="hit-area font-mono text-link hover:underline"
                >
                  {quote.convertedId}
                </Link>
                .
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Convert it into a purchase order draft (when the company uses POs) or an order.
              </p>
            )}
          </Section>
        ) : null}
        {editing ? (
          <Section
            title="Draft"
            description="Only a draft can be changed. Sending it locks it; a change after that is a new version."
          >
            <form onSubmit={save}>
              <FieldGroup className="gap-5">
                <Field className="gap-2">
                  <FieldLabel htmlFor="qt-edit-name">Name</FieldLabel>
                  <Input
                    id="qt-edit-name"
                    name="name"
                    required
                    maxLength={120}
                    defaultValue={quote.name}
                  />
                </Field>
                <Field className="gap-2">
                  <FieldLabel htmlFor="qt-edit-buyer">For</FieldLabel>
                  <NativeSelect
                    id="qt-edit-buyer"
                    name="buyerId"
                    defaultValue={quote.buyerId ?? ''}
                    wrapperClassName="w-full"
                  >
                    <NativeSelectOption value="">No named buyer</NativeSelectOption>
                    {members.map((m) => (
                      <NativeSelectOption key={m.id} value={m.id}>
                        {m.name} ({m.email})
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>An active member of the company.</FieldDescription>
                </Field>
                <Field className="gap-2">
                  <FieldLabel htmlFor="qt-edit-expires">Good through</FieldLabel>
                  <Input
                    id="qt-edit-expires"
                    name="expiresOn"
                    type="date"
                    defaultValue={quote.expiresAt ? dayOfExpiry(quote.expiresAt) : ''}
                  />
                  <FieldDescription>
                    The last day (UTC) the prices count. Needed to send it.
                  </FieldDescription>
                </Field>
                <Field className="gap-2">
                  <FieldLabel htmlFor="qt-edit-notes">Notes</FieldLabel>
                  <Input
                    id="qt-edit-notes"
                    name="notes"
                    defaultValue={quote.notes ?? ''}
                    maxLength={2000}
                  />
                </Field>
                <QuoteLinesEditor lines={quote.lines ?? []} />
                {error ? <FieldError>{error}</FieldError> : null}
                <div>
                  <Button type="submit" size="sm" disabled={change.busy}>
                    Save draft
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </Section>
        ) : (
          <>
            <Section title="Lines" flush>
              {quote.lines?.length ? (
                <Table stack="cards" caption="Quote lines">
                  <TableHead>
                    <Tr>
                      <Th>SKU</Th>
                      <Th>Description</Th>
                      <Th numeric>Up to qty</Th>
                      <Th numeric>List price</Th>
                      <Th numeric>Quoted price</Th>
                      <Th numeric>Off list</Th>
                    </Tr>
                  </TableHead>
                  <TableBody>
                    {quote.lines.map((l) => {
                      const off = lineDiscount(l);
                      return (
                        <Tr key={l.sku}>
                          <Td>{l.sku}</Td>
                          <Td label="Description">{l.name ?? ''}</Td>
                          <Td numeric label="Up to qty">
                            {l.qty}
                          </Td>
                          <Td numeric label="List price">
                            {l.listPrice === null ? '—' : money(l.listPrice)}
                          </Td>
                          <Td numeric label="Quoted price">
                            {money(l.unitPrice)}
                          </Td>
                          <Td numeric label="Off list">
                            {off === null ? '—' : `${off}%`}
                          </Td>
                        </Tr>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <Empty>No lines.</Empty>
              )}
              <p className="border-t px-5 py-2 text-muted-foreground text-xs">
                Total at the quoted quantities: {money(quote.total)}
              </p>
            </Section>
            <Section title="Details">
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground text-xs">For</dt>
                  <dd>
                    {members.find((m) => m.id === quote.buyerId)?.name ??
                      quote.buyerId ??
                      'Not named'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Good through</dt>
                  <dd>{quote.expiresAt ? `${dayOfExpiry(quote.expiresAt)} (UTC)` : 'Not set'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Notes</dt>
                  <dd>{quote.notes ?? 'None'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Last changed</dt>
                  <dd>{dateTime(quote.updatedAt, 'UTC')}</dd>
                </div>
              </dl>
            </Section>
          </>
        )}
        <Section title="Versions" description="Every version of this negotiation, oldest first.">
          <ul className="grid gap-1 text-sm">
            {quote.versions.map((v) => (
              <li key={v.id} className="flex items-center gap-3">
                <span className="tabular w-16 text-muted-foreground">Version {v.version}</span>
                {v.id === quote.id ? (
                  <span className="font-medium">This one</span>
                ) : (
                  <Link to={`/quotes/${v.id}`} className="hit-area text-link hover:underline">
                    Open
                  </Link>
                )}
                <span className="text-muted-foreground text-xs">
                  {QUOTE_STATUS_LABELS[v.status]}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </Body>
    </>
  );
}
