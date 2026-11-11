/**
 * A purchase order. A draft is a form (number, buyer, ship-to, notes and lines) saved through the
 * assistant (`update_po_draft`); anything else is read-only, because it has started an order, which
 * carries its timeline. Submitting and cancelling stop for a confirm card.
 */
import { PO_STATUS_LABELS } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { dateTime } from '@commerceworker/ui/lib/format';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { type FormEvent, useState } from 'react';
import { data, Link, useLoaderData } from 'react-router';
import { LinesEditor, linesOf, nextMoves, PoStatusBadge } from '~/components/purchase-orders';
import { requireUser } from '~/lib/auth.server';
import { PO_SOURCE_NAME, shipToFrom } from '~/lib/purchase-orders';
import { purchaseOrderDetail } from '~/lib/purchase-orders.server';
import { useChange } from '~/lib/use-change';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/purchase-order';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.po.poNumber ?? 'Purchase order'} · CommerceWorker` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const found = await purchaseOrderDetail(params.poId);
  if (!found) throw data('Purchase order not found', { status: 404 });
  return found;
}

export default function PurchaseOrder() {
  const { po, company, members } = useLoaderData<typeof loader>();
  const canOperate = useCan('operator');
  const change = useChange();
  const [problem, setProblem] = useState<string | null>(null);
  const moves = nextMoves(po.status);
  const editing = canOperate && moves.edit;

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const lines = linesOf(f);
    if (typeof lines === 'string') return setProblem(lines);
    setProblem(null);
    const shipTo = shipToFrom(f);
    await change.run('update_po_draft', {
      poId: po.id,
      poNumber: String(f.get('poNumber') ?? ''),
      buyerId: String(f.get('buyerId') ?? '') || null,
      notes: String(f.get('notes') ?? '').trim() || null,
      shipTo,
      lines,
    });
  };
  const error = problem ?? change.error;
  const ship = po.shipTo;

  return (
    <>
      <PageHeader
        title={`Purchase order ${po.poNumber}`}
        crumbs={
          <Link to="/purchase-orders" className="hover:underline">
            Purchase orders
          </Link>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <PoStatusBadge status={po.status} />
            <span>
              {company ? (
                <Link to={`/customers/${company.id}`} className="hit-area hover:underline">
                  {company.name}
                </Link>
              ) : (
                po.companyId
              )}{' '}
              · {PO_SOURCE_NAME(po.source)} · created {dateTime(po.createdAt, 'UTC')}
            </span>
          </span>
        }
        actions={
          canOperate ? (
            <span className="flex gap-2">
              {moves.submit ? (
                <Button
                  size="sm"
                  disabled={change.busy}
                  onClick={() => void change.run('submit_po', { poId: po.id })}
                >
                  Submit
                </Button>
              ) : null}
              {moves.cancel ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={change.busy}
                  onClick={() => void change.run('cancel_po', { poId: po.id })}
                >
                  Cancel PO
                </Button>
              ) : null}
            </span>
          ) : null
        }
      />
      <Body className="grid gap-4">
        {po.orderId ? (
          <Section
            title="Order"
            description="The order this PO started carries its timeline: credit, budgets, approvals, invoice and shipment."
          >
            <Link
              to={`/orders/${po.orderId}`}
              className="hit-area font-mono text-link hover:underline"
            >
              {po.orderId}
            </Link>
            <p className="pt-1 text-muted-foreground text-xs">
              The PO’s status follows the order’s progress: now{' '}
              {PO_STATUS_LABELS[po.status].toLowerCase()}.
            </p>
          </Section>
        ) : po.status !== 'draft' ? (
          <Section title="Order">
            <Empty>No order has started yet. Submit again to start it, or cancel the PO.</Empty>
          </Section>
        ) : null}
        {change.error && !editing ? (
          <p role="alert" className="text-bad text-sm">
            {change.error}
          </p>
        ) : null}
        {editing ? (
          <Section
            title="Draft"
            description="Only a draft can be changed. Submitting starts an order and locks it."
          >
            <form onSubmit={save}>
              <FieldGroup className="gap-5">
                <Field className="gap-2">
                  <FieldLabel htmlFor="po-edit-number">PO number</FieldLabel>
                  <Input
                    id="po-edit-number"
                    name="poNumber"
                    required
                    maxLength={64}
                    defaultValue={po.poNumber}
                  />
                </Field>
                <Field className="gap-2">
                  <FieldLabel htmlFor="po-edit-buyer">Buyer</FieldLabel>
                  <NativeSelect
                    id="po-edit-buyer"
                    name="buyerId"
                    defaultValue={po.buyerId ?? ''}
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
                <fieldset className="grid gap-3">
                  <legend className="font-medium text-sm">Ship to</legend>
                  {(
                    [
                      ['name', 'Name'],
                      ['line1', 'Street'],
                      ['line2', 'Street, line 2'],
                      ['city', 'City'],
                      ['region', 'Region'],
                      ['postalCode', 'Postcode'],
                      ['country', 'Country'],
                    ] as const
                  ).map(([k, label]) => (
                    <Field key={k} className="gap-1">
                      <FieldLabel htmlFor={`po-ship-${k}`}>{label}</FieldLabel>
                      <Input
                        id={`po-ship-${k}`}
                        name={`shipTo.${k}`}
                        defaultValue={ship?.[k] ?? ''}
                        maxLength={200}
                      />
                    </Field>
                  ))}
                </fieldset>
                <Field className="gap-2">
                  <FieldLabel htmlFor="po-edit-notes">Notes</FieldLabel>
                  <Input
                    id="po-edit-notes"
                    name="notes"
                    defaultValue={po.notes ?? ''}
                    maxLength={2000}
                  />
                </Field>
                <LinesEditor lines={po.lines ?? []} />
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
              {po.lines?.length ? (
                <Table stack="cards" caption="Purchase order lines">
                  <TableHead>
                    <Tr>
                      <Th>SKU</Th>
                      <Th>Description</Th>
                      <Th numeric>Qty</Th>
                      <Th numeric>Expected price</Th>
                    </Tr>
                  </TableHead>
                  <TableBody>
                    {po.lines.map((l, i) => (
                      <Tr key={i}>
                        <Td>{l.sku}</Td>
                        <Td label="Description">{l.name ?? ''}</Td>
                        <Td numeric label="Qty">
                          {l.qty}
                        </Td>
                        <Td numeric label="Expected price">
                          {l.unitPrice ?? '—'}
                        </Td>
                      </Tr>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty>No lines were recorded; the order’s document carries them.</Empty>
              )}
            </Section>
            <Section title="Details">
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground text-xs">Buyer</dt>
                  <dd>
                    {members.find((m) => m.id === po.buyerId)?.name ?? po.buyerId ?? 'Not named'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Ship to</dt>
                  <dd>
                    {ship
                      ? [
                          ship.name,
                          ship.line1,
                          ship.line2,
                          ship.city,
                          ship.region,
                          ship.postalCode,
                          ship.country,
                        ]
                          .filter(Boolean)
                          .join(', ')
                      : 'None'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Notes</dt>
                  <dd>{po.notes ?? 'None'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Last changed</dt>
                  <dd>{dateTime(po.updatedAt, 'UTC')}</dd>
                </div>
              </dl>
            </Section>
          </>
        )}
      </Body>
    </>
  );
}
