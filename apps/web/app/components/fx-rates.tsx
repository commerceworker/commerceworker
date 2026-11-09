import { BASE_CURRENCY, FX_LARGE_CHANGE, fxRateChange } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { Table, TableBody, TableEmpty, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { useId, useState } from 'react';
import { useRevalidator } from 'react-router';
import { Ago } from '~/components/ago';
import { ToneBadge } from '~/components/status';
import { useAssistant } from '~/lib/assistant';
import { useCan } from '~/lib/use-me';

export type FxRateRow = {
  currency: string;
  rate: number | null;
  updatedAt: number | null;
  source: 'ecb' | 'person' | null;
  updatedBy: string | null;
};

/**
 * One currency's rate, edited in place. The new rate goes through the assistant (`set_fx_rate`):
 * its card shows the rate now, the change and what stays as it was, and nothing is saved until the
 * person confirms there. A large change is flagged here too, before the card asks.
 */
function RateEditor({ row, onDone }: { row: FxRateRow; onDone: () => void }) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [text, setText] = useState(row.rate === null ? '' : String(row.rate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const rate = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(rate) && rate > 0;
  const change = valid ? fxRateChange(row.rate, rate) : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act('set_fx_rate', { currency: row.currency, rate });
      if ('declined' in r) return;
      revalidate();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-center justify-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void save();
      }}
    >
      <Input
        name="rate"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`${row.currency} per ${BASE_CURRENCY}`}
        aria-describedby={hintId}
        aria-invalid={text !== '' && !valid ? true : undefined}
        className="w-32 tabular"
      />
      <Button type="submit" size="sm" disabled={!valid || busy}>
        {busy ? 'Confirm it in the assistant' : 'Review'}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDone}>
        Cancel
      </Button>
      <p
        id={hintId}
        className="w-full text-right text-xs"
        role={change?.large ? 'alert' : undefined}
      >
        {change?.large ? (
          <span className="text-wait">
            {change.percent !== null && change.percent > 0 ? '+' : ''}
            {change.percent?.toFixed(1)}%: a change of {Math.round(FX_LARGE_CHANGE * 100)}% or more.
            Check it is not a slipped decimal point.
          </span>
        ) : (
          <span className="text-muted-foreground">
            {row.currency} per 1 {BASE_CURRENCY}
          </span>
        )}
      </p>
      {error ? (
        <p role="alert" className="w-full text-right text-bad text-xs">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** The rate's table on the Commerce page: each currency, its rate, who set it and when. */
export function FxRates({ rates }: { rates: FxRateRow[] }) {
  const canAdmin = useCan('admin');
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="border-t">
      <h3 className="px-4 pt-3 font-medium text-sm">Exchange rates</h3>
      <p className="max-w-measure px-4 pt-0.5 pb-2 text-muted-foreground text-xs">
        Units of each currency per 1 {BASE_CURRENCY}. Orders convert at the rate when they are
        priced and keep it. The daily refresh from the European Central Bank replaces a rate for the
        currencies the deployment names.
        {canAdmin ? '' : ' An admin edits them.'}
      </p>
      <Table stack="cards" scroll caption="Exchange rates">
        <TableHead>
          <Tr>
            <Th>Currency</Th>
            <Th numeric>Rate</Th>
            <Th>Source</Th>
            <Th>Updated</Th>
            {canAdmin ? <Th className="text-right">Edit</Th> : null}
          </Tr>
        </TableHead>
        <TableBody>
          {rates.map((r) => (
            <Tr key={r.currency} id={`rate-${r.currency}`}>
              <Td className="font-medium">{r.currency}</Td>
              <Td numeric label="Rate">
                {r.rate ?? '–'}
              </Td>
              <Td label="Source">
                {r.source === 'person' ? (
                  <span className="inline-flex flex-wrap items-center gap-x-2">
                    <ToneBadge tone="wait" label="By hand" />
                    {r.updatedBy ? (
                      <span className="text-muted-foreground text-xs">{r.updatedBy}</span>
                    ) : null}
                  </span>
                ) : r.source === 'ecb' ? (
                  <ToneBadge tone="idle" label="Daily ECB" />
                ) : (
                  <span className="text-muted-foreground text-xs">No rate yet</span>
                )}
              </Td>
              <Td label="Updated" className="text-muted-foreground">
                {r.updatedAt ? <Ago ms={r.updatedAt} /> : '–'}
              </Td>
              {canAdmin ? (
                <Td className="text-right">
                  {editing === r.currency ? (
                    <RateEditor row={r} onDone={() => setEditing(null)} />
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit the ${r.currency} rate`}
                      onClick={() => setEditing(r.currency)}
                    >
                      Edit
                    </Button>
                  )}
                </Td>
              ) : null}
            </Tr>
          ))}
          {rates.length ? null : (
            <TableEmpty colSpan={canAdmin ? 5 : 4}>
              No rates yet. Name the currencies the deployment sells in and the daily refresh adds
              them.
            </TableEmpty>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
