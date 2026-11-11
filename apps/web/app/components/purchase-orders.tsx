/**
 * Purchase orders as the pages show them: a table of them (the list and a customer's page), the
 * lines editor a draft is written in, and the form that starts one. Every change goes through the
 * assistant (`useChange`), so a confirm card says what submitting or cancelling does to the order
 * and the audit trail names the person. Which moves are offered is core's lifecycle.
 */
import {
  PO_LIFECYCLE,
  PO_STATUS_LABELS,
  type PoStatus,
  type PurchaseOrderLine,
  poEditable,
  poPath,
} from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { count, dateTime } from '@commerceworker/ui/lib/format';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Empty, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FormSheet } from '~/components/form-sheet';
import { ToneBadge } from '~/components/status';
import { linesFrom as linesFromForm, PO_SOURCE_NAME, PO_TONE } from '~/lib/purchase-orders';
import { useChange } from '~/lib/use-change';

export const PoStatusBadge = ({ status }: { status: PoStatus }) => (
  <ToneBadge tone={PO_TONE[status]} label={PO_STATUS_LABELS[status]} />
);

export type PoRow = {
  id: string;
  companyId: string;
  poNumber: string;
  status: PoStatus;
  source: Parameters<typeof PO_SOURCE_NAME>[0];
  orderId: string | null;
  lineCount?: number;
  createdAt: number;
};

/** The POs on a page; a phone gets each as a card, like the other lists. */
export function PoTable({
  rows,
  companies,
  showCompany = true,
}: {
  rows: PoRow[];
  companies: Record<string, string>;
  showCompany?: boolean;
}) {
  return (
    <Table stack="cards" caption="Purchase orders">
      <TableHead>
        <Tr>
          <Th>PO number</Th>
          {showCompany ? <Th>Company</Th> : null}
          <Th>Status</Th>
          <Th>Source</Th>
          <Th numeric>Lines</Th>
          <Th>Created</Th>
          <Th>Order</Th>
        </Tr>
      </TableHead>
      <TableBody>
        {rows.map((p) => (
          <Tr key={p.id}>
            <Td>
              <Link
                to={`/purchase-orders/${p.id}`}
                className="hit-area font-medium hover:underline"
              >
                {p.poNumber}
              </Link>
            </Td>
            {showCompany ? (
              <Td label="Company">
                <Link to={`/customers/${p.companyId}`} className="hover:underline">
                  {companies[p.companyId] ?? p.companyId}
                </Link>
              </Td>
            ) : null}
            <Td label="Status">
              <PoStatusBadge status={p.status} />
            </Td>
            <Td label="Source">{PO_SOURCE_NAME(p.source)}</Td>
            <Td numeric label="Lines">
              {p.lineCount ?? 0}
            </Td>
            <Td label="Created">{dateTime(p.createdAt, 'UTC')}</Td>
            <Td label="Order">
              {p.orderId ? (
                <Link to={`/orders/${p.orderId}`} className="font-mono hover:underline">
                  {p.orderId}
                </Link>
              ) : (
                <span className="text-muted-foreground">None yet</span>
              )}
            </Td>
          </Tr>
        ))}
      </TableBody>
    </Table>
  );
}

let rowKey = 0;
const newRow = (line?: Partial<PurchaseOrderLine>) => ({ key: ++rowKey, ...line });

/**
 * The lines of a draft, a row each. Fields are named alike so the form reads them as lists
 * (`linesFrom`); on a phone a row stacks its fields, and the remove control is a 44px target.
 */
