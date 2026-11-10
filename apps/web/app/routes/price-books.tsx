/**
 * Price books: named lists of prices with a priority and dates, assigned to a customer or a tier.
 * Where several books assigned to a customer price a line, the highest priority wins, then the
 * lowest price in it. A book prices nothing until it has entries, is assigned and is active inside
 * its dates. Adding one goes through the assistant (`create_price_book`), whose card the person
 * confirms.
 */

import { type PriceBookStatus, priceBookState } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { dateTime, plural } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { useEffect, useState } from 'react';
import { Form, Link, useActionData, useLoaderData, useNavigate, useNavigation } from 'react-router';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { ToneBadge } from '~/components/status';
import { useAssistant } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import { BOOK_STATES, priceBookFrom, STATUS_FILTERS } from '~/lib/price-books';
import { bookPage } from '~/lib/price-books.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/price-books';

export const meta = () => [{ title: 'Price books · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const asked = url.searchParams.get('status');
  const status = STATUS_FILTERS.find((s) => s === asked && s !== 'all') as
    | PriceBookStatus
    | undefined;
  const page = await bookPage({ status, after: url.searchParams.get('after') ?? undefined });
  // One clock for the page, so the server and the hydrating browser agree on what has ended.
  return {
    ...page,
    status: status ?? 'all',
    after: url.searchParams.get('after'),
    now: Date.now(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request, 'operator');
  // Checked here; the page then adds it through the assistant (`create_price_book`), whose card
  // says what it does, and the person confirms it there.
  const b = priceBookFrom(await request.formData());
  if (typeof b === 'string') return { error: b };
  return { create: b };
}

const dates = (b: { startsAt: number | null; endsAt: number | null }) =>
  b.startsAt === null && b.endsAt === null
    ? 'Whenever active'
    : [
        b.startsAt === null ? null : `from ${dateTime(b.startsAt, 'UTC')}`,
        b.endsAt === null ? null : `until ${dateTime(b.endsAt, 'UTC')}`,
      ]
        .filter(Boolean)
        .join(' ');

export default function PriceBooks() {
  const { books, total, next, status, after, now } = useLoaderData<typeof loader>();
  const answer = useActionData<typeof action>();
  const nav = useNavigation();
  const navigate = useNavigate();
  const canOperate = useCan('operator');
  const { act } = useAssistant();
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: true } | { error: string } | null>(null);
  const create = answer && 'create' in answer ? answer.create : undefined;
  useEffect(() => {
    if (!create) return;
    let live = true;
    setAsking(true);
    setOutcome(null);
    act('create_price_book', create)
      .then((r) => {
        if (!live || 'declined' in r) return;
        setOutcome({ ok: true });
        const id = (r.output as { id?: string } | undefined)?.id;
        if (id) navigate(`/price-books/${id}`);
      })
      .catch(
        (e: unknown) => live && setOutcome({ error: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => live && setAsking(false));
    return () => {
      live = false;
    };
  }, [create]);
  const result = outcome ?? (answer && 'error' in answer ? answer : undefined);
  const busy = nav.state === 'submitting' || asking;
  const sheet = useFormSheet(result, (r) => 'ok' in r);
  const filter = (s: string) => (s === 'all' ? '/price-books' : `/price-books?status=${s}`);
  return (
    <>
      <PageHeader
        title="Price books"
        crumbs={
          <Link to="/commerce#pricing" className="hover:underline">
            Commerce
          </Link>
        }
        subtitle="Named prices for a customer or a tier. Where several books price a line, the highest priority wins, then the lowest price in it. Prices are in USD, the base currency."
        actions={
          canOperate ? (
            <FormSheet open={sheet.open} onOpenChange={sheet.onOpenChange} label="New price book">
              <NewBook
                error={sheet.result && 'error' in sheet.result ? sheet.result.error : null}
                busy={busy}
              />
            </FormSheet>
          ) : null
        }
      />
      <Body className="grid gap-4">
        <nav aria-label="Status" className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              asChild
              size="sm"
              variant={s === status ? 'default' : 'outline'}
              className="hit-area"
            >
              <Link to={filter(s)} aria-current={s === status ? 'page' : undefined}>
                {s === 'all' ? 'All' : BOOK_STATES[s].label.replace('In force', 'Active')}
              </Link>
            </Button>
          ))}
        </nav>
        <Section
          title="Books"
          description={`${plural(total, 'book')}${status === 'all' ? '' : ` ${status}`}, by code.`}
          flush
        >
          {books.length ? (
            <Table stack="cards" caption="Price books">
              <TableHead>
                <Tr>
                  <Th>Book</Th>
                  <Th>State</Th>
                  <Th numeric>Priority</Th>
                  <Th>In force</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {books.map((b) => {
                  const state = priceBookState(b, now);
                  const shown = BOOK_STATES[state];
                  return (
                    <Tr key={b.id} className={cn(state !== 'active' && 'text-muted-foreground')}>
                      <Td>
                        <Link
                          to={`/price-books/${b.id}`}
                          className="font-mono text-link hover:underline"
                        >
                          {b.code}
                        </Link>
                        <div className="text-muted-foreground text-xs">{b.name}</div>
                      </Td>
                      <Td label="State">
                        <ToneBadge tone={shown.tone} label={shown.label} />
                      </Td>
                      <Td numeric label="Priority">
                        {b.priority}
                      </Td>
                      <Td label="In force" className="text-muted-foreground text-xs">
                        {dates(b)}
                      </Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>No price books{status === 'all' ? ' yet' : ` that are ${status}`}.</Empty>
          )}
          {after || next ? (
            <div className="flex gap-2 px-4 py-3">
              {after ? (
                <Button asChild variant="outline" size="sm">
                  <Link to={filter(status)}>First page</Link>
                </Button>
              ) : null}
              {next ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    to={`${filter(status)}${status === 'all' ? '?' : '&'}after=${encodeURIComponent(next)}`}
                  >
                    Next page
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : null}
        </Section>
      </Body>
    </>
  );
}

/** A new book's code, name, priority and dates. The action checks them (`priceBookFrom`). */
function NewBook({ error, busy }: { error?: string | null; busy: boolean }) {
  return (
    <Form method="post">
      <FieldGroup className="gap-5">
        {[
          ['code', 'Code', 'spring-2027'],
          ['name', 'Name', 'Spring 2027 wholesale'],
        ].map(([k, label, ph]) => (
          <Field key={k} className="gap-2">
            <FieldLabel htmlFor={`book-${k}`}>{label}</FieldLabel>
            <Input
              id={`book-${k}`}
              name={k}
              placeholder={ph}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
        ))}
        <Field className="gap-2">
          <FieldLabel htmlFor="book-priority">Priority (the higher wins)</FieldLabel>
          <Input
            id="book-priority"
            name="priority"
            inputMode="numeric"
            placeholder="0"
            className="max-w-32"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field className="gap-2">
            <FieldLabel htmlFor="book-startsAt">First day (optional)</FieldLabel>
            <Input id="book-startsAt" name="startsAt" type="date" />
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="book-endsAt">Last day (optional)</FieldLabel>
            <Input id="book-endsAt" name="endsAt" type="date" />
          </Field>
        </div>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Add price book
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}
