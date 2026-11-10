/**
 * A company's budgets on its customer page: each one's spend in the window it counts now, as a bar
 * in the status tokens (and as words, so colour is never the only signal), the moves its lifecycle
 * allows, and the spend ledger behind it. Every change goes through the assistant (`useChange`), so
 * its card says what it does and the audit trail names the person. Which moves are offered is
 * core's lifecycle, not a list kept here.
 */
import {
  BUDGET_ENFORCEMENT_LABELS,
  BUDGET_ENFORCEMENTS,
  BUDGET_LIFECYCLE,
  BUDGET_PERIOD_LABELS,
  BUDGET_PERIODS,
  BUDGET_STATUS_LABELS,
  type BudgetEnforcement,
  type BudgetPeriod,
  type BudgetStatus,
  type SpendStatus,
  teamDepth,
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
import { count, dateTime, money } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Empty, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { FormSheet } from '~/components/form-sheet';
import { type Tone, ToneBadge } from '~/components/status';
import { humanize } from '~/lib/format';
import { useChange } from '~/lib/use-change';

const STATUS_TONE: Record<BudgetStatus, Tone> = { active: 'ok', paused: 'wait', archived: 'idle' };
const SPEND_TONE: Record<SpendStatus, Tone> = { committed: 'ok', reversed: 'undo' };

/** What a move is called on its button. */
const MOVE: Record<string, string> = {
  'active>paused': 'Pause',
  'paused>active': 'Resume',
  'active>archived': 'Archive',
  'paused>archived': 'Archive',
};

export type BudgetRow = {
  id: string;
  companyId: string;
  teamId: string | null;
  name: string;
  amount: number;
  period: BudgetPeriod;
  anchor: number;
  enforcement: BudgetEnforcement;
  status: BudgetStatus;
  window: { start: number; end: number | null } | null;
  spent: number;
  remaining: number;
};

export type BudgetsData = {
  company: { id: string; status: string };
  teams: { id: string; name: string; path: string }[];
  budgets: BudgetRow[];
  total: number;
  cursor: string | null;
  ledger: {
    budgetId: string;
    entries: {
      id: string;
      orderId: string;
      amount: number;
      windowStart: number;
      at: number;
      status: SpendStatus;
    }[];
    total: number;
    cursor: string | null;
  } | null;
};

/** Whole class names, so Tailwind sees them. */
const BAR = { ok: 'bg-ok', wait: 'bg-wait', bad: 'bg-bad' } as const;

/** Under this share of the budget the bar reads as fine; past it, as running out; over it, as over. */
const NEAR = 0.8;

/**
 * A window's spend against its budget. The bar is a meter, so a screen reader hears the figures,
 * and the label beside it says the same in words.
 */
export function SpendBar({ b }: { b: BudgetRow }) {
  const share = b.amount > 0 ? b.spent / b.amount : 0;
  const tone = share > 1 ? 'bad' : share >= NEAR ? 'wait' : 'ok';
  const label = !b.window
    ? 'Not started'
    : share > 1
      ? `Over by ${money(b.spent - b.amount)}`
      : share >= NEAR
        ? 'Nearly spent'
        : 'Within budget';
  return (
    <div className="grid gap-1.5">
      {/* A real meter for assistive tech; the bar beside it is only the picture. */}
      <meter
        className="sr-only"
        aria-label={`${b.name} spend`}
        min={0}
        max={b.amount}
        value={Math.min(Math.max(b.spent, 0), b.amount)}
      >
        {`${money(b.spent)} of ${money(b.amount)}, ${label}`}
      </meter>
      <div aria-hidden="true" className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-(--motion-move)',
            BAR[tone],
          )}
          style={{ width: `${Math.min(Math.max(share, 0), 1) * 100}%` }}
        />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs tabular">
        <span>
          <span className="font-medium">{money(b.spent)}</span>
          <span className="text-muted-foreground"> of {money(b.amount)}</span>
        </span>
        <span
          className={cn(
            tone === 'bad' && 'font-medium text-bad',
            tone === 'wait' && 'font-medium text-wait',
            tone === 'ok' && 'text-muted-foreground',
          )}
        >
          {label}
          {b.window && b.remaining >= 0 ? ` · ${money(b.remaining)} left` : ''}
        </span>
      </div>
    </div>
  );
}

/** When a budget's window closes, or that it never does. */
const windowText = (b: BudgetRow) =>
  !b.window
    ? `Starts ${dateTime(b.anchor, 'UTC')}`
    : b.window.end === null
      ? `Since ${dateTime(b.window.start, 'UTC')}`
      : `Resets ${dateTime(b.window.end, 'UTC')}`;

