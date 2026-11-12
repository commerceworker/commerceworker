import { HOSTED_LIMITS, type HostedCheckout } from '@commerceworker/core';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { FieldDescription, FieldLegend } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { money, plural } from '@commerceworker/ui/lib/format';
import { Section } from '@commerceworker/ui/page';
import { CreditCard } from 'lucide-react';
import { Form } from 'react-router';
import {
  type CodeStatus,
  chosenOption,
  codeStatuses,
  type FieldErrors,
  type FormValues,
  isOpen,
  issuesBySection,
  SHIP_FIELDS,
  type ShipField,
  totalRows,
} from '~/lib/checkout-form';
import { FieldMessage, fieldId, IssueList, RadioRow, TextField } from './checkout-fields';

/** The ship-to fields: what each is called, the token a browser fills it by, and its shape. */
const SHIP_INPUTS: Record<
  ShipField,
  { label: string; autoComplete: string; wide?: boolean; required?: boolean; hint?: string }
> = {
  name: { label: 'Full name', autoComplete: 'shipping name', wide: true },
  line1: { label: 'Address', autoComplete: 'shipping address-line1', wide: true, required: true },
  line2: { label: 'Apartment, suite, etc.', autoComplete: 'shipping address-line2', wide: true },
  city: { label: 'City', autoComplete: 'shipping address-level2', required: true },
  region: { label: 'State or region', autoComplete: 'shipping address-level1' },
  postalCode: { label: 'Postal code', autoComplete: 'shipping postal-code', required: true },
  country: {
    label: 'Country',
    autoComplete: 'shipping country-name',
    required: true,
    hint: 'A name or a code, like United States or US.',
  },
};

/** "2 to 4 days", "1 day". */
const days = (min: number, max: number) =>
  min === max ? plural(max, 'day') : `${min} to ${plural(max, 'day')}`;

export type CheckoutFormProps = {
  checkout: HostedCheckout;
  /** Payments are only recorded: the page offers a test order instead of a card. */
  testPayments: boolean;
  editLines: boolean;
  /** What the buyer posted last, kept when the page is shown again with errors. */
  values?: FormValues | undefined;
  /** What the page found wrong in what they posted, before the engine was asked. */
  errors?: FieldErrors | undefined;
  /** Whether they have already tried to continue, so what is still to fill in shows as errors. */
  attempted: boolean;
  /** Something is being sent. */
  busy: boolean;
  /** It is the order being placed. */
  placing?: boolean;
  /** The page changed under the buyer: its fields start again from the session as it is. */
  changed?: boolean;
};

/**
 * The hosted checkout page: contact, where it goes (a ship-to and the quote's shipping options, or a
 * store to collect from), promo codes, and the total with the button that places the order. One
 * plain form that posts to the page's own action, so everything works without a script; the version
 * it was drawn from and the total it showed travel with it, so a change made since is said, not
 * overwritten, and an order is never placed at a price the buyer did not see. A checkout that has
 * ended, is being placed or waits on the business is shown read-only. Every amount is the quote's.
 */
