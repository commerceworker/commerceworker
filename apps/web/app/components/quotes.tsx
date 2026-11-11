/**
 * Quotes as the pages show them: a table of them, the lines editor a draft is written in, and the
 * form that starts one. Every change goes through the assistant (`useChange`), so a confirm card
 * says what sending, accepting or converting does and the audit trail names the person. Which
 * moves are offered is core's lifecycle (`quoteMoves`).
 */
import {
  dayOfExpiry,
  QUOTE_STATUS_LABELS,
  type QuoteLine,
  type QuoteStatus,
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
import { money } from '@commerceworker/ui/lib/format';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FormSheet } from '~/components/form-sheet';
import { ToneBadge } from '~/components/status';
import { linesFrom, QUOTE_TONE } from '~/lib/quotes';
import { useChange } from '~/lib/use-change';

export const QuoteStatusBadge = ({ status }: { status: QuoteStatus }) => (
  <ToneBadge tone={QUOTE_TONE[status]} label={QUOTE_STATUS_LABELS[status]} />
);

export type QuoteRowData = {
  id: string;
  companyId: string;
  name: string;
  version: number;
  /** What it is now (`quoteState`): a lapsed quote reads as expired. */
  state: QuoteStatus;
  expiresAt: number | null;
  lineCount?: number;
  total: number;
  createdAt: number;
};

/** The quotes on a page; a phone gets each as a card, like the other lists. */
export function QuoteTable({
  rows,
  companies,
}: {
  rows: QuoteRowData[];
  companies: Record<string, string>;
}) {
  return (
    <Table stack="cards" caption="Quotes">
      <TableHead>
        <Tr>
          <Th>Quote</Th>
          <Th>Company</Th>
          <Th>Status</Th>
          <Th numeric>Version</Th>
          <Th numeric>Lines</Th>
          <Th numeric>Total</Th>
          <Th>Expires</Th>
        </Tr>
      </TableHead>
      <TableBody>
        {rows.map((q) => (
          <Tr key={q.id}>
            <Td>
              <Link to={`/quotes/${q.id}`} className="hit-area font-medium hover:underline">
                {q.name}
              </Link>
            </Td>
            <Td label="Company">
              <Link to={`/customers/${q.companyId}`} className="hover:underline">
                {companies[q.companyId] ?? q.companyId}
              </Link>
            </Td>
            <Td label="Status">
              <QuoteStatusBadge status={q.state} />
            </Td>
            <Td numeric label="Version">
              {q.version}
            </Td>
            <Td numeric label="Lines">
              {q.lineCount ?? 0}
            </Td>
            <Td numeric label="Total">
              {money(q.total)}
            </Td>
            <Td label="Expires">
              {q.expiresAt === null ? (
                <span className="text-muted-foreground">Not set</span>
              ) : (
                dayOfExpiry(q.expiresAt)
              )}
            </Td>
          </Tr>
        ))}
      </TableBody>
    </Table>
  );
}

let rowKey = 0;
const newRow = (line?: Partial<QuoteLine>) => ({ key: ++rowKey, ...line });

/**
 * The lines of a draft, a row each. Fields are named alike so the form reads them as lists
 * (`linesFrom`); on a phone a row stacks its fields, and the remove control is a 44px target.
 */
export function QuoteLinesEditor({ lines }: { lines: Partial<QuoteLine>[] }) {
  const [rows, setRows] = useState(() => (lines.length ? lines : [{}]).map(newRow));
  return (
    <fieldset className="grid gap-3">
      <legend className="font-medium text-sm">Lines</legend>
      {rows.map((r, i) => (
        <div
          key={r.key}
          className="grid grid-cols-2 items-end gap-2 rounded-2xl border p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_5.5rem_6rem_auto]"
        >
          <Field className="col-span-2 gap-1 sm:col-span-1">
            <FieldLabel htmlFor={`qt-sku-${r.key}`}>SKU</FieldLabel>
            <Input id={`qt-sku-${r.key}`} name="sku" defaultValue={r.sku} maxLength={100} />
          </Field>
          <Field className="col-span-2 gap-1 sm:col-span-1">
            <FieldLabel htmlFor={`qt-name-${r.key}`}>Description</FieldLabel>
            <Input
              id={`qt-name-${r.key}`}
              name="name"
              defaultValue={r.name ?? ''}
              maxLength={200}
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor={`qt-qty-${r.key}`}>Up to qty</FieldLabel>
            <Input id={`qt-qty-${r.key}`} name="qty" inputMode="decimal" defaultValue={r.qty} />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor={`qt-price-${r.key}`}>Quoted price</FieldLabel>
            <Input
              id={`qt-price-${r.key}`}
              name="unitPrice"
              inputMode="decimal"
              defaultValue={r.unitPrice}
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
        One line a SKU. The price holds up to the quantity on the line; an order for more is priced
        as if there were no quote. Prices are in USD, the base currency.
      </FieldDescription>
    </fieldset>
  );
}

/** Starts a draft: the company, a name, an expiry and the lines. The rest is the editor's. */
export function NewQuote({
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
    const lines = linesFrom(f);
    if (typeof lines === 'string') return setProblem(lines);
    setProblem(null);
    const expiresOn = String(f.get('expiresOn') ?? '');
    const r = (await change.run('create_quote', {
      companyId: String(f.get('companyId') ?? ''),
      name: String(f.get('name') ?? ''),
      ...(expiresOn ? { expiresOn } : {}),
      lines,
    })) as { quote?: { id: string } } | null;
    if (r?.quote) {
      setOpen(false);
      navigate(`/quotes/${r.quote.id}`);
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
      label="New quote"
      title="New quote"
      description="Saved as a draft: nothing is priced from it until it is sent and accepted."
    >
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          <Field className="gap-2">
            <FieldLabel htmlFor="qt-company">Company</FieldLabel>
            <NativeSelect
              id="qt-company"
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
            <FieldLabel htmlFor="qt-name">Name</FieldLabel>
            <Input id="qt-name" name="name" required maxLength={120} />
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="qt-expires">Good through</FieldLabel>
            <Input id="qt-expires" name="expiresOn" type="date" />
            <FieldDescription>
              The last day (UTC) the prices count. Needed to send it.
            </FieldDescription>
          </Field>
          <QuoteLinesEditor lines={[]} />
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