/** A budget's fields, for adding one and for changing one: what can't change is shown, not editable. */
function BudgetForm({
  teams,
  budget,
  busy,
  error,
  onSubmit,
}: {
  teams: BudgetsData['teams'];
  budget?: BudgetRow;
  busy: boolean;
  error: string | null;
  onSubmit: (f: FormData) => void;
}) {
  const id = budget?.id ?? 'new';
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      <FieldGroup className="gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor={`budget-name-${id}`}>Name</FieldLabel>
          <Input
            id={`budget-name-${id}`}
            name="name"
            required
            maxLength={80}
            defaultValue={budget?.name}
          />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`budget-amount-${id}`}>Amount</FieldLabel>
          <Input
            id={`budget-amount-${id}`}
            name="amount"
            required
            inputMode="decimal"
            pattern="[0-9]*\.?[0-9]*"
            defaultValue={budget?.amount}
            aria-describedby={`budget-amount-hint-${id}`}
          />
          <FieldDescription id={`budget-amount-hint-${id}`}>
            What may be spent in one period, in the base currency.
          </FieldDescription>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`budget-period-${id}`}>Period</FieldLabel>
          <NativeSelect
            id={`budget-period-${id}`}
            name="period"
            defaultValue={budget?.period ?? 'monthly'}
            disabled={!!budget}
            wrapperClassName="w-full"
          >
            {BUDGET_PERIODS.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {BUDGET_PERIOD_LABELS[p]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            Calendar periods in UTC. {budget ? 'It can’t change: add a new budget instead.' : ''}
          </FieldDescription>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`budget-team-${id}`}>Applies to</FieldLabel>
          <NativeSelect
            id={`budget-team-${id}`}
            name="teamId"
            defaultValue={budget?.teamId ?? ''}
            disabled={!!budget}
            wrapperClassName="w-full"
          >
            <NativeSelectOption value="">The whole company</NativeSelectOption>
            {teams.map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {'– '.repeat(teamDepth(t.path) - 1)}
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>A team’s budget also covers the teams under it.</FieldDescription>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`budget-enforcement-${id}`}>Enforcement</FieldLabel>
          <NativeSelect
            id={`budget-enforcement-${id}`}
            name="enforcement"
            defaultValue={budget?.enforcement ?? 'advisory'}
            wrapperClassName="w-full"
          >
            {BUDGET_ENFORCEMENTS.map((e) => (
              <NativeSelectOption key={e} value={e}>
                {BUDGET_ENFORCEMENT_LABELS[e]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            Strict declines an order that would take it below zero; advisory lets it through with a
            warning.
          </FieldDescription>
        </Field>
        {budget ? null : (
          <Field className="gap-2">
            <FieldLabel htmlFor="budget-starts-new">Starts on (optional)</FieldLabel>
            <Input id="budget-starts-new" name="startsOn" type="date" className="max-w-48" />
          </Field>
        )}
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            {budget ? 'Save budget' : 'Add budget'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

const amountOf = (raw: FormDataEntryValue | null) => Number(String(raw ?? '').trim());

/** The company's budgets, their spend this window and the ledger of one. */
export function BudgetsSection({ data, canOperate }: { data: BudgetsData; canOperate: boolean }) {
  const { company, teams, budgets, ledger } = data;
  const change = useChange();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const closed = company.status === 'closed' || company.status === 'rejected';

  const save = (f: FormData, budget?: BudgetRow) =>
    change.run('put_budget', {
      companyId: company.id,
      ...(budget ? { budgetId: budget.id } : {}),
      name: String(f.get('name') ?? ''),
      amount: amountOf(f.get('amount')),
      enforcement: String(f.get('enforcement') ?? 'advisory'),
      ...(budget
        ? {}
        : {
            period: String(f.get('period') ?? 'monthly'),
            teamId: String(f.get('teamId') ?? '') || null,
            ...(f.get('startsOn') ? { startsOn: String(f.get('startsOn')) } : {}),
          }),
    });
  const pageLink = (cursor: string | null) =>
    `?${new URLSearchParams(cursor ? { 'budgets-after': cursor } : {}).toString()}#budgets`;
  const ledgerLink = (budgetId: string, cursor?: string | null) => {
    const p = new URLSearchParams({ ledger: budgetId });
    if (cursor) p.set('ledger-after', cursor);
    return `?${p.toString()}#budget-ledger`;
  };
  const shown = ledger ? budgets.find((b) => b.id === ledger.budgetId) : undefined;

  return (
    <Section
      id="budgets"
      title="Budgets"
      description="What this company, or one of its teams, may spend in a period. A flow’s budget check holds its orders to them; spend is summed from a ledger, per period."
      actions={
        canOperate && !closed ? (
          <FormSheet
            open={adding}
            onOpenChange={(o) => {
              setAdding(o);
              change.clearError();
            }}
            label="Add budget"
            title="Add a budget"
            description="Orders are held to it once a flow’s budget check uses the company’s budgets."
          >
            <BudgetForm
              teams={teams}
              busy={change.busy}
              error={change.error}
              onSubmit={async (f) => {
                if (await save(f)) setAdding(false);
              }}
            />
          </FormSheet>
        ) : null
      }
    >
      {budgets.length ? (
        <ul className="-mx-2 flex flex-col gap-3" aria-label="Company budgets">
          {budgets.map((b) => (
            <li
              key={b.id}
              className={cn(
                'grid gap-3 rounded-2xl border px-4 py-3',
                b.status !== 'active' && 'text-muted-foreground',
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{b.name}</div>
                  <div className="text-xs">
                    {BUDGET_PERIOD_LABELS[b.period]} · {money(b.amount)} ·{' '}
                    {b.teamId ? `Team ${teamName.get(b.teamId) ?? b.teamId}` : 'Whole company'} ·{' '}
                    {windowText(b)}
                  </div>
                </div>
                <span className="flex flex-wrap items-center gap-1.5">
                  <ToneBadge
                    tone={b.enforcement === 'strict' ? 'bad' : 'idle'}
                    label={BUDGET_ENFORCEMENT_LABELS[b.enforcement]}
                  />
                  <ToneBadge tone={STATUS_TONE[b.status]} label={BUDGET_STATUS_LABELS[b.status]} />
                </span>
              </div>
              <SpendBar b={b} />
              <div className="flex flex-wrap gap-1">
                <Button asChild variant="ghost" size="sm">
                  <Link to={ledgerLink(b.id)} aria-label={`Spend ledger of ${b.name}`}>
                    Spend ledger
                  </Link>
                </Button>
                {canOperate && !closed && b.status !== 'archived' ? (
                  <>
                    {BUDGET_LIFECYCLE.next(b.status).map((to) => (
                      <Button
                        key={to}
                        variant="ghost"
                        size="sm"
                        disabled={change.busy}
                        aria-label={`${MOVE[`${b.status}>${to}`]} ${b.name}`}
                        onClick={() =>
                          void change.run('set_budget_status', {
                            companyId: company.id,
                            budgetId: b.id,
                            status: to,
                          })
                        }
                      >
                        {MOVE[`${b.status}>${to}`]}
                      </Button>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={change.busy}
                      aria-label={`Edit ${b.name}`}
                      onClick={() => {
                        change.clearError();
                        setEditing(b);
                      }}
                    >
                      Edit
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No budgets. Add one to hold this company’s orders to an amount each period.</Empty>
      )}
      <nav aria-label="Budgets pages" className="flex items-center gap-4 pt-1 text-xs">
        <span className="text-muted-foreground tabular">{count(data.total)} in all</span>
        <span className="ml-auto flex gap-4">
          {data.cursor ? (
            <Link to={pageLink(data.cursor)} className="hit-area text-link hover:underline">
              Next page
            </Link>
          ) : null}
        </span>
      </nav>
      {change.error && !adding && !editing ? (
        <p role="alert" className="text-bad text-sm">
          {change.error}
        </p>
      ) : null}
      {ledger ? (
        <section id="budget-ledger" aria-label="Spend ledger" className="mt-2 grid gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium text-sm">Spend ledger{shown ? `: ${shown.name}` : ''}</h3>
            <Link to="?#budgets" className="hit-area text-link text-xs hover:underline">
              Hide
            </Link>
          </div>
          {ledger.entries.length ? (
            <Table stack="cards" caption="Spend ledger">
              <TableHead>
                <Tr>
                  <Th>Order</Th>
                  <Th>Recorded</Th>
                  <Th>Window from</Th>
                  <Th numeric>Amount</Th>
                  <Th>Status</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {ledger.entries.map((e) => (
                  <Tr key={e.id} className={cn(e.status === 'reversed' && 'text-muted-foreground')}>
                    <Td>
                      <Link to={`/orders/${e.orderId}`} className="font-mono hover:underline">
                        {e.orderId}
                      </Link>
                    </Td>
                    <Td label="Recorded">{dateTime(e.at, 'UTC')}</Td>
                    <Td label="Window from">{dateTime(e.windowStart, 'UTC')}</Td>
                    <Td numeric label="Amount">
                      {money(e.amount)}
                    </Td>
                    <Td label="Status">
                      <ToneBadge tone={SPEND_TONE[e.status]} label={humanize(e.status)} />
                    </Td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>Nothing recorded against this budget yet.</Empty>
          )}
          <nav aria-label="Ledger pages" className="flex items-center gap-4 text-xs">
            <span className="text-muted-foreground tabular">{count(ledger.total)} in all</span>
            <span className="ml-auto">
              {ledger.cursor ? (
                <Link
                  to={ledgerLink(ledger.budgetId, ledger.cursor)}
                  className="hit-area text-link hover:underline"
                >
                  Next page
                </Link>
              ) : null}
            </span>
          </nav>
        </section>
      ) : null}
      <FormSheet
        bare
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
          change.clearError();
        }}
        label="Edit budget"
        title={editing ? `Edit ${editing.name}` : 'Edit budget'}
      >
        {editing ? (
          <BudgetForm
            key={editing.id}
            teams={teams}
            budget={editing}
            busy={change.busy}
            error={change.error}
            onSubmit={async (f) => {
              if (await save(f, editing)) setEditing(null);
            }}
          />
        ) : null}
      </FormSheet>
    </Section>
  );
}
