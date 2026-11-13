/**
 * The card processor port (`PaymentProcessor`, @commerceworker/ports/commerce) on Stripe, over the
 * REST client in ./stripe. It translates Stripe's errors into the port's: a card error is a
 * `PaymentDeclinedError`, an intent in the wrong state an `IntentStateError`, a request Stripe
 * refuses fails the step for good, and anything worth retrying throws as-is (`rethrow`). A refusal
 * about an invoice is an `InvoiceRefusedError`, so voiding can ask where the invoice stands.
 */
import {
  IntentStateError,
  type InvoiceProcessor,
  InvoiceRefusedError,
  PaymentDeclinedError,
  type PaymentProcessor,
  type ProcessorIntent,
} from '@commerceworker/ports/commerce';
import { rethrow } from './gateway';
import { type PaymentIntent, type StripeClient, StripeError } from './stripe';

const intentOf = (pi: PaymentIntent): ProcessorIntent => ({
  id: pi.id,
  status: pi.status,
  amount: pi.amount,
  currency: pi.currency,
  customer: pi.customer,
  paymentMethod: pi.payment_method,
  metadata: pi.metadata ?? {},
});

/** An intent Stripe won't act on in its state: the port's error, with the intent's status. */
function stateError(err: unknown): never {
  if (err instanceof StripeError && err.code === 'payment_intent_unexpected_state')
    throw new IntentStateError(`Stripe: ${err.message} (${err.code})`, err.paymentIntent?.status);
  rethrow(err);
}

/** A refusal about an invoice: missing, or refused (ask Stripe where it stands); retries as-is. */
function invoiceError(err: unknown): never {
  if (err instanceof StripeError && !err.isRetryable)
    throw new InvoiceRefusedError(
      `Stripe: ${err.message}${err.code ? ` (${err.code})` : ''}`,
      err.code === 'resource_missing' ? 'missing' : 'refused',
    );
  rethrow(err);
}

function stripeInvoices(stripe: StripeClient): InvoiceProcessor {
  return {
    async createDraft(d, key) {
      const draft = await stripe.invoices
        .create(
          {
            customer: d.customer,
            collection_method: 'send_invoice',
            ...('daysUntilDue' in d.due
              ? { days_until_due: d.due.daysUntilDue }
              : { due_date: d.due.dueDate }),
            auto_advance: false,
            pending_invoice_items_behavior: 'exclude',
            currency: d.currency,
            description: d.description,
            metadata: d.metadata,
          },
          key,
        )
        .catch(rethrow);
      return draft.id;
    },
    async addItem(item, key) {
      await stripe.invoiceItems.create({ ...item }, key).catch(rethrow);
    },
    async finalize(id, key) {
      const open = await stripe.invoices.finalize(id, { auto_advance: false }, key).catch(rethrow);
      return { number: open.number, hostedUrl: open.hosted_invoice_url, dueDate: open.due_date };
    },
    async send(id, key) {
      await stripe.invoices.send(id, key).catch(rethrow);
    },
    async void(id, key) {
      await stripe.invoices.void(id, key).catch(invoiceError);
    },
    async delete(id) {
      await stripe.invoices.del(id).catch(invoiceError);
    },
    async status(id) {
      return (await stripe.invoices.retrieve(id).catch(rethrow)).status;
    },
    async payments(id) {
      const inv = await stripe.invoices.withPayments(id).catch(rethrow);
      return (inv.payments?.data ?? []).flatMap((p) => {
        const pi = p.payment.payment_intent;
        const intentId = typeof pi === 'string' ? pi : pi?.id;
        return p.status === 'paid' && p.payment.type === 'payment_intent' && intentId
          ? [{ intentId, amount: p.amount_paid ?? 0 }]
          : [];
      });
    },
  };
}

export function stripeProcessor(stripe: StripeClient): PaymentProcessor {
  return {
    id: 'stripe',
    testMode: stripe.testMode,
    invoices: stripeInvoices(stripe),

    async createIntent(r, key) {
      try {
        return intentOf(
          await stripe.paymentIntents.create(
            {
              amount: r.amount,
              currency: r.currency,
              ...(r.capture === 'manual' ? { capture_method: 'manual' } : {}),
              confirm: true,
              payment_method: r.paymentMethod,
              customer: r.customer,
              off_session: r.offSession,
              setup_future_usage: r.saveForLater ? 'off_session' : undefined,
              automatic_payment_methods: r.anyMethod
                ? { enabled: true, allow_redirects: 'never' }
                : undefined,
              description: r.description,
              metadata: r.metadata,
            },
            key,
          ),
        );
      } catch (err) {
        if (err instanceof StripeError && err.isCardError)
          throw new PaymentDeclinedError(
            err.declineCode ?? err.code ?? err.message,
            err.paymentIntent?.id,
          );
        rethrow(err);
      }
    },

    async retrieveIntent(id) {
      return intentOf(await stripe.paymentIntents.retrieve(id).catch(rethrow));
    },

    async cancelIntent(id, key) {
      await stripe.paymentIntents.cancel(id, {}, key).catch(stateError);
    },

    async captureIntent(id, amount, key) {
      await stripe.paymentIntents.capture(id, { amount_to_capture: amount }, key).catch(stateError);
    },

    async refund(r, key) {
      const out = await stripe.refunds
        .create({ payment_intent: r.intentId, amount: r.amount, metadata: r.metadata }, key)
        .catch(rethrow);
      return { id: out.id, status: out.status };
    },

    async listRefunds(intentId) {
      const out = await stripe.refunds
        .list({ payment_intent: intentId, limit: 100 })
        .catch(rethrow);
      return out.data.map((r) => ({
        id: r.id,
        status: r.status,
        amount: r.amount,
        metadata: r.metadata ?? {},
      }));
    },

    async createCustomer(c, key) {
      const out = await stripe.customers
        .create({ email: c.email, name: c.name, metadata: c.metadata }, key)
        .catch(rethrow);
      return out.id;
    },
  };
}
