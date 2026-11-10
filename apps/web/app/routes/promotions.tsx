/**
 * Promotions: what each takes off, how it combines with the others, its limits and how often it
 * has been used. A code reaches an order from a cart (or `meta.promoCodes`); an automatic
 * promotion has no code and applies to any order it fits. A flow applies both with an Apply
 * promotions step.
 */

import { BASE_CURRENCY, promotionLabel } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { dateTime, money, plural } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from 'react-router';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { ToneBadge } from '~/components/status';
import { useAssistant } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import { customerNames } from '~/lib/orders.server';
import { promotionFrom, promotionState } from '~/lib/promotions';
import { listPromotions } from '~/lib/promotions.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/promotions';

export const meta = () => [{ title: 'Promotions · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const promotions = await listPromotions();
  // One clock for the page, so the server and the hydrating browser agree on what has ended.
  return {
    promotions,
    customers: await customerNames(promotions.map((p) => p.customerId)),
    now: Date.now(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request, 'operator');
  // Checked here; the page then adds it through the assistant (`create_promotion`), whose card
  // says what the code does, and the person confirms it there.
  const p = promotionFrom(await request.formData());
  if (typeof p === 'string') return { error: p };
  const {
    code,
    customerId,
    minSubtotal,
    skus,
    validTo,
    maxRedemptions,
    perCustomerLimit,
    maxDiscount,
    ...rest
  } = p;
  return {
    create: {
      ...rest,
      ...(code ? { code } : {}),
      ...(maxDiscount !== null ? { maxDiscount } : {}),
      ...(customerId ? { customerId } : {}),
      ...(minSubtotal !== null ? { minSubtotal } : {}),
      ...(skus ? { skus } : {}),
      ...(validTo !== null ? { validTo } : {}),
      ...(maxRedemptions !== null ? { maxRedemptions } : {}),
      ...(perCustomerLimit !== null ? { perCustomerLimit } : {}),
    },
  };
}

const describe = (p: { kind: string; value: number; currency: string | null }) =>
  p.kind === 'pct'
    ? `${p.value}% off`
    : p.kind === 'amount'
      ? `${money(p.value, p.currency ?? BASE_CURRENCY)} off`
      : 'Free shipping';

export default function Promotions() {
  const { promotions, customers, now } = useLoaderData<typeof loader>();
  const answer = useActionData<typeof action>();
  const nav = useNavigation();
  const canOperate = useCan('operator');
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  // A checked form is added through the assistant; its answer closes the form or says why not.
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: true } | { error: string } | null>(null);
  const create = answer && 'create' in answer ? answer.create : undefined;
  useEffect(() => {
    if (!create) return;
    let live = true;
    setAsking(true);
    setOutcome(null);
    act('create_promotion', create)
      .then((r) => {
        if (!live || 'declined' in r) return;
        setOutcome({ ok: true });
        revalidate();
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
  // A code added closes the form; a refusal keeps it open with what was typed.
  const sheet = useFormSheet(result, (r) => 'ok' in r);
  return (
    <>
      <PageHeader
        title="Promotions"
        crumbs={
          <Link to="/commerce#pricing" className="hover:underline">
            Commerce
          </Link>
        }
        subtitle="Codes buyers and staff enter on a cart, and automatic promotions that need none. A flow applies them with an Apply promotions step, after Price lines and before Calculate tax."
        actions={
          canOperate ? (
            <FormSheet open={sheet.open} onOpenChange={sheet.onOpenChange} label="New promotion">
              <NewPromotion
                error={sheet.result && 'error' in sheet.result ? sheet.result.error : null}
                busy={busy}
              />
            </FormSheet>
          ) : null
        }
      />
      <Body className="grid gap-4">
        <Section
          title="Promotions"
          description="What each takes off, how it combines with the others, its limits and how often it has been used."
          flush
        >
          {promotions.length ? (
            <Table stack="cards" caption="Promotions">
              <TableHead>
                <Tr>
                  <Th>Promotion</Th>
                  <Th>Takes off</Th>
                  <Th>Combines</Th>
                  <Th>Limits</Th>
                  <Th numeric>Used</Th>
                  <Th className="w-0">
                    <span className="sr-only">Actions</span>
                  </Th>
                </Tr>
              </TableHead>
              <TableBody>
                {promotions.map((p) => {
                  const paused = p.status === 'paused';
                  const state = promotionState(p, now);
                  const limits: ReactNode[] = [
                    p.minSubtotal ? `over ${money(p.minSubtotal)}` : null,
                    p.skus ? plural(p.skus.length, 'SKU') : null,
                    p.customerId ? (
                      <Link to={`/customers/${p.customerId}`} className="text-link hover:underline">
                        {customers[p.customerId] ?? p.customerId}
                      </Link>
                    ) : null,
                    p.maxDiscount ? `at most ${money(p.maxDiscount)} per order` : null,
                    p.maxRedemptions ? plural(p.maxRedemptions, 'use') : null,
                    p.perCustomerLimit ? `${p.perCustomerLimit} per customer` : null,
                    p.validTo
                      ? `${state === 'ended' ? 'ended' : 'until'} ${dateTime(p.validTo, 'UTC')}`
                      : null,
                  ].filter(Boolean);
                  return (
                    <Tr key={p.id} className={cn(state !== 'active' && 'text-muted-foreground')}>
                      <Td>
                        {p.code ? (
                          <span className="font-mono">{p.code}</span>
                        ) : (
                          <span>{p.name}</span>
                        )}
                        {state !== 'active' ? (
                          <span className="ml-2 align-[0.0625em]">
                            <ToneBadge tone="idle" label={state === 'ended' ? 'Ended' : 'Paused'} />
                          </span>
                        ) : null}
                        {p.code ? (
                          p.name ? (
                            <div className="text-muted-foreground text-xs">{p.name}</div>
                          ) : null
                        ) : (
                          <div className="text-muted-foreground text-xs">
                            Automatic: applies to any order it fits
                          </div>
                        )}
                      </Td>
                      <Td label="Takes off">{describe(p)}</Td>
                      <Td label="Combines" className="text-muted-foreground text-xs">
                        {p.stacking === 'stackable' ? 'Stackable' : 'Exclusive'}
                        {p.priority ? ` · priority ${p.priority}` : ''}
                      </Td>
                      <Td label="Limits" className="text-muted-foreground text-xs">
                        {limits.length
                          ? limits.map((l, i) => (
                              // The limits keep a fixed order, so the index is a stable key.
                              <Fragment key={i}>
                                {i ? ' · ' : null}
                                {l}
                              </Fragment>
                            ))
                          : 'None'}
                      </Td>
                      <Td numeric label="Used">
                        {p.redeemed}
                      </Td>
                      <Td className="max-md:-ml-3 max-md:basis-full">
                        {state === 'ended' ? (
                          // Pausing or resuming it would change nothing, and its dates can't be
                          // edited: the way to run it again is a new promotion.
                          <p className="max-w-48 text-muted-foreground text-xs max-md:pl-3 md:text-right">
                            Ended, so it no longer applies.
                            {canOperate ? ' To run it again, add a new promotion.' : null}
                          </p>
                        ) : canOperate ? (
                          <StatusButton id={p.id} label={promotionLabel(p)} paused={paused} />
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>No promotions yet.</Empty>
          )}
        </Section>
      </Body>
    </>
  );
}

/**
 * The fields of a new promotion: its code (or none) and what it takes off, how it combines, then its limits, grouped. The action
 * checks them (`promotionFrom`).
 */
function NewPromotion({ error, busy }: { error?: string | null; busy: boolean }) {
  return (
    <Form method="post">
      <FieldGroup className="gap-5">
        {[
          ['code', 'Code (leave empty for an automatic promotion)', 'WELCOME15'],
          ['name', 'Name (needed without a code)', 'Welcome offer'],
        ].map(([k, label, ph]) => (
          <Field key={k} className="gap-2">
            <FieldLabel htmlFor={`promo-${k}`}>{label}</FieldLabel>
            <Input id={`promo-${k}`} name={k} placeholder={ph} />
          </Field>
        ))}
        <div className="grid grid-cols-2 gap-3">
          <Field className="gap-2">
            <FieldLabel htmlFor="promo-kind">Takes off</FieldLabel>
            <NativeSelect id="promo-kind" name="kind">
              <NativeSelectOption value="pct">A percentage</NativeSelectOption>
              <NativeSelectOption value="amount">An amount ({BASE_CURRENCY})</NativeSelectOption>
              <NativeSelectOption value="free_shipping">Shipping</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="promo-value">Percent or amount</FieldLabel>
            <Input id="promo-value" name="value" inputMode="decimal" />
          </Field>
        </div>
        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0">
            Combining
          </FieldLegend>
          <div className="grid grid-cols-2 gap-3">
            <Field className="gap-2">
              <FieldLabel htmlFor="promo-stacking">Combines</FieldLabel>
              <NativeSelect id="promo-stacking" name="stacking">
                <NativeSelectOption value="exclusive">Never with another</NativeSelectOption>
                <NativeSelectOption value="stackable">With stackable ones</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="promo-priority">Priority</FieldLabel>
              <Input id="promo-priority" name="priority" inputMode="numeric" placeholder="0" />
            </Field>
          </div>
          <Field className="gap-2">
            <FieldLabel htmlFor="promo-maxDiscount">
              Most it takes off one order ({BASE_CURRENCY}, optional)
            </FieldLabel>
            <Input id="promo-maxDiscount" name="maxDiscount" inputMode="decimal" />
          </Field>
        </FieldSet>
        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0">
            Limits
          </FieldLegend>
          {[
            ['minSubtotal', `Minimum subtotal (${BASE_CURRENCY}, optional)`],
            ['skus', 'Only these SKUs (optional, comma separated)'],
            ['customerId', 'Only this customer id (optional)'],
            ['maxRedemptions', 'Uses in all (optional)'],
            ['perCustomerLimit', 'Uses per customer (optional)'],
          ].map(([k, label]) => (
            <Field key={k} className="gap-2">
              <FieldLabel htmlFor={`promo-${k}`}>{label}</FieldLabel>
              <Input id={`promo-${k}`} name={k} />
            </Field>
          ))}
          <Field className="gap-2">
            <FieldLabel htmlFor="promo-validTo">Ends on (optional)</FieldLabel>
            <Input id="promo-validTo" name="validTo" type="date" className="max-w-48" />
          </Field>
        </FieldSet>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Add promotion
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}

/** Pauses or resumes a promotion through the assistant: its card says what changes for buyers. */
function StatusButton({ id, label, paused }: { id: string; label: string; paused: boolean }) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act('set_promotion_status', {
        promotionId: id,
        status: paused ? 'active' : 'paused',
      });
      if (!('declined' in r)) revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-label={`${paused ? 'Resume' : 'Pause'} ${label}`}
        onClick={() => void run()}
      >
        {busy ? 'Confirm it in the assistant' : paused ? 'Resume' : 'Pause'}
      </Button>
      {error ? (
        <span role="alert" className="text-bad text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}
