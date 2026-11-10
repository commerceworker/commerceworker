import type { AssistantTool, PriceBookStatus } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Textarea } from '@commerceworker/ui/textarea';
import { type FormEvent, useState } from 'react';
import { useRevalidator } from 'react-router';
import { useAssistant } from '~/lib/assistant';
import { entriesFrom } from '~/lib/price-books';

/**
 * Runs a price book change through the assistant (`act`): its card says what changes for buyers
 * and the person confirms it there. `run` resolves true once it is done, false when declined or
 * refused (the refusal in `error`).
 */
export function useBookAct() {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (tool: AssistantTool, input: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await act(tool, input);
      if ('declined' in r) return false;
      revalidate();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

const MOVES: { to: Exclude<PriceBookStatus, 'draft'>; label: string }[] = [
  { to: 'active', label: 'Activate' },
  { to: 'inactive', label: 'Deactivate' },
  { to: 'archived', label: 'Archive' },
];

/** The moves the book's status allows from where it is, one button each. */
export function StatusButtons({
  bookId,
  name,
  allowed,
}: {
  bookId: string;
  name: string;
  allowed: readonly PriceBookStatus[];
}) {
  const { run, busy, error } = useBookAct();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {MOVES.filter((m) => allowed.includes(m.to)).map((m) => (
        <Button
          key={m.to}
          size="sm"
          variant={m.to === 'active' ? 'default' : 'outline'}
          disabled={busy}
          aria-label={`${m.label} ${name}`}
          onClick={() => void run('set_price_book_status', { bookId, status: m.to })}
        >
          {m.label}
        </Button>
      ))}
      {error ? (
        <span role="alert" className="text-bad text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Takes one entry out of the book. */
export function RemoveEntryButton({
  bookId,
  entry,
}: {
  bookId: string;
  entry: { sku: string; minQty: number };
}) {
  const { run, busy, error } = useBookAct();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-label={`Remove ${entry.sku} from ${entry.minQty}`}
        onClick={() =>
          void run('put_price_book_entries', {
            bookId,
            entries: [{ sku: entry.sku, minQty: entry.minQty, remove: true }],
          })
        }
      >
        Remove
      </Button>
      {error ? (
        <span role="alert" className="text-bad text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Entries typed or pasted a line each; checked here, then added through the assistant. */
export function AddEntries({ bookId }: { bookId: string }) {
  const { run, busy, error } = useBookAct();
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const parsed = entriesFrom(String(new FormData(form).get('entries') ?? ''));
    if (typeof parsed === 'string') return setProblem(parsed);
    setProblem(null);
    if (await run('put_price_book_entries', { bookId, entries: parsed })) form.reset();
  };
  const shown = problem ?? error;
  return (
    <form onSubmit={(e) => void submit(e)}>
      <FieldGroup className="gap-3">
        <Field className="gap-2">
          <FieldLabel htmlFor="book-entries">Add or replace entries</FieldLabel>
          <Textarea
            id="book-entries"
            name="entries"
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={'WID-100 12.50\nWID-100 500 11.25\nGSK-010 10%'}
            className="font-mono text-xs"
          />
          <p className="text-muted-foreground text-xs">
            One a line: a SKU, an optional quantity (a volume tier), then a price in USD or a
            percentage off list. A SKU at a quantity already in the book is replaced.
          </p>
        </Field>
        {shown ? <FieldError>{shown}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Confirm it in the assistant' : 'Add entries'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** Assigns the book to a customer (by id) or to a tier. */
export function AssignBook({ bookId }: { bookId: string }) {
  const { run, busy, error } = useBookAct();
  const [kind, setKind] = useState<'customerId' | 'tier'>('customerId');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const to = String(new FormData(form).get('to') ?? '').trim();
    if (!to) return;
    if (await run('assign_price_book', { bookId, [kind]: to })) form.reset();
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
      <FieldGroup className="gap-3">
        <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
          <Field className="gap-2">
            <FieldLabel htmlFor="assign-kind">Assign to</FieldLabel>
            <NativeSelect
              id="assign-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'customerId' | 'tier')}
            >
              <NativeSelectOption value="customerId">A customer</NativeSelectOption>
              <NativeSelectOption value="tier">A tier</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="assign-to">{kind === 'tier' ? 'Tier' : 'Customer id'}</FieldLabel>
            <Input
              id="assign-to"
              name="to"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={kind === 'tier' ? 'silver' : 'cus_…'}
            />
          </Field>
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Confirm it in the assistant' : 'Assign'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** Takes an assignment away. */
export function UnassignButton({
  bookId,
  to,
  label,
}: {
  bookId: string;
  to: { customerId: string } | { tier: string };
  label: string;
}) {
  const { run, busy, error } = useBookAct();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-label={`Take the book away from ${label}`}
        onClick={() => void run('assign_price_book', { bookId, ...to, remove: true })}
      >
        Remove
      </Button>
      {error ? (
        <span role="alert" className="text-bad text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}