export function LinesEditor({ lines }: { lines: Partial<PurchaseOrderLine>[] }) {
  const [rows, setRows] = useState(() => (lines.length ? lines : [{}]).map(newRow));
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium text-sm">Lines</legend>
      {rows.map((r, i) => (
        <div
          key={r.key}
          className="grid grid-cols-2 items-end gap-2 rounded-2xl border p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_5rem_6rem_auto]"
        >
          <Field className="col-span-2 gap-1 sm:col-span-1">
            <FieldLabel htmlFor={`po-sku-${r.key}`}>SKU</FieldLabel>
            <Input id={`po-sku-${r.key}`} name="sku" defaultValue={r.sku} maxLength={100} />
          </Field>
          <Field className="col-span-2 gap-1 sm:col-span-1">
            <FieldLabel htmlFor={`po-name-${r.key}`}>Description</FieldLabel>
            <Input
              id={`po-name-${r.key}`}
              name="name"
              defaultValue={r.name ?? ''}
              maxLength={200}
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor={`po-qty-${r.key}`}>Qty</FieldLabel>
            <Input id={`po-qty-${r.key}`} name="qty" inputMode="decimal" defaultValue={r.qty} />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor={`po-price-${r.key}`}>Expected price</FieldLabel>
            <Input
              id={`po-price-${r.key}`}
              name="unitPrice"
              inputMode="decimal"
              defaultValue={r.unitPrice ?? ''}
            />
          </Field>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hit-area col-span-2 justify-self-end sm:col-span-1"
            aria-label={`Remove line ${i + 1}`}
            disabled={rows.length === 1}
            onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRows([...rows, newRow()])}
        >
          <Plus aria-hidden="true" /> Add line
        </Button>
      </div>
      <FieldDescription>
        The expected price is what the buyer wrote; the flow prices the order from the company’s
        price books.
      </FieldDescription>
    </fieldset>
  );
}

/** A company's customer-page section: its newest POs and a way to the whole list. */
export function PurchaseOrdersSection({
  companyId,
  data,
}: {
  companyId: string;
  data: { purchaseOrders: PoRow[]; total: number };
}) {
  return (
    <Section
      id="purchase-orders"
      title="Purchase orders"
      description="This company’s buyer POs, newest first. Submitting one starts an order on the B2B purchase order flow."
    >
      {data.purchaseOrders.length ? (
        <PoTable rows={data.purchaseOrders} companies={{}} showCompany={false} />
      ) : (
        <Empty>No purchase orders yet.</Empty>
      )}
      <nav aria-label="Purchase order pages" className="flex items-center gap-4 pt-1 text-xs">
        <span className="text-muted-foreground tabular">{count(data.total)} in all</span>
        <Link
          to={`/purchase-orders?company=${encodeURIComponent(companyId)}`}
          className="hit-area ml-auto text-link hover:underline"
        >
          All of this company’s purchase orders
        </Link>
      </nav>
    </Section>
  );
}

/** Starts a draft: the company, the number and the lines. Further details are the draft page’s. */
export function NewPurchaseOrder({
  companies,
  initialCompany,
}: {
  companies: { id: string; name: string }[];
  initialCompany?: string;
}) {
  const change = useChange();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const lines = linesOf(f);
    if (typeof lines === 'string') return setProblem(lines);
    setProblem(null);
    const r = (await change.run('create_po_draft', {
      companyId: String(f.get('companyId') ?? ''),
      poNumber: String(f.get('poNumber') ?? ''),
      lines,
    })) as { purchaseOrder?: { id: string } } | null;
    if (r?.purchaseOrder) {
      setOpen(false);
      navigate(`/purchase-orders/${r.purchaseOrder.id}`);
    }
  };
  const error = problem ?? change.error;
  return (
    <FormSheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setProblem(null);
        change.clearError();
      }}
      label="New purchase order"
      title="New purchase order"
      description="Saved as a draft: nothing starts until you submit it."
    >
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          <Field className="gap-2">
            <FieldLabel htmlFor="po-company">Company</FieldLabel>
            <NativeSelect
              id="po-company"
              name="companyId"
              required
              defaultValue={initialCompany ?? ''}
              wrapperClassName="w-full"
            >
              <NativeSelectOption value="" disabled>
                Pick a company
              </NativeSelectOption>
              {companies.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="po-number">PO number</FieldLabel>
            <Input id="po-number" name="poNumber" required maxLength={64} />
            <FieldDescription>The buyer’s own number; unique within the company.</FieldDescription>
          </Field>
          <LinesEditor lines={[]} />
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button type="submit" size="sm" disabled={change.busy}>
              Save draft
            </Button>
          </div>
        </FieldGroup>
      </form>
    </FormSheet>
  );
}

/** A form's lines as the tool takes them (`unitPrice` absent when blank), or why they're refused. */
export function linesOf(f: FormData) {
  const read = linesFromForm(f);
  return typeof read === 'string'
    ? read
    : read.map((l) => ({
        sku: l.sku,
        ...(l.name ? { name: l.name } : {}),
        qty: l.qty,
        ...(l.unitPrice !== null ? { unitPrice: l.unitPrice } : {}),
      }));
}

/** The moves a PO may make next, from core's lifecycle, as the buttons the page offers. */
export const nextMoves = (status: PoStatus) => ({
  edit: poEditable(status),
  submit: PO_LIFECYCLE.can(status, 'submitted'),
  // An approved PO is cancelled through its order, which the lifecycle reaches in two moves.
  cancel: poPath(status, 'cancelled').length > 0,
});
