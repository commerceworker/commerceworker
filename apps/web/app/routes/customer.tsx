/**
 * One customer: the account as the commerce steps see it, its recent orders and the places they
 * ship to, and its tax exemption certificates.
 * Operators add a certificate (with its scan), verify it once checked with the issuer, and revoke
 * it; only a verified, unexpired certificate covering an order's ship-to exempts it from tax
 * (`commerce.tax`). Buyers never claim one.
 */

import {
  atLeast,
  newId,
  ORDER_MODEL_LABELS,
  type OrderModel,
  taxCertificateState,
} from '@commerceworker/core';
import { Ago } from '@commerceworker/ui/ago';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardDescription, CardTitle } from '@commerceworker/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@commerceworker/ui/field';
import { useNow } from '@commerceworker/ui/hooks/use-now';
import { Input } from '@commerceworker/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from '@commerceworker/ui/item';
import { count, dateTime, money } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect } from '@commerceworker/ui/native-select';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { useState } from 'react';
import {
  data,
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from 'react-router';
import { BudgetsSection } from '~/components/budgets';
import { CompanySection, EditCustomer, MembersSection, TeamsSection } from '~/components/company';
import { FormSheet, useFormSheet } from '~/components/form-sheet';
import { StatusBadge, ToneBadge } from '~/components/status';
import { useAssistant } from '~/lib/assistant';
import { audit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import { amountFrom, ENTRY_KINDS } from '~/lib/credit';
import {
  addCertificate,
  addressesOf,
  budgetsOf,
  companyOf,
  creditOf,
  customerById,
} from '~/lib/customers.server';
import { engine } from '~/lib/env.server';
import { humanize, liveStatus, orderRef } from '~/lib/format';
import { countOrders, listOrders } from '~/lib/orders.server';
import { BOOK_STATES } from '~/lib/price-books';
import { customerPricing } from '~/lib/price-books.server';
import { CERTIFICATE_STATES, expiryDay, placesLabel } from '~/lib/tax-certificates';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/customer';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.customer.name ?? 'Customer'} · Customers · CommerceWorker` },
];

/** How many of the customer's orders the page lists, most recently changed first. */
const RECENT_ORDERS = 6;
/** How many of the places it ships to, most recently used first. */
const ADDRESSES = 4;
/** How many ledger entries a page of the credit account lists. */
const CREDIT_ENTRIES = 10;

export async function loader({ request, params }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const after = new URL(request.url).searchParams.get('after') ?? undefined;
  const [customer, certificates, recent, ordered, addresses, company, credit] = await Promise.all([
    customerById(params.customerId),
    engine().taxCertificates(params.customerId),
    listOrders({ customer: params.customerId, sort: 'updated' }, RECENT_ORDERS),
    countOrders({ customer: params.customerId }),
    addressesOf(params.customerId, ADDRESSES),
    // Members are personal data: the page shows them to the roles that may list them.
    companyOf(params.customerId, new URL(request.url).searchParams, atLeast(me.role, 'operator')),
    // Null for a customer who doesn't buy on account.
    creditOf(params.customerId, after, CREDIT_ENTRIES),
  ]);
  if (!customer || !certificates) throw data('Customer not found', { status: 404 });
  // A company's budgets, shown to every role that can see the page.
  const budgets = company
    ? await budgetsOf(params.customerId, new URL(request.url).searchParams)
    : null;
  const { stripeCustomerId: _c, stripePaymentMethodId: _pm, ...shown } = customer;
  return {
    customer: shown,
    pricing: await customerPricing(customer, Date.now()),
    certificates,
    // An open order with no run reads "recorded", never waiting (`liveStatus`).
    recent: recent.map((o) => ({ ...o, status: liveStatus(o) })),
    ordered,
    addresses,
    company,
    credit,
    after: after ?? null,
    budgets,
    // The next certificate's id, minted here so a form sent twice adds it once.
    nextId: newId('txc'),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  const customerId = params.customerId;
  const f = await request.formData();
  const intent = f.get('intent');
  // Verifying and revoking go through the assistant (`CertificateButton`); adding stays here,
  // since it stores the certificate's file first.
  const r = await addCertificate(customerId, me, f);
  if (!r.ok) return { intent: String(intent ?? 'add'), error: r.error };
  // A repeat (a form sent twice, verifying what's verified) did nothing to record.
  if (r.changed)
    await audit(request, 'tax_certificate.added', {
      actor: me,
      target: customerId,
      detail: { certificate: r.id, via: 'app' },
    });
  return { intent: String(intent ?? 'add'), ok: true as const };
}

export default function CustomerPage() {
  const {
    customer: c,
    certificates,
    recent,
    ordered,
    addresses,
    company,
    credit,
    after,
    budgets,
    nextId,
    pricing,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === 'submitting';
  const canOperate = useCan('operator');
  const now = useNow(60_000);
  const business = c.kind === 'business';
  // A certificate added closes the form; a refusal keeps it open with what was typed.
  const sheet = useFormSheet(result, (r) => 'ok' in r && r.intent === 'add');
  const addError =
    sheet.result && 'error' in sheet.result && sheet.result.intent === 'add'
      ? sheet.result.error
      : null;
  const states = certificates.map((t) => taxCertificateState(t, now));
  const exempting = states.filter((s) => s === 'active').length;
  const figures: Figure[] = [
    { label: 'Terms', value: business ? humanize(c.terms) : 'Pays at checkout' },
    {
      label: 'Exempting certificates',
      value: count(exempting),
      note: `of ${count(certificates.length)} on file`,
    },
  ];
  return (
    <>
      <PageHeader
        title={c.name}
        crumbs={
          <Link to="/commerce#customers" className="hover:underline">
            Customers
          </Link>
        }
        subtitle={[
          humanize(c.kind),
          business ? `${humanize(c.tier)} tier` : null,
          business ? humanize(c.terms) : 'Pays at checkout',
          credit && c.creditLimit
            ? `${money(credit.balance)} of ${money(credit.limit)} credit`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <div className="flex gap-2">
            {canOperate ? <EditCustomer customer={c} /> : null}
            <Button asChild variant="outline" size="sm">
              <Link to={`/orders?q=${encodeURIComponent(c.name)}`}>Orders</Link>
            </Button>
          </div>
        }
      />
      <Body className="grid gap-4 lg:gap-6">
        {/* The account as the commerce steps read it, figure by figure (the preview cards' tiles). */}
        <section aria-label="Account" className="grid grid-cols-2 gap-4">
          {figures.map((f) => (
            <FigureCard key={f.label} f={f} />
          ))}
        </section>
        {company ? (
          <>
            <CompanySection data={company} canOperate={canOperate} />
            <Section
              title="Price books"
              description="Books assigned to this customer, or to its tier, in the order they rank: the highest priority that prices a line wins."
              flush
            >
              {pricing.books.length ? (
                <Table stack="cards" caption="Price books assigned to this customer">
                  <TableHead>
                    <Tr>
                      <Th>Book</Th>
                      <Th>State</Th>
                      <Th numeric>Priority</Th>
                    </Tr>
                  </TableHead>
                  <TableBody>
                    {pricing.books.map((b) => (
                      <Tr
                        key={b.id}
                        className={cn(b.state !== 'active' && 'text-muted-foreground')}
                      >
                        <Td>
                          <Link to={`/price-books/${b.id}`} className="text-link hover:underline">
                            {b.name}
                          </Link>
                          <div className="font-mono text-muted-foreground text-xs">{b.code}</div>
                        </Td>
                        <Td label="State">
                          <ToneBadge
                            tone={BOOK_STATES[b.state].tone}
                            label={BOOK_STATES[b.state].label}
                          />
                        </Td>
                        <Td numeric label="Priority">
                          {b.priority}
                        </Td>
                      </Tr>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty>No price books are assigned to this customer or its tier.</Empty>
              )}
            </Section>
            <Section
              title="Contract prices"
              description={
                pricing.contractTotal > pricing.contracts.length
                  ? `The first ${count(pricing.contracts.length)} of ${count(pricing.contractTotal)}. A contract price is what was agreed, even above list price.`
                  : 'What was agreed per SKU, even above list price. Prices are in USD.'
              }
              flush
            >
              {pricing.contracts.length ? (
                <Table stack="cards" caption="Contract prices">
                  <TableHead>
                    <Tr>
                      <Th>SKU</Th>
                      <Th numeric>Contract price</Th>
                      <Th numeric>List price</Th>
                    </Tr>
                  </TableHead>
                  <TableBody>
                    {pricing.contracts.map((p) => (
                      <Tr key={p.sku}>
                        <Td className="font-mono">{p.sku}</Td>
                        <Td numeric label="Contract price">
                          {money(p.price)}
                        </Td>
                        <Td numeric label="List price" className="text-muted-foreground">
                          {p.listPrice === null ? 'No product' : money(p.listPrice)}
                        </Td>
                      </Tr>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty>No contract prices.</Empty>
              )}
            </Section>
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
              <MembersSection data={company} canOperate={canOperate} />
              <TeamsSection data={company} canOperate={canOperate} />
            </div>
            {budgets ? (
              <BudgetsSection
                data={{ ...budgets, company: company.company, teams: company.teams }}
                canOperate={canOperate}
              />
            ) : null}
          </>
        ) : null}
        {credit ? <CreditSection customerId={c.id} credit={credit} after={after} /> : null}
        <Section
          title="Tax exemption certificates"
          description="Only a verified, unexpired certificate covering an order’s ship-to exempts it from tax."
          flush
          actions={
            canOperate ? (
              <FormSheet
                open={sheet.open}
                onOpenChange={sheet.onOpenChange}
                label="Add certificate"
                title="Add a certificate"
                description="It exempts orders once someone verifies it with the issuer."
              >
                <AddCertificate nextId={nextId} error={addError} busy={busy} />
              </FormSheet>
            ) : null
          }
        >
          {certificates.length ? (
            <Table stack="cards" caption="Tax exemption certificates">
              <TableHead>
                <Tr>
                  <Th>Certificate</Th>
                  <Th>Covers</Th>
                  <Th>Expires</Th>
                  <Th>Status</Th>
                  <Th className="w-0">
                    <span className="sr-only">Actions</span>
                  </Th>
                </Tr>
              </TableHead>
              <TableBody>
                {certificates.map((t, i) => {
                  const state = states[i] ?? taxCertificateState(t, now);
                  const shown = CERTIFICATE_STATES[state];
                  return (
                    <Tr key={t.id} className={cn(state === 'revoked' && 'text-muted-foreground')}>
                      <Td>
                        <span className="font-mono">{t.number}</span>
                        {t.file ? (
                          <a
                            href={`/customers/${c.id}/tax-certificates/${t.id}`}
                            className="block truncate text-link text-xs hover:underline"
                            download={t.file.name}
                          >
                            {t.file.name}
                          </a>
                        ) : (
                          <div className="text-muted-foreground text-xs">No file</div>
                        )}
                      </Td>
                      <Td label="Covers">{placesLabel(t.regions)}</Td>
                      <Td label="Expires">
                        {t.expiresAt ? (
                          expiryDay(t.expiresAt)
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </Td>
                      <Td label="Status">
                        <ToneBadge tone={shown.tone} label={shown.label} />
                        <div className="text-muted-foreground text-xs">
                          {t.revokedAt
                            ? `Revoked by ${t.revokedBy} · ${dateTime(t.revokedAt, 'UTC')}`
                            : t.verifiedAt
                              ? `Verified by ${t.verifiedBy} · ${dateTime(t.verifiedAt, 'UTC')}`
                              : `Added by ${t.createdBy} · ${dateTime(t.createdAt, 'UTC')}`}
                        </div>
                      </Td>
                      <Td className="max-md:-ml-3 max-md:basis-full">
                        {canOperate && t.status === 'active' ? (
                          <div className="flex gap-1">
                            {state === 'unverified' ? (
                              <CertificateButton
                                customerId={c.id}
                                id={t.id}
                                intent="verify"
                                number={t.number}
                              />
                            ) : null}
                            <CertificateButton
                              customerId={c.id}
                              id={t.id}
                              intent="revoke"
                              number={t.number}
                            />
                          </div>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <Empty>No certificates. Orders for this customer are taxed.</Empty>
          )}
          {result && 'error' in result && result.intent !== 'add' ? (
            <p role="alert" className="px-4 py-2 text-bad text-sm">
              {result.error}
            </p>
          ) : null}
        </Section>
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
          <Section
            title="Recent orders"
            description={
              ordered.n
                ? `The ${Math.min(recent.length, ordered.n)} most recently changed of ${ordered.more ? `${count(ordered.n)}+` : count(ordered.n)} orders.`
                : undefined
            }
            actions={
              ordered.n > recent.length ? (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/orders?q=${encodeURIComponent(c.name)}`}>All orders</Link>
                </Button>
              ) : undefined
            }
          >
            {recent.length ? (
              <ul className="-mx-2 flex flex-col gap-0.5">
                {recent.map((o) => (
                  <OrderItem key={o.id} o={o} />
                ))}
              </ul>
            ) : (
              <Empty>No orders yet.</Empty>
            )}
          </Section>
          <Section
            title="Addresses"
            description={
              addresses.list.length
                ? addresses.more
                  ? `The ${addresses.list.length} its orders shipped to most recently.`
                  : 'Where its orders ship to, most recent first.'
                : undefined
            }
          >
            {addresses.list.length ? (
              <ul className="-mx-2 flex flex-col gap-0.5">
                {addresses.list.map((a) => (
                  <AddressItem key={a.id} a={a} />
                ))}
              </ul>
            ) : (
              <Empty>No addresses yet. An order that ships to one adds it here.</Empty>
            )}
          </Section>
        </div>
      </Body>
    </>
  );
}

/** One of the customer's orders: where it is, linked to its page, with its total and last change. */
function OrderItem({
  o,
}: {
  o: ReturnType<typeof useLoaderData<typeof loader>>['recent'][number];
}) {
  const model = ORDER_MODEL_LABELS[o.model as OrderModel] ?? o.model;
  return (
    <Item asChild size="xs" className="relative items-start px-2 hover:bg-muted/60">
      <li>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <Link
              to={`/orders/${o.id}`}
              className="truncate after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
            >
              {o.title || o.externalId || model}{' '}
              <span className="font-mono font-normal text-muted-foreground text-xs">
                {orderRef(o.id)}
              </span>
            </Link>
          </ItemTitle>
          <ItemDescription className="text-xs">
            {model}
            {o.waitingAt && o.status === 'waiting' ? ` · waiting at ${o.waitingAt}` : ''}
            {o.stoppedAt && o.status !== 'completed' ? ` · stopped at ${o.stoppedAt}` : ''}
          </ItemDescription>
        </ItemContent>
        <ItemActions className="flex-col items-end gap-1 self-start">
          <span className="font-medium text-sm tabular">{money(o.total, o.currency)}</span>
          <StatusBadge status={o.status} />
        </ItemActions>
      </li>
    </Item>
  );
}

/** A place the customer's orders ship to, with how many did and a link to the latest. */
function AddressItem({
  a,
}: {
  a: ReturnType<typeof useLoaderData<typeof loader>>['addresses']['list'][number];
}) {
  return (
    <Item asChild size="xs" className="items-start px-2">
      <li>
        <ItemContent className="min-w-0">
          <address className="text-sm not-italic">
            {a.name ? <span className="block font-medium">{a.name}</span> : null}
            <span className="block">{[a.line1, a.line2].filter(Boolean).join(', ')}</span>
            <span className="block text-muted-foreground">
              {[a.city, a.region, a.postalCode].filter(Boolean).join(' ')} · {a.country}
            </span>
          </address>
          <ItemDescription className="text-xs">
            {a.orders === 1 ? '1 order' : `${count(a.orders)} orders`}, last{' '}
            <Link to={`/orders/${a.lastOrderId}`} className="hover:underline">
              <Ago ms={a.lastUsedAt} />
            </Link>
          </ItemDescription>
        </ItemContent>
      </li>
    </Item>
  );
}

type Figure = { label: string; value: string; note?: string; tone?: string };

/** One account figure: its label, the value set large, and a muted note under it. */
function FigureCard({ f }: { f: Figure }) {
  return (
    <Card size="sm" className="min-w-0 gap-1">
      <CardContent className="flex flex-1 flex-col gap-1">
        <CardDescription>{f.label}</CardDescription>
        <CardTitle className={cn('font-semibold text-2xl tabular max-md:text-xl', f.tone)}>
          {f.value}
        </CardTitle>
        {f.note ? (
          <CardDescription className={cn('text-xs tabular', f.tone && 'font-medium', f.tone)}>
            {f.note}
          </CardDescription>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Verifies or revokes a certificate through the assistant: its card says what changes in tax. */
function CertificateButton({
  customerId,
  id,
  intent,
  number,
}: {
  customerId: string;
  id: string;
  intent: 'verify' | 'revoke';
  number: string;
}) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await act(
        intent === 'verify' ? 'verify_tax_certificate' : 'revoke_tax_certificate',
        {
          customerId,
          certificateId: id,
        },
      );
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
        aria-label={`${intent === 'verify' ? 'Verify' : 'Revoke'} certificate ${number}`}
        onClick={() => void run()}
      >
        {busy ? 'Confirm it in the assistant' : intent === 'verify' ? 'Verify' : 'Revoke'}
      </Button>
      {error ? (
        <span role="alert" className="text-bad text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** A new certificate's fields; the id is minted by the loader, so a form sent twice adds it once. */
function AddCertificate({
  nextId,
  error,
  busy,
}: {
  nextId: string;
  error?: string | null;
  busy: boolean;
}) {
  return (
    <Form method="post" encType="multipart/form-data">
      <input type="hidden" name="intent" value="add" />
      <input type="hidden" name="id" value={nextId} />
      <FieldGroup className="gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-number">Certificate number</FieldLabel>
          <Input id="cert-number" name="number" required maxLength={64} />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-regions">Covers</FieldLabel>
          <Input
            id="cert-regions"
            name="regions"
            required
            autoCapitalize="characters"
            autoCorrect="off"
            placeholder="US-CA, US-NV"
            aria-describedby="cert-regions-hint"
          />
          <FieldDescription id="cert-regions-hint">
            A country, or a region of one: US, US-CA, CA-ON.
          </FieldDescription>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-expires">Last day it is valid (optional)</FieldLabel>
          <Input id="cert-expires" name="expires" type="date" className="max-w-48" />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor="cert-file">The certificate (optional)</FieldLabel>
          <Input
            id="cert-file"
            name="file"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            aria-describedby="cert-file-hint"
          />
          <FieldDescription id="cert-file-hint">PDF or image, up to 10 MB.</FieldDescription>
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Add certificate
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}

type Credit = NonNullable<ReturnType<typeof useLoaderData<typeof loader>>['credit']>;

/**
 * A business customer's credit: the limit, what is owed, what open orders hold and what is left,
 * then the ledger behind the balance, newest first with the balance after each entry. An admin
 * sets the limit or adjusts the balance (a credit memo, a payment received elsewhere) through the
 * assistant, whose card shows the account before and after.
 */
function CreditSection({
  customerId,
  credit,
  after,
}: {
  customerId: string;
  credit: Credit;
  after: string | null;
}) {
  const canAdmin = useCan('admin');
  const over = credit.limit > 0 && credit.balance > credit.limit;
  const tight = !over && credit.available < 0;
  const near = !over && !tight && credit.limit > 0 && credit.available <= credit.limit * 0.1;
  const figures: Figure[] = [
    { label: 'Credit limit', value: credit.limit ? money(credit.limit) : 'No limit' },
    {
      label: 'Balance owed',
      value: money(credit.balance),
      note: over ? 'Over limit' : undefined,
      tone: over ? 'text-bad' : undefined,
    },
    {
      label: 'Held by open orders',
      value: money(credit.held),
      note: 'Claimed until invoiced or released',
    },
    {
      label: 'Available',
      value: money(credit.available),
      note: tight ? 'Orders on account are refused' : near ? 'Near limit' : undefined,
      tone: tight ? 'text-bad' : near ? 'text-wait' : undefined,
    },
  ];
  return (
    <Section
      id="credit"
      title="Credit"
      description="Orders on account hold their total against the limit until they are invoiced."
      actions={
        canAdmin ? (
          <div className="flex flex-wrap gap-2">
            <CreditSheet kind="limit" customerId={customerId} credit={credit} />
            <CreditSheet kind="adjust" customerId={customerId} credit={credit} />
          </div>
        ) : null
      }
      flush
    >
      <div className="grid grid-cols-2 gap-4 px-(--card-spacing) lg:grid-cols-4">
        {figures.map((f) => (
          <FigureCard key={f.label} f={f} />
        ))}
      </div>
      {credit.entries.length ? (
        <Table stack="cards" caption="Credit ledger">
          <TableHead>
            <Tr>
              <Th>When</Th>
              <Th>Entry</Th>
              <Th numeric>Amount</Th>
              <Th numeric>Balance after</Th>
            </Tr>
          </TableHead>
          <TableBody>
            {credit.entries.map((e) => (
              <Tr key={e.id}>
                <Td label="When" className="text-muted-foreground">
                  {dateTime(e.at, 'UTC')}
                </Td>
                <Td label="Entry">
                  <span className="font-medium">{ENTRY_KINDS[e.kind]}</span>
                  <div className="text-muted-foreground text-xs">
                    {e.orderId ? (
                      <Link to={`/orders/${e.orderId}`} className="hover:underline">
                        Order {orderRef(e.orderId)}
                      </Link>
                    ) : null}
                    {e.note ? `${e.note}${e.reference ? ` · ${e.reference}` : ''}` : null}
                  </div>
                </Td>
                <Td numeric label="Amount" className={cn(e.amount < 0 && 'text-ok')}>
                  {e.amount > 0 ? '+' : ''}
                  {money(e.amount)}
                </Td>
                <Td numeric label="Balance after">
                  {money(e.balanceAfter)}
                </Td>
              </Tr>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty>No entries yet. Invoicing an order on account is the first.</Empty>
      )}
      {after || credit.next ? (
        <nav aria-label="Ledger pages" className="flex justify-between gap-2 border-t px-4 py-2">
          {after ? (
            <Button asChild variant="ghost" size="sm">
              <Link to={{ search: '', hash: '#credit' }}>Latest entries</Link>
            </Button>
          ) : (
            <span />
          )}
          {credit.next ? (
            <Button asChild variant="ghost" size="sm">
              <Link to={`?after=${encodeURIComponent(credit.next)}#credit`}>Older entries</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}
    </Section>
  );
}

/**
 * One credit change behind a button: the new limit, or an adjustment's amount, direction and
 * reason. Nothing is saved until the person confirms the assistant's card, which shows the account
 * now and after; the sheet closes once they have.
 */
function CreditSheet({
  kind,
  customerId,
  credit,
}: {
  kind: 'limit' | 'adjust';
  customerId: string;
  credit: Credit;
}) {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(kind === 'limit' ? String(credit.limit) : '');
  const [lower, setLower] = useState('lower');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `credit-${kind}`;
  const amount = amountFrom(text);
  const problem =
    typeof amount === 'string'
      ? amount
      : kind === 'adjust' && amount === 0
        ? 'An adjustment can’t be zero.'
        : kind === 'adjust' && !reason.trim()
          ? 'Give a reason: it is what the ledger shows.'
          : null;
  const save = async () => {
    if (typeof amount === 'string') return;
    setBusy(true);
    setError(null);
    try {
      const r =
        kind === 'limit'
          ? await act('set_credit_limit', { customerId, limit: amount })
          : await act('adjust_credit', {
              customerId,
              amount: lower === 'lower' ? -amount : amount,
              reason: reason.trim(),
            });
      if ('declined' in r) return;
      revalidate();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormSheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setError(null);
      }}
      icon={null}
      label={kind === 'limit' ? 'Set limit' : 'Adjust balance'}
      title={kind === 'limit' ? 'Set the credit limit' : 'Adjust the balance'}
      description={
        kind === 'limit'
          ? 'What the customer may owe on account, in US dollars. Orders already holding credit keep it.'
          : 'A credit memo or a payment received elsewhere lowers what is owed. The entry stays in the ledger; undo it with another.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && !busy) void save();
        }}
      >
        <FieldGroup className="gap-5">
          {kind === 'adjust' ? (
            <Field className="gap-2">
              <FieldLabel htmlFor={`${id}-direction`}>Effect</FieldLabel>
              <NativeSelect
                id={`${id}-direction`}
                value={lower}
                onChange={(e) => setLower(e.target.value)}
              >
                <option value="lower">Lower the balance (memo or payment)</option>
                <option value="raise">Raise the balance (debit)</option>
              </NativeSelect>
            </Field>
          ) : null}
          <Field className="gap-2">
            <FieldLabel htmlFor={`${id}-amount`}>
              {kind === 'limit' ? 'Limit' : 'Amount'}
            </FieldLabel>
            <Input
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={text !== '' && typeof amount === 'string' ? true : undefined}
              className="max-w-48 tabular"
            />
          </Field>
          {kind === 'adjust' ? (
            <Field className="gap-2">
              <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
              <Input
                id={`${id}-reason`}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Credit memo 41, wire received"
              />
              <FieldDescription>It is shown in the ledger and the audit trail.</FieldDescription>
            </Field>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button type="submit" size="sm" disabled={!!problem || busy}>
              {busy ? 'Confirm it in the assistant' : 'Review'}
            </Button>
          </div>
        </FieldGroup>
      </form>
    </FormSheet>
  );
}