export function CheckoutForm({
  checkout,
  testPayments,
  editLines,
  values,
  errors = {},
  attempted,
  busy,
  placing = false,
  changed = false,
}: CheckoutFormProps) {
  const q = checkout.quote;
  const stores = checkout.pickupStores ?? [];
  const open = isOpen(checkout);
  const issues = issuesBySection(checkout.issues, attempted);
  const val = (name: string, fallback = '') => values?.[name] ?? fallback;
  // What is wrong with an input: what the page found, else what the engine said about it.
  const wrong = (name: string) => errors[name] ?? issues.fields[name]?.content;
  const pickingUp = (values?.fulfillment ?? checkout.fulfillment) === 'pickup';
  const offersPickup = stores.length > 0 || checkout.fulfillment === 'pickup';
  const ships = !!q?.ships;
  const option = chosenOption(checkout);
  const quoted = new Map((q?.lines ?? []).map((l) => [l.id, l]));
  const promoError = errors.promo;

  return (
    // Remounted only when the page changed under the buyer: otherwise the fields (and the focus in
    // them) stay where they are after each update.
    <Form
      method="post"
      key={changed ? `v${checkout.version}` : 'form'}
      noValidate
      preventScrollReset
    >
      <input type="hidden" name="version" value={checkout.version} />
      {q ? <input type="hidden" name="total" value={q.total} /> : null}
      {/* Nothing can be changed or placed on a checkout that is over, being placed or with the business. */}
      <fieldset
        disabled={!open}
        className="m-0 grid min-w-0 gap-6 border-0 p-0 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start"
      >
        {/* What Enter in a field does: update. (Any button named below would otherwise be first.) */}
        <button
          type="submit"
          name="intent"
          value="update"
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />

        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Contact" description="Where we send your confirmation.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                name="email"
                label="Email"
                type="email"
                inputMode="email"
                autoComplete="email"
                defaultValue={val('email', checkout.buyer.email)}
                error={wrong('email')}
                required
                maxLength={HOSTED_LIMITS.email}
                className="sm:col-span-2"
              />
              <TextField
                name="firstName"
                label="First name"
                autoComplete="given-name"
                defaultValue={val('firstName', checkout.buyer.firstName)}
                error={wrong('firstName')}
                optional
                maxLength={HOSTED_LIMITS.name}
              />
              <TextField
                name="lastName"
                label="Last name"
                autoComplete="family-name"
                defaultValue={val('lastName', checkout.buyer.lastName)}
                error={wrong('lastName')}
                optional
                maxLength={HOSTED_LIMITS.name}
              />
              <TextField
                name="phone"
                label="Phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                defaultValue={val('phone', checkout.buyer.phone)}
                error={wrong('phone')}
                optional
                maxLength={HOSTED_LIMITS.phone}
                hint="For the carrier."
                className="sm:col-span-2"
              />
            </div>
            <IssueList issues={issues.contact} />
          </Section>

          {ships ? (
            <Section title="Delivery">
              <div className="group/ful flex flex-col gap-4">
                {offersPickup ? (
                  <fieldset className="flex flex-col gap-2">
                    <FieldLegend variant="label">How you get it</FieldLegend>
                    <RadioRow name="fulfillment" value="ship" checked={!pickingUp}>
                      Ship it to me
                    </RadioRow>
                    <RadioRow name="fulfillment" value="pickup" checked={pickingUp}>
                      Pick it up in a store
                    </RadioRow>
                  </fieldset>
                ) : null}

                <div className="flex flex-col gap-4 group-has-[input[value=pickup]:checked]/ful:hidden">
                  <fieldset className="grid gap-4 sm:grid-cols-2">
                    <FieldLegend variant="label" className="sm:col-span-2">
                      Ship to
                    </FieldLegend>
                    {SHIP_FIELDS.map((f) => (
                      <TextField
                        key={f}
                        name={`shipTo.${f}`}
                        label={SHIP_INPUTS[f].label}
                        autoComplete={SHIP_INPUTS[f].autoComplete}
                        defaultValue={val(`shipTo.${f}`, checkout.shipTo?.[f])}
                        error={wrong(`shipTo.${f}`)}
                        hint={SHIP_INPUTS[f].hint}
                        required={SHIP_INPUTS[f].required}
                        optional={!SHIP_INPUTS[f].required}
                        className={SHIP_INPUTS[f].wide ? 'sm:col-span-2' : undefined}
                      />
                    ))}
                  </fieldset>
                  <IssueList issues={issues.address} />
                  <ShippingOptions
                    options={q?.shippingOptions ?? []}
                    chosen={values?.shippingOption ?? option}
                    currency={q?.currency ?? checkout.currency}
                  />
                  <IssueList issues={issues.shipping} />
                </div>

                {offersPickup ? (
                  <div className="hidden flex-col gap-2 group-has-[input[value=pickup]:checked]/ful:flex">
                    <fieldset className="flex flex-col gap-2">
                      <FieldLegend variant="label">Pick up from</FieldLegend>
                      {stores.length ? (
                        stores.map((s) => (
                          <RadioRow
                            key={s.id}
                            name="pickupLocationId"
                            value={s.id}
                            checked={
                              (values?.pickupLocationId ?? checkout.pickupLocationId) === s.id
                            }
                            aside={s.postalCode}
                          >
                            {s.name}
                          </RadioRow>
                        ))
                      ) : (
                        <FieldDescription>
                          No store has everything in this checkout.
                        </FieldDescription>
                      )}
                    </fieldset>
                    <IssueList issues={issues.pickup} />
                  </div>
                ) : null}
              </div>
            </Section>
          ) : q ? (
            <Section title="Delivery">
              <p className="text-sm text-muted-foreground">
                Nothing here ships: it is delivered digitally.
              </p>
            </Section>
          ) : null}

          <Section title="Promo code" description="A code takes its discount off your total.">
            <div className="flex flex-col gap-3">
              <CodeList codes={codeStatuses(checkout)} disabled={!open || busy} />
              <div className="flex items-end gap-2">
                <TextField
                  // Cleared once applied: a new input, not the last one's text.
                  key={(checkout.promoCodes ?? []).join('|')}
                  name="promo"
                  label="Code"
                  autoComplete="off"
                  defaultValue={val('promo')}
                  errorBelow={promoError ? `${fieldId('promo')}-error` : undefined}
                  maxLength={HOSTED_LIMITS.promoCode}
                  className="flex-1"
                />
                <Button
                  type="submit"
                  name="intent"
                  value="update"
                  variant="outline"
                  className="h-11 px-5"
                  disabled={!open || busy}
                >
                  Apply
                </Button>
              </div>
              {promoError ? (
                <FieldMessage id={`${fieldId('promo')}-error`}>{promoError}</FieldMessage>
              ) : null}
              <IssueList issues={issues.promo} />
            </div>
          </Section>
        </div>

        <aside
          aria-label="Order summary"
          className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6 lg:self-start"
        >
          <Section title="Your order">
            <div className="flex flex-col gap-4">
              <ul className="divide-y">
                {checkout.lines.map((l) => {
                  const priced = quoted.get(l.id);
                  const qtyError = errors[`qty:${l.id}`];
                  const title = l.title ?? l.sku;
                  return (
                    <li
                      key={l.id}
                      className="flex items-start justify-between gap-3 py-3 first:pt-0"
                    >
                      <span className="min-w-0">
                        <span className="block break-words font-medium">{title}</span>
                        {editLines && open ? (
                          <span className="mt-1 flex items-center gap-2 text-muted-foreground">
                            <label htmlFor={`qty-${l.id}`}>
                              Quantity<span className="sr-only"> of {title}</span>
                            </label>
                            <Input
                              // A new input once the session's quantity moves.
                              key={`${l.id}:${l.qty}`}
                              id={`qty-${l.id}`}
                              name={`qty:${l.id}`}
                              type="number"
                              inputMode="numeric"
                              min={0}
                              defaultValue={val(`qty:${l.id}`, String(l.qty))}
                              aria-invalid={qtyError ? true : undefined}
                              aria-describedby={qtyError ? `qty-${l.id}-error` : undefined}
                              className="h-11 w-20 text-base md:text-base"
                            />
                            <Button
                              type="submit"
                              name="removeLine"
                              value={l.id}
                              variant="ghost"
                              size="sm"
                              className="h-11 px-3"
                              aria-label={`Remove ${title}`}
                              disabled={busy}
                            >
                              Remove
                            </Button>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Qty {l.qty}</span>
                        )}
                        {qtyError ? (
                          <FieldMessage id={`qty-${l.id}-error`}>{qtyError}</FieldMessage>
                        ) : null}
                      </span>
                      {priced?.total !== undefined ? (
                        <span className="shrink-0 text-right tabular-nums">
                          {priced.listTotal !== undefined && priced.listTotal > priced.total ? (
                            <>
                              <s className="block text-muted-foreground">
                                <span className="sr-only">Was </span>
                                {money(priced.listTotal, checkout.currency)}
                              </s>
                              <span className="sr-only">Now </span>
                            </>
                          ) : null}
                          {money(priced.total, checkout.currency)}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {errors.lines ? <FieldMessage id="lines-error">{errors.lines}</FieldMessage> : null}
              <IssueList issues={issues.lines} />

              {q ? (
                <dl className="flex flex-col gap-1.5 border-t pt-4 text-sm">
                  {totalRows(q).map((r, i) => (
                    <div
                      key={`${r.key}:${i}`}
                      className={
                        r.key === 'total'
                          ? 'mt-1 flex justify-between gap-3 border-t pt-3 text-base font-semibold'
                          : 'flex justify-between gap-3'
                      }
                    >
                      <dt className={r.key === 'total' ? '' : 'text-muted-foreground'}>
                        {r.label}
                        {r.note ? <span className="ml-1.5 font-mono text-xs">{r.note}</span> : null}
                      </dt>
                      <dd className="tabular-nums">
                        {r.free ? 'Free' : money(r.amount, q.currency)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">The total shows once it is priced.</p>
              )}
              <IssueList issues={issues.general} />
            </div>
          </Section>

          {open ? (
            <div className="flex flex-col gap-3">
              <IssueList issues={issues.payment} />
              {testPayments ? (
                <>
                  <Button
                    type="submit"
                    name="intent"
                    value="place"
                    size="lg"
                    className="h-11 w-full text-base"
                    disabled={busy}
                  >
                    {placing ? 'Placing…' : 'Place order (test mode)'}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    Test mode: no card is charged and nothing ships.
                  </p>
                </>
              ) : (
                <Alert>
                  <CreditCard aria-hidden="true" />
                  <AlertTitle>Card payment is coming</AlertTitle>
                  <AlertDescription>
                    You can fill in your details now, but this page can’t take a payment yet.
                    Contact the business to pay for this order.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          ) : null}
        </aside>
      </fieldset>
    </Form>
  );
}

function ShippingOptions({
  options,
  chosen,
  currency,
}: {
  options: NonNullable<HostedCheckout['quote']>['shippingOptions'];
  chosen: string | null;
  currency: string;
}) {
  if (!options.length)
    return (
      <p className="text-sm text-muted-foreground">
        Enter your address to see how it can be shipped.
      </p>
    );
  return (
    // New radios when the options or the chosen one change: the server's choice, not the last click.
    <fieldset
      key={`${options.map((o) => o.id).join('|')}:${chosen}`}
      className="flex flex-col gap-2"
    >
      <FieldLegend variant="label">Shipping</FieldLegend>
      {options.map((o) => (
        <RadioRow
          key={o.id}
          name="shippingOption"
          value={o.id}
          checked={o.id === chosen}
          aside={o.amount === 0 ? 'Free' : money(o.amount, currency)}
        >
          <span className="block font-medium">{o.title}</span>
          <span className="block text-xs text-muted-foreground">
            {o.carrier} · {days(o.minDays, o.maxDays)}
          </span>
        </RadioRow>
      ))}
    </fieldset>
  );
}

function CodeList({ codes, disabled }: { codes: CodeStatus[]; disabled: boolean }) {
  if (!codes.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {codes.map((c) => (
        <li
          key={c.code}
          className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-1"
        >
          <span className="min-w-0">
            <span className="font-mono text-sm">{c.code}</span>
            <span
              className={
                c.state === 'refused'
                  ? 'block text-sm text-destructive'
                  : 'block text-sm text-muted-foreground'
              }
            >
              {c.state === 'applied'
                ? `Applied: ${c.title}`
                : c.state === 'refused'
                  ? `Not applied: ${c.reason}`
                  : 'Applied when it is priced'}
            </span>
          </span>
          <Button
            type="submit"
            name="remove"
            value={c.code}
            variant="ghost"
            size="sm"
            className="h-11 px-3"
            aria-label={`Remove code ${c.code}`}
            disabled={disabled}
          >
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}
